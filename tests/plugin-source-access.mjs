import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { definePlugin, createCorePluginRegistry, createCorePluginWorkbench } from '@mokuyoaxis/dsh-iris/plugins';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCoreArtifact } from '../lib/core-artifacts.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';

const work = fs.mkdtempSync(path.join(process.env.IRIS_TEST_EVIDENCE_DIRECTORY || os.tmpdir(), 'iris-plugin-source-'));
const dataRoot = path.join(work, 'core'), app = createApplicationRuntime({ dataRoot }), checks = [];
const large = await sharp(crypto.randomBytes(1900 * 1600 * 3), { raw: { width: 1900, height: 1600, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
assert(large.length > 8 * 1024 * 1024 && large.length < 20 * 1024 * 1024);
function plugin(id) {
  const inputSchema = { type: 'object', properties: { source: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' },
    unbound: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' } }, required: ['source'], additionalProperties: false };
  return definePlugin({ manifest: { contractVersion: 0, id, version: '0.1.0', compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' }, contributions: {
    operations: [
      ...['copy', 'large'].map(name => ({ id: name, version: '0.1.0', title: name, mode: 'writer', commands: ['artifact.read', 'artifact.import'], artifactInputs: ['source'], inputSchema })),
      { id: 'info', version: '0.1.0', title: 'Info', mode: 'reader', commands: ['artifact.list'], inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
    ] } }, activate() { return { operations: {
      async copy(input, { core }) {
        if (input.unbound) await core.execute('artifact.read', { artifact_id: input.unbound });
        const source = await core.execute('artifact.read', { artifact_id: input.source });
        const value = await core.execute('artifact.import', { image_bytes: Buffer.from(source.imageBase64, 'base64') });
        return { artifactId: value.artifact.id };
      },
      async large(_input, { core }) {
        const value = await core.execute('artifact.import', { image_bytes: large });
        return { artifactId: value.artifact.id };
      },
      info() { return { ok: true }; }
    } }; } });
}
let registry, api, started;
const owner = () => ({ Authorization: 'Bearer ' + started.accessToken });
async function request(route, { input, headers = owner(), key, expected = 200 } = {}) {
  const response = await fetch(started.origin + route, { method: input ? 'POST' : 'GET', headers: { ...headers,
    ...(input ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}) });
  const body = await response.json(); assert.equal(response.status, expected, route + ': ' + JSON.stringify(body)); return body;
}
async function submit(operationId, input, headers = owner(), expected = 202) {
  const key = crypto.randomUUID(), value = await request('/api/v0/plugin-operations', { input: {
    operationId, dependency: registry.dependency('operations', operationId), input }, key, headers, expected });
  if (expected !== 202) return value;
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const operation = (await request('/api/v0/operations/' + value.operation.id, { headers })).operation;
    if (!['queued', 'running'].includes(operation.state)) return { key, operation };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('source policy operation did not finish');
}
async function image(id, headers, expected = 200) {
  const response = await fetch(started.origin + '/api/v0/artifacts/' + id + '/content', { headers });
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, expected, 'Artifact ' + id + ': HTTP ' + response.status); return bytes;
}
async function connection(ids, capabilities = []) {
  const created = await request('/api/v0/connection-management/connections', { input: { key: crypto.randomUUID(), label: 'Source policy fixture',
    scopes: ['read', 'execute', 'stop'], capabilities, pluginOperations: ids.map(id => registry.dependency('operations', id)) }, expected: 201 });
  const record = (await request('/api/v0/connection-management/connections')).connections.find(item => item.connectionId === created.connectionId);
  const exported = await request('/api/v0/connection-management/connections/' + record.connectionId + '/export', { input: { transport: 'http', format: 'entry' } });
  return handshake(record, exported.configuration.headers);
}
async function handshake(record, credentialHeaders) {
  const runtimeInstanceId = crypto.randomUUID(), headers = { ...credentialHeaders, 'Iris-Connection-Id': record.connectionId, 'Iris-Runtime-Id': runtimeInstanceId };
  await request('/api/v0/connections/' + record.connectionId + '/handshake', { headers, input: { contractVersion: 0, adapterId: 'iris.mcp', harnessKind: 'generic',
    runtimeInstanceId, harnessVersion: 'source policy fixture', requestedScopes: record.scopes, requestedCapabilities: record.capabilities,
    requestedTools: record.tools, requestedPluginOperations: record.pluginOperations } });
  return { record, credentialHeaders, headers };
}
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { audio: true });
  const original = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const rawLarge = (await app.execute('artifact.import', { image_bytes: large })).artifact;
  const gifBytes = await sharp(FLOW_SOURCE).gif().toBuffer();
  const writer = createCoreRuntime({ dataRoot, mode: 'writer' }); writer.start();
  let gif;
  try { gif = await writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, { bytes: gifBytes, mediaType: 'image/gif', kind: 'fixture' })); }
  finally { await writer.dispose(); }
  registry = await createCorePluginRegistry({ plugins: [plugin('audit.source-a'), plugin('audit.source-b')] });
  const operations = ['audit.source-a', 'audit.source-b'].flatMap(id => ['copy', 'large', 'info'].map(name => id + '.' + name));
  const config = path.join(work, 'providers.json'); fs.writeFileSync(config, JSON.stringify({ providers: [], assignments: {} }), { mode: 0o600 });
  api = createCorePluginWorkbench({ dataRoot, registry, allowedOperations: operations, allowMcp: true, connectionStore: path.join(work, 'connections'),
    providerConfigPath: config, allowProviderManagement: true });
  started = await api.start();
  const a = await submit('audit.source-a.copy', { source: original.id }); assert.equal(a.operation.state, 'succeeded');
  const aImage = a.operation.result.artifactIds[0], aLarge = await submit('audit.source-a.large', { source: original.id });
  assert.equal(aLarge.operation.state, 'succeeded'); const aLargeImage = aLarge.operation.result.artifactIds[0];
  const b = await connection(['audit.source-b.copy', 'audit.source-b.large']);
  const catalog = await request('/api/v0/plugin-operations/catalog', { headers: b.headers });
  assert(catalog.artifacts.some(item => item.id === aImage)); assert(!catalog.artifacts.some(item => [rawLarge.id, aLargeImage, gif.id].includes(item.id)));
  assert.deepEqual(await image(aImage, b.headers), FLOW_SOURCE);
  assert.deepEqual(await image(original.id, b.headers), FLOW_SOURCE);
  const copied = await submit('audit.source-b.copy', { source: aImage }, b.headers); assert.equal(copied.operation.state, 'succeeded');
  assert.deepEqual(await image(copied.operation.result.artifactIds[0], b.headers), FLOW_SOURCE);
  checks.push('a connection granted only B can discover, preview and compose eligible images made by A in the same root');

  await request('/api/v0/operations/' + a.operation.id, { headers: b.headers, expected: 403 });
  await request('/api/v0/operations?key=' + a.key, { headers: b.headers, expected: 403 });
  await request('/api/v0/operations/' + a.operation.id + '/cancel', { input: {}, headers: b.headers, expected: 403 });
  await submit('audit.source-a.copy', { source: original.id }, b.headers, 403);
  await request('/api/v0/provider-management/settings', { headers: b.headers, expected: 403 });
  await request('/api/v0/connection-management/connections', { headers: b.headers, expected: 403 });
  checks.push('source-image sharing does not authorize another business, its history/key/stop controls or owner provider/connection management');

  await image(rawLarge.id, b.headers, 403); await image(aLargeImage, b.headers, 403); await image(gif.id, b.headers, 403);
  const tooLarge = await submit('audit.source-b.copy', { source: aLargeImage }, b.headers);
  assert.equal(tooLarge.operation.state, 'failed'); assert.deepEqual(tooLarge.operation.result.artifactIds, []);
  const unbound = await submit('audit.source-b.copy', { source: original.id, unbound: aImage }, b.headers);
  assert.equal(unbound.operation.state, 'failed'); assert.deepEqual(unbound.operation.result.artifactIds, []);
  const ownLarge = await submit('audit.source-b.large', { source: original.id }, b.headers); assert.equal(ownLarge.operation.state, 'succeeded');
  assert.deepEqual(await image(ownLarge.operation.result.artifactIds[0], b.headers), large);
  checks.push('source type/8 MiB and per-call binding remain enforced; larger outputs of an explicitly selected business retain their existing delivery grant');

  const infoOnly = await connection(['audit.source-b.info']);
  assert.deepEqual((await request('/api/v0/plugin-operations/catalog', { headers: infoOnly.headers })).artifacts, []);
  await image(aImage, infoOnly.headers, 403); await image(original.id, infoOnly.headers, 403);
  checks.push('a business without image inputs does not receive the shared source-image grant');

  const speechOnly = await connection(['audit.source-b.info'], ['tts']);
  await image(rawLarge.id, speechOnly.headers, 403); await image(original.id, speechOnly.headers, 403);
  const mediaReader = await connection(['audit.source-b.info'], ['image-edit']);
  assert.deepEqual(await image(rawLarge.id, mediaReader.headers), large);
  checks.push('combining a plugin control tool with speech does not grant images; an explicitly selected image group keeps its existing larger raw-image access');

  await request('/api/v0/connection-management/connections/' + b.record.connectionId + '/update', { input: { expectedRevision: b.record.revision,
    label: b.record.label, scopes: b.record.scopes, capabilities: [], tools: b.record.tools.filter(name => name !== 'iris_core_image'), pluginOperations: b.record.pluginOperations } });
  const latest = (await request('/api/v0/connection-management/connections')).connections.find(item => item.connectionId === b.record.connectionId);
  const limited = await handshake(latest, b.credentialHeaders); await image(aImage, limited.headers, 403);
  checks.push('removing the image tool from the saved grant still prevents direct image delivery after a fresh handshake');
  console.log(JSON.stringify({ ok: true, checks, work }, null, 2));
} finally { await api?.dispose(); await registry?.dispose(); await app.dispose(); }
