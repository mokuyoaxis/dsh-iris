import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { createConnectionPair } from '../lib/core-connections.js';
import { createDshServiceBridge } from '../lib/dsh-service-bridge.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-vision-api'), dataRoot = path.join(root, 'core');
let calls = 0;
const provider = http.createServer(async (request, response) => {
  assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.method, 'POST');
  const parts = []; for await (const part of request) parts.push(part);
  const input = JSON.parse(Buffer.concat(parts)); assert.equal(input.model, 'vision'); assert.equal(input.stream, true); calls++;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '紫色鸢尾 <script>data</script>' }, finish_reason: null }] })
    + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const config = path.join(root, 'providers.json');
fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'vision-fixture', enabled: true, type: 'openai', apiKey: 'PRIVATE_VISION_API_KEY',
  baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1', models: [{ id: 'vision', capabilities: ['vision'] }] }],
  assignments: { vision: ['vision-fixture::vision'] } }), { mode: 0o600 });
const app = createApplicationRuntime({ dataRoot });
let api, session, stdio, native;
const uuid = () => crypto.randomUUID();
async function json(route, value, key) {
  const response = await fetch(session.origin + route, { method: value === undefined ? 'GET' : 'POST', headers: {
    Authorization: 'Bearer ' + session.accessToken, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(key ? { 'Idempotency-Key': key } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const body = await response.json(); assert(response.status < 300, JSON.stringify(body)); return body;
}
async function grant(capabilities, scopes = ['read', 'create', 'execute', 'stop'], tools) {
  const created = await json('/api/v0/connection-management/connections', { key: uuid(), label: 'vision controlled', capabilities, scopes, ...(tools ? { tools } : {}) });
  const entry = await json('/api/v0/connection-management/connections/' + created.connectionId + '/export', { transport: 'http', format: 'entry' });
  const remote = httpMcpClient(session.origin, entry.configuration.headers.Authorization.slice(7)); await remote.initialize(); remote.connectionId = created.connectionId; return remote;
}
const value = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(item => item.type === 'text').text); };
async function wait(id) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await json('/api/v0/operations/' + id);
    if (!['queued', 'running'].includes(result.operation.state)) { assert.equal(result.operation.state, 'succeeded'); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('vision operation timeout');
}
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { vision: true }); await app.dispose();
  const options = { dataRoot, providerConfigPath: config, serveWorkbench: true, allowExecution: true, allowMcp: true,
    allowConnectionManagement: true, connectionStore: path.join(root, 'connections') };
  api = createLocalReadApi(options); session = await api.start();
  assert.equal((await json('/api/v0/session')).vision, true);
  const catalog = await json('/api/v0/connection-management/catalog'); assert.equal(catalog.groups.length, 7);
  assert.deepEqual(catalog.media.find(item => item.id === 'vision').capabilities, ['vision', 'ocr']);
  const vision = await grant(['vision']), ocr = await grant(['ocr']), legacy = await grant(['image-edit']);
  const tools = (await vision.request('tools/list')).tools.map(item => item.name);
  assert(tools.includes('iris_core_create_vision')); assert(!tools.includes('iris_core_create_ocr'));
  assert(!(await legacy.request('tools/list')).tools.some(item => item.name.includes('vision') || item.name.includes('ocr')));
  assert.deepEqual(value(await vision.call('iris_core_vision_models', {})).models, [{ modelRef: 'vision-fixture::vision', displayName: 'vision' }]);
  const source = value(await vision.call('iris_core_import_image', { key: uuid(), imageBase64: FLOW_SOURCE.toString('base64'), mediaType: 'image/png' })).artifact;
  const input = { sourceArtifactId: source.artifactId, modelRef: 'vision-fixture::vision', question: '描述图片' }, key = uuid();
  const created = value(await vision.call('iris_core_create_vision', { key, ...input })); assert.equal(calls, 0);
  assert.equal(value(await vision.call('iris_core_create_vision', { key, ...input })).flow.id, created.flow.id);
  await assert.rejects(legacy.call('iris_core_create_vision', { key: uuid(), ...input }), { rpcCode: -32602 });
  assert.equal((await ocr.call('iris_core_run', { runId: created.flow.id })).isError, true);
  const executionKey = uuid(), operation = value(await vision.call('iris_core_continue', { key: executionKey, runId: created.flow.id, expectedRevision: created.flow.revision }));
  await wait(operation.operation.id); assert.equal(calls, 1);
  const saved = value(await vision.call('iris_core_run', { runId: created.flow.id })); assert.equal(saved.status, 'ready');
  assert.equal(saved.input.question, input.question); assert.equal(saved.comparison, null);
  const text = value(await vision.call('iris_core_vision_text', { artifactId: saved.output.artifactId })); assert.match(text.text, /<script>data<\/script>/);
  assert.equal((await legacy.call('iris_core_image', { artifactId: saved.output.artifactId })).isError, true);
  assert.equal((await ocr.call('iris_core_vision_text', { artifactId: saved.output.artifactId })).isError, true);
  const sourceOcr = value(await ocr.call('iris_core_import_image', { key: uuid(), imageBase64: FLOW_SOURCE.toString('base64'), mediaType: 'image/png' })).artifact;
  const draft = value(await ocr.call('iris_core_create_ocr', { key: uuid(), sourceArtifactId: sourceOcr.artifactId, modelRef: input.modelRef }));
  assert.equal(draft.flow.plan.totalChunks, 1); assert.equal(calls, 1);
  const runOcr = value(await ocr.call('iris_core_continue', { key: uuid(), runId: draft.flow.id, expectedRevision: draft.flow.revision }));
  await wait(runOcr.operation.id);
  const savedOcr = value(await ocr.call('iris_core_run', { runId: draft.flow.id }));
  assert.equal(savedOcr.ocr.status, 'complete');
  const report = value(await ocr.call('iris_core_ocr_result', { artifactId: savedOcr.report.artifactId }));
  assert.equal(report.status, 'complete'); assert.equal(report.invocations, 1);
  const exported = await json('/api/v0/connection-management/connections/' + ocr.connectionId + '/export', { transport: 'stdio', format: 'entry' });
  stdio = stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read,create,execute,stop', { version: '2026-07-28', launch: exported.configuration });
  await stdio.initialize();
  assert.equal(value(await stdio.call('iris_core_ocr_result', { artifactId: savedOcr.report.artifactId })).status, 'complete');
  assert.match(value(await stdio.call('iris_core_vision_text', { artifactId: savedOcr.output.artifactId })).text, /紫色鸢尾/);
  await stdio.close();
  assert.equal((await vision.call('iris_core_vision_text', { artifactId: savedOcr.output.artifactId })).isError, true);
  assert(!JSON.stringify([saved, savedOcr, report]).includes('PRIVATE_'));
  assert.equal((await json('/api/v0/runs?kind=image')).total, 0); assert.equal((await json('/api/v0/runs?kind=ocr')).total, 1);
  await api.dispose(); api = createLocalReadApi(options); session = await api.start();
  const lookup = await json('/api/v0/operations?key=' + executionKey); assert.equal(lookup.operation.id, operation.operation.id);
  assert.equal((await json('/api/v0/runs/' + saved.id)).task.id, saved.task.id); assert.equal(calls, 2);
  await api.dispose(); api = createLocalReadApi({ dataRoot, providerConfigPath: config, allowLocalWrites: true }); session = await api.start();
  const draftOnly = await json('/api/v0/visions', input, uuid()); assert.equal(draftOnly.flow.status, 'not_started'); assert.equal(calls, 2);
  for (const invalid of [{ maxInvocations: 33 }, { maxDimension: 0 }, { chunkHeight: 0 }, { sourcePath: '/private/image.png' }]) {
    const response = await fetch(session.origin + '/api/v0/ocrs', { method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken,
      'Content-Type': 'application/json', 'Idempotency-Key': uuid() }, body: JSON.stringify({ sourceArtifactId: source.artifactId, modelRef: input.modelRef, ...invalid }) });
    assert.equal(response.status, 400); await response.arrayBuffer();
  }
  await api.dispose();
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'native-pair'), origin: 'http://127.0.0.1:1', harnessKind: 'dsh', label: 'vision bridge fixture',
    scopes: ['read'], capabilities: ['vision', 'ocr'] });
  api = createLocalReadApi({ dataRoot, connectionsFile: pair.serverFile }); session = await api.start();
  fs.writeFileSync(pair.clientFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(pair.clientFile)), origin: session.origin }), { mode: 0o600 });
  const registered = new Map();
  native = createDshServiceBridge({ connectionFile: pair.clientFile, getHost: () => ({ id: 'vision-host-fixture', ports: {
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } } } }) });
  await native.start();
  assert.equal((await registered.get('iris_core_ocr_result').execute({ artifactId: savedOcr.report.artifactId })).value.status, 'complete');
  assert.match((await registered.get('iris_core_vision_text').execute({ artifactId: saved.output.artifactId })).value.text, /紫色鸢尾/);
  assert(!registered.has('iris_core_create_ocr')); assert.equal(calls, 2);
  console.log('PASS Core-owned HTTP SSE, API/MCP vision+OCR, isolated explicit grants, durable text/report, UUID recovery and zero restart POSTs');
} finally { await native?.dispose(); await stdio?.kill(); await api?.dispose(); await app.dispose(); await new Promise(resolve => provider.close(resolve)); }
