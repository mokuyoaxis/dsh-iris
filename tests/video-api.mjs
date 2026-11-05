import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createCoreArtifact } from '../lib/core-artifacts.js';
import { MAX_VIDEO_BYTES } from '../lib/video-flow-input.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { createDshServiceBridge } from '../lib/dsh-service-bridge.js';
import { VIDEO_MODEL, VIDEO_MP4, videoFlowFixture } from './fixtures/video-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-video-api'), dataRoot = path.join(root, 'core'), fixture = videoFlowFixture();
const app = createApplicationRuntime({ dataRoot, ...fixture }), services = [], children = [];
const uuid = () => crypto.randomUUID(), config = path.join(root, 'providers.json');
fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'video-fixture', enabled: true, apiKey: 'VIDEO_PRIVATE_KEY_MARKER',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
  models: ['text-video', 'wan-s2v', 'wan2.6-i2v', 'wan2.6-r2v'].map(id => ({ id, capabilities: ['video-gen'] })) }],
  assignments: { 'video-gen': [VIDEO_MODEL, 'video-fixture::wan-s2v', 'video-fixture::wan2.6-i2v', 'video-fixture::wan2.6-r2v'] } }), { mode: 0o600 });
let api, session;
async function json(route, value, { token = session.accessToken, method = value === undefined ? 'GET' : 'POST', key } = {}) {
  const response = await fetch(session.origin + route, { method, headers: { Authorization: 'Bearer ' + token,
    ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
  return { status: response.status, body: await response.json() };
}
const ok = async (...args) => { const value = await json(...args); assert(value.status < 300, JSON.stringify(value)); return value.body; };
async function waitOperation(id) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const { operation } = await ok('/api/v0/operations/' + id); if (!['queued', 'running'].includes(operation.state)) return operation; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('video Operation timeout');
}
async function grant(capabilities, scopes = ['read', 'create', 'execute', 'stop'], version = '2025-11-25', tools) {
  const created = await ok('/api/v0/connection-management/connections', { key: uuid(), label: 'controlled-video', capabilities, scopes, ...(tools ? { tools } : {}) });
  const entry = await ok('/api/v0/connection-management/connections/' + created.connectionId + '/export', { transport: 'http', format: 'entry' });
  const token = entry.configuration.headers.Authorization.slice(7), remote = httpMcpClient(session.origin, token, { version }); await remote.initialize();
  const profile = (await ok('/api/v0/connection-management/connections')).connections.find(item => item.connectionId === created.connectionId);
  return { created: { ...created, revision: profile.revision }, token, remote };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  assert.equal(new URL(input instanceof Request ? input.url : input).hostname, '127.0.0.1', 'no provider network');
  return originalFetch(input, options);
};
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { video: true });
  const options = { dataRoot, providerConfigPath: config, serveWorkbench: true, allowExecution: true,
    allowConnectionManagement: true, connectionStore: path.join(root, 'connections'), allowMcp: true, executionPorts: fixture };
  api = createLocalReadApi(options); services.push(api); session = await api.start();
  const status = await ok('/api/v0/session'); assert.equal(status.video, true); assert.equal(status.audio, true); assert(status.operations.includes('videos.create'));
  const models = await ok('/api/v0/video-models'); assert.deepEqual(models.models.map(model => model.modelRef), [VIDEO_MODEL]);
  assert(!JSON.stringify(models).includes('PRIVATE_KEY')); assert(!JSON.stringify(models).includes('aliyuncs'));
  const catalog = await ok('/api/v0/connection-management/catalog'); assert.equal(catalog.groups.length, 5);
  assert.deepEqual(catalog.media.find(item => item.id === 'video').capabilities, ['video-generate']);
  const creationKey = uuid(), input = { modelRef: VIDEO_MODEL, prompt: 'A purple iris in the breeze', duration: 2 };
  const created = await ok('/api/v0/videos', input, { key: creationKey }); assert.equal(fixture.calls.submit.length, 0);
  assert.equal((await ok('/api/v0/videos', input, { key: creationKey })).flow.id, created.flow.id);
  assert.equal((await json('/api/v0/videos', { ...input, duration: 3 }, { key: creationKey })).status, 409);
  const executeKey = uuid(), operation = await ok('/api/v0/runs/' + created.flow.id + '/continue', { expectedRevision: created.flow.revision }, { key: executeKey });
  assert.equal((await waitOperation(operation.operation.id)).state, 'succeeded');
  const accepted = await ok('/api/v0/runs/' + created.flow.id); assert.equal(accepted.status, 'running');
  await api.dispose(); api = createLocalReadApi(options); services.push(api); session = await api.start();
  assert.equal(fixture.calls.submit.length, 1, 'restart never submits');
  assert.equal((await ok('/api/v0/creation-requests?kind=video-create&key=' + creationKey)).result.runId, accepted.id);
  assert.equal((await ok('/api/v0/runs/' + created.flow.id + '/continue', { expectedRevision: created.flow.revision }, { key: executeKey })).operation.id, operation.operation.id);
  const observed = await ok('/api/v0/runs/' + accepted.id + '/continue', { expectedRevision: accepted.revision }, { key: uuid() });
  assert.equal((await waitOperation(observed.operation.id)).state, 'succeeded');
  const saved = await ok('/api/v0/runs/' + accepted.id); assert.equal(saved.status, 'ready'); assert.equal(saved.task.id, accepted.task.id);
  for (const route of ['/api/v0/artifacts/' + saved.output.artifactId + '/video', '/api/v0/runs/' + saved.id + '/download']) {
    const response = await fetch(session.origin + route, { headers: { Authorization: 'Bearer ' + session.accessToken } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'video/mp4');
    if (route.endsWith('/download')) assert.match(response.headers.get('content-disposition'), /\.mp4"$/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), VIDEO_MP4);
  }
  assert.equal((await json('/api/v0/artifacts/' + saved.output.artifactId + '/content')).status, 415);
  assert.equal((await json('/api/v0/artifacts/' + saved.output.artifactId + '/audio')).status, 415);
  assert.equal((await json('/api/v0/videos', { ...input, duration: '2' }, { key: uuid() })).status, 400);
  assert.equal((await json('/api/v0/videos', { ...input, firstFramePath: '/private/image' }, { key: uuid() })).status, 400);
  const oversized = await app.run('writer', runtime => runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot,
    { bytes: Buffer.alloc(MAX_VIDEO_BYTES + 1), kind: 'generated-video', mediaType: 'video/mp4', metadata: {}, relations: [] })));
  assert.equal((await json('/api/v0/artifacts/' + oversized.id + '/video')).status, 413, 'bounded media rejects before reading/sending the payload');
  assert.equal((await ok('/api/v0/runs?kind=image')).total, 0); assert.equal((await ok('/api/v0/runs?kind=video')).total, 1);
  const selected = await grant(['video-generate']);
  const tools = (await selected.remote.request('tools/list')).tools.map(tool => tool.name);
  assert(tools.includes('iris_core_create_video')); assert(!tools.includes('iris_core_audio')); assert(!tools.includes('iris_core_image'));
  const templates = await selected.remote.request('resources/templates/list', {});
  assert.equal(templates.resourceTemplates[0].uriTemplate, 'iris://video/{artifactId}');
  const resource = await selected.remote.call('iris_core_video', { artifactId: saved.output.artifactId });
  assert.equal(resource.content[0].type, 'resource_link'); assert.equal(resource.content[0].mimeType, 'video/mp4');
  const uri = resource.content[0].uri, bytes = await selected.remote.request('resources/read', { uri });
  assert.deepEqual(Buffer.from(bytes.contents[0].blob, 'base64'), VIDEO_MP4);
  await assert.rejects(selected.remote.request('resources/read', { uri: uri + '?path=/private' }));
  assert.equal((await selected.remote.call('iris_core_create_video', { key: uuid(), ...input, duration: '2' })).isError, true);
  const skill = await ok('/api/v0/connection-management/connections/' + selected.created.connectionId + '/skill', {});
  assert(skill.preview.includes('Text to video · 文生视频')); assert(skill.preview.includes('resources/read')); assert(!skill.preview.includes('undefined'));
  const imageOnly = await grant(['image-edit'], ['read']);
  assert(!(await imageOnly.remote.request('tools/list')).tools.some(tool => tool.name === 'iris_core_video'));
  await assert.rejects(imageOnly.remote.request('resources/templates/list', {}));
  assert.equal((await imageOnly.remote.call('iris_core_run', { runId: saved.id })).isError, true);
  assert.equal((await json('/api/v0/artifacts/' + saved.output.artifactId + '/video', undefined, { token: imageOnly.token })).status >= 400, true);
  const limited = await grant(['video-generate'], ['read'], '2025-11-25', ['iris_core_run']);
  await assert.rejects(limited.remote.request('resources/read', { uri }));
  for (const version of ['2025-11-25', '2026-07-28']) {
    const modern = await grant(['video-generate'], ['read'], version);
    const link = await modern.remote.call('iris_core_video', { artifactId: saved.output.artifactId }); assert.equal(link.content[0].uri, uri);
    const payload = await modern.remote.request('resources/read', { uri }); assert.deepEqual(Buffer.from(payload.contents[0].blob, 'base64'), VIDEO_MP4);
    const exported = await ok('/api/v0/connection-management/connections/' + modern.created.connectionId + '/export', { transport: 'stdio', format: 'entry' });
    const stdio = stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read', { version, launch: exported.configuration }); children.push(stdio);
    await stdio.initialize();
    assert.equal((await stdio.call('iris_core_video', { artifactId: saved.output.artifactId })).content[0].uri, uri);
    assert.deepEqual(Buffer.from((await stdio.request('resources/read', { uri })).contents[0].blob, 'base64'), VIDEO_MP4);
    await ok('/api/v0/connection-management/connections/' + modern.created.connectionId + '/update', { expectedRevision: modern.created.revision,
      label: 'video read removed', capabilities: ['video-generate'], scopes: ['read'], tools: ['iris_core_run'] });
    await assert.rejects(stdio.request('resources/read', { uri }), 'existing stdio resource does not retain a removed read grant');
    assert.equal((await stdio.close()).status, 0);
    await assert.rejects(modern.remote.request('resources/read', { uri }));
  }
  await ok('/api/v0/connection-management/connections/' + selected.created.connectionId + '/revoke', { expectedRevision: selected.created.revision });
  await assert.rejects(selected.remote.request('resources/read', { uri }));
  assert.equal(fixture.calls.submit.length, 1); assert.equal(fixture.calls.poll.length, 1, 'all media reads stay local');
  await api.dispose();
  const createOnly = createLocalReadApi({ dataRoot, providerConfigPath: config, allowLocalWrites: true }); services.push(createOnly); session = await createOnly.start();
  const intent = await ok('/api/v0/videos', input, { key: uuid() }); assert.equal(intent.flow.status, 'not_started'); assert.equal(fixture.calls.submit.length, 1);
  const nativePair = createConnectionPair({ dataRoot, directory: path.join(root, 'native-pair'), origin: 'http://127.0.0.1:1',
    harnessKind: 'dsh', label: 'native-video-boundary', scopes: ['read'], capabilities: ['video-generate'] });
  const nativeApi = createLocalReadApi({ dataRoot, connectionsFile: nativePair.serverFile }); services.push(nativeApi); const nativeSession = await nativeApi.start();
  fs.writeFileSync(nativePair.clientFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(nativePair.clientFile)), origin: nativeSession.origin }), { mode: 0o600 });
  let hostCalls = 0;
  const native = createDshServiceBridge({ connectionFile: nativePair.clientFile, getHost() { hostCalls++; return {}; } });
  try { await assert.rejects(native.start(), { code: 'IRIS_DSH_VIDEO_NOT_SUPPORTED' }); assert.equal(hostCalls, 0); }
  finally { await native.dispose(); }
  console.log('video API/MCP: HTTP+stdio SDK 2025/2026, standard video resources, original Task/restart/UUID, byte identity, scope/tool/revoke isolation and create-only mode OK');
} finally { for (const child of children) await child.kill(); for (const service of services.reverse()) await service.dispose(); await app.dispose(); globalThis.fetch = originalFetch; }
