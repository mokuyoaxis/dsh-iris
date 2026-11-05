import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadCorePluginRegistry, createCorePluginRegistry } from '@mokuyoaxis/dsh-iris/plugins';
import { projectPluginStatus } from '../lib/web/plugin-status.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { checkedClientConnection, createConnectionPair } from '../lib/core-connections.js';
import { loadCorePluginFixture } from './fixtures/core-plugin-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-plugin-status'), fixture = await loadCorePluginFixture();
const registry = await loadCorePluginRegistry({ entries: [fixture.entry] }), dataRoot = path.join(root, 'core');
const connectionStore = path.join(root, 'connections'), app = createApplicationRuntime({ dataRoot }), checks = [];
const hashTree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile())
  .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, name))).digest('hex')]));
let api, session, bridge, newer;
const request = async (route, value, headers = { Authorization: 'Bearer ' + session.accessToken }) => {
  const response = await fetch(session.origin + '/api/v0/' + route, { method: value === undefined ? 'GET' : 'POST', headers: { ...headers,
    ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { status: response.status, body: await response.json() };
};
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const before = hashTree();
  api = createLocalReadApi({ dataRoot, serveWorkbench: true, pluginRegistry: registry, allowedOperations: ['example.media.import'],
    panelContributions: { pages: ['example.media.library'] }, allowConnectionManagement: true, connectionStore });
  session = await api.start();
  const catalog = (await request('capabilities')).body, pin = registry.dependency('operations', 'example.media.import');
  const initial = projectPluginStatus(catalog, []);
  assert.equal(initial.plugins.length, 1); assert.equal(initial.enabled, 1); assert.deepEqual(initial.authorizations, []);
  assert.equal(projectPluginStatus(catalog, null).authorizations, null, 'unread grants remain unknown');
  assert.equal(initial.plugins[0].compatibility.min, '0.3.0-alpha.1');
  assert.equal(initial.plugins[0].contributions.find(item => item.id === 'example.media.library').access.web, 'available-in-panel');
  assert.equal(initial.plugins[0].contributions.find(item => item.id === 'example.media.png').access.web, 'not-mounted');
  assert.equal(initial.plugins[0].contributions.find(item => item.id === 'example.media.images').access.local, 'requires-configuration');
  const resource = await fetch(session.origin + '/plugin-status.js'); assert.equal(resource.status, 200);
  assert.match(resource.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(session.origin + '/plugin-status.js', { method: 'POST' })).status, 405);
  assert.equal((await request('capabilities', undefined, {})).status, 401);
  assert.equal((await request('capabilities?probe=1')).status, 400);
  checks.push('real owner catalog preserves compatibility, mounting and Provider configuration boundaries; static resource has existing method/auth gates');

  const create = async (label, scopes, tools) => {
    const key = crypto.randomUUID();
    assert.equal((await request('connection-management/connections', { key, label, capabilities: [], scopes, tools, pluginOperations: [pin] })).status, 201);
    return JSON.parse(fs.readFileSync(path.join(connectionStore, 'profiles', key + '.json')));
  };
  const fullTools = ['iris_core_connection', 'iris_core_connections', 'iris_core_plugin_call', 'iris_core_plugin_catalog'];
  const read = await create('Read only', ['read'], fullTools);
  const noTool = await create('No call tool', ['read', 'execute'], ['iris_core_plugin_catalog']);
  const allowed = await create('Allowed <img onerror=alert(1)>', ['read', 'execute'], fullTools);
  const records = () => request('connection-management/connections').then(value => value.body.connections);
  let facts = projectPluginStatus(catalog, await records());
  const authorization = (facts, record) => facts.authorizations.find(item => item.connectionId === record.connectionId);
  assert.deepEqual([read, noTool, allowed].map(record => authorization(facts, record).code), ['scope', 'tool', 'permitted']);
  assert.equal(authorization(facts, allowed).connectionLabel, allowed.label);
  assert.deepEqual(authorization(facts, allowed).instances, []);
  const same = { ...pin }; delete same.pluginId; same.pluginId = pin.pluginId;
  assert.equal(projectPluginStatus(catalog, [{ ...allowed, pluginOperations: [same] }]).authorizations[0].code, 'permitted', 'JSON member ordering does not change exact identity');
  const stale = { ...pin, pluginVersion: '0.9.0' };
  assert.equal(projectPluginStatus(catalog, [{ ...allowed, pluginOperations: [stale] }]).authorizations[0].code, 'version');
  checks.push('saved exact grants distinguish missing execute scope, omitted call tool, permitted configuration and version mismatch without treating JSON key order as identity');

  const connection = checkedClientConnection({ schemaVersion: 0, origin: session.origin, adapterId: 'iris.mcp', harnessKind: 'generic', ...Object.fromEntries(
    ['rootId', 'connectionId', 'label', 'accessToken', 'capabilities', 'tools', 'pluginOperations'].map(key => [key, allowed[key]])) });
  bridge = createCoreServiceClient({ connection, requestedScopes: ['read'] });
  const hello = await bridge.connect();
  facts = projectPluginStatus(catalog, await records());
  assert.equal(authorization(facts, allowed).code, 'permitted');
  assert.equal(authorization(facts, allowed).instances[0].code, 'scope', 'read-only handshake never implies execution authority');
  assert.equal((await request('capabilities', undefined, { Authorization: 'Bearer ' + allowed.accessToken, 'Iris-Connection-Id': allowed.connectionId,
    'Iris-Runtime-Id': hello.instance.runtimeInstanceId })).status, 403);
  await bridge.dispose(); bridge = null;
  assert.equal(authorization(projectPluginStatus(catalog, await records()), allowed).instances[0].code, 'disconnected');
  assert.equal((await request('connection-management/connections/' + allowed.connectionId + '/update', { expectedRevision: allowed.revision,
    label: allowed.label, scopes: ['read'], capabilities: [], tools: fullTools, pluginOperations: [pin] })).status, 200);
  assert.equal(authorization(projectPluginStatus(catalog, await records()), allowed).code, 'scope');
  assert.equal((await request('connection-management/connections/' + noTool.connectionId + '/revoke', { expectedRevision: noTool.revision })).status, 200);
  assert.equal(authorization(projectPluginStatus(catalog, await records()), noTool).code, 'revoked');
  checks.push('actual handshake shrinkage, disconnect, saved permission reduction and revocation remain separate; MCP credentials cannot read owner-only discovery');

  await api.dispose();
  newer = await createCorePluginRegistry({ plugins: [fixture.fixturePlugin({ version: '1.1.0' })] });
  api = createLocalReadApi({ dataRoot, serveWorkbench: true, pluginRegistry: newer, allowedOperations: ['example.media.import'],
    allowConnectionManagement: true, connectionStore }); session = await api.start();
  facts = projectPluginStatus((await request('capabilities')).body, await records());
  assert.equal(authorization(facts, read).code, 'version'); assert.equal(facts.plugins[0].version, '1.1.0');
  await api.dispose(); await newer.dispose(); newer = null;
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'static-pair'), origin: session.origin, label: 'Static read grant',
    capabilities: [], scopes: ['read'], tools: fullTools, pluginOperations: [pin] });
  api = createLocalReadApi({ dataRoot, serveWorkbench: true, pluginRegistry: registry, allowedOperations: ['example.media.import'], connectionsFile: pair.serverFile });
  session = await api.start();
  facts = projectPluginStatus((await request('capabilities')).body, (await request('connections')).body.connections);
  assert.equal(facts.authorizations[0].code, 'scope'); assert.equal((await request('session')).body.connectionManagement, false);
  checks.push('actual restart with a different plugin version preserves old pins; static grants are readable without enabling connection management');

  await api.dispose(); api = createLocalReadApi({ dataRoot, serveWorkbench: true, pluginRegistry: registry,
    allowConnectionManagement: true, connectionStore }); session = await api.start();
  facts = projectPluginStatus((await request('capabilities')).body, await records());
  assert.equal(facts.enabled, 0); assert.equal(authorization(facts, read).code, 'disabled');
  await registry.dispose();
  facts = projectPluginStatus((await request('capabilities')).body, await records());
  assert.equal(facts.state, 'closed'); assert.equal(authorization(facts, read).code, 'closed');
  await api.dispose(); api = createLocalReadApi({ dataRoot, serveWorkbench: true, allowConnectionManagement: true, connectionStore }); session = await api.start();
  facts = projectPluginStatus((await request('capabilities')).body, await records());
  assert.deepEqual(facts.plugins, []); assert.equal(facts.missing.length, 3); assert.equal(authorization(facts, read).code, 'missing');
  assert.equal(authorization(facts, noTool).code, 'revoked', 'missing plugin does not reactivate a revoked grant');
  const text = JSON.stringify(facts);
  for (const secret of [dataRoot, fixture.directory, session.accessToken, read.accessToken, allowed.accessToken, noTool.accessToken]) assert(!text.includes(secret));
  assert.deepEqual(hashTree(), before, 'diagnostics, management and handshake never write business records');
  checks.push('restarts with omitted execution, closed registry and missing plugin retain accurate saved grants, no credential/module paths and byte-identical Core business storage');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally { await bridge?.dispose(); await api?.dispose(); await app.dispose(); await newer?.dispose(); await registry.dispose(); }
