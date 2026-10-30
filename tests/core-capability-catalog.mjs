import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCorePluginRegistry, createCoreCapabilityCatalog, createCorePluginHost } from '@mokuyoaxis/dsh-iris/plugins';
import { CORE_CAPABILITY_TOOLS, CORE_PLUGIN_BRIDGE_TOOLS, projectCoreSessionOperations } from '../lib/core-capability-catalog.js';
import { CORE_BRIDGE_TOOLS, bridgeToolsForScopes } from '../lib/core-bridge-tools.js';
import { BRIDGE_CAPABILITIES, LEGACY_BRIDGE_TOOLS_V0, selectedBridgeTools } from '../lib/core-bridge-selection.js';
import { checkedClientConnection } from '../lib/core-connections.js';
import { connectionSkillResources } from '../lib/connection-skill.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { loadCorePluginFixture } from './fixtures/core-plugin-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-capability-catalog'), { fixturePlugin } = await loadCorePluginFixture();
const registries = [], services = [], apps = [], clients = [], hosts = [], checks = [];
const uuid = () => crypto.randomUUID();
const scopes = ['read', 'create', 'execute', 'stop'];
const declarations = new Map([...CORE_CAPABILITY_TOOLS, ...CORE_PLUGIN_BRIDGE_TOOLS].map(tool => [tool.name, tool]));
const files = directory => Object.fromEntries(fs.readdirSync(directory, { recursive: true }).filter(name => fs.lstatSync(path.join(directory, name)).isFile())
  .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
try {
  const empty = createCoreCapabilityCatalog();
  assert.equal(empty.snapshot().groups.length, 2); assert.equal(empty.snapshot({ audioEnabled: true }).groups.length, 4);
  assert.equal(CORE_BRIDGE_TOOLS.length, 21); assert.equal(empty.snapshot({ audioEnabled: true }).tools.length, 19);
  assert.equal(empty.snapshot().pluginTools.length, 2);
  assert(!selectedBridgeTools([]).includes('iris_core_plugin_call'), 'discovery does not select the new business tools');
  assert.deepEqual(empty.snapshot().plugins, []); assert.deepEqual(empty.selectOperations(), []);
  for (const tool of CORE_BRIDGE_TOOLS) {
    const source = declarations.get(tool.name);
    assert.equal(tool.parameters, source.parameters); assert.equal(tool.description, source.description);
    assert(source.guidance.length > 40); assert(scopes.includes(source.scope));
    assert.equal(source.groups.length === 0, [...empty.snapshot().controlTools, ...empty.snapshot().pluginTools.map(item => item.name)].includes(tool.name));
    for (const group of source.groups) assert(BRIDGE_CAPABILITIES.find(item => item.id === group).tools.includes(tool.name));
  }
  assert.throws(() => empty.snapshot({ audioEnabled: true }).groups[0].tools.push('forged'), TypeError);
  let combinations = 0;
  for (let groupMask = 0; groupMask < 16; groupMask++) for (let scopeMask = 0; scopeMask < 8; scopeMask++) {
    const capabilities = BRIDGE_CAPABILITIES.filter((_, i) => groupMask & 1 << i).map(item => item.id);
    const grantedScopes = ['read', ...scopes.slice(1).filter((_, i) => scopeMask & 1 << i)];
    for (const selection of [selectedBridgeTools(capabilities), []]) {
      const actual = bridgeToolsForScopes(grantedScopes, capabilities, selection);
      const bundle = { schemaVersion: 0, kind: 'iris-mcp-skill', rootId: uuid(), connectionId: uuid(), revision: 1,
        label: 'Selection', scopes: grantedScopes, capabilities, tools: actual.map(tool => tool.name) };
      if (actual.length) {
        const text = connectionSkillResources(bundle).bytes['SKILL.md'].toString();
        for (const tool of actual) assert(text.includes('- `' + tool.name + '`: ' + declarations.get(tool.name).guidance));
        assert.equal([...text.matchAll(/^- `iris_core_/gm)].length, actual.length);
      }
      for (const audio of [false, true]) for (const execution of [false, true]) {
        const operations = projectCoreSessionOperations({ scopes: grantedScopes, tools: actual.map(tool => tool.name),
          audio, imageGeneration: false, execution, creationLookup: true, selection: true });
        assert(!operations.includes('generations.create'));
        assert(!operations.includes('creation.lookup')); assert(!operations.includes('runs.select'), 'owner-only aliases have no bridge tool');
        if (!audio) assert(!operations.some(id => /audio|speech|transcri/.test(id)));
        if (!execution) assert(!operations.some(id => id.startsWith('operations.') || id === 'runs.continue'));
        if (!grantedScopes.includes('create')) assert(!operations.some(id => id.endsWith('.create')));
        if (!grantedScopes.includes('execute')) assert(!operations.includes('runs.continue'));
        if (!grantedScopes.includes('stop')) assert(!operations.includes('operations.stop'));
        if (!actual.length) assert.deepEqual(operations, []);
        combinations++;
      }
    }
  }
  checks.push(`${combinations} root/service/scope/tool intersections; selected Skill entries use the Core guidance and no writer is granted by discovery`);

  let calls = 0;
  const registry = await createCorePluginRegistry({ plugins: [fixturePlugin({ operation: async () => { calls++; return { total: 0 }; } })] }); registries.push(registry);
  const catalog = createCoreCapabilityCatalog({ registry }), full = catalog.snapshot({ audioEnabled: true });
  assert.equal(full.plugins[0].id, 'example.media');
  assert.deepEqual(Object.values(full.contributions).map(entries => entries.length), [1, 2, 1, 1, 0]);
  assert.equal(full.contributions.operations[0].access.local, 'requires-grant');
  assert.equal(full.contributions.operations[1].access.mcp, 'durable-operation-required');
  assert.equal(full.contributions.pages[0].access.web, 'not-mounted');
  assert.equal(full.contributions.pages[0].entry, undefined); assert.equal(full.contributions.renderers[0].entry, undefined);
  assert.deepEqual(full.contributions.providers[0].dependency, registry.dependency('providers', 'example.media.images'));
  assert.equal(calls, 0); assert.deepEqual(catalog.selectOperations(), []);
  for (const ids of [null, '*', ['example.media.unknown'], ['example.media.list', 'example.media.list'], ['iris_core_models']]) {
    assert.throws(() => catalog.selectOperations(ids), { code: 'IRIS_PLUGIN_OPERATION_DENIED' });
  }
  assert.throws(() => full.contributions.operations[0].inputSchema.properties.limit.maximum = 900, TypeError);
  const absentRoot = path.join(root, 'never-created');
  const denied = createCorePluginHost({ dataRoot: absentRoot, registry }); hosts.push(denied);
  await assert.rejects(denied.call('example.media.list', {}), { code: 'IRIS_PLUGIN_OPERATION_DENIED' });
  assert(!fs.existsSync(absentRoot)); assert.equal(calls, 0);
  checks.push('four kinds retain exact dependency metadata; discovery is immutable, exposes no module path, invokes nothing and grants nothing');

  for (const version of [1, 2, 3]) {
    const dataRoot = path.join(root, 'core-' + version), application = createApplicationRuntime({ dataRoot }); apps.push(application);
    await application.execute('flow.init', {});
    await application.execute('execution.init', version === 3 ? { audio: true } : version === 2 ? { imageGeneration: true } : {});
    const connectionStore = path.join(root, 'connections-' + version);
    const api = createLocalReadApi({ dataRoot, allowLocalWrites: true, allowConnectionManagement: true, connectionStore, allowMcp: true, pluginRegistry: registry }); services.push(api);
    const session = await api.start(), baseline = files(dataRoot);
    const request = async (route, value, headers = { Authorization: 'Bearer ' + session.accessToken }) => {
      const response = await fetch(session.origin + '/api/v0/' + route, { method: value === undefined ? 'GET' : 'POST',
        headers: { ...headers, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      return { status: response.status, body: await response.json() };
    };
    const fullCatalog = await request('capabilities'); assert.equal(fullCatalog.status, 200);
    const managed = (await request('connection-management/catalog')).body;
    for (const field of ['groups', 'tools', 'scopeOptions', 'media', 'controlTools', 'plugins', 'contributions']) assert.deepEqual(managed[field], fullCatalog.body[field]);
    assert.equal(managed.groups.length, version === 3 ? 4 : 2);
    assert(!JSON.stringify(fullCatalog.body).includes(dataRoot)); assert(!JSON.stringify(fullCatalog.body).includes(session.accessToken));
    assert.equal((await request('capabilities', undefined, {})).status, 401);
    assert.equal((await request('capabilities?grant=all')).status, 400);
    const status = (await request('session')).body;
    assert.equal(status.operations.includes('generations.create'), version >= 2);
    assert.equal(status.operations.includes('speeches.create'), version === 3);
    assert(!status.operations.includes('runs.continue')); assert(!status.operations.includes('operations.inspect'));
    const key = uuid(), created = await request('connection-management/connections', { key, label: 'Explicit saved selection',
      scopes: ['read'], capabilities: ['image-edit'], tools: [...LEGACY_BRIDGE_TOOLS_V0] });
    assert.equal(created.status, 201);
    const file = path.join(connectionStore, 'profiles', key + '.json'), bytes = fs.readFileSync(file), profile = JSON.parse(bytes);
    const remote = httpMcpClient(session.origin, profile.accessToken); await remote.initialize();
    const tools = (await remote.request('tools/list')).tools;
    assert.deepEqual(tools.map(tool => tool.name), bridgeToolsForScopes(['read'], ['image-edit'], LEGACY_BRIDGE_TOOLS_V0).map(tool => tool.name));
    for (const tool of tools) {
      assert.equal(tool.description, declarations.get(tool.name).description);
      const { $schema, ...wire } = tool.inputSchema; wire.required ||= [];
      assert.equal($schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.deepEqual(wire, declarations.get(tool.name).parameters);
    }
    await assert.rejects(remote.call('example.media.list', {}), { rpcCode: -32602 }); assert.equal(calls, 0);
    const exposed = await request('connection-management/connections', { key: uuid(), label: 'No accidental plugin grant', scopes: ['read'], capabilities: ['image-edit'], tools: ['example.media.list'] });
    assert.equal(exposed.status, 400);
    const connection = checkedClientConnection({ schemaVersion: 0, origin: session.origin, adapterId: 'iris.mcp', harnessKind: 'generic', ...Object.fromEntries(
      ['rootId', 'connectionId', 'label', 'accessToken', 'capabilities', 'tools'].map(name => [name, profile[name]])) });
    const client = createCoreServiceClient({ connection, requestedScopes: ['read'] }); clients.push(client);
    const hello = await client.connect();
    const headers = { Authorization: 'Bearer ' + profile.accessToken, 'Iris-Connection-Id': profile.connectionId, 'Iris-Runtime-Id': hello.instance.runtimeInstanceId };
    assert.equal((await request('capabilities', undefined, headers)).status, 403);
    const skill = (await request('connection-management/connections/' + key + '/skill', {})).body;
    assert.deepEqual(skill.bundle.tools, tools.map(tool => tool.name)); assert(!skill.preview.includes('example.media.list'));
    const contacted = JSON.parse(fs.readFileSync(file));
    for (const name of ['rootId', 'connectionId', 'label', 'scopes', 'capabilities', 'tools', 'revision', 'creationDigest']) {
      assert.deepEqual(contacted[name], profile[name], 'discovery and client metadata do not change authorization: ' + name);
    }
    assert.equal(crypto.createHash('sha256').update(contacted.accessToken).digest('hex'), crypto.createHash('sha256').update(profile.accessToken).digest('hex'));
    assert.equal(contacted.lastContact.source, 'client-declared');
    assert.deepEqual(files(dataRoot), baseline, 'all catalog and denied calls leave business storage intact');
    const local = createCorePluginHost({ dataRoot, registry, allowedOperations: catalog.selectOperations(['example.media.list']).map(item => item.id) }); hosts.push(local);
    assert.equal((await local.call('example.media.list', {})).value.total, 0);
    calls = 0;
    await api.dispose(); assert.equal(registry.snapshot().state, 'active', 'service does not own a caller-supplied registry');
  }
  checks.push('real HTTP and official-SDK MCP on v1/v2/v3 preserve schema/root gates, exact saved grants, owner discovery and zero business writes');
  const other = await createCorePluginRegistry({ plugins: [] }); registries.push(other);
  assert.throws(() => createLocalReadApi({ dataRoot: root, pluginRegistry: registry, providerRegistry: other.providers }), { code: 'IRIS_API_CONFIG_INVALID' });
  await registry.dispose();
  assert(catalog.snapshot().contributions.operations.every(item => Object.values(item.access).every(value => value === 'unavailable')));
  assert.throws(() => catalog.selectOperations(['example.media.list']), { code: 'IRIS_PLUGIN_CLOSED' });
  const closed = createLocalReadApi({ dataRoot: root, pluginRegistry: registry }); services.push(closed);
  await assert.rejects(closed.start(), { code: 'IRIS_API_CONFIG_INVALID' });
  checks.push('shared registry ownership, conflicting assembly and closed-catalog selections fail clearly');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  for (const client of clients) await client.dispose();
  for (const service of services) await service.dispose();
  for (const host of hosts) await host.dispose();
  for (const application of apps) await application.dispose();
  for (const registry of registries) await registry.dispose();
}
