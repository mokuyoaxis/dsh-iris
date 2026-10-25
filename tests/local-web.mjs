import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { presentReadOnlyFlow } from '../lib/web/flow-view.js';
import { createReadClient } from '../lib/web/transport.js';
import { FLOW_MODEL, FLOW_SOURCE, FLOW_RESULT, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-local-web');
const dataRoot = path.join(root, 'core'), fixture = imageFlowFixture(dataRoot);
const app = createApplicationRuntime({ dataRoot, ...fixture }), services = [];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function tree() {
  return Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const file = path.join(item.parentPath, item.name); return [path.relative(dataRoot, file), digest(fs.readFileSync(file))]; }));
}
async function start(options) { const api = createLocalReadApi({ dataRoot, ...options }); services.push(api); return api.start(); }
const nativeFetch = globalThis.fetch;

try {
  assert.throws(() => createLocalReadApi({ dataRoot, serveWorkbench: 'yes' }), TypeError);
  const unstartedWriter = createLocalReadApi({ dataRoot, serveWorkbench: true, allowLocalWrites: true });
  assert.equal(unstartedWriter.snapshot().state, 'new', 'explicit Web writes do not require connection management');
  assert.equal(fs.existsSync(dataRoot), false, 'construction still performs no initialization');
  await unstartedWriter.dispose();
  await app.execute('flow.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const facts = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: '<img src=x onerror=alert(1)>; keep the subject' });
  const complete = await app.execute('flow.continue', { run_id: facts.run.id });
  await app.execute('flow.select', { run_id: facts.run.id, artifact_id: complete.run.output.artifactId });
  const before = tree(), beforeEvents = readFlowEvents(dataRoot);
  const ordinary = await start({});
  assert.equal((await nativeFetch(ordinary.origin + '/')).status, 401, 'API mode does not silently add a public page');
  const session = await start({ serveWorkbench: true });
  const headers = { Authorization: 'Bearer ' + session.accessToken };
  const assets = new Map([['/', 'text/html'], ['/app.js', 'text/javascript'], ['/transport.js', 'text/javascript'],
    ['/media-client.js', 'text/javascript'], ['/recovery.js', 'text/javascript'],
    ['/creation.js', 'text/javascript'], ['/gallery.js', 'text/javascript'], ['/providers.js', 'text/javascript'], ['/appearance.js', 'text/javascript'],
    ['/flow-view.js', 'text/javascript'], ['/connections.js', 'text/javascript'], ['/styles.css', 'text/css'], ['/iris-mark.svg', 'image/svg+xml']]);
  for (const [resource, type] of assets) {
    const response = await nativeFetch(session.origin + resource);
    assert.equal(response.status, 200, resource); assert(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length > 0);
    assert(!bytes.includes(dataRoot)); assert(!bytes.includes(session.accessToken)); assert(!bytes.includes('onerror=alert'));
    const head = await nativeFetch(session.origin + resource, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(Number(head.headers.get('content-length')), bytes.length);
    assert.equal((await nativeFetch(session.origin + resource, { headers: { Origin: 'https://outside.invalid' } })).status, 403);
    assert.equal((await nativeFetch(session.origin + resource, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await nativeFetch(session.origin + resource, { method: 'POST' })).status, 405);
  }
  assert.equal((await nativeFetch(session.origin + '/?token=never-in-url')).status, 400);
  const hostDenied = await new Promise((resolve, reject) => {
    const request = http.get(session.origin + '/', { headers: { Host: 'outside.invalid' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }); request.once('error', reject);
  }); assert.equal(hostDenied, 403);
  for (const resource of ['/api/v0/session', '/api/v0/runs', '/api/v0/artifacts/' + source.id + '/content']) {
    assert.equal((await nativeFetch(session.origin + resource)).status, 401, resource + ' must remain private');
  }
  for (const resource of ['/.internal/PLAN.md', '/package.json', '/web/index.html', '/docs/assets/logo/iris-mark.svg',
    '/%2e%2e/package.json', '/%61pp.js', '/app.js/extra', '/token', '/api/v0/execute']) {
    const response = await nativeFetch(session.origin + resource, { headers });
    assert.notEqual(response.status, 200, resource); assert(!(await response.text()).includes(dataRoot));
  }
  for (const resource of ['/api/v0/images', '/api/v0/runs', '/api/v0/runs/' + facts.run.id + '/continue']) {
    assert.equal((await nativeFetch(session.origin + resource, { headers, method: 'POST' })).status, 405);
  }

  // Exercise the browser transport against the real HTTP service without a DOM or mock DTOs.
  let unauthorized = 0;
  globalThis.fetch = (resource, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert(!resource.includes(session.accessToken));
    return nativeFetch(session.origin + resource, options);
  };
  const client = createReadClient(session.accessToken);
  const values = await Promise.all(Array.from({ length: 8 }, () => client.get('/api/v0/runs/' + facts.run.id)));
  assert(values.every(view => view.id === facts.run.id && view.status === 'selected'));
  const view = values[0];
  assert.equal(presentReadOnlyFlow(view).title, '已选择结果');
  const download = await client.get('/api/v0/runs/' + facts.run.id + '/download', { binary: true });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), FLOW_RESULT);
  const delivered = await client.get('/api/v0/runs/' + facts.run.id + '/download', { download: true });
  assert.deepEqual(Buffer.from(await delivered.blob.arrayBuffer()), FLOW_RESULT);
  assert.equal(delivered.filename, 'iris-' + complete.run.output.artifactId + '.png');
  for (const status of ['not_started', 'running', 'needs_attention', 'delivery_failed', 'needs_comparison', 'awaiting_selection']) {
    const message = presentReadOnlyFlow({ ...view, status, task: { acceptance: 'unknown' } });
    assert(message.title); assert(message.message);
    if (status === 'needs_attention') assert.match(message.message, /可能已经计费/);
    if (status === 'running') assert.match(message.message, /不会查询模型服务/);
  }
  assert.throws(() => presentReadOnlyFlow({ ...view, status: 'future' }), /不支持/);
  assert.throws(() => presentReadOnlyFlow({ ...view, contractVersion: 1 }), /不支持/);
  assert.throws(() => client.get('https://outside.invalid/api/v0/session'), TypeError);
  assert.throws(() => client.postManagement('/api/v0/images', {}), TypeError, 'management entry cannot dispatch media writes');
  const wrong = createReadClient('x'.repeat(43), { onUnauthorized: () => unauthorized++ });
  await assert.rejects(wrong.get('/api/v0/session'), error => error.status === 401);
  assert.equal(unauthorized, 1); wrong.close();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.get('/api/v0/runs', { signal: controller.signal }), { name: 'AbortError' });
  client.close();
  await assert.rejects(client.get('/api/v0/session'), { name: 'AbortError' });
  assert.deepEqual(tree(), before, 'static, API, media, download, errors and aborted reads write no Core bytes');
  assert.deepEqual(readFlowEvents(dataRoot), beforeEvents, 'opening and refreshing never submits or polls a Provider');
  console.log('local Web: package assets, Host/Origin/Bearer boundaries, read-only page calls, all Flow states, original download and zero writes/provider calls OK');
} finally {
  globalThis.fetch = nativeFetch;
  for (const service of services) await service.dispose();
  await app.dispose();
}
