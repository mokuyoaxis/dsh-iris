import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { FLOW_MODEL, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { AUDIO_WAV, SPEECH_MODEL, TRANSCRIBE_MODEL, audioFlowFixture } from './fixtures/audio-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-source-authority'), dataRoot = path.join(root, 'core');
const image = imageFlowFixture(dataRoot), audio = audioFlowFixture();
const fixture = { ...image, ...audio, resolveTaskAdapter(task) {
  return task.providerId === 'audio-fixture' ? audio.resolveTaskAdapter(task) : image.resolveTaskAdapter(task);
} };
const app = createApplicationRuntime({ dataRoot, ...fixture }), remotes = [];
let api, started;
const key = () => crypto.randomUUID(), owner = () => ({ Authorization: 'Bearer ' + started.accessToken });
async function request(route, { input, headers = owner(), requestKey, expected = 200 } = {}) {
  const response = await fetch(started.origin + '/api/v0/' + route, {
    method: input === undefined ? 'GET' : 'POST', headers: { ...headers,
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(requestKey ? { 'Idempotency-Key': requestKey } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  });
  const body = response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, expected, route + ': ' + (Buffer.isBuffer(body) ? 'media response' : JSON.stringify(body)));
  return body;
}
async function handshake(record, credentials) {
  const runtimeInstanceId = key(), headers = { ...credentials, 'Iris-Connection-Id': record.connectionId, 'Iris-Runtime-Id': runtimeInstanceId };
  await request('connections/' + record.connectionId + '/handshake', { headers, input: {
    contractVersion: 0, adapterId: 'iris.mcp', harnessKind: 'generic', runtimeInstanceId,
    harnessVersion: 'source authorization fixture', requestedScopes: record.scopes,
    requestedCapabilities: record.capabilities, requestedTools: record.tools
  } });
  return headers;
}
async function connect(capabilities) {
  const created = await request('connection-management/connections', { input: { key: key(), label: 'Source authorization fixture',
    scopes: ['read', 'create', 'execute'], capabilities }, expected: 201 });
  const record = (await request('connection-management/connections')).connections.find(item => item.connectionId === created.connectionId);
  const exported = await request('connection-management/connections/' + record.connectionId + '/export', { input: { transport: 'http', format: 'entry' } });
  const credentials = exported.configuration.headers;
  const headers = await handshake(record, credentials);
  const remote = httpMcpClient(started.origin, credentials.Authorization.slice(7)); remotes.push(remote); await remote.initialize();
  return { record, credentials, headers, remote };
}
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { audio: true });
  const speech = await app.execute('flow.create', { recipe: 'speech/v0', model_ref: SPEECH_MODEL, text: 'Synthetic source fixture' });
  await app.execute('flow.continue', { run_id: speech.run.id });
  const speechArtifact = (await app.execute('flow.inspect', { run_id: speech.run.id })).run.output.artifactId;
  const generated = await app.execute('flow.create', { model_ref: FLOW_MODEL, prompt: 'Synthetic source fixture' });
  await app.execute('flow.continue', { run_id: generated.run.id });
  const imageArtifact = (await app.execute('flow.inspect', { run_id: generated.run.id })).run.output.artifactId;
  const imported = await app.execute('creation.audio', { key: key(), bytes: AUDIO_WAV, mediaType: 'audio/wav' });
  api = createLocalReadApi({ dataRoot, allowExecution: true, allowConnectionManagement: true, allowMcp: true,
    connectionStore: path.join(root, 'connections'), executionPorts: fixture });
  started = await api.start();

  const asr = await connect(['transcribe']);
  const input = { modelRef: TRANSCRIBE_MODEL, sourceArtifactId: speechArtifact };
  const count = (await request('runs')).total;
  assert.equal((await request(`artifacts/${speechArtifact}/audio`, { headers: asr.headers, expected: 403 })).error.code,
    'IRIS_CONNECTION_CAPABILITY_DENIED');
  const denied = await request('transcriptions', { input, headers: asr.headers, requestKey: key(), expected: 403 });
  assert.equal(denied.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');
  const mcpDenied = await asr.remote.call('iris_core_create_transcription', { key: key(), ...input });
  assert.equal(mcpDenied.isError, true); assert(JSON.stringify(mcpDenied).includes('IRIS_CONNECTION_CAPABILITY_DENIED'));
  assert.equal((await request('runs')).total, count, 'denied sources do not persist a new Run');

  const edit = await connect(['image-edit']);
  await request(`artifacts/${imageArtifact}/content`, { headers: edit.headers, expected: 403 });
  await request('runs', { input: { sourceArtifactId: imageArtifact, modelRef: FLOW_MODEL, prompt: 'Fixture edit' },
    headers: edit.headers, requestKey: key(), expected: 403 });
  const selected = await connect(['image-edit', 'image-generate']);
  await request(`artifacts/${imageArtifact}/content`, { headers: selected.headers });
  const allowed = await request('runs', { input: { sourceArtifactId: imageArtifact, modelRef: FLOW_MODEL, prompt: 'Fixture edit' },
    headers: selected.headers, requestKey: key(), expected: 201 });
  assert.equal(allowed.flow.source.artifactId, imageArtifact);

  // Unbound imports keep their existing source grant, independent of who imported them.
  const importedInput = { modelRef: TRANSCRIBE_MODEL, sourceArtifactId: imported.artifact.id }, originalKey = key();
  assert.deepEqual(await request(`artifacts/${imported.artifact.id}/audio`, { headers: asr.headers }), AUDIO_WAV);
  const saved = await request('transcriptions', { input: importedInput, headers: asr.headers, requestKey: originalKey, expected: 201 });
  const replay = await request('transcriptions', { input: importedInput, headers: asr.headers, requestKey: originalKey });
  assert.equal(replay.flow.id, saved.flow.id); assert.equal(replay.idempotentReplay, true);
  await request('transcriptions', { input, headers: asr.headers, requestKey: originalKey, expected: 403 });
  const malformed = await request('transcriptions', { input: { ...input, sourceArtifactId: '../not-an-artifact' }, headers: asr.headers,
    requestKey: key(), expected: 400 });
  assert.equal(malformed.error.code, 'IRIS_API_INPUT_INVALID');

  // Removing speech must remove the source grant as well, including on the HTTP MCP edge.
  const combined = await connect(['tts', 'transcribe']);
  await request(`artifacts/${speechArtifact}/audio`, { headers: combined.headers });
  await request('connection-management/connections/' + combined.record.connectionId + '/update', { input: {
    expectedRevision: combined.record.revision, label: combined.record.label, scopes: combined.record.scopes,
    capabilities: ['transcribe'], tools: asr.record.tools
  } });
  const latest = (await request('connection-management/connections')).connections.find(item => item.connectionId === combined.record.connectionId);
  const limitedHeaders = await handshake(latest, combined.credentials);
  await request('transcriptions', { input, headers: limitedHeaders, requestKey: key(), expected: 403 });
  const limitedMcp = await combined.remote.call('iris_core_create_transcription', { key: key(), ...input });
  assert.equal(limitedMcp.isError, true);
  assert.equal(audio.preparation.length, 0, 'creation never prepares or uploads audio');
  assert.equal(audio.calls.submit.length, 1); assert.equal(image.calls.submit.length, 1);
  console.log('Source authorization: real HTTP/MCP reject unreadable bound audio/image inputs, preserve unbound imports and exact replay, enforce narrowed grants and create no unauthorized Run/upload/task OK');
} finally {
  for (const remote of remotes) await remote.close?.();
  await api?.dispose(); await app.dispose();
}
