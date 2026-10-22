import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi, writeLocalApiTokenFile } from '../lib/local-api.js';
import { createCoreArtifact } from '../lib/core-artifacts.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { projectLocalApiFlow } from '../lib/local-api-projection.js';
import { projectFlowFacts } from '../prototypes/workbench/view-model.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-local-api');
const apps = [], apis = [];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const file = path.join(item.parentPath, item.name); return [path.relative(directory, file), { sha256: sha(fs.readFileSync(file)), mode: fs.statSync(file).mode & 0o777 }]; }));
}
function api(options) { const value = createLocalReadApi(options); apis.push(value); return value; }
async function flow(name, options) {
  const dataRoot = path.join(root, name), fixture = imageFlowFixture(dataRoot, options);
  const app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {});
  const imported = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const create = () => app.execute('flow.create', { source_artifact_id: imported.id, model_ref: FLOW_MODEL, prompt: 'PRIVATE_CREATIVE_PROMPT; keep the subject' });
  const facts = await create();
  return { dataRoot, fixture, app, source: imported, facts, create, input: { run_id: facts.run.id } };
}
async function raw(origin, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(new URL(origin).port), '127.0.0.1');
    let response = '';
    socket.setTimeout(8000, () => socket.destroy(new Error('raw HTTP timeout')));
    socket.on('error', reject); socket.on('data', bytes => { response += bytes; });
    socket.once('end', () => resolve(response)); socket.once('connect', () => socket.write(request));
  });
}
async function get(session, url, options = {}) {
  const response = await fetch(session.origin + url, { ...options, headers: { Authorization: 'Bearer ' + session.accessToken, ...options.headers } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes, json: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes.toString()) : undefined };
}

try {
  const absent = path.join(root, 'absent'), unused = api({ dataRoot: absent });
  assert.equal(unused.snapshot().state, 'new'); assert.equal(fs.existsSync(absent), false);
  await assert.rejects(unused.start(), { code: 'IRIS_CORE_DATA_ROOT_NOT_FOUND' });
  assert.equal(fs.existsSync(absent), false, 'startup must never initialize a missing root');
  const ordinaryRoot = path.join(root, 'ordinary'), ordinaryApp = createApplicationRuntime({ dataRoot: ordinaryRoot }); apps.push(ordinaryApp);
  await ordinaryApp.execute('artifact.import', { image_bytes: FLOW_SOURCE });
  const ordinaryBytes = tree(ordinaryRoot);
  await assert.rejects(api({ dataRoot: ordinaryRoot }).start(), { code: 'IRIS_FLOW_ROOT_REQUIRED' });
  assert.deepEqual(tree(ordinaryRoot), ordinaryBytes);

  const main = await flow('main');
  const completedFacts = await main.app.execute('flow.continue', main.input);
  const chosenFacts = await main.app.execute('flow.select', { ...main.input, artifact_id: completedFacts.run.output.artifactId });
  assert.deepEqual(projectLocalApiFlow(chosenFacts), projectFlowFacts(chosenFacts), 'production DTO stays aligned with the retained demo contract');
  const unstarted = await main.create(), third = await main.create();
  const dataBefore = tree(main.dataRoot), eventsBefore = readFlowEvents(main.dataRoot);
  const config = path.join(root, 'providers.json'), secret = 'PRIVATE_API_KEY_MARKER';
  const configBytes = JSON.stringify({ providers: [{ id: 'configured', name: secret,
    baseUrl: 'https://should-not-contact.invalid/v1', apiKey: secret, mediaProtocol: 'openai-chat-images', enabled: true,
    models: [{ id: 'edit', capabilities: ['image-gen'] }, { id: 'unsupported', capabilities: ['image-gen'], imageProtocol: 'openai-images' }, { id: 'speech', capabilities: ['tts'] }] }],
    assignments: { 'image-gen': ['configured::edit', 'configured::unsupported'] } });
  fs.writeFileSync(config, configBytes, { mode: 0o600 });
  const service = api({ dataRoot: main.dataRoot, providerConfigPath: config }), session = await service.start();
  assert.equal(new URL(session.origin).hostname, '127.0.0.1');
  assert(/^[A-Za-z0-9_-]{43}$/.test(session.accessToken));
  assert(!JSON.stringify(service.snapshot()).includes(session.accessToken));
  await assert.rejects(service.start(), { code: 'IRIS_API_LIFECYCLE' });
  const routes = ['/api/v0/session', '/api/v0/models', '/api/v0/runs', '/api/v0/runs/' + main.facts.run.id,
    '/api/v0/artifacts/' + main.source.id + '/content', '/api/v0/runs/' + main.facts.run.id + '/download'];
  for (const url of routes) {
    const response = await fetch(session.origin + url); assert.equal(response.status, 401, url);
    const body = await response.text(); assert(!body.includes(session.accessToken)); assert(!body.includes(main.dataRoot));
    assert(!response.headers.has('access-control-allow-origin'));
  }
  const auth = await get(session, '/api/v0/session'); assert.equal(auth.response.status, 200);
  assert.equal(auth.json.readOnly, true); assert.deepEqual(auth.json.operations, ['models.list', 'runs.list', 'runs.inspect', 'artifacts.content', 'runs.download']);
  for (const forbidden of [session.accessToken, secret, main.dataRoot, config, 'should-not-contact']) assert(!JSON.stringify(auth.json).includes(forbidden));
  assert.equal(auth.response.headers.get('cache-control'), 'no-store'); assert.equal(auth.response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(auth.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const headers of [{ Origin: 'https://outside.invalid' }, { Origin: 'null' }, { Origin: session.origin + '/' },
    { Origin: session.origin.replace('http:', 'https:') }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await get(session, '/api/v0/session', { headers })).response.status, 403);
  }
  assert.equal((await get(session, '/api/v0/session', { headers: { Origin: session.origin, 'Sec-Fetch-Site': 'same-origin' } })).response.status, 200);
  assert.equal((await get(session, '/api/v0/session', { headers: { Authorization: 'bearer  ' + session.accessToken } })).response.status, 200);
  const changedCase = session.accessToken.replace(/[a-zA-Z]/, value => value === value.toUpperCase() ? value.toLowerCase() : value.toUpperCase());
  assert.equal((await get(session, '/api/v0/session', { headers: { Authorization: 'Bearer ' + changedCase } })).response.status, 401, 'scheme is case-insensitive; token bytes remain case-sensitive');
  assert.equal((await get(session, '/api/v0/session', { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } })).response.status, 401);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const value = await get(session, '/api/v0/runs', { method }); assert.equal(value.response.status, 405); assert.equal(value.response.headers.get('allow'), 'GET, HEAD');
  }
  const authority = new URL(session.origin).host, authorization = 'Authorization: Bearer ' + session.accessToken + '\r\n';
  const request = extra => `GET /api/v0/session HTTP/1.1\r\nHost: ${authority}\r\n${authorization}${extra}Connection: close\r\n\r\n`;
  for (const extra of ['Host: outside.invalid\r\n', 'Origin: ' + session.origin + '\r\nOrigin: ' + session.origin + '\r\n']) {
    assert.match(await raw(session.origin, request(extra)), /^HTTP\/1\.1 403 /);
  }
  assert.match(await raw(session.origin, request(authorization)), /^HTTP\/1\.1 401 /);
  assert.match(await raw(session.origin, request('Content-Length: 1\r\n') + 'x'), /^HTTP\/1\.1 400 /);
  const badHost = await new Promise((resolve, reject) => {
    const value = http.get(session.origin + '/api/v0/session', { headers: { Host: 'outside.invalid', Authorization: 'Bearer ' + session.accessToken,
      'X-Forwarded-Host': authority, Forwarded: 'host=' + authority } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    value.once('error', reject);
  }); assert.equal(badHost, 403);

  const modelList = await get(session, '/api/v0/models'); assert.equal(modelList.response.status, 200);
  assert.deepEqual(modelList.json.models, [{ modelRef: 'configured::edit', displayName: 'edit', supportsImageEdit: true },
    { modelRef: 'configured::unsupported', displayName: 'unsupported', supportsImageEdit: false }]);
  for (const forbidden of [secret, 'should-not-contact', 'apiKey', 'baseUrl']) assert(!modelList.bytes.includes(forbidden));
  const page = (await get(session, '/api/v0/runs?limit=2')).json;
  assert.equal(page.total, 3); assert.equal(page.runs.length, 2); assert(page.nextCursor);
  assert(!JSON.stringify(page).includes('PRIVATE_CREATIVE_PROMPT')); assert(!JSON.stringify(page).includes('sha256'));
  const tail = (await get(session, '/api/v0/runs?limit=2&cursor=' + page.nextCursor)).json;
  assert.equal(tail.runs.length, 1); assert.equal(tail.nextCursor, null);
  assert.equal(new Set([...page.runs, ...tail.runs].map(item => item.id)).size, 3);
  const detail = await get(session, '/api/v0/runs/' + main.facts.run.id);
  assert.deepEqual(detail.json, projectLocalApiFlow(chosenFacts));
  for (const name of ['providerBinding', 'inputDigest', 'remoteTaskId', 'lastError', 'attempts', 'sha256']) assert(!detail.bytes.includes(name), name);
  const fresh = (await get(session, '/api/v0/runs/' + unstarted.run.id)).json;
  assert.equal(fresh.status, 'not_started'); assert.equal(fresh.task, null);
  assert.equal((await get(session, '/api/v0/runs/' + unstarted.run.id + '/download')).response.status, 409);
  const content = await get(session, '/api/v0/artifacts/' + main.source.id + '/content');
  assert.equal(content.response.status, 200); assert.deepEqual(content.bytes, FLOW_SOURCE);
  const download = await get(session, '/api/v0/runs/' + main.facts.run.id + '/download');
  assert.equal(download.response.status, 200); assert.match(download.response.headers.get('content-disposition'), /^attachment; filename="iris-artifact_[a-f0-9]{24}\.png"$/);
  const head = await fetch(session.origin + '/api/v0/runs/' + main.facts.run.id + '/download', { method: 'HEAD', headers: { Authorization: 'Bearer ' + session.accessToken } });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0); assert(Number(head.headers.get('content-length')) > 0);
  for (const url of ['/api/v0/runs?limit=0', '/api/v0/runs?limit=31', '/api/v0/runs?limit=2&limit=3', '/api/v0/runs?path=x',
    '/api/v0/runs?cursor=not-a-run', '/api/v0/runs?cursor=run_' + 'f'.repeat(24), '/api/v0/session?token=not-accepted',
    '/api/v0/artifacts/..%2f..%2fconfig/content', '/api/v0/runs/invalid']) {
    assert.equal((await get(session, url)).response.status, 400, url);
  }
  for (const url of ['/.internal/PLAN.md', '/package.json', '/api/v0/execute', '/api/v0/runs/' + third.run.id + '/continue']) {
    assert.equal((await get(session, url)).response.status, 404, url);
  }
  assert.equal((await get(session, '/api/v0/runs/run_' + 'f'.repeat(24))).response.status, 404);
  assert.equal((await get(session, '/api/v0/artifacts/artifact_' + 'f'.repeat(24) + '/content')).response.status, 404);
  const pipeline = Array.from({ length: 3 }, (_, index) => `GET /api/v0/runs HTTP/1.1\r\nHost: ${authority}\r\n${authorization}Connection: ${index === 2 ? 'close' : 'keep-alive'}\r\n\r\n`).join('');
  assert.deepEqual([...((await raw(session.origin, pipeline)).matchAll(/HTTP\/1\.1 (\d+)/g))].map(item => Number(item[1])), [200, 200, 429]);
  assert.deepEqual(tree(main.dataRoot), dataBefore, 'all HTTP paths, media reads and errors leave the Core bytes/modes untouched');
  assert.deepEqual(readFlowEvents(main.dataRoot), eventsBefore, 'GET never queries or submits a Provider');
  assert.equal(fs.readFileSync(config, 'utf8'), configBytes);

  const privateToken = path.join(root, 'session-token');
  writeLocalApiTokenFile(privateToken, session.accessToken, main.dataRoot);
  if (process.platform !== 'win32') assert.equal(fs.statSync(privateToken).mode & 0o777, 0o600);
  const tokenBytes = fs.readFileSync(privateToken);
  assert.throws(() => writeLocalApiTokenFile(privateToken, 'replacement', main.dataRoot), { code: 'IRIS_API_TOKEN_FILE_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(privateToken), tokenBytes);
  assert.throws(() => writeLocalApiTokenFile(path.join(main.dataRoot, 'token'), session.accessToken, main.dataRoot), { code: 'IRIS_API_TOKEN_FILE_INVALID' });

  const other = await flow('other', { mode: 'unknown' });
  await other.app.execute('flow.continue', other.input);
  const otherBefore = tree(other.dataRoot), otherEvents = readFlowEvents(other.dataRoot);
  const otherService = api({ dataRoot: other.dataRoot }), otherSession = await otherService.start();
  assert.equal((await get(otherSession, '/api/v0/models')).json.configured, false);
  assert.equal((await get({ ...session, accessToken: otherSession.accessToken }, '/api/v0/session')).response.status, 401);
  assert.equal((await get(otherSession, '/api/v0/runs/' + main.facts.run.id)).response.status, 404);
  assert.equal((await get(otherSession, '/api/v0/runs/' + other.facts.run.id)).json.status, 'needs_attention');
  assert.deepEqual(tree(other.dataRoot), otherBefore); assert.deepEqual(readFlowEvents(other.dataRoot), otherEvents);
  const canceled = api({ dataRoot: main.dataRoot }), starting = canceled.start(), disposing = canceled.dispose();
  await assert.rejects(starting, { code: 'IRIS_API_UNAVAILABLE' }); await disposing;
  assert.equal(canceled.snapshot().state, 'closed'); assert.equal(canceled.snapshot().origin, null);
  const occupied = api({ dataRoot: main.dataRoot });
  await assert.rejects(occupied.start({ port: Number(new URL(session.origin).port) }), { code: 'EADDRINUSE' });
  assert.equal(occupied.snapshot().state, 'closed');

  if (process.platform !== 'win32') {
    const alias = path.join(root, 'alias'), replacement = path.join(root, 'replacement-alias');
    fs.symlinkSync(main.dataRoot, alias);
    const pinned = api({ dataRoot: alias }), pinnedSession = await pinned.start();
    fs.symlinkSync(other.dataRoot, replacement); fs.renameSync(replacement, alias);
    assert.deepEqual((await get(pinnedSession, '/api/v0/artifacts/' + main.source.id + '/content')).bytes, FLOW_SOURCE, 'media and application retain the same physical root');
    assert.throws(() => writeLocalApiTokenFile(path.join(alias, 'token'), session.accessToken, other.dataRoot), { code: 'IRIS_API_TOKEN_FILE_INVALID' });
  }
  const corruptFile = path.join(main.dataRoot, 'flow-store/v0/runs', unstarted.run.id + '.json');
  const recordBytes = fs.readFileSync(corruptFile);
  fs.writeFileSync(corruptFile, 'PRIVATE_BROKEN_RUN');
  const conflict = await get(session, '/api/v0/runs/' + unstarted.run.id);
  assert.equal(conflict.response.status, 409); assert(!conflict.bytes.includes('PRIVATE_BROKEN_RUN')); assert(!conflict.bytes.includes(main.dataRoot));
  fs.writeFileSync(corruptFile, recordBytes);
  fs.writeFileSync(config, 'PRIVATE_BROKEN_CONFIG');
  const configError = await get(session, '/api/v0/models'); assert.equal(configError.response.status, 500); assert(!configError.bytes.includes('PRIVATE_BROKEN_CONFIG'));
  fs.writeFileSync(config, configBytes);

  const writer = createCoreRuntime({ dataRoot: main.dataRoot }); writer.start();
  let largeId;
  try { const artifact = await writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, { kind: 'text', mediaType: 'text/plain', bytes: Buffer.from('PRIVATE_TEXT_NOT_IMAGE') }));
    assert.equal((await get(session, '/api/v0/artifacts/' + artifact.id + '/content')).response.status, 415);
    const oversized = await writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, { kind: 'image', mediaType: 'image/png', bytes: FLOW_SOURCE }));
    const objectFile = path.join(main.dataRoot, 'artifact-store/v0/objects', oversized.id + '.png');
    const manifestFile = path.join(main.dataRoot, 'artifact-store/v0/manifests', oversized.id + '.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    manifest.size = 64 * 1024 * 1024 + 1; manifest.digest.value = 'f'.repeat(64);
    fs.truncateSync(objectFile, manifest.size); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.equal((await get(session, '/api/v0/artifacts/' + oversized.id + '/content')).response.status, 413, 'size limit precedes large content hashing');
    const corrupt = await writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, { kind: 'image', mediaType: 'image/png', bytes: FLOW_SOURCE }));
    const corruptObject = path.join(main.dataRoot, 'artifact-store/v0/objects', corrupt.id + '.png');
    const corruptBytes = fs.readFileSync(corruptObject); corruptBytes[corruptBytes.length - 1] ^= 1; fs.writeFileSync(corruptObject, corruptBytes);
    const invalidContent = await get(session, '/api/v0/artifacts/' + corrupt.id + '/content');
    assert.equal(invalidContent.response.status, 409, 'content hash is still mandatory before serving');
    assert.equal(invalidContent.response.headers.get('content-type'), 'application/json; charset=utf-8');
    const large = Buffer.alloc(10 * 1024 * 1024); FLOW_SOURCE.copy(large);
    largeId = (await writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, { kind: 'image', mediaType: 'image/png', bytes: large }))).id;
  } finally { await writer.dispose(); }
  const transferBefore = tree(main.dataRoot);
  const transferPath = '/api/v0/artifacts/' + largeId + '/content';
  const end = http.ServerResponse.prototype.end;
  let blockedResponse, idle, heldTransfers = 0;
  // Pausing a client does not stop a large OS socket buffer from accepting the whole body.
  // Hold this real response before completion; dispose must still close the actual sockets.
  http.ServerResponse.prototype.end = function (...args) {
    if (this.req.url === transferPath && this.statusCode === 200) {
      heldTransfers++;
      this.flushHeaders();
      return this;
    }
    return end.apply(this, args);
  };
  try {
    blockedResponse = await new Promise((resolve, reject) => {
      const request = http.get(session.origin + transferPath, {
        headers: { Authorization: 'Bearer ' + session.accessToken }
      }, response => { response.pause(); response.on('error', () => {}); resolve(response); });
      request.once('error', reject);
    });
    assert.equal(blockedResponse.statusCode, 200); assert.equal(heldTransfers, 1);
    assert.equal(service.snapshot().activeReads, 1, 'an unfinished transfer retains its bounded reader slot');
    const transferClosed = new Promise(resolve => blockedResponse.once('close', resolve));
    idle = net.connect(Number(new URL(session.origin).port), '127.0.0.1');
    await new Promise((resolve, reject) => { idle.once('connect', resolve); idle.once('error', reject); });
    const idleClosed = new Promise(resolve => idle.once('close', resolve));
    await service.dispose(); await service.closed;
    blockedResponse.destroy(); await transferClosed;
    await idleClosed;
  } finally {
    http.ServerResponse.prototype.end = end;
    blockedResponse?.destroy(); idle?.destroy();
  }
  assert.equal(service.snapshot().state, 'closed'); assert.equal(service.snapshot().activeReads, 0);
  assert.deepEqual(await service.dispose(), service.snapshot());
  assert.deepEqual(tree(main.dataRoot), transferBefore, 'aborting an active transfer never writes Core');
  await assert.rejects(fetch(session.origin + '/api/v0/session'));
  console.log('local API: authenticated read routes, Core zero-write, DTO privacy, media bytes, isolation, lifecycle and token file OK');
} finally {
  for (const service of apis) await service.dispose();
  for (const app of apps) await app.dispose();
}
