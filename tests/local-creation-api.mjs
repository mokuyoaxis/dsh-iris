import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { listCreationRequests } from '../lib/creation-request-store.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-creation-api');
const dataRoot = path.join(root, 'core'), app = createApplicationRuntime({ dataRoot });
const servers = [], apis = [];
const api = options => { const service = createLocalReadApi(options); apis.push(service); return service; };
const key = () => crypto.randomUUID();
let providerRequests = 0;
const provider = http.createServer((_req, res) => { providerRequests++; res.writeHead(500); res.end(); }); servers.push(provider);
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const config = path.join(root, 'providers.json'), privateMarker = 'TEST_CONFIG_SECRET_NEVER_PERSIST_IN_CORE';
const initialConfig = JSON.stringify({ providers: [{ id: 'local', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
  apiKey: privateMarker, mediaProtocol: 'openai-chat-images', models: [{ id: 'edit', capabilities: ['image-gen'] }] }],
  assignments: { 'image-gen': ['local::edit'] } });
fs.writeFileSync(config, initialConfig, { mode: 0o600 });
async function post(session, route, bytes, { token = session.accessToken, requestKey = key(), type = 'application/json', headers = {} } = {}) {
  const response = await fetch(session.origin + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token,
    'Idempotency-Key': requestKey, 'Content-Type': type, ...headers }, body: bytes });
  const text = await response.text();
  assert(!text.includes(session.accessToken)); assert(!text.includes(privateMarker)); assert(!text.includes(dataRoot));
  return { response, body: text ? JSON.parse(text) : null };
}
async function streamed(session, { contentLength, size, chunks = 1 }) {
  return new Promise((resolve, reject) => {
    const request = http.request(session.origin + '/api/v0/images', { method: 'POST', headers: {
      Authorization: 'Bearer ' + session.accessToken, 'Idempotency-Key': key(), 'Content-Type': 'image/png',
      ...(contentLength ? { 'Content-Length': contentLength } : {})
    } }, response => {
      let body = ''; response.on('data', data => { body += data; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    for (let i = 0; i < chunks; i++) request.write(Buffer.alloc(size));
    request.end();
  });
}

try {
  await app.execute('flow.init', {});
  await assert.rejects(api({ dataRoot, allowLocalWrites: true }).start(), { code: 'IRIS_CREATION_ROOT_REQUIRED' });
  await app.execute('creation.init', {});
  const readonly = api({ dataRoot }), readSession = await readonly.start();
  assert.equal((await post(readSession, '/api/v0/images', FLOW_SOURCE, { type: 'image/png' })).response.status, 405);
  assert.equal(listCreationRequests(dataRoot).length, 0);
  const service = api({ dataRoot, providerConfigPath: config, allowLocalWrites: true }), session = await service.start();
  const auth = { Authorization: 'Bearer ' + session.accessToken };
  const info = await (await fetch(session.origin + '/api/v0/session', { headers: auth })).json();
  assert.equal(info.readOnly, false); assert(info.operations.includes('images.create')); assert(info.operations.includes('runs.create'));
  assert.equal(info.limits.uploadBytes, 20 * 1024 * 1024);
  const before = listCreationRequests(dataRoot).length;
  for (const extra of [{ Origin: 'null' }, { Origin: 'https://outside.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await post(session, '/api/v0/images', FLOW_SOURCE, { type: 'image/png', headers: extra })).response.status, 403);
  }
  assert.equal((await post(session, '/api/v0/images', FLOW_SOURCE, { type: 'image/png', token: 'x'.repeat(43) })).response.status, 401);
  assert.equal((await post(session, '/api/v0/images?path=/tmp/file', FLOW_SOURCE, { type: 'image/png' })).response.status, 400);
  assert.equal((await post(session, '/api/v0/images', FLOW_SOURCE, { type: 'image/png', requestKey: 'not-a-key' })).response.status, 400);
  assert.equal((await post(session, '/api/v0/images', FLOW_SOURCE, { type: 'image/svg+xml' })).response.status, 415);
  assert.equal((await post(session, '/api/v0/images', FLOW_SOURCE, { type: 'image/jpeg' })).response.status, 415);
  assert.equal((await post(session, '/api/v0/images', 'broken png', { type: 'image/png' })).response.status, 400);
  assert.equal((await post(session, '/api/v0/runs', '{broken')).response.status, 400);
  assert.equal((await post(session, '/api/v0/runs', Buffer.from([0xff]))).response.status, 400);
  assert.equal((await post(session, '/api/v0/runs', ' '.repeat(65537))).response.status, 413);
  assert.equal((await streamed(session, { contentLength: String(20 * 1024 * 1024 + 1), size: 0 })).status, 413);
  assert.equal((await streamed(session, { chunks: 21, size: 1024 * 1024 })).status, 413);
  assert.equal(listCreationRequests(dataRoot).length, before, 'invalid or untrusted HTTP never consumes a Key');

  const uploadKey = key(), uploaded = await post(session, '/api/v0/images', FLOW_SOURCE, { type: 'image/png', requestKey: uploadKey });
  assert.equal(uploaded.response.status, 201); assert.equal(uploaded.body.idempotentReplay, false);
  assert.deepEqual(Object.keys(uploaded.body.artifact).sort(), ['artifactId', 'height', 'mediaType', 'size', 'width']);
  const source = uploaded.body.artifact.artifactId;
  const replay = await post(session, '/api/v0/images', FLOW_SOURCE, { type: 'image/png', requestKey: uploadKey });
  assert.equal(replay.response.status, 200); assert(replay.body.idempotentReplay); assert.equal(replay.body.artifact.artifactId, source);
  const altered = Buffer.concat([FLOW_SOURCE, Buffer.from([0])]);
  assert.equal((await post(session, '/api/v0/images', altered, { type: 'image/png', requestKey: uploadKey })).response.status, 409);
  const createKey = key(), input = { sourceArtifactId: source, modelRef: 'local::edit', prompt: 'Keep the subject' };
  const created = await post(session, '/api/v0/runs', JSON.stringify(input), { requestKey: createKey });
  assert.equal(created.response.status, 201); assert.equal(created.body.flow.status, 'not_started'); assert.equal(created.body.flow.task, null);
  const runId = created.body.flow.id;
  const repeated = await Promise.all(Array.from({ length: 4 }, () => post(session, '/api/v0/runs', JSON.stringify(input), { requestKey: createKey })));
  assert(repeated.every(item => item.response.status === 200 && item.body.flow.id === runId));
  assert.equal((await post(session, '/api/v0/runs', JSON.stringify({ ...input, prompt: 'Different' }), { requestKey: createKey })).response.status, 409);
  assert.equal((await post(session, '/api/v0/runs', JSON.stringify({ ...input, runId: 'user-selected-id' }))).response.status, 400);
  assert.equal((await post(session, '/api/v0/runs/' + runId + '/continue', '{}')).response.status, 404);
  assert.equal(listCoreTasks(dataRoot).total, 0); assert.equal(providerRequests, 0);
  const media = await fetch(session.origin + '/api/v0/artifacts/' + source + '/content', { headers: auth });
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), FLOW_SOURCE);

  // Same request is independent of current Provider configuration, across Token/port/process instances.
  fs.writeFileSync(config, 'CONFIG_NOW_UNREADABLE');
  assert.equal((await post(session, '/api/v0/runs', JSON.stringify(input), { requestKey: createKey })).body.flow.id, runId);
  assert.equal((await post(session, '/api/v0/runs', JSON.stringify(input))).response.status, 500);
  await service.dispose();
  const restarted = api({ dataRoot, allowLocalWrites: true }), next = await restarted.start();
  assert.notEqual(next.accessToken, session.accessToken);
  assert.equal((await post(next, '/api/v0/runs', JSON.stringify(input), { requestKey: createKey, token: session.accessToken })).response.status, 401);
  assert.equal((await post(next, '/api/v0/runs', JSON.stringify(input), { requestKey: createKey })).body.flow.id, runId);
  assert.equal((await post(next, '/api/v0/images', FLOW_SOURCE, { type: 'image/png', requestKey: uploadKey })).body.artifact.artifactId, source);

  // One incomplete upload bounds memory and rejects another; closing it consumes no Key.
  const socket = net.connect(Number(new URL(next.origin).port), '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`POST /api/v0/images HTTP/1.1\r\nHost: ${new URL(next.origin).host}\r\nAuthorization: Bearer ${next.accessToken}\r\nIdempotency-Key: ${key()}\r\nContent-Type: image/png\r\nContent-Length: 1000\r\n\r\nx`);
  // An authenticated same-socket response cannot arrive before this first request; a short event loop turn lets the server receive its prefix.
  await new Promise(resolve => setTimeout(resolve, 30));
  const occupiedCount = listCreationRequests(dataRoot).length;
  assert.equal((await post(next, '/api/v0/images', FLOW_SOURCE, { type: 'image/png' })).response.status, 429);
  socket.destroy(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(listCreationRequests(dataRoot).length, occupiedCount);
  assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  assert.equal(providerRequests, 0);
  for (const file of fs.readdirSync(path.join(dataRoot, 'creation-requests/v0/requests'))) {
    const text = fs.readFileSync(path.join(dataRoot, 'creation-requests/v0/requests', file), 'utf8');
    for (const secret of [uploadKey, createKey, privateMarker, session.accessToken, next.accessToken, 'baseUrl']) assert(!text.includes(secret));
  }
  console.log('local creation HTTP: default read-only, explicit bounded writes, auth, validation, identity/restart replay, no Provider calls and upload cancellation OK');
} finally {
  for (const service of apis) await service.dispose();
  await app.dispose();
  for (const server of servers) await new Promise(resolve => server.close(resolve));
}
