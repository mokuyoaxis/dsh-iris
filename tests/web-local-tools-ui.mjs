import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreArtifact } from '../lib/core-artifact-store.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createReadClient } from '../lib/web/transport.js';
import { FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-web-local-tools-ui');
const dataRoot = path.join(root, 'core');
const fixture = imageFlowFixture(dataRoot);
const app = createApplicationRuntime({ dataRoot, ...fixture });
const services = [];
const nativeFetch = globalThis.fetch;

async function start(options) {
  const api = createLocalReadApi({ dataRoot, serveWorkbench: true, ...options });
  services.push(api);
  return api.start();
}

try {
  // 1. Static HTML & JS wiring safety checks (all DOM IDs exist, zero inline styles / innerHTML).
  const html = fs.readFileSync(new URL('../lib/web/index.html', import.meta.url), 'utf8');
  const localToolsJs = fs.readFileSync(new URL('../lib/web/local-tools.js', import.meta.url), 'utf8');
  const lineageJs = fs.readFileSync(new URL('../lib/web/lineage.js', import.meta.url), 'utf8');
  for (const [name, src] of [['local-tools.js', localToolsJs], ['lineage.js', lineageJs]]) {
    assert(!src.includes('innerHTML'), name + ' must never use innerHTML');
    assert(!src.includes('.style.'), name + ' must never mutate inline styles');
    for (const match of src.matchAll(/\$\('#([a-z0-9-]+)'\)/g)) {
      const id = match[1];
      assert(html.includes(`id="${id}"`), `${name} references #${id} missing from index.html`);
    }
  }

  // 2. Seed static images and unsupported candidates with otherwise readable metadata.
  await app.execute('flow.init', {});
  await app.execute('execution.init', { vision: true });
  const imgA = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const imgBBytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#e76f51' } }).png().toBuffer();
  const imgB = (await app.execute('artifact.import', { image_bytes: imgBBytes })).artifact;
  const animated = await sharp(Buffer.concat([Buffer.alloc(300), Buffer.alloc(300, 255)]),
    { raw: { width: 10, height: 20, channels: 3, pageHeight: 10 } }).webp().toBuffer();
  // A 1×1 APNG with red and blue frames. libvips can read the first frame as a PNG.
  const apng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEAAQAAVirfMQAAAAxJREFUeJxj+M/AAAADAQEAyf6S7wAAABpmY1RMAAAAAQAAAAEAAAABAAAAAAAAAAAAAQABAADNWTXlAAAAEGZkQVQAAAACeJxjYGD4DwABAwEAaL/t9AAAAABJRU5ErkJggg==', 'base64');
  const mismatched = await app.run('writer', runtime => runtime.run('execute', ({ dataRoot }) =>
    createCoreArtifact(dataRoot, { kind: 'generated-image', mediaType: 'image/jpeg', bytes: imgBBytes })));
  const animatedArt = await app.run('writer', runtime => runtime.run('execute', ({ dataRoot }) =>
    createCoreArtifact(dataRoot, { kind: 'generated-image', mediaType: 'image/webp', bytes: animated })));
  const apngArt = await app.run('writer', runtime => runtime.run('execute', ({ dataRoot }) =>
    createCoreArtifact(dataRoot, { kind: 'generated-image', mediaType: 'image/png', bytes: apng })));

  // 3. Read-only mode: directory/meta/lineage GET work, POST crop/diff/html return 405.
  const ro = await start({});
  globalThis.fetch = (resource, options) => nativeFetch(ro.origin + resource, options);
  const roClient = createReadClient(ro.accessToken);
  const roSession = await roClient.get('/api/v0/session');
  assert.equal(roSession.readOnly, true);
  assert(!roSession.operations.includes('local-media.crop'));
  assert(!roSession.operations.includes('local-media.diff'));
  assert(!roSession.operations.includes('html.render'));
  assert.equal(roSession.htmlRender, undefined);

  const roList = await roClient.listArtifacts({ kind: 'image', limit: 10, offset: 0 });
  assert.equal(roList.total, 5);
  const roMeta = await roClient.getArtifactMeta(imgA.id);
  assert.deepEqual(roMeta.image, { width: 48, height: 32, orientation: 1 });
  for (const image of [mismatched, animatedArt, apngArt]) {
    await assert.rejects(roClient.getArtifactMeta(image.id), { status: 415, code: 'IRIS_API_MEDIA_UNSUPPORTED' });
  }
  await assert.rejects(roClient.cropImage({ artifactId: imgA.id, left: 0, top: 0, width: 10, height: 10 }), error => error.status === 405);
  await assert.rejects(roClient.pixelDiff({ imageAArtifactId: imgA.id, imageBArtifactId: imgB.id }), error => error.status === 405);
  await assert.rejects(roClient.renderHtml({ html: '<p>x</p>' }), error => error.status === 405);
  roClient.close();
  await services.pop().dispose();

  // 4. Local-writes mode WITHOUT browser port: crop & diff succeed (201), html-render is 404.
  const rwNoBrowser = await start({ allowLocalWrites: true });
  globalThis.fetch = (resource, options) => nativeFetch(rwNoBrowser.origin + resource, options);
  const rwClient = createReadClient(rwNoBrowser.accessToken);
  const rwSession = await rwClient.get('/api/v0/session');
  assert(rwSession.operations.includes('local-media.crop'));
  assert(rwSession.operations.includes('local-media.diff'));
  assert(!rwSession.operations.includes('html.render'));
  assert.equal(rwSession.htmlRender, undefined);

  const cropRes = await rwClient.cropImage({ artifactId: imgA.id, left: 2, top: 4, width: 20, height: 12 });
  assert.equal(cropRes.contractVersion, 0);
  assert.equal(cropRes.artifact.width, 20);
  assert.equal(cropRes.artifact.height, 12);

  const diffRes = await rwClient.pixelDiff({ imageAArtifactId: imgA.id, imageBArtifactId: imgB.id, grid: 4, topRegions: 2 });
  assert.equal(diffRes.contractVersion, 0);
  assert(diffRes.metrics.ratio > 0);
  assert.equal(diffRes.metrics.worstRegions.length, 2);

  // Verify lineage recorded for both zero-cost artifacts!
  const diffLin = await rwClient.getArtifactLineage(diffRes.artifact.artifactId);
  assert.equal(diffLin.totalParents, 2);
  assert.deepEqual(new Set(diffLin.parents.map(p => p.artifactId)), new Set([imgA.id, imgB.id]));

  await assert.rejects(rwClient.renderHtml({ html: '<p>blocked</p>' }), error => error.status === 404);
  rwClient.close();
  await services.pop().dispose();

  // 5. Local-writes mode WITH explicit browser port: htmlRender flag + renderHtml succeeds (201).
  const mockPng = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#2a9d8f' } }).png().toBuffer();
  let renderCalls = 0;
  const mockBrowser = {
    async renderHtml({ html: sourceHtml, width, height, fullPage }) {
      renderCalls++;
      assert(sourceHtml.includes('Iris Sandbox'));
      assert.equal(width, 320);
      assert.equal(height, 180);
      assert.equal(fullPage, false);
      return { bytes: mockPng, mediaType: 'image/png' };
    }
  };
  const rwHtml = await start({ allowLocalWrites: true, browser: mockBrowser });
  globalThis.fetch = (resource, options) => nativeFetch(rwHtml.origin + resource, options);
  const htmlClient = createReadClient(rwHtml.accessToken);
  const htmlSession = await htmlClient.get('/api/v0/session');
  assert.equal(htmlSession.htmlRender, true);
  assert(htmlSession.operations.includes('html.render'));

  const htmlRes = await htmlClient.renderHtml({ html: '<div>Iris Sandbox</div>', width: 320, height: 180, fullPage: false });
  assert.equal(renderCalls, 1);
  assert.equal(htmlRes.contractVersion, 0);
  assert.equal(htmlRes.artifact.width, 320);
  assert.equal(htmlRes.artifact.height, 180);
  const htmlBytes = Buffer.from(await (await htmlClient.get('/api/v0/artifacts/' + htmlRes.artifact.artifactId + '/content', { binary: true })).arrayBuffer());
  assert.deepEqual(htmlBytes, mockPng);

  // Invalid HTML render params rejected both at client transport and HTTP API boundaries.
  assert.throws(() => htmlClient.renderHtml({ html: '   ' }), TypeError);
  assert.throws(() => htmlClient.renderHtml({ html: '<p>x</p>', width: 9999 }), TypeError);
  const badRes = await nativeFetch(rwHtml.origin + '/api/v0/html-render', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + rwHtml.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>x</p>', width: 9999 })
  });
  assert.equal(badRes.status, 400);
  assert.equal(renderCalls, 1);

  htmlClient.close();
  console.log('web local tools UI: DOM IDs, CSP hygiene, transport crop/diff/html-render gating and lineage OK');
} finally {
  globalThis.fetch = nativeFetch;
  for (const service of services) await service.dispose();
  await app.dispose();
}
