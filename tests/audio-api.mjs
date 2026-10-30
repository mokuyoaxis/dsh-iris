import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { AUDIO_WAV, TRANSCRIPT, SPEECH_MODEL, TRANSCRIBE_MODEL, audioFlowFixture } from './fixtures/audio-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { createConnectionPair } from '../lib/core-connections.js';
import { createDshServiceBridge } from '../lib/dsh-service-bridge.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-audio-api'), dataRoot = path.join(root, 'core'), fixture = audioFlowFixture();
const app = createApplicationRuntime({ dataRoot, ...fixture }), services = [], remotes = [], children = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  assert.equal(new URL(input instanceof Request ? input.url : input).hostname, '127.0.0.1', 'no provider network is allowed in this test');
  return originalFetch(input, options);
};
const providerConfigPath = path.join(root, 'providers.json');
fs.writeFileSync(providerConfigPath, JSON.stringify({ providers: [{ id: 'audio-fixture', enabled: true, apiKey: 'AUDIO_PRIVATE_KEY_MARKER',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope', models: [{ id: 'speech', capabilities: ['tts'] }, { id: 'transcribe', capabilities: ['transcribe'] }] }],
  assignments: { tts: [SPEECH_MODEL], transcribe: [TRANSCRIBE_MODEL] } }), { mode: 0o600 });
const uuid = () => crypto.randomUUID();
let session, api;
async function json(route, value, { token = session.accessToken, headers = {}, method = value === undefined ? 'GET' : 'POST', key } = {}) {
  const response = await fetch(session.origin + route, { method, headers: { Authorization: 'Bearer ' + token,
    ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function waitOperation(id) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const response = await json('/api/v0/operations/' + id); assert.equal(response.status, 200);
    if (!['queued', 'running'].includes(response.body.operation.state)) return response.body.operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('audio operation timeout');
}
const ok = async (route, value, options) => { const result = await json(route, value, options); assert(result.status < 300, result.body.error?.code); return result.body; };
async function connection(capabilities, scopes, version = '2025-11-25') {
  const created = await ok('/api/v0/connection-management/connections', { key: uuid(), label: capabilities.join('+'), capabilities, scopes });
  const entry = await ok('/api/v0/connection-management/connections/' + created.connectionId + '/export', { transport: 'http', format: 'entry' });
  const remote = httpMcpClient(session.origin, entry.configuration.headers.Authorization.slice(7), { version }); remotes.push(remote); await remote.initialize();
  return { remote, created, token: entry.configuration.headers.Authorization.slice(7) };
}
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { audio: true });
  const options = { dataRoot, providerConfigPath, serveWorkbench: true, allowExecution: true, allowSelection: true,
    allowConnectionManagement: true, connectionStore: path.join(root, 'connections'), allowMcp: true, executionPorts: fixture };
  api = createLocalReadApi(options); services.push(api); session = await api.start();
  const status = await ok('/api/v0/session'); assert.equal(status.audio, true); assert(status.operations.includes('speeches.create'));
  const models = await ok('/api/v0/audio-models'); assert.deepEqual(models.models.map(model => model.capability).sort(), ['transcribe', 'tts']);
  assert(!JSON.stringify(models).includes('AUDIO_PRIVATE_KEY_MARKER')); assert(!JSON.stringify(models).includes('aliyuncs.com'));
  const catalog = await ok('/api/v0/connection-management/catalog'); assert.equal(catalog.groups.length, 4);
  assert.deepEqual(catalog.media.find(item => item.id === 'tts').capabilities, ['tts']);
  const input = { modelRef: SPEECH_MODEL, text: 'Hello Iris', voice: 'Cherry' }, creationKey = uuid();
  const created = await ok('/api/v0/speeches', input, { key: creationKey });
  assert.equal(created.flow.status, 'not_started'); assert.equal(fixture.calls.submit.length, 0);
  assert.equal((await ok('/api/v0/speeches', input, { key: creationKey })).flow.id, created.flow.id);
  assert.equal((await json('/api/v0/speeches', { ...input, text: 'different' }, { key: creationKey })).status, 409);
  const executeKey = uuid();
  const accepted = await ok('/api/v0/runs/' + created.flow.id + '/continue', { expectedRevision: created.flow.revision }, { key: executeKey });
  await waitOperation(accepted.operation.id);
  const saved = await ok('/api/v0/runs/' + created.flow.id); assert.equal(saved.status, 'ready');
  assert.equal((await ok('/api/v0/runs/' + created.flow.id + '/continue', { expectedRevision: created.flow.revision }, { key: executeKey })).operation.id, accepted.operation.id);
  assert.equal(fixture.calls.submit.length, 1);
  const audio = await fetch(session.origin + '/api/v0/artifacts/' + saved.output.artifactId + '/audio', { headers: { Authorization: 'Bearer ' + session.accessToken } });
  assert.equal(audio.status, 200); assert.equal(audio.headers.get('content-type'), 'audio/wav'); assert.deepEqual(Buffer.from(await audio.arrayBuffer()), AUDIO_WAV);
  const download = await fetch(session.origin + '/api/v0/runs/' + saved.id + '/download', { headers: { Authorization: 'Bearer ' + session.accessToken } });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /\.wav"$/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), AUDIO_WAV);
  assert.equal((await json('/api/v0/artifacts/' + saved.output.artifactId + '/content')).status, 415, 'image path stays image-only');
  assert.equal((await json('/api/v0/artifacts/' + saved.output.artifactId + '/text')).status, 415);
  assert.equal((await json('/api/v0/speeches', input, { key: uuid(), headers: { Origin: 'https://outside.invalid' } })).status, 403);
  const speech = await connection(['tts'], ['read', 'create', 'execute', 'stop']);
  const list = (await speech.remote.request('tools/list')).tools.map(tool => tool.name);
  assert(list.includes('iris_core_create_speech')); assert(!list.includes('iris_core_create_transcription')); assert(!list.includes('iris_core_image'));
  const delivered = await speech.remote.call('iris_core_audio', { artifactId: saved.output.artifactId });
  assert.equal(delivered.content[0].type, 'audio'); assert.deepEqual(Buffer.from(delivered.content[0].data, 'base64'), AUDIO_WAV);
  const ttsModels = await speech.remote.call('iris_core_audio_models', {}); assert(ttsModels.structuredContent.models.every(model => model.capability === 'tts'));
  const asr = await connection(['transcribe'], ['read', 'create', 'execute']);
  const imported = await asr.remote.call('iris_core_import_audio', { key: uuid(), audioBase64: AUDIO_WAV.toString('base64'), mediaType: 'audio/wav' });
  const asrRun = (await asr.remote.call('iris_core_create_transcription', { key: uuid(), modelRef: TRANSCRIBE_MODEL, sourceArtifactId: imported.structuredContent.artifact.artifactId })).structuredContent.flow;
  const first = (await asr.remote.call('iris_core_continue', { key: uuid(), runId: asrRun.id, expectedRevision: asrRun.revision })).structuredContent.operation;
  await waitOperation(first.id);
  const original = (await asr.remote.call('iris_core_run', { runId: asrRun.id })).structuredContent;
  const second = (await asr.remote.call('iris_core_continue', { key: uuid(), runId: original.id, expectedRevision: original.revision })).structuredContent.operation;
  await waitOperation(second.id);
  const result = (await asr.remote.call('iris_core_run', { runId: asrRun.id })).structuredContent;
  assert.equal(result.status, 'ready'); assert.equal(result.task.id, original.task.id);
  const text = await asr.remote.call('iris_core_transcript', { artifactId: result.output.artifactId });
  assert.equal(text.structuredContent.text, TRANSCRIPT.toString());
  assert.equal((await speech.remote.call('iris_core_audio', { artifactId: imported.structuredContent.artifact.artifactId })).isError, true);
  assert.equal((await speech.remote.call('iris_core_run', { runId: asrRun.id })).isError, true, 'speech grant cannot read a transcription');
  const imageOnly = await connection(['image-edit'], ['read']);
  assert.equal((await imageOnly.remote.request('tools/list')).tools.length, 8);
  assert.equal((await json('/api/v0/speeches', input, { token: imageOnly.token, key: uuid() })).status, 401);
  const visible = await asr.remote.call('iris_core_runs', {}); assert(visible.structuredContent.runs.every(run => run.recipe === 'transcribe/v0'));
  assert.equal(fixture.calls.submit.length, 2); assert.equal(fixture.preparation.length, 1);
  const skill = await ok('/api/v0/connection-management/connections/' + asr.created.connectionId + '/skill', {});
  assert(skill.preview.includes('Voice and transcription · 语音合成与音频转写')); assert(skill.preview.includes('iris_core_transcript'));
  assert(!skill.preview.includes('undefined')); assert(!skill.preview.includes('iris_core_create_speech')); assert(!skill.preview.includes(asr.token));
  const modern = await connection(['tts'], ['read'], '2026-07-28');
  const modernAudio = await modern.remote.call('iris_core_audio', { artifactId: saved.output.artifactId });
  assert.equal(modernAudio.content[0].type, 'audio'); assert.equal(modernAudio.content[0].mimeType, 'audio/wav');
  const exported = await ok('/api/v0/connection-management/connections/' + speech.created.connectionId + '/export', { transport: 'stdio', format: 'entry' });
  const stdio = stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read,create,execute,stop', { version: '2026-07-28', launch: exported.configuration }); children.push(stdio);
  await stdio.initialize();
  assert((await stdio.request('tools/list')).tools.some(tool => tool.name === 'iris_core_create_speech'));
  const stdioIntent = await stdio.call('iris_core_create_speech', { key: uuid(), ...input }); assert(!stdioIntent.isError);
  const stdioRun = stdioIntent.structuredContent.flow, stdioKey = uuid();
  const stdioOperation = await stdio.call('iris_core_continue', { key: stdioKey, runId: stdioRun.id, expectedRevision: stdioRun.revision });
  await waitOperation(stdioOperation.structuredContent.operation.id);
  const stdioSaved = (await stdio.call('iris_core_run', { runId: stdioRun.id })).structuredContent;
  assert.equal(stdioSaved.status, 'ready');
  const stdioAudio = await stdio.call('iris_core_audio', { artifactId: stdioSaved.output.artifactId });
  assert.deepEqual(Buffer.from(stdioAudio.content[0].data, 'base64'), AUDIO_WAV);
  assert.equal((await stdio.call('iris_core_lookup', { key: stdioKey })).structuredContent.operation.id, stdioOperation.structuredContent.operation.id);
  assert.equal((await stdio.close()).status, 0); assert(!stdio.output().stdout.includes(speech.token)); assert(!stdio.output().stderr.includes(speech.token));
  assert.equal(fixture.calls.submit.length, 3);
  for (const remote of remotes) await remote.close?.();
  await api.dispose(); api = createLocalReadApi(options); services.push(api); session = await api.start();
  assert.equal((await ok('/api/v0/runs/' + saved.id)).status, 'ready'); assert.equal(fixture.calls.submit.length, 3);
  const lookup = await ok('/api/v0/creation-requests?kind=speech-create&key=' + creationKey); assert.equal(lookup.result.runId, saved.id);
  const onlyCreate = createLocalReadApi({ dataRoot, providerConfigPath, allowLocalWrites: true }); services.push(onlyCreate);
  const createSession = await onlyCreate.start();
  const local = await fetch(createSession.origin + '/api/v0/speeches', { method: 'POST', headers: { Authorization: 'Bearer ' + createSession.accessToken,
    'Content-Type': 'application/json', 'Idempotency-Key': uuid() }, body: JSON.stringify(input) });
  const localBody = await local.json();
  assert.equal(local.status, 201, 'saving a speech Run does not require execution: ' + (localBody.error?.code || '')); assert.equal(fixture.calls.submit.length, 3);
  const nativePair = createConnectionPair({ dataRoot, directory: path.join(root, 'native-pair'), origin: 'http://127.0.0.1:1', harnessKind: 'dsh', label: 'native-audio-boundary', scopes: ['read'], capabilities: ['tts'] });
  const nativeApi = createLocalReadApi({ dataRoot, connectionsFile: nativePair.serverFile }); services.push(nativeApi); const nativeSession = await nativeApi.start();
  fs.writeFileSync(nativePair.clientFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(nativePair.clientFile)), origin: nativeSession.origin }), { mode: 0o600 });
  let hostCalls = 0;
  const native = createDshServiceBridge({ connectionFile: nativePair.clientFile, getHost() { hostCalls++; return {}; } });
  try { await assert.rejects(native.start(), { code: 'IRIS_DSH_AUDIO_NOT_SUPPORTED' }); assert.equal(hostCalls, 0, 'unsupported native audio never registers a broken host tool'); }
  finally { await native.dispose(); }
  console.log('audio API/MCP: actual HTTP+stdio SDK (2025/2026), scope/media isolation, playable audio/text bytes, connection Skill, shared runner, replay/restart and create-only mode OK');
} finally { for (const child of children) await child.kill(); for (const remote of remotes) await remote.close?.(); for (const service of services) await service.dispose(); await app.dispose(); globalThis.fetch = originalFetch; }
