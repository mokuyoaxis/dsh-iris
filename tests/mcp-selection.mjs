import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { checkedClientConnection, createConnectionPair, readConnectionGrants, createConnectionRegistry } from '../lib/core-connections.js';
import { CORE_BRIDGE_TOOLS, bridgeToolsForScopes } from '../lib/core-bridge-tools.js';
import { BRIDGE_CONTROL_TOOLS, LEGACY_BRIDGE_TOOLS_V0, selectedBridgeTools } from '../lib/core-bridge-selection.js';
import { FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-selection');
const dataRoot = path.join(root, 'core'), fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
const key = () => crypto.randomUUID(), scopes = ['read', 'create', 'execute', 'stop'];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
function snapshot(directory) {
  const result = {};
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = prefix + name, stat = fs.lstatSync(file);
      result[relative] = { mode: stat.mode, ...(stat.isFile() ? { hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } : {}) };
      if (stat.isDirectory()) visit(file, relative + '/');
    }
  }
  visit(directory); return result;
}
let api, client;
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'pair'), origin: 'http://127.0.0.1:1',
    label: 'Generic selected', scopes, capabilities: [] });
  assert.equal(pair.harnessKind, 'generic');
  const source = read(pair.clientFile), grant = readConnectionGrants(pair.serverFile)[0];
  let combinations = 0;
  for (const capabilities of [[], ['image-edit'], ['image-generate'], ['image-edit', 'image-generate']]) {
    const possible = selectedBridgeTools(capabilities);
    for (const tools of [possible, [], possible.slice(0, 1)]) for (let mask = 0; mask < 8; mask++) {
      const requestedScopes = ['read', ...scopes.slice(1).filter((_scope, index) => mask & 1 << index)];
      const registry = createConnectionRegistry([{ ...grant, capabilities, tools }], scopes), runtimeInstanceId = key();
      const hello = { contractVersion: 0, adapterId: grant.adapterId, harnessKind: grant.harnessKind,
        harnessVersion: 'unregistered product', runtimeInstanceId, requestedScopes, requestedCapabilities: capabilities, requestedTools: tools };
      const accepted = registry.handshake(grant.connectionId, hello);
      const visible = bridgeToolsForScopes(requestedScopes, accepted.instance.capabilities, accepted.instance.tools).map(tool => tool.name);
      for (const tool of CORE_BRIDGE_TOOLS) {
        const call = () => registry.authorize(grant.connectionId, runtimeInstanceId, tool.scope, tool.name);
        if (visible.includes(tool.name)) assert.doesNotThrow(call);
        else assert.throws(call, { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' });
      }
      registry.dispose(); combinations++;
    }
  }
  assert.equal(combinations, 96);
  for (const capabilities of [null, ['video'], ['image-edit', 'image-edit'], '*']) {
    assert.throws(() => checkedClientConnection({ ...source, capabilities }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  }
  for (const tools of [null, ['iris_unknown'], ['iris_core_run', 'iris_core_run'], '*']) {
    assert.throws(() => checkedClientConnection({ ...source, tools }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  }
  const unsupportedDir = path.join(root, 'unimplemented');
  assert.throws(() => createConnectionPair({ dataRoot, directory: unsupportedDir, origin: source.origin, label: 'unsupported', capabilities: ['video'] }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  assert(!fs.existsSync(unsupportedDir), 'unsupported selection fails before creating files');

  const legacyPair = createConnectionPair({ dataRoot, directory: path.join(root, 'legacy'), origin: source.origin, label: 'Legacy' });
  for (const [file, wrapper] of [[legacyPair.clientFile, false], [legacyPair.serverFile, true]]) {
    const value = read(file), target = wrapper ? value.grants[0] : value;
    delete target.capabilities; delete target.tools; write(file, value);
    const before = fs.readFileSync(file);
    const loaded = wrapper ? readConnectionGrants(file)[0] : checkedClientConnection(read(file));
    assert.deepEqual(loaded.capabilities, ['image-edit']); assert.deepEqual(loaded.tools, LEGACY_BRIDGE_TOOLS_V0);
    assert.deepEqual(fs.readFileSync(file), before, 'legacy read never migrates a file');
  }
  api = createLocalReadApi({ dataRoot, allowExecution: true, allowMcp: true, executionPorts: fixture, connectionsFile: pair.serverFile });
  const started = await api.start(); write(pair.clientFile, { ...source, origin: started.origin });
  const before = snapshot(dataRoot);
  client = createCoreServiceClient({ connectionFile: pair.clientFile, requestedScopes: scopes });
  const connected = await client.connect();
  assert.deepEqual(connected.instance.tools, BRIDGE_CONTROL_TOOLS);
  const headers = { Authorization: 'Bearer ' + source.accessToken, 'Iris-Connection-Id': source.connectionId,
    'Iris-Runtime-Id': connected.instance.runtimeInstanceId };
  const session = await fetch(started.origin + '/api/v0/session', { headers });
  assert.deepEqual((await session.json()).operations, []);
  const runId = 'run_' + 'a'.repeat(24), operationId = 'op_' + 'b'.repeat(64), artifactId = 'artifact_' + 'c'.repeat(24);
  const routes = [
    ['/api/v0/models'], ['/api/v0/runs'], ['/api/v0/runs/' + runId], ['/api/v0/runs/' + runId + '/download'],
    ['/api/v0/artifacts/' + artifactId + '/content'], ['/api/v0/operations/' + operationId],
    ['/api/v0/operations?key=' + key()], ['/api/v0/runs/' + runId + '/operations'],
    ['/api/v0/images', FLOW_SOURCE, 'image/png'], ['/api/v0/runs', '{}'],
    ['/api/v0/runs/' + runId + '/continue', '{"expectedRevision":1}'], ['/api/v0/operations/' + operationId + '/cancel', '{}']
  ];
  for (const [route, body, mediaType] of routes) {
    const response = await fetch(started.origin + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': mediaType || 'application/json', 'Idempotency-Key': key() }) }, body });
    assert.equal(response.status, 403, route); await response.arrayBuffer();
  }
  const forged = createCoreServiceClient({ connection: { ...source, origin: started.origin, capabilities: ['image-edit'], tools: [...LEGACY_BRIDGE_TOOLS_V0] }, requestedScopes: ['read'] });
  await assert.rejects(forged.connect(), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' }); await forged.dispose();
  assert.deepEqual(snapshot(dataRoot), before, 'selection refusals, handshake and reads make no business-root writes');
  assert.equal(fixture.calls.submit.length, 0);
  console.log('PASS 96 selection/scope combinations, every tool authorization, legacy frozen policy, empty/unknown input and 12 direct-API bypass refusals with zero writes/submits');
} finally { await client?.dispose(); await api?.dispose(); await app.dispose(); }
