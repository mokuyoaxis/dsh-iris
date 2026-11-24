import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { definePlugin, createCorePluginRegistry, createCorePluginHost, PLUGIN_MEDIA_KINDS } from '../lib/plugins.js';
import { loadPluginLaunch } from '../lib/plugin-launch.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { AUDIO_WAV } from './fixtures/audio-flow-fixture.mjs';
import { VIDEO_MP4 } from './fixtures/video-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-plugin-multimodal');
const dataRoot = path.join(root, 'core');
const outboxDir = path.join(root, 'outbox');
fs.mkdirSync(outboxDir, { mode: 0o700 });
const uuid = () => crypto.randomUUID();
const services = [], registries = [], hosts = [], apps = [];

// Legacy plugin: declares artifactInputs WITHOUT artifactInputTypes -> strictly image-only <=8 MiB!
const legacyPlugin = definePlugin({
  manifest: {
    contractVersion: 0, id: 'example.legacy', version: '1.0.0',
    compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
    contributions: {
      operations: [{
        id: 'readimg', version: '1.0.0', title: 'Legacy Image Reader', mode: 'reader',
        commands: ['artifact.read'],
        artifactInputs: ['sourceId'],
        inputSchema: { type: 'object', properties: { sourceId: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' } }, required: ['sourceId'], additionalProperties: false }
      }]
    }
  },
  activate() {
    return {
      operations: {
        async readimg(input, { core }) {
          const read = await core.execute('artifact.read', { artifact_id: input.sourceId });
          return { mediaType: read.artifact.mediaType, hasLegacyBase64: typeof read.imageBase64 === 'string', hasBytesBase64: 'bytesBase64' in read };
        }
      }
    };
  }
});

// Modern multimodal plugin: reads audio/video/text/json + lineage, imports plugin-audio/plugin-text/plugin-json!
const multimodalPlugin = definePlugin({
  manifest: {
    contractVersion: 0, id: 'example.mm', version: '1.0.0',
    compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
    contributions: {
      operations: [{
        id: 'transform', version: '1.0.0', title: 'Multimodal Inspector & Importer', mode: 'writer',
        commands: ['artifact.read', 'artifact.lineage', 'artifact.import'],
        artifactInputs: ['mediaId'],
        artifactInputTypes: { mediaId: ['image', 'audio', 'video', 'text', 'json'] },
        artifactOutputKinds: ['audio', 'text', 'json'],
        ui: { category: 'transform', summary: 'Reads any media artifact + lineage and writes derived audio/text/json.' },
        inputSchema: {
          type: 'object',
          properties: {
            mediaId: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$', title: 'Source Media' },
            outKind: { type: 'string', enum: ['audio', 'text', 'json', 'bad-json', 'bad-audio'] }
          },
          required: ['mediaId', 'outKind'],
          additionalProperties: false
        }
      }, {
        id: 'unscoped_lineage', version: '1.0.0', title: 'Unscoped Lineage Probe', mode: 'reader',
        commands: ['artifact.lineage'],
        inputSchema: {
          type: 'object',
          properties: { targetId: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' } },
          required: ['targetId'],
          additionalProperties: false
        }
      }]
    }
  },
  activate() {
    return {
      operations: {
        async unscoped_lineage(input, { core }) {
          return core.execute('artifact.lineage', { artifact_id: input.targetId });
        },
        async transform(input, { core }) {
          const read = await core.execute('artifact.read', { artifact_id: input.mediaId });
          const lineage = await core.execute('artifact.lineage', { artifact_id: input.mediaId });
          let imported;
          if (input.outKind === 'audio') {
            imported = await core.execute('artifact.import', { media_type: 'audio/wav', bytes: AUDIO_WAV });
          } else if (input.outKind === 'text') {
            imported = await core.execute('artifact.import', { media_type: 'text/plain', bytes: Buffer.from('Multimodal summary OK\n', 'utf8') });
          } else if (input.outKind === 'json') {
            imported = await core.execute('artifact.import', {
              media_type: 'application/json',
              bytes: Buffer.from(JSON.stringify({ source: input.mediaId, mediaType: read.mediaType, parents: lineage.totalParents }), 'utf8')
            });
          } else if (input.outKind === 'bad-json') {
            imported = await core.execute('artifact.import', { media_type: 'application/json', bytes: Buffer.from('{not valid json', 'utf8') });
          } else {
            imported = await core.execute('artifact.import', { media_type: 'audio/wav', bytes: Buffer.from('NOT_A_WAV_FILE') });
          }
          const producedLineage = await core.execute('artifact.lineage', { artifact_id: imported.artifact.id });
          return {
            readMediaType: read.mediaType,
            readBytes: Buffer.from(read.bytesBase64, 'base64').length,
            artifactId: imported.artifact.id,
            outputKind: imported.artifact.kind,
            sourceLineageRuns: lineage.totalRuns,
            sourceLineageChildren: lineage.children.map(c => c.artifactId),
            producedLineageParents: producedLineage.parents.map(p => p.artifactId),
            producedLineageRuns: producedLineage.totalRuns
          };
        }
      }
    };
  }
});

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

try {
  assert.deepEqual([...PLUGIN_MEDIA_KINDS], ['image', 'audio', 'video', 'text', 'json']);
  const app = createApplicationRuntime({ dataRoot }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', { video: true });
  const imgArt = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const audioArt = (await app.execute('creation.audio', { key: uuid(), bytes: AUDIO_WAV, mediaType: 'audio/wav' })).artifact;
  const videoArt = await app.run('writer', rt => rt.run('execute', async ({ dataRoot: rootDir }) => {
    const { createCoreArtifact } = await import('../lib/core-artifacts.js');
    return createCoreArtifact(rootDir, { bytes: VIDEO_MP4, kind: 'generated-video', mediaType: 'video/mp4', metadata: {}, relations: [] });
  }));

  // 1. Validate manifest contract rejects bad artifactInputTypes / artifactOutputKinds!
  assert.throws(() => definePlugin({
    manifest: {
      contractVersion: 0, id: 'example.bad-mm', version: '1.0.0',
      compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
      contributions: { operations: [{ id: 'op', version: '1.0.0', title: 'Bad', mode: 'reader', commands: ['artifact.read'],
        artifactInputs: ['id'], artifactInputTypes: { unknownField: ['audio'] },
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false } }] }
    },
    activate: () => ({ operations: { op: async () => ({}) } })
  }), { code: 'IRIS_PLUGIN_INVALID' });

  const registry = await createCorePluginRegistry({ plugins: [legacyPlugin, multimodalPlugin] }); registries.push(registry);
  const host = createCorePluginHost({ dataRoot, registry, allowedOperations: ['example.legacy.readimg', 'example.mm.transform'] }); hosts.push(host);

  // 2. Legacy plugin: image succeeds (with legacy imageBase64 only), audio is DENIED (zero silent expansion)!
  const legacyImg = await host.call('example.legacy.readimg', { sourceId: imgArt.id });
  assert.equal(legacyImg.value.mediaType, 'image/png');
  assert.equal(legacyImg.value.hasLegacyBase64, true);
  assert.equal(legacyImg.value.hasBytesBase64, false);
  await assert.rejects(host.call('example.legacy.readimg', { sourceId: audioArt.id }), { code: 'IRIS_PLUGIN_INPUT_INVALID' });

  // 3. Multimodal plugin: reads audio & video + lineage, imports plugin-audio / plugin-text / plugin-json, rejects spoofed audio / bad json!
  const mmAudio = await host.call('example.mm.transform', { mediaId: audioArt.id, outKind: 'audio' });
  assert.equal(mmAudio.value.readMediaType, 'audio/wav');
  assert.equal(mmAudio.value.outputKind, 'plugin-audio');
  const mmText = await host.call('example.mm.transform', { mediaId: videoArt.id, outKind: 'text' });
  assert.equal(mmText.value.readMediaType, 'video/mp4');
  assert.equal(mmText.value.outputKind, 'plugin-text');
  const mmJson = await host.call('example.mm.transform', { mediaId: mmText.value.artifactId, outKind: 'json' });
  assert.equal(mmJson.value.readMediaType, 'text/plain');
  assert.equal(mmJson.value.outputKind, 'plugin-json');
  await assert.rejects(host.call('example.mm.transform', { mediaId: imgArt.id, outKind: 'bad-json' }), { code: 'IRIS_PLUGIN_INPUT_INVALID' });
  await assert.rejects(host.call('example.mm.transform', { mediaId: imgArt.id, outKind: 'bad-audio' }), { code: 'IRIS_PLUGIN_INPUT_INVALID' });

  // Seed a FlowRun referencing audioArt AND an unrelated derived child artifact to verify plugin artifact.lineage projection!
  const unrelatedChild = await app.run('writer', rt => rt.run('execute', async ({ dataRoot: rootDir }) => {
    const { createCoreArtifact } = await import('../lib/core-artifacts.js');
    const { prepareFlowCreation, commitFlowCreation } = await import('../lib/flow-store.js');
    commitFlowCreation(rootDir, prepareFlowCreation({
      recipe: 'transcribe/v0',
      source: { artifactId: audioArt.id, sha256: audioArt.digest.value },
      input: { model_ref: 'private-prov::secret-asr-model', source_artifact_id: audioArt.id },
      providerBinding: 'sha256:' + 'c'.repeat(64)
    }));
    return createCoreArtifact(rootDir, {
      bytes: Buffer.from('unrelated sibling', 'utf8'), kind: 'transcript', mediaType: 'text/plain',
      metadata: {}, relations: [{ type: 'derived-from', artifactId: audioArt.id }]
    });
  }));

  // 4. Local HTTP API: /artifacts?kind=audio|video|text|json, /artifacts/:id/json, /plugin-operations/catalog multimodal sources, owner-only /outbox/files!
  const api = createLocalReadApi({
    dataRoot, serveWorkbench: true, allowLocalWrites: true, allowMcp: true,
    allowConnectionManagement: true, connectionStore: path.join(root, 'connections'),
    outboxDir, pluginRegistry: registry,
    allowedOperations: ['example.legacy.readimg', 'example.mm.transform', 'example.mm.unscoped_lineage']
  });
  services.push(api); session = await api.start();

  // Issue #6 regression: owner lineage sees the FlowRun & modelRef, whereas durable plugin artifact.lineage MUST strip Runs/modelRef, hide unrelated children, and reject unscoped targets!
  const ownerAudioLineage = await ok('/api/v0/artifacts/' + audioArt.id + '/lineage');
  assert.equal(ownerAudioLineage.totalRuns, 1);
  assert.equal(ownerAudioLineage.runs[0].modelRef, 'private-prov::secret-asr-model');
  const unscopedDep = registry.dependency('operations', 'example.mm.unscoped_lineage');
  const unscopedOp = await ok('/api/v0/plugin-operations', {
    operationId: 'example.mm.unscoped_lineage', dependency: unscopedDep, input: { targetId: audioArt.id }
  }, { key: uuid() });
  const unscopedTerm = await waitOp(unscopedOp.operation.id);
  assert.equal(unscopedTerm.state, 'failed', 'durable plugin without artifactInputs must NOT query arbitrary artifact lineage');
  assert.equal(unscopedTerm.failureCode, 'permission_denied');

  assert.equal((await ok('/api/v0/session')).outbox, true);
  assert((await ok('/api/v0/artifacts?kind=audio')).artifacts.some(a => a.artifactId === mmAudio.value.artifactId));
  assert((await ok('/api/v0/artifacts?kind=video')).artifacts.some(a => a.artifactId === videoArt.id));
  assert((await ok('/api/v0/artifacts?kind=text')).artifacts.some(a => a.artifactId === mmText.value.artifactId));
  assert((await ok('/api/v0/artifacts?kind=json')).artifacts.some(a => a.artifactId === mmJson.value.artifactId));
  const jsonPayload = await ok('/api/v0/artifacts/' + mmJson.value.artifactId + '/json');
  assert.equal(jsonPayload.source, mmText.value.artifactId);
  assert.equal(jsonPayload.parents, 0);

  const catalog = await ok('/api/v0/plugin-operations/catalog');
  const mmOp = catalog.operations.find(op => op.id === 'example.mm.transform');
  assert.deepEqual(mmOp.artifactInputTypes, { mediaId: ['image', 'audio', 'video', 'text', 'json'] });
  assert.deepEqual(mmOp.artifactOutputKinds, ['audio', 'text', 'json']);
  assert.equal(mmOp.ui.category, 'transform');
  assert(catalog.artifacts.some(a => a.id === audioArt.id && a.mediaType === 'audio/wav'));
  assert(catalog.artifacts.some(a => a.id === videoArt.id && a.mediaType === 'video/mp4'));
  assert(catalog.artifacts.some(a => a.id === mmJson.value.artifactId && a.mediaType === 'application/json'));

  // 5. MCP plugin connection + outbox export of plugin-audio + owner-only GET /api/v0/outbox/files!
  const mmDep = registry.dependency('operations', 'example.mm.transform');
  const conn = await ok('/api/v0/connection-management/connections', {
    key: uuid(), label: 'mm-client',
    capabilities: ['outbox'],
    scopes: ['read', 'create', 'execute', 'stop'],
    pluginOperations: [mmDep],
    tools: ['iris_core_connection', 'iris_core_operation', 'iris_core_lookup', 'iris_core_stop', 'iris_core_plugin_catalog', 'iris_core_plugin_call', 'iris_core_export_outbox']
  });
  const exported = await ok('/api/v0/connection-management/connections/' + conn.connectionId + '/export', { transport: 'http', format: 'entry' });
  const mcpToken = exported.configuration.headers.Authorization.slice(7);
  const remote = httpMcpClient(session.origin, mcpToken);
  await remote.initialize();
  const mcpCatalog = await remote.call('iris_core_plugin_catalog', {});
  assert(!mcpCatalog.isError);
  assert(mcpCatalog.structuredContent.artifacts.some(a => a.id === audioArt.id));

  const callRes = await remote.call('iris_core_plugin_call', {
    key: uuid(), operationId: 'example.mm.transform', dependency: mmDep,
    input: { mediaId: audioArt.id, outKind: 'audio' }
  });
  assert(!callRes.isError);
  const term = await waitOp(callRes.structuredContent.operation.id);
  assert.equal(term.state, 'succeeded');
  assert.equal(term.result.value.sourceLineageRuns, 0, 'plugin artifact.lineage must NEVER expose FlowRuns or modelRef');
  assert(!term.result.value.sourceLineageChildren.includes(unrelatedChild.id), 'durable plugin artifact.lineage must NOT expose unrelated sibling children');
  assert.deepEqual(term.result.value.producedLineageParents, [audioArt.id], 'durable plugin sees bound source as parent of its own produced artifact');
  assert.equal(term.result.value.producedLineageRuns, 0);
  const producedAudioId = term.result.artifactIds[0];

  // Export produced plugin-audio via outbox!
  const outboxRes = await remote.call('iris_core_export_outbox', { key: uuid(), artifactId: producedAudioId, name: 'plugin-track.wav' });
  assert(!outboxRes.isError, JSON.stringify(outboxRes));

  // Drop a dot-file and symlink in outboxDir to ensure listOutboxFiles ignores them and exposes zero host paths!
  fs.writeFileSync(path.join(outboxDir, '.hidden-staging'), 'ignore');
  fs.symlinkSync(path.join(outboxDir, 'plugin-track.wav'), path.join(outboxDir, 'symlink.wav'));
  const ownerOutbox = await ok('/api/v0/outbox/files');
  assert.equal(ownerOutbox.files.length, 1);
  assert.equal(ownerOutbox.files[0].name, 'plugin-track.wav');
  assert(!JSON.stringify(ownerOutbox).includes(outboxDir), 'outbox listing must never expose host path');
  // Non-owner MCP connection cannot access owner-only GET /api/v0/outbox/files (401 without handshake headers / 403 with handshake)!
  assert.equal((await json('/api/v0/outbox/files', undefined, { token: mcpToken })).status, 401);

  // 6. plugins inspect diagnostics!
  const pluginEntry = path.join(root, 'mm-plugin.mjs');
  fs.writeFileSync(pluginEntry, [
    "import { definePlugin } from " + JSON.stringify(path.resolve('lib/plugins.js')) + ";",
    "export default definePlugin({ manifest: { contractVersion: 0, id: 'example.diag', version: '1.0.0', compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },",
    "  contributions: { operations: [{ id: 'auto', version: '1.0.0', title: 'Auto Form Op', mode: 'reader', commands: ['artifact.read'], artifactInputs: ['fileId'], artifactInputTypes: { fileId: ['audio', 'text'] }, ui: { category: 'local-tool', summary: 'Zero frontend form' },",
    "    inputSchema: { type: 'object', properties: { fileId: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' } }, required: ['fileId'], additionalProperties: false } }] } },",
    "  activate: () => ({ operations: { auto: async () => ({ ok: true }) } }) });"
  ].join('\n'));
  const selectionFile = path.join(root, 'plugins.json');
  fs.writeFileSync(selectionFile, JSON.stringify({ schemaVersion: 0, entries: [pluginEntry], operations: ['example.diag.auto'] }));
  const launch = await loadPluginLaunch(selectionFile);
  try {
    assert(launch.summary.diagnostics);
    assert.equal(launch.summary.diagnostics.multimodalOperations.length, 1);
    assert.deepEqual(launch.summary.diagnostics.multimodalOperations[0], { id: 'example.diag.auto', inputTypes: { fileId: ['audio', 'text'] }, outputKinds: null });
    assert.deepEqual(launch.summary.diagnostics.autoFormOperations, [{ id: 'example.diag.auto', title: 'Auto Form Op', category: 'local-tool' }]);
  } finally { await launch.registry.dispose(); }

  console.log('plugin multimodal contract + legacy zero-expansion + lineage + owner outbox listing + inspect diagnostics OK');
} finally {
  for (const service of services.reverse()) await service.dispose();
  for (const host of hosts) await host.dispose();
  for (const app of apps) await app.dispose();
  for (const registry of registries) await registry.dispose();
}
