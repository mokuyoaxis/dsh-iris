import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { BrowserHtmlRenderer, renderRoot, serveRender } from '../lib/render.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCommandService } from '../lib/command-service.js';
import { listCoreArtifacts } from '../lib/core-artifacts.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-render-confirmation'), dataRoot = path.join(root, 'core');
const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#fff' } }).png().toBuffer();
let mode = 'missing', shots = 0, closed = 0, requests = 0;
const server = http.createServer((request, response) => {
  requests++;
  assert.equal(request.headers.cookie, 'render-session=fixture', 'use the browser navigation, not a new unauthenticated probe');
  if (mode === 'missing') { response.writeHead(404); response.end('not found'); }
  else if (mode === 'wrong') { response.writeHead(200); response.end('<h1>another service</h1>'); }
  else serveRender(request, response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const renderer = new BrowserHtmlRenderer({ waitMs: 0, getAddress: () => ({ baseUrl: 'http://127.0.0.1:' + server.address().port }), browser: {
  async open() { return 'route-fixture'; },
  async openUrl(_session, { url }) {
    const response = await fetch(url, { method: mode === 'head' ? 'HEAD' : 'GET', headers: { Cookie: 'render-session=fixture' } });
    await response.arrayBuffer(); // Some browsers navigate to HTTP error pages without throwing.
  },
  async screenshot() { shots++; return { dataUrl: 'data:image/png;base64,' + png.toString('base64') }; },
  async close() { closed++; }
} });
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
const commands = createCommandService(runtime, { browser: { async renderHtml(input) {
  const result = await renderer.render(input); return { bytes: result.png, mediaType: 'image/png' };
} } });
try {
  for (mode of ['missing', 'wrong', 'head']) {
    await assert.rejects(commands.execute('media.html', { html: '<p>this render only</p>' }), { code: 'IRIS_RENDER_ROUTE_UNCONFIRMED' });
    assert.equal(shots, 0); assert.equal(listCoreArtifacts(dataRoot).total, 0);
    assert.deepEqual(fs.readdirSync(renderRoot()), []);
  }
  mode = 'ok';
  const result = await commands.execute('media.html', { html: '<p>this render only</p>' });
  assert.equal(result.artifact.kind, 'html-screenshot'); assert.equal(shots, 1);
  assert.equal(requests, 4, 'no extra preflight requests or authentication bypass');
  mode = 'missing';
  await assert.rejects(commands.execute('media.html', { html: '<p>next render</p>' }), { code: 'IRIS_RENDER_ROUTE_UNCONFIRMED' });
  assert.equal(shots, 1); assert.equal(listCoreArtifacts(dataRoot).total, 1, 'an earlier success does not confirm a later page');
  assert.equal(closed, 5); assert.deepEqual(fs.readdirSync(renderRoot()), []);
  console.log('PASS real HTTP 404/wrong-200/HEAD fail before screenshot or Artifact; per-render route delivery, browser auth and cleanup preserved');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.dispose();
}
