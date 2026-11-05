import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectMcpSetup, mcpClientEvidence } from '../lib/web/connections.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { checkMcpConnection } from '../lib/mcp-check.js';
import { bridgeToolsForScopes } from '../lib/core-bridge-tools.js';
import { createCoreCapabilityCatalog } from '../lib/core-capability-catalog.js';
import { loadCorePluginRegistry } from '../lib/plugins.js';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-setup'), dataRoot = path.join(root, 'core'), directory = path.join(root, 'connections');
const app = createApplicationRuntime({ dataRoot }), checks = [], key = crypto.randomUUID();
let api, session, registry;
async function request(route, value) {
  const response = await fetch(session.origin + '/api/v0/' + route, { method: value === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + session.accessToken, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  assert(response.ok, route + ' HTTP ' + response.status); return response.json();
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile())
  .map(name => [name, sha(fs.readFileSync(path.join(dataRoot, name)))]));
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { audio: true });
  api = createLocalReadApi({ dataRoot, allowConnectionManagement: true, connectionStore: directory, allowMcp: true }); session = await api.start();
  await request('connection-management/connections', { key, label: 'Setup <img onerror=alert(1)>', scopes: ['read'], capabilities: ['image-edit'] });
  const catalog = await request('connection-management/catalog'), before = tree();
  const file = path.join(directory, 'profiles', key + '.json'), profileBytes = fs.readFileSync(file), profile = JSON.parse(profileBytes);
  const record = () => request('connection-management/connections').then(value => value.connections.find(item => item.connectionId === key));
  let saved = await record();
  const result = inspectMcpSetup(saved, catalog);
  assert.equal(result.ok, true); assert.equal(result.transportTested, false); assert.equal(result.mediaTested, false);
  assert.deepEqual(new Set(result.tools), new Set(bridgeToolsForScopes(['read'], ['image-edit']).map(tool => tool.name)));
  assert.equal(mcpClientEvidence(saved, catalog).state, 'waiting');
  let intersections = 0;
  for (let mask = 0; mask < 1 << catalog.groups.length; mask++) for (const scopes of [['read'], ['read', 'create', 'execute', 'stop']]) for (const empty of [false, true]) {
    const capabilities = catalog.groups.filter((_, index) => mask & 1 << index).map(group => group.id);
    const selected = empty ? [] : bridgeToolsForScopes(['read', 'create', 'execute', 'stop'], capabilities).map(tool => tool.name);
    const projection = inspectMcpSetup({ ...saved, scopes, capabilities, tools: selected }, catalog);
    const expected = bridgeToolsForScopes(scopes.filter(scope => catalog.availableScopes.includes(scope)), capabilities, selected)
      .map(tool => tool.name).filter(name => catalog.availableTools.includes(name));
    assert.deepEqual(new Set(projection.tools), new Set(expected)); intersections++;
  }
  await request('session'); await request('connection-management/catalog'); await record();
  assert(fs.readFileSync(file).equals(profileBytes)); assert.deepEqual(tree(), before);
  assert.deepEqual((await record()).instances, []);
  checks.push(`owner GET-only setup inspection derives eight actual read tools and ${intersections} Core scope/group/tool intersections, changes no grant/business bytes and creates no handshake or declaration`);

  const exported = await request('connection-management/connections/' + key + '/export', { transport: 'stdio', format: 'entry' });
  const clientFile = exported.configuration.args[exported.configuration.args.indexOf('--connection-file') + 1];
  const probe = await checkMcpConnection({ connectionFile: clientFile }); assert.equal(probe.ok, true);
  saved = await record();
  assert(saved.instances.length > 0); assert.equal(saved.lastContact, null);
  assert.notEqual(mcpClientEvidence(saved, catalog).state, 'observed');
  checks.push('existing CLI check performs its real temporary handshake while the UI refuses to count it as an Agent declaration');

  const remote = httpMcpClient(session.origin, profile.accessToken, { version: '2026-07-28', name: 'setup-protocol-client' });
  await remote.initialize(); const tools = (await remote.request('tools/list')).tools.map(tool => tool.name);
  assert.deepEqual(new Set(result.tools), new Set(tools));
  await remote.call('iris_core_connections', {});
  const deadline = performance.now() + 5000;
  do { saved = await record(); if (saved.lastContact) break; await new Promise(resolve => setTimeout(resolve, 30)); } while (performance.now() < deadline);
  const evidence = mcpClientEvidence(saved, catalog);
  assert.equal(evidence.state, 'observed'); assert(evidence.instances.some(item => item.clientInfo.name === 'setup-protocol-client'));
  for (const instance of evidence.instances) assert.deepEqual(new Set(instance.tools), new Set(tools));
  assert.deepEqual(tree(), before);
  const narrowed = { ...saved, instances: saved.instances.map(instance => ({ ...instance, scopes: ['read'], tools: [...profile.tools, 'iris_core_continue'] })) };
  assert(!mcpClientEvidence(narrowed, catalog).instances[0].tools.includes('iris_core_continue'));
  assert.equal(mcpClientEvidence({ ...saved, instances: [] }, catalog).state, 'historical');
  assert.equal(mcpClientEvidence({ ...saved, instances: saved.instances.map(item => ({ ...item, state: 'disconnected' })) }, catalog).state, 'disconnected');
  checks.push('formal HTTP MCP discovery matches the projected tool set; actual client declaration, historical receipt, disconnect and read-only negotiated tools remain distinct');

  for (const [change, choice, code] of [
    [{ revokedAt: new Date().toISOString() }, {}, 'revoked'], [{}, { location: 'other' }, 'location'], [{}, { location: 'unknown' }, 'location'],
    [{ tools: [] }, {}, 'tools'], [{ scopes: ['read', 'execute'] }, {}, 'scope'], [{ capabilities: ['not-enabled'] }, {}, 'capability']
  ]) assert(inspectMcpSetup({ ...saved, ...change }, catalog, choice).issues.some(item => item.code === code));
  assert(inspectMcpSetup(saved, { ...catalog, httpEnabled: false }, { transport: 'http' }).issues.some(item => item.code === 'transport'));
  assert.equal(mcpClientEvidence({ ...saved, revokedAt: 'now' }, catalog).state, 'revoked');

  registry = await loadCorePluginRegistry({ entries: [path.resolve('plugins/contact-sheet/index.mjs')] });
  const pluginCatalog = createCoreCapabilityCatalog({ registry }).snapshot({ allowedOperations: ['community.contact-sheet.create'] });
  const available = { ...pluginCatalog, availableScopes: ['read', 'execute', 'stop'], availableTools: [...pluginCatalog.tools, ...pluginCatalog.pluginTools].map(item => item.name), httpEnabled: true };
  const pin = registry.dependency('operations', 'community.contact-sheet.create'), pluginRecord = { ...saved, capabilities: [], pluginOperations: [pin],
    scopes: ['read', 'execute'], tools: ['iris_core_plugin_catalog', 'iris_core_plugin_call'] };
  assert.equal(inspectMcpSetup(pluginRecord, available).ok, true);
  assert(inspectMcpSetup({ ...pluginRecord, pluginOperations: [{ ...pin, pluginVersion: '9.0.0' }] }, available).issues.some(item => item.code === 'plugin'));
  assert(inspectMcpSetup(pluginRecord, catalog).issues.some(item => item.code === 'plugin'));
  const omitted = createCoreCapabilityCatalog({ registry }).snapshot();
  assert(inspectMcpSetup(pluginRecord, { ...available, ...omitted }).issues.some(item => item.message.includes('未启用')));
  const privateValues = [profile.accessToken, dataRoot, directory];
  for (const text of [JSON.stringify(result), JSON.stringify(evidence)]) for (const value of privateValues) assert(!text.includes(value));
  await request('connection-management/connections/' + key + '/revoke', { expectedRevision: profile.revision });
  saved = await record();
  assert.deepEqual(inspectMcpSetup(saved, catalog).tools, []); assert.equal(mcpClientEvidence(saved, catalog).state, 'revoked');
  await assert.rejects(remote.request('tools/list'), error => [401, 403].includes(error.status));
  assert.deepEqual(tree(), before);
  checks.push('location, HTTP gate, revoked/limited/zero-tool profiles and exact plugin pins produce bounded explanations without auto-grants or credential/path disclosure');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally { await api?.dispose(); await app.dispose(); await registry?.dispose(); }
