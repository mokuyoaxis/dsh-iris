import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { inspectCoreTask, claimFlowTask, beginCoreAttempt, recordCoreAttemptResult, failCoreDelivery } from '../lib/core-tasks.js';
import { readFlowRun, updateFlowRun } from '../lib/flow-store.js';
import { definePlugin, defineProviderAdapter, createCorePluginRegistry } from '../lib/plugins.js';
import { AUDIO_WAV } from './fixtures/audio-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-music-flow');
const dataRoot = path.join(root, 'core');
const uuid = () => crypto.randomUUID();
const services = [], registries = [], apps = [];

// Controlled OpenAI-compatible gemini-web-music HTTP fixture: returns 502 on first call, WAV data URL on second!
let builtInCalls = 0, failNextWith502 = true;
const musicServer = http.createServer(async (req, res) => {
  assert.equal(req.url, '/v1/chat/completions');
  for await (const _chunk of req) { /* drain */ }
  builtInCalls++;
  if (failNextWith502) {
    failNextWith502 = false;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'controlled upstream 502' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { content: 'Here is your track: data:audio/wav;base64,' + AUDIO_WAV.toString('base64') } }]
  }));
});
await new Promise(resolve => musicServer.listen(0, '127.0.0.1', resolve));

// Third-party music-gen plugin provider!
let pluginMusicCalls = 0;
const musicPlugin = definePlugin({
  manifest: {
    contractVersion: 0, id: 'example.music-engine', version: '1.0.0',
    compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
    contributions: {
      providers: [{ id: 'synth', version: '1.0.0', title: 'Plugin Music Synth', capabilities: ['music-gen'] }]
    }
  },
  activate() {
    return {
      providers: {
        synth: {
          normalizeEndpoint: value => String(value || '').replace(/\/+$/, ''),
          supportsModel: ({ capability }) => capability === 'music-gen',
          createAdapter: provider => defineProviderAdapter({
            id: provider.id, protocol: 'example.music-engine.synth', capabilities: ['music'],
            operations: {
              async submit({ input }) {
                pluginMusicCalls++;
                assert(typeof input.prompt === 'string' && input.prompt.length > 0);
                return { kind: 'completed', artifacts: [{ kind: 'inline-base64', data: AUDIO_WAV.toString('base64'), mediaType: 'audio/wav' }] };
              },
              mapError: error => error
            },
            unsupported: { discover: 'n/a', poll: 'n/a', cancel: 'n/a', download: 'n/a' }
          })
        }
      }
    };
  }
});

const config = path.join(root, 'providers.json');
fs.writeFileSync(config, JSON.stringify({
  providers: [
    {
      id: 'builtin-music', enabled: true, apiKey: 'MUSIC_PRIVATE_KEY',
      baseUrl: 'http://127.0.0.1:' + musicServer.address().port + '/v1',
      models: [{ id: 'melody-v1', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' }]
    },
    {
      id: 'plugin-music', enabled: true, auth: 'none',
      baseUrl: 'http://127.0.0.1:9', mediaProtocol: 'example.music-engine.synth',
      models: [{ id: 'synth-v1', capabilities: ['music-gen'], musicProtocol: 'example.music-engine.synth' }]
    }
  ],
  assignments: { 'music-gen': ['builtin-music::melody-v1', 'plugin-music::synth-v1'] }
}), { mode: 0o600 });

let session;
async function json(route, value, { token = session.accessToken, method = value === undefined ? 'GET' : 'POST', key } = {}) {
  const response = await fetch(session.origin + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {})
    },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {})
  });
  return { status: response.status, body: await response.json() };
}
const ok = async (...args) => { const r = await json(...args); assert(r.status < 300, JSON.stringify(r)); return r.body; };
async function waitOp(id) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { operation } = await ok('/api/v0/operations/' + id);
    if (!['queued', 'running'].includes(operation.state)) return operation;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('operation timeout');
}
async function grant(capabilities, scopes = ['read', 'create', 'execute', 'stop']) {
  const created = await ok('/api/v0/connection-management/connections', { key: uuid(), label: capabilities.join('+'), capabilities, scopes });
  const entry = await ok('/api/v0/connection-management/connections/' + created.connectionId + '/export', { transport: 'http', format: 'entry' });
  const token = entry.configuration.headers.Authorization.slice(7);
  const remote = httpMcpClient(session.origin, token);
  await remote.initialize();
  return { created, token, remote };
}

try {
  const registry = await createCorePluginRegistry({ plugins: [musicPlugin] }); registries.push(registry);

  // 1. Old v2 root rejects music creation without migration.
  const v2Root = path.join(root, 'v2-core');
  const v2App = createApplicationRuntime({ dataRoot: v2Root }); apps.push(v2App);
  await v2App.execute('flow.init', {}); await v2App.execute('execution.init', { imageGeneration: true });
  const v2Api = createLocalReadApi({ dataRoot: v2Root, providerConfigPath: config, allowLocalWrites: true, pluginRegistry: registry });
  services.push(v2Api); session = await v2Api.start();
  assert.notEqual((await ok('/api/v0/session')).music, true);
  assert.equal((await json('/api/v0/music', { modelRef: 'builtin-music::melody-v1', prompt: 'ambient piano' }, { key: uuid() })).status, 409);
  await v2Api.dispose();

  // 2. Initialize v3 root (no v6 bump!) -> session.music === true and music-models lists both built-in + plugin providers.
  const app = createApplicationRuntime({ dataRoot }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', { audio: true });
  const apiOptions = {
    dataRoot, providerConfigPath: config, serveWorkbench: true, allowExecution: true,
    allowConnectionManagement: true, connectionStore: path.join(root, 'connections'),
    allowMcp: true, pluginRegistry: registry
  };
  let api = createLocalReadApi(apiOptions); services.push(api); session = await api.start();
  const sess = await ok('/api/v0/session');
  assert.equal(sess.music, true);
  assert(sess.operations.includes('music.create'));
  const models = await ok('/api/v0/music-models');
  assert.deepEqual(models.models.map(m => m.modelRef), ['builtin-music::melody-v1', 'plugin-music::synth-v1']);
  assert(!JSON.stringify(models).includes('MUSIC_PRIVATE_KEY'));

  // 3. Strict 1 Run = 1 Task = 1 finite submission: HTTP 502 fails cleanly with ZERO hidden retries!
  const key1 = uuid();
  const run1 = await ok('/api/v0/music', { modelRef: 'builtin-music::melody-v1', prompt: 'gentle acoustic iris theme', timeoutMs: 30000 }, { key: key1 });
  assert.equal(run1.flow.recipe, 'music/v0');
  assert.equal(run1.flow.status, 'not_started');
  assert.equal(builtInCalls, 0);
  // Idempotent replay + conflict check
  assert.equal((await ok('/api/v0/music', { modelRef: 'builtin-music::melody-v1', prompt: 'gentle acoustic iris theme', timeoutMs: 30000 }, { key: key1 })).flow.id, run1.flow.id);
  assert.equal((await json('/api/v0/music', { modelRef: 'builtin-music::melody-v1', prompt: 'different prompt' }, { key: key1 })).status, 409);

  // Issue #4 regression: cannot retry an unstarted music Run (prevents dangling retriedFrom.taskId -> IRIS_TASK_NOT_FOUND)!
  assert.equal((await json('/api/v0/music', {
    modelRef: 'builtin-music::melody-v1', prompt: 'retry unstarted must fail', retriedFromRunId: run1.flow.id
  }, { key: uuid() })).status, 400);

  // Also reject retrying a running or delivery_failed music Run!
  const runningDraft = await ok('/api/v0/music', { modelRef: 'builtin-music::melody-v1', prompt: 'running run' }, { key: uuid() });
  const deliveryDraft = await ok('/api/v0/music', { modelRef: 'builtin-music::melody-v1', prompt: 'delivery failed run' }, { key: uuid() });
  await api.dispose();
  await app.run('writer', rt => rt.run('execute', ({ dataRoot: rootDir }) => {
    const rRun = readFlowRun(rootDir, runningDraft.flow.id);
    const tRun = claimFlowTask(rootDir, rRun.id);
    updateFlowRun(rootDir, rRun, { music: { ...rRun.music, claimed: true } });
    const aRun = beginCoreAttempt(rootDir, tRun.id, { providerId: 'builtin-music', model: 'builtin-music::melody-v1', providerBinding: rRun.providerBinding });
    recordCoreAttemptResult(rootDir, tRun.id, { ...aRun, acceptance: 'accepted', resultKind: 'accepted', remoteTaskId: 'remote-music-running' });

    const rDel = readFlowRun(rootDir, deliveryDraft.flow.id);
    const tDel = claimFlowTask(rootDir, rDel.id);
    updateFlowRun(rootDir, rDel, { music: { ...rDel.music, claimed: true } });
    const aDel = beginCoreAttempt(rootDir, tDel.id, { providerId: 'builtin-music', model: 'builtin-music::melody-v1', providerBinding: rDel.providerBinding });
    recordCoreAttemptResult(rootDir, tDel.id, { ...aDel, acceptance: 'accepted', resultKind: 'completed' });
    failCoreDelivery(rootDir, tDel.id, { stage: 'persist', category: 'local_io', message: 'controlled delivery fail' });
  }));
  api = createLocalReadApi(apiOptions); services.push(api); session = await api.start();
  assert.equal((await ok('/api/v0/runs/' + runningDraft.flow.id)).status, 'running');
  assert.equal((await ok('/api/v0/runs/' + deliveryDraft.flow.id)).status, 'delivery_failed');
  assert.equal((await json('/api/v0/music', { modelRef: 'builtin-music::melody-v1', prompt: 'retry running', retriedFromRunId: runningDraft.flow.id }, { key: uuid() })).status, 400);
  assert.equal((await json('/api/v0/music', { modelRef: 'builtin-music::melody-v1', prompt: 'retry delivery_failed', retriedFromRunId: deliveryDraft.flow.id }, { key: uuid() })).status, 400);

  const op1 = await ok('/api/v0/runs/' + run1.flow.id + '/continue', { expectedRevision: run1.flow.revision }, { key: uuid() });
  await waitOp(op1.operation.id);
  assert.equal(builtInCalls, 1, 'Core music/v0 must submit at most once — no hidden 502 retry loop!');
  const failedRun = await ok('/api/v0/runs/' + run1.flow.id);
  assert.equal(failedRun.status, 'needs_attention');
  assert.equal(failedRun.task.errorSummary.httpStatus, 502);

  // 4. Informed retry via retriedFromRunId -> new Run linked via retried-from lineage, with an existing Core Task!
  const run2 = await ok('/api/v0/music', {
    modelRef: 'builtin-music::melody-v1', prompt: 'gentle acoustic iris theme',
    timeoutMs: 30000, retriedFromRunId: failedRun.id
  }, { key: uuid() });
  assert.equal(run2.flow.input.retriedFromRunId, failedRun.id);
  assert.equal(run2.flow.retriedFrom.runId, failedRun.id);
  assert.equal(run2.flow.retriedFrom.taskId, failedRun.task.id);
  assert.equal(inspectCoreTask(dataRoot, run2.flow.retriedFrom.taskId).id, failedRun.task.id);
  const op2 = await ok('/api/v0/runs/' + run2.flow.id + '/continue', { expectedRevision: run2.flow.revision }, { key: uuid() });
  assert.equal((await waitOp(op2.operation.id)).state, 'succeeded');
  assert.equal(builtInCalls, 2);
  const readyRun = await ok('/api/v0/runs/' + run2.flow.id);
  assert.equal(readyRun.status, 'ready');
  assert(readyRun.output?.artifactId);

  // Verify playable audio bytes & download filename
  const audioResp = await fetch(session.origin + '/api/v0/artifacts/' + readyRun.output.artifactId + '/audio', { headers: { Authorization: 'Bearer ' + session.accessToken } });
  assert.equal(audioResp.status, 200);
  assert.equal(audioResp.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await audioResp.arrayBuffer()), AUDIO_WAV);
  const dlResp = await fetch(session.origin + '/api/v0/runs/' + readyRun.id + '/download', { headers: { Authorization: 'Bearer ' + session.accessToken } });
  assert.equal(dlResp.status, 200);
  assert.match(dlResp.headers.get('content-disposition'), /\.wav"$/);
  assert.deepEqual(Buffer.from(await dlResp.arrayBuffer()), AUDIO_WAV);

  // Verify retried-from Run lineage in both directions (failedRun <-> readyRun)!
  const retryLineage = await ok('/api/v0/runs/' + readyRun.id + '/lineage');
  assert(retryLineage.upstreamRuns.some(r => r.runId === failedRun.id && r.roles.includes('retried-from')));
  const origLineage = await ok('/api/v0/runs/' + failedRun.id + '/lineage');
  assert(origLineage.downstreamRuns.some(r => r.runId === readyRun.id && r.roles.includes('retried-from')));

  // 5. Third-party plugin music-gen provider + artifact-level retried-from relation when retrying a completed Run!
  const run3 = await ok('/api/v0/music', {
    modelRef: 'plugin-music::synth-v1', prompt: 'lofi synth variation',
    retriedFromRunId: readyRun.id
  }, { key: uuid() });
  assert.equal(run3.flow.retriedFrom.artifactId, readyRun.output.artifactId);
  const op3 = await ok('/api/v0/runs/' + run3.flow.id + '/continue', { expectedRevision: run3.flow.revision }, { key: uuid() });
  assert.equal((await waitOp(op3.operation.id)).state, 'succeeded');
  assert.equal(pluginMusicCalls, 1);
  const pluginReady = await ok('/api/v0/runs/' + run3.flow.id);
  assert.equal(pluginReady.status, 'ready');
  const artLineage = await ok('/api/v0/artifacts/' + pluginReady.output.artifactId + '/lineage');
  assert(artLineage.parents.some(p => p.artifactId === readyRun.output.artifactId && p.relation === 'retried-from'));

  // Restart service: zero extra provider calls, runs?kind=music filters cleanly!
  await api.dispose(); api = createLocalReadApi(apiOptions); services.push(api); session = await api.start();
  assert.equal(builtInCalls, 2); assert.equal(pluginMusicCalls, 1);
  assert.equal((await ok('/api/v0/runs?kind=music')).total, 5);
  assert.equal((await ok('/api/v0/runs?kind=speech')).total, 0);

  // 6. MCP music group + cross-group isolation!
  const musicConn = await grant(['music']);
  const ttsConn = await grant(['tts']);
  const imgConn = await grant(['image-edit']);
  const musicTools = (await musicConn.remote.request('tools/list')).tools.map(t => t.name);
  assert(musicTools.includes('iris_core_music_models') && musicTools.includes('iris_core_create_music') && musicTools.includes('iris_core_audio'));
  assert(!(await ttsConn.remote.request('tools/list')).tools.some(t => t.name.includes('music')));
  assert(!(await imgConn.remote.request('tools/list')).tools.some(t => t.name.includes('music')));

  const mcpModels = await musicConn.remote.call('iris_core_music_models', {});
  assert.equal(mcpModels.structuredContent.models.length, 2);
  const mcpAudio = await musicConn.remote.call('iris_core_audio', { artifactId: readyRun.output.artifactId });
  assert.equal(mcpAudio.content[0].type, 'audio');
  assert.deepEqual(Buffer.from(mcpAudio.content[0].data, 'base64'), AUDIO_WAV);
  // Cross-group isolation: tts connection cannot inspect music Run or read music audio!
  assert.equal((await ttsConn.remote.call('iris_core_run', { runId: readyRun.id })).isError, true);
  assert.equal((await ttsConn.remote.call('iris_core_audio', { artifactId: readyRun.output.artifactId })).isError, true);

  console.log('music/v0 flow + no hidden 502 retry + retried-from lineage + plugin music-gen + MCP isolation OK');
} finally {
  for (const service of services.reverse()) await service.dispose();
  for (const app of apps) await app.dispose();
  for (const registry of registries) await registry.dispose();
  await new Promise(resolve => musicServer.close(resolve));
}
