import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { definePlugin, defineProviderAdapter, createCorePluginRegistry } from '../lib/plugins.js';
import { inspectArtifactLineage, inspectRunLineage } from '../lib/core-lineage.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { AUDIO_WAV } from './fixtures/audio-flow-fixture.mjs';
import { VIDEO_MP4 } from './fixtures/video-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-video-i2v-s2v');
const dataRoot = path.join(root, 'core');
const uuid = () => crypto.randomUUID();
const services = [], registries = [], apps = [], servers = [];
const originalFetch = globalThis.fetch;
let dashServerPort = 0;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === 'dashscope.aliyuncs.com' && dashServerPort) {
    const rewritten = new URL(url.pathname + url.search, `http://127.0.0.1:${dashServerPort}`);
    return originalFetch(rewritten, options);
  }
  assert.equal(url.hostname, '127.0.0.1', 'no external network allowed');
  return originalFetch(input, options);
};

// Real DashScope HTTP loopback server: captures exact wire JSON request bodies for t2v, i2v (parameters.resolution!) and s2v!
const wireDashRequests = [];
const dashServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  if (req.url.startsWith('/api/v1/uploads?')) {
    const model = new URL(req.url, 'http://127.0.0.1').searchParams.get('model');
    wireDashRequests.push({ kind: 'upload-policy', model });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        upload_dir: 'wire-temp', upload_host: `http://127.0.0.1:${dashServer.address().port}/oss-upload`,
        oss_access_key_id: 'id', signature: 'sig', policy: 'pol',
        x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true'
      }
    }));
    return;
  }
  if (req.url === '/oss-upload') {
    wireDashRequests.push({ kind: 'oss-upload', bytes: Buffer.concat(chunks).length });
    res.writeHead(200); res.end();
    return;
  }
  if (req.url === '/api/v1/services/aigc/video-generation/video-synthesis' || req.url === '/api/v1/services/aigc/image2video/video-synthesis') {
    const body = JSON.parse(rawBody);
    wireDashRequests.push({ kind: 'submit', path: req.url, ossResolve: req.headers['x-dashscope-ossresourceresolve'] || null, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: { task_id: 'wire-dash-' + wireDashRequests.length } }));
    return;
  }
  if (req.url.startsWith('/api/v1/tasks/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: { task_status: 'SUCCEEDED', video_url: `http://127.0.0.1:${dashServer.address().port}/video.mp4` } }));
    return;
  }
  if (req.url === '/video.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.end(VIDEO_MP4);
    return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve => dashServer.listen(0, '127.0.0.1', resolve));
dashServerPort = dashServer.address().port;
servers.push(dashServer);

// Custom plugin provider declaring supportsVideoMode — including 'dual-i2v' (name contains 'i2v' yet explicitly supports BOTH t2v and i2v!).
const pluginSubmits = [];
const customVideoPlugin = definePlugin({
  manifest: {
    contractVersion: 0, id: 'example.custom-video', version: '1.0.0',
    compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
    contributions: {
      providers: [{ id: 'proto', version: '1.0.0', title: 'Custom Video Protocol', capabilities: ['video-gen'] }]
    }
  },
  activate() {
    return {
      providers: {
        proto: {
          normalizeEndpoint: value => String(value || '').replace(/\/+$/, ''),
          supportsModel: ({ capability }) => capability === 'video-gen',
          supportsVideoMode: (modelId, mode) =>
            (modelId === 'custom-i2v' && mode === 'i2v')
            || (modelId === 'custom-s2v' && mode === 's2v')
            || (modelId === 'dual-i2v' && (mode === 't2v' || mode === 'i2v'))
            || (modelId === 'dual-s2v' && (mode === 't2v' || mode === 's2v')),
          createAdapter: provider => defineProviderAdapter({
            id: provider.id, protocol: 'example.custom-video.proto', capabilities: ['video'],
            operations: {
              async submit({ model, input }) {
                pluginSubmits.push({ model, hasFirstFrame: Buffer.isBuffer(input.firstFrame?.bytes), hasAudio: Buffer.isBuffer(input.audio?.bytes), prompt: input.prompt, resolution: input.resolution });
                return { kind: 'accepted', remoteTaskId: 'plugin-video-' + pluginSubmits.length };
              },
              async poll() {
                return { kind: 'succeeded', artifacts: [{ kind: 'inline-base64', data: VIDEO_MP4.toString('base64'), mediaType: 'video/mp4' }] };
              },
              mapError: error => error
            },
            unsupported: { discover: 'n/a', cancel: 'n/a', download: 'n/a' },
            unsupportedPreparation: 'Plugin protocol accepts direct bytes'
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
      id: 'dash-video', enabled: true, apiKey: 'VIDEO_SECRET_NEVER_EXPOSE',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
      models: [
        { id: 'wan2.2-t2v-plus', capabilities: ['video-gen'] },
        { id: 'wan2.6-i2v', capabilities: ['video-gen'] },
        { id: 'wan2.2-s2v', capabilities: ['video-gen'] }
      ]
    },
    {
      id: 'custom-prov', enabled: true, auth: 'none',
      baseUrl: 'http://127.0.0.1:9', mediaProtocol: 'example.custom-video.proto',
      models: [
        { id: 'custom-i2v', capabilities: ['video-gen'] },
        { id: 'custom-s2v', capabilities: ['video-gen'] },
        { id: 'dual-i2v', capabilities: ['video-gen'] },
        { id: 'dual-s2v', capabilities: ['video-gen'] }
      ]
    }
  ],
  assignments: {
    'video-gen': [
      'dash-video::wan2.2-t2v-plus', 'dash-video::wan2.6-i2v', 'dash-video::wan2.2-s2v',
      'custom-prov::custom-i2v', 'custom-prov::custom-s2v', 'custom-prov::dual-i2v', 'custom-prov::dual-s2v'
    ]
  }
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
  const registry = await createCorePluginRegistry({ plugins: [customVideoPlugin] }); registries.push(registry);

  // 1. Old v3 root rejects i2v / s2v creation without silent migration.
  const v3Root = path.join(root, 'v3-core');
  const v3App = createApplicationRuntime({ dataRoot: v3Root }); apps.push(v3App);
  await v3App.execute('flow.init', {}); await v3App.execute('execution.init', { audio: true });
  const v3Api = createLocalReadApi({ dataRoot: v3Root, providerConfigPath: config, allowLocalWrites: true, pluginRegistry: registry });
  services.push(v3Api); session = await v3Api.start();
  assert.equal((await json('/api/v0/videos/i2v', { sourceArtifactId: 'artifact_' + 'a'.repeat(24), modelRef: 'dash-video::wan2.6-i2v' }, { key: uuid() })).status, 409);
  assert.equal((await json('/api/v0/videos/s2v', { sourceArtifactId: 'artifact_' + 'a'.repeat(24), audioArtifactId: 'artifact_' + 'b'.repeat(24), modelRef: 'dash-video::wan2.2-s2v' }, { key: uuid() })).status, 409);
  await v3Api.dispose();

  // 2. Initialize v4+ root and start full service using REAL configured DashScope + plugin adapters (no mocked executionPorts!).
  const app = createApplicationRuntime({ dataRoot }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', { video: true });
  const imgRes = await app.execute('artifact.import', { image_bytes: FLOW_SOURCE });
  const audioRes = await app.execute('creation.audio', { key: uuid(), bytes: AUDIO_WAV, mediaType: 'audio/wav' });
  const imageId = imgRes.artifact.id, audioId = audioRes.artifact.id;

  const apiOptions = {
    dataRoot, providerConfigPath: config, serveWorkbench: true, allowExecution: true,
    allowConnectionManagement: true, connectionStore: path.join(root, 'connections'),
    allowMcp: true, pluginRegistry: registry
  };
  let api = createLocalReadApi(apiOptions); services.push(api); session = await api.start();

  // Verify video-models mode filtering honors both built-in rules and plugin supportsVideoMode hook (including dual-i2v and dual-s2v!).
  assert.deepEqual((await ok('/api/v0/video-models?mode=t2v')).models.map(m => m.modelRef), ['dash-video::wan2.2-t2v-plus', 'custom-prov::dual-i2v', 'custom-prov::dual-s2v']);
  assert.deepEqual((await ok('/api/v0/video-models?mode=i2v')).models.map(m => m.modelRef), ['dash-video::wan2.6-i2v', 'custom-prov::custom-i2v', 'custom-prov::dual-i2v']);
  assert.deepEqual((await ok('/api/v0/video-models?mode=s2v')).models.map(m => m.modelRef), ['dash-video::wan2.2-s2v', 'custom-prov::custom-s2v', 'custom-prov::dual-s2v']);
  assert.equal((await json('/api/v0/video-models?mode=r2v')).status, 400);

  // Explicit plugin supportsVideoMode overrides model-name heuristic for BOTH dual-i2v and dual-s2v; built-in DashScope wan2.2-s2v still rejects t2v!
  const dualT2v = await ok('/api/v0/videos', { modelRef: 'custom-prov::dual-i2v', prompt: 'dual model explicit t2v support' }, { key: uuid() });
  assert.equal(dualT2v.flow.recipe, 'video-generate/v0');
  const dualOp = await ok('/api/v0/runs/' + dualT2v.flow.id + '/continue', { expectedRevision: dualT2v.flow.revision }, { key: uuid() });
  assert.equal((await waitOp(dualOp.operation.id)).state, 'succeeded');
  assert.equal(pluginSubmits.at(-1).model, 'dual-i2v');
  assert.equal((await json('/api/v0/videos/s2v', { sourceArtifactId: imageId, audioArtifactId: audioId, modelRef: 'custom-prov::dual-i2v' }, { key: uuid() })).status, 400);

  const dualS2vT2v = await ok('/api/v0/videos', { modelRef: 'custom-prov::dual-s2v', prompt: 'dual-s2v explicit t2v support' }, { key: uuid() });
  assert.equal(dualS2vT2v.flow.recipe, 'video-generate/v0');
  const dualS2vOp = await ok('/api/v0/runs/' + dualS2vT2v.flow.id + '/continue', { expectedRevision: dualS2vT2v.flow.revision }, { key: uuid() });
  assert.equal((await waitOp(dualS2vOp.operation.id)).state, 'succeeded');
  assert.equal(pluginSubmits.at(-1).model, 'dual-s2v');
  assert.equal((await json('/api/v0/videos', { modelRef: 'dash-video::wan2.2-s2v', prompt: 'built-in s2v still rejected for t2v' }, { key: uuid() })).status, 400);

  // 3. video-i2v/v0: optional prompt omitted, idempotent create, REAL DashScope wire body carries parameters.resolution='720P' (NO spurious default size!), restart + observe!
  const i2vKey = uuid();
  const i2vCreated = await ok('/api/v0/videos/i2v', { sourceArtifactId: imageId, modelRef: 'dash-video::wan2.6-i2v', resolution: '720P', duration: 5 }, { key: i2vKey });
  assert.equal(i2vCreated.flow.recipe, 'video-i2v/v0');
  assert.equal(i2vCreated.flow.source.artifactId, imageId);
  assert.equal(i2vCreated.flow.input.prompt, undefined);
  assert.equal(i2vCreated.flow.input.resolution, '720P');
  assert.equal(wireDashRequests.length, 0, 'create never submits');
  assert.equal((await ok('/api/v0/videos/i2v', { sourceArtifactId: imageId, modelRef: 'dash-video::wan2.6-i2v', resolution: '720P', duration: 5 }, { key: i2vKey })).flow.id, i2vCreated.flow.id);
  assert.equal((await json('/api/v0/videos/i2v', { sourceArtifactId: imageId, modelRef: 'dash-video::wan2.6-i2v', resolution: '1080P', duration: 5 }, { key: i2vKey })).status, 409);

  const i2vOp1 = await ok('/api/v0/runs/' + i2vCreated.flow.id + '/continue', { expectedRevision: i2vCreated.flow.revision }, { key: uuid() });
  assert.equal((await waitOp(i2vOp1.operation.id)).state, 'succeeded');
  const i2vWire = wireDashRequests.filter(r => r.kind === 'submit');
  assert.equal(i2vWire.length, 1);
  assert.equal(i2vWire[0].path, '/api/v1/services/aigc/video-generation/video-synthesis');
  assert.equal(i2vWire[0].body.model, 'wan2.6-i2v');
  assert.equal(i2vWire[0].body.input.prompt, undefined, 'optional prompt omitted cleanly');
  assert(i2vWire[0].body.input.img_url.startsWith('data:image/png;base64,'));
  assert.deepEqual(Buffer.from(i2vWire[0].body.input.img_url.slice('data:image/png;base64,'.length), 'base64'), FLOW_SOURCE, 'i2v img_url must carry exact PNG base64 bytes');
  assert.deepEqual(i2vWire[0].body.parameters, { resolution: '720P', duration: 5 }, 'Blocker #2: DashScope i2v MUST send parameters.resolution and NOT inject default size');

  // Restart service between submit & observe to verify zero automatic resubmission and persisted dual-s2v t2v record readability!
  await api.dispose(); api = createLocalReadApi(apiOptions); services.push(api); session = await api.start();
  assert.equal((await ok('/api/v0/runs/' + dualS2vT2v.flow.id)).input.modelRef, 'custom-prov::dual-s2v');
  assert.equal(wireDashRequests.filter(r => r.kind === 'submit').length, 1, 'restart must not resubmit');
  const i2vRunning = await ok('/api/v0/runs/' + i2vCreated.flow.id);
  assert.equal(i2vRunning.status, 'running');
  const i2vOp2 = await ok('/api/v0/runs/' + i2vRunning.id + '/continue', { expectedRevision: i2vRunning.revision }, { key: uuid() });
  assert.equal((await waitOp(i2vOp2.operation.id)).state, 'succeeded');
  const i2vReady = await ok('/api/v0/runs/' + i2vRunning.id);
  assert.equal(i2vReady.status, 'ready');
  assert.equal(i2vReady.task.id, i2vRunning.task.id);
  const i2vLineage = inspectArtifactLineage(dataRoot, i2vReady.output.artifactId);
  assert(i2vLineage.parents.some(p => p.artifactId === imageId && p.relation === 'derived-from'));

  // Also verify DashScope t2v STILL sends default parameters.size='1280*720' cleanly!
  const t2vCreated = await ok('/api/v0/videos', { modelRef: 'dash-video::wan2.2-t2v-plus', prompt: 'gentle breeze over irises', duration: 5 }, { key: uuid() });
  const t2vOp = await ok('/api/v0/runs/' + t2vCreated.flow.id + '/continue', { expectedRevision: t2vCreated.flow.revision }, { key: uuid() });
  assert.equal((await waitOp(t2vOp.operation.id)).state, 'succeeded');
  const t2vWire = wireDashRequests.filter(r => r.kind === 'submit').at(-1);
  assert.deepEqual(t2vWire.body.parameters, { size: '1280*720', duration: 5 });

  // 4. video-s2v/v0: DashScope uploads both image + audio at continue (NOT create), rejects prompt, sends image_url/audio_url/resolution + OssResourceResolve header, records dual derived-from lineage!
  assert.equal((await json('/api/v0/videos/s2v', { sourceArtifactId: imageId, audioArtifactId: audioId, modelRef: 'dash-video::wan2.2-s2v', prompt: 'forbidden' }, { key: uuid() })).status, 400);
  const uploadsBefore = wireDashRequests.filter(r => r.kind === 'oss-upload').length;
  const s2vCreated = await ok('/api/v0/videos/s2v', { sourceArtifactId: imageId, audioArtifactId: audioId, modelRef: 'dash-video::wan2.2-s2v', resolution: '480P' }, { key: uuid() });
  assert.equal(s2vCreated.flow.recipe, 'video-s2v/v0');
  assert.equal(s2vCreated.flow.source, null);
  assert.deepEqual(s2vCreated.flow.sources.map(s => s.artifactId), [imageId, audioId]);
  assert.equal(wireDashRequests.filter(r => r.kind === 'oss-upload').length, uploadsBefore, 's2v creation must not upload media');
  const s2vOp1 = await ok('/api/v0/runs/' + s2vCreated.flow.id + '/continue', { expectedRevision: s2vCreated.flow.revision }, { key: uuid() });
  assert.equal((await waitOp(s2vOp1.operation.id)).state, 'succeeded');
  assert.equal(wireDashRequests.filter(r => r.kind === 'oss-upload').length, uploadsBefore + 2, 's2v continue uploads firstFrame + audio via prepareInput');
  const s2vWire = wireDashRequests.filter(r => r.kind === 'submit').at(-1);
  assert.equal(s2vWire.path, '/api/v1/services/aigc/image2video/video-synthesis');
  assert.equal(s2vWire.ossResolve, 'enable');
  assert(s2vWire.body.input.image_url.startsWith('oss://wire-temp/'));
  assert(s2vWire.body.input.audio_url.startsWith('oss://wire-temp/'));
  assert.deepEqual(s2vWire.body.parameters, { resolution: '480P' });
  const s2vRunning = await ok('/api/v0/runs/' + s2vCreated.flow.id);
  const s2vOp2 = await ok('/api/v0/runs/' + s2vRunning.id + '/continue', { expectedRevision: s2vRunning.revision }, { key: uuid() });
  assert.equal((await waitOp(s2vOp2.operation.id)).state, 'succeeded');
  const s2vReady = await ok('/api/v0/runs/' + s2vRunning.id);
  assert.equal(s2vReady.status, 'ready');
  const s2vArtLineage = inspectArtifactLineage(dataRoot, s2vReady.output.artifactId);
  assert.deepEqual(new Set(s2vArtLineage.parents.map(p => p.artifactId)), new Set([imageId, audioId]));
  const s2vRunLineage = inspectRunLineage(dataRoot, s2vReady.id);
  assert.deepEqual(new Set(s2vRunLineage.artifacts.filter(a => a.roles.includes('source')).map(a => a.artifactId)), new Set([imageId, audioId]));

  // 5. Plugin s2v adapter without prepareInput receives direct { firstFrame, audio } bytes!
  const pluginBefore = pluginSubmits.length;
  const pluginS2v = await ok('/api/v0/videos/s2v', { sourceArtifactId: imageId, audioArtifactId: audioId, modelRef: 'custom-prov::custom-s2v', resolution: '720P' }, { key: uuid() });
  const pOp1 = await ok('/api/v0/runs/' + pluginS2v.flow.id + '/continue', { expectedRevision: pluginS2v.flow.revision }, { key: uuid() });
  assert.equal((await waitOp(pOp1.operation.id)).state, 'succeeded');
  assert.equal(pluginSubmits.length, pluginBefore + 1);
  assert.equal(pluginSubmits.at(-1).hasFirstFrame, true);
  assert.equal(pluginSubmits.at(-1).hasAudio, true);
  assert.equal(pluginSubmits.at(-1).resolution, '720P');

  // 6. MCP group isolation + Blocker #1 full import -> create -> continue -> read path using the SAME single-group connection!
  const t2vConn = await grant(['video-generate']);
  const i2vConn = await grant(['video-i2v']);
  const s2vConn = await grant(['video-s2v']);
  const t2vTools = (await t2vConn.remote.request('tools/list')).tools.map(t => t.name);
  const i2vTools = (await i2vConn.remote.request('tools/list')).tools.map(t => t.name);
  const s2vTools = (await s2vConn.remote.request('tools/list')).tools.map(t => t.name);
  assert(!t2vTools.includes('iris_core_create_video_i2v') && !t2vTools.includes('iris_core_create_video_s2v'), 't2v group gets zero silent expansion');
  assert(i2vTools.includes('iris_core_create_video_i2v') && i2vTools.includes('iris_core_import_image') && !i2vTools.includes('iris_core_create_video_s2v') && !i2vTools.includes('iris_core_import_audio'));
  assert(s2vTools.includes('iris_core_create_video_s2v') && s2vTools.includes('iris_core_import_image') && s2vTools.includes('iris_core_import_audio') && !s2vTools.includes('iris_core_create_video_i2v'));

  // Blocker #1 regression: video-i2v-only connection imports an image and creates + runs video-i2v/v0 with the SAME connection!
  const mcpImportedImg1 = await i2vConn.remote.call('iris_core_import_image', {
    key: uuid(), imageBase64: FLOW_SOURCE.toString('base64'), mediaType: 'image/png'
  });
  assert(!mcpImportedImg1.isError, JSON.stringify(mcpImportedImg1));
  const mcpI2vCreated = await i2vConn.remote.call('iris_core_create_video_i2v', {
    key: uuid(), sourceArtifactId: mcpImportedImg1.structuredContent.artifact.artifactId,
    modelRef: 'dash-video::wan2.6-i2v', prompt: 'gentle camera pan', resolution: '720P', duration: 5
  });
  assert(!mcpI2vCreated.isError, 'video-i2v-only connection must be allowed to create flow from its unbound imported image: ' + JSON.stringify(mcpI2vCreated));
  const mcpI2vRun = mcpI2vCreated.structuredContent.flow;
  const mcpI2vCont1 = await i2vConn.remote.call('iris_core_continue', { key: uuid(), runId: mcpI2vRun.id, expectedRevision: mcpI2vRun.revision });
  assert(!mcpI2vCont1.isError, JSON.stringify(mcpI2vCont1));
  assert.equal((await waitOp(mcpI2vCont1.structuredContent.operation.id)).state, 'succeeded');
  const mcpI2vWire = wireDashRequests.filter(r => r.kind === 'submit').at(-1);
  assert.equal(mcpI2vWire.body.input.prompt, 'gentle camera pan');
  assert.deepEqual(mcpI2vWire.body.parameters, { resolution: '720P', duration: 5 });

  // Blocker #1 regression: video-s2v-only connection imports image + audio and creates + runs video-s2v/v0 with the SAME connection!
  const mcpImportedImg2 = await s2vConn.remote.call('iris_core_import_image', {
    key: uuid(), imageBase64: FLOW_SOURCE.toString('base64'), mediaType: 'image/png'
  });
  assert(!mcpImportedImg2.isError, JSON.stringify(mcpImportedImg2));
  const mcpImportedAud = await s2vConn.remote.call('iris_core_import_audio', {
    key: uuid(), audioBase64: AUDIO_WAV.toString('base64'), mediaType: 'audio/wav'
  });
  assert(!mcpImportedAud.isError, JSON.stringify(mcpImportedAud));
  const mcpS2vCreated = await s2vConn.remote.call('iris_core_create_video_s2v', {
    key: uuid(), sourceArtifactId: mcpImportedImg2.structuredContent.artifact.artifactId,
    audioArtifactId: mcpImportedAud.structuredContent.artifact.artifactId,
    modelRef: 'custom-prov::custom-s2v', resolution: '720P'
  });
  assert(!mcpS2vCreated.isError, 'video-s2v-only connection must be allowed to create flow from its unbound imported image & audio: ' + JSON.stringify(mcpS2vCreated));

  // Cross-group 403/error isolation: t2v cannot inspect i2v/s2v runs or read their videos, and video-i2v cannot use audio!
  assert.equal((await t2vConn.remote.call('iris_core_run', { runId: i2vReady.id })).isError, true);
  assert.equal((await t2vConn.remote.call('iris_core_video', { artifactId: i2vReady.output.artifactId })).isError, true);
  assert.equal((await i2vConn.remote.call('iris_core_run', { runId: s2vReady.id })).isError, true);
  assert.equal((await s2vConn.remote.call('iris_core_run', { runId: i2vReady.id })).isError, true);

  // Authorized MCP i2v/s2v end-to-end model listing + video resource read!
  const mcpI2vModels = await i2vConn.remote.call('iris_core_video_models', { mode: 'i2v' });
  assert(!mcpI2vModels.isError);
  assert.deepEqual(mcpI2vModels.structuredContent.models.map(m => m.modelRef), ['dash-video::wan2.6-i2v', 'custom-prov::custom-i2v', 'custom-prov::dual-i2v']);
  const mcpI2vVideo = await i2vConn.remote.call('iris_core_video', { artifactId: i2vReady.output.artifactId });
  assert.equal(mcpI2vVideo.content[0].type, 'resource_link');
  const i2vBytes = await i2vConn.remote.request('resources/read', { uri: mcpI2vVideo.content[0].uri });
  assert.deepEqual(Buffer.from(i2vBytes.contents[0].blob, 'base64'), VIDEO_MP4);
  const mcpS2vVideo = await s2vConn.remote.call('iris_core_video', { artifactId: s2vReady.output.artifactId });
  assert.equal(mcpS2vVideo.content[0].type, 'resource_link');
  const s2vBytes = await s2vConn.remote.request('resources/read', { uri: mcpS2vVideo.content[0].uri });
  assert.deepEqual(Buffer.from(s2vBytes.contents[0].blob, 'base64'), VIDEO_MP4);

  console.log('video i2v/s2v flow + DashScope resolution wire check + plugin supportsVideoMode precedence + single-group MCP import->create + dual lineage OK');
} finally {
  for (const service of services.reverse()) await service.dispose();
  for (const app of apps) await app.dispose();
  for (const registry of registries) await registry.dispose();
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  globalThis.fetch = originalFetch;
}
