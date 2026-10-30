import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair, readPrivateConnectionJson } from '../lib/core-connections.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { FLOW_SOURCE, FLOW_MODEL, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-connection-management'), dataRoot = path.join(root, 'core'), store = path.join(root, 'managed');
let submitGate;
const fixture = imageFlowFixture(dataRoot, { beforeSubmit: async () => { if (submitGate) await submitGate; } }), app = createApplicationRuntime({ dataRoot, ...fixture }), children = [], clients = [];
const BASE = '/api/v0/connection-management', uuid = () => crypto.randomUUID();
let api, session;
const options = { dataRoot, serveWorkbench: true, allowConnectionManagement: true, connectionStore: store, allowMcp: true, allowExecution: true, executionPorts: fixture };
const request = async (route, value, { token = session.accessToken, headers = {} } = {}) => {
  const response = await fetch(session.origin + route, { headers: { Authorization: 'Bearer ' + token,
    ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(value === undefined ? {} : { method: 'POST', body: JSON.stringify(value) }) });
  return { status: response.status, body: await response.json() };
};
const ok = async (route, value) => { const result = await request(BASE + route, value); assert(result.status < 300, JSON.stringify(result)); return result.body; };
const list = async () => (await ok('/connections')).connections;
const record = async id => (await list()).find(item => item.connectionId === id);
const profile = label => ({ key: uuid(), label, scopes: ['read'], capabilities: ['image-edit'] });
const config = async (id, transport = 'http') => (await ok('/connections/' + id + '/export', { transport, format: 'entry' })).configuration;
const readProfile = id => readPrivateConnectionJson(path.join(store, 'profiles', id + '.json'));
const hashCore = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile())
  .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, name))).digest('hex')]));
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'static'), origin: 'http://127.0.0.1:1', label: 'Legacy static' });
  options.connectionsFile = pair.serverFile; const staticBefore = fs.readFileSync(pair.serverFile);
  const before = hashCore();
  assert.throws(() => createLocalReadApi({ dataRoot, connectionStore: store }), { code: 'IRIS_API_CONFIG_INVALID' });
  assert.throws(() => createLocalReadApi({ dataRoot, allowConnectionManagement: true }), { code: 'IRIS_API_CONFIG_INVALID' });
  api = createLocalReadApi(options); session = await api.start();
  const runningBefore = hashCore();
  const status = (await request('/api/v0/session')).body; assert.equal(status.connectionManagement, true); assert.equal(status.workbenchMediaReadOnly, false);
  assert(status.operations.includes('runs.continue')); assert(!status.operations.includes('runs.select'), 'execution does not implicitly grant selection');
  const catalog = await ok('/catalog'); assert.equal(catalog.media.length, 6); assert.equal(catalog.groups.length, 2); assert.equal(catalog.httpEnabled, true);
  assert.deepEqual(catalog.media.find(item => item.id === 'image').capabilities, ['image-edit', 'image-generate']);
  const first = profile('<img src=x onerror=alert(1)> / any brand');
  const created = await Promise.all([ok('/connections', first), ok('/connections', first)]);
  assert.equal(created[0].connectionId, first.key); assert.equal(created[1].connectionId, first.key);
  assert.equal(created.filter(item => item.idempotentReplay).length, 1);
  const sameName = await ok('/connections', { ...first, key: uuid() }); assert.notEqual(sameName.connectionId, first.key);
  assert.equal((await list()).length, 3); assert.equal((await record(pair.connectionId)).managed, false);
  assert(!JSON.stringify(await list()).includes(readProfile(first.key).accessToken)); assert(!JSON.stringify(await list()).includes(root));
  for (const [headers, token] of [[{ Origin: 'https://outside.invalid' }, session.accessToken], [{}, 'x'.repeat(43)]]) {
    const denied = await request(BASE + '/connections', profile('Denied'), { headers, token }); assert([401, 403].includes(denied.status));
  }
  const host = await new Promise((resolve, reject) => {
    const req = http.get(session.origin + BASE + '/connections', { headers: { Authorization: 'Bearer ' + session.accessToken, Host: 'outside.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
  }); assert.equal(host, 403);
  assert.equal((await request(BASE + '/connections', { ...profile('invalid'), scopes: ['admin'] })).status, 403);
  assert.equal((await request(BASE + '/connections', { ...profile('invalid'), capabilities: ['video'] })).status, 400);
  assert.equal((await list()).length, 3); assert.equal(fixture.calls.submit.length, 0);
  for (const transport of ['stdio', 'http']) for (const version of ['2025-11-25', '2026-07-28']) {
    const input = profile('Same harness multiple workspaces'), created = await ok('/connections', input);
    const name = 'Unlisted harness ' + transport + ' ' + version;
    const exported = await config(created.connectionId, transport);
    const client = transport === 'stdio' ? stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read', { version, name, launch: exported })
      : httpMcpClient(session.origin, exported.headers.Authorization.slice(7), { version, name });
    if (transport === 'stdio') children.push(client);
    await client.initialize(); await client.call('iris_core_models', {});
    const saved = await record(created.connectionId);
    assert.equal(saved.lastContact.clientInfo.name, name, 'real SDK client declaration must reach durable store');
    assert.equal(saved.lastContact.source, 'client-declared'); assert.equal(saved.lastContact.transport, transport);
    assert(saved.instances[0].harnessVersion.startsWith('Iris '), 'bridge version is separate');
    assert(saved.instances[0].declaredClient.clientInfo.name === name);
    const forbidden = await request(BASE + '/connections', profile('Not owner'), { token: readProfile(created.connectionId).accessToken,
      headers: { 'Iris-Connection-Id': created.connectionId, 'Iris-Runtime-Id': saved.instances[0].runtimeInstanceId } }); assert.equal(forbidden.status, 403);
    const edit = { label: 'Renamed', scopes: ['read'], capabilities: ['image-edit'], tools: saved.tools, expectedRevision: saved.revision };
    await ok('/connections/' + saved.connectionId + '/update', edit);
    assert.equal((await client.call('iris_core_models', {})).isError, undefined, 'rename preserves active authorization');
    const renamed = await record(saved.connectionId);
    assert.equal(renamed.instances.length, 1, 'rename cannot retire a cached HTTP bridge');
    assert.equal(renamed.instances[0].runtimeInstanceId, saved.instances[0].runtimeInstanceId);
    assert.equal(renamed.instances[0].state, 'connected');
    const changed = await record(saved.connectionId);
    await ok('/connections/' + saved.connectionId + '/update', { ...edit, capabilities: [], tools: [], expectedRevision: changed.revision });
    if (transport === 'stdio') assert.equal((await client.call('iris_core_models', {})).isError, true, 'old stdio schema cannot bypass new Core grant');
    else assert.deepEqual((await client.request('tools/list')).tools, [], 'HTTP rebuilds from current tool selection');
    const revised = await record(saved.connectionId);
    assert.equal((await request(BASE + '/connections/' + saved.connectionId + '/update', edit)).status, 409, 'CAS rejects stale editor');
    await ok('/connections/' + saved.connectionId + '/revoke', { expectedRevision: revised.revision });
    if (transport === 'stdio') assert.equal((await client.call('iris_core_models', {})).isError, true);
    else await assert.rejects(client.request('tools/list'), error => error.status === 401);
    assert.equal((await request(BASE + '/connections/' + saved.connectionId + '/export', { transport: 'http', format: 'entry' })).status, 409);
    if (transport === 'stdio') assert.equal((await client.close()).status, 0);
    console.log('PASS managed', transport, version, 'client declaration, rename, selection shrink, owner isolation and revoke');
  }
  const unknown = await ok('/connections', profile('No self declaration'));
  const connection = { schemaVersion: 0, origin: session.origin, ...(() => { const value = readProfile(unknown.connectionId);
    const { rootId, connectionId, accessToken, label, capabilities, tools } = value; return { rootId, connectionId, accessToken, label, capabilities, tools, adapterId: 'iris.mcp', harnessKind: 'generic' }; })() };
  const direct = createCoreServiceClient({ connection }); clients.push(direct); await direct.connect(); await direct.models();
  assert.equal((await record(unknown.connectionId)).lastContact, null, 'bridge handshake does not invent harness name');
  const inputRecord = await record(unknown.connectionId);
  const forged = await request('/api/v0/connections/' + unknown.connectionId + '/client-info', { clientInfo: { name: 'safe', version: '1', scopes: ['execute'] }, transport: 'http' }, {
    token: connection.accessToken, headers: { 'Iris-Connection-Id': unknown.connectionId, 'Iris-Runtime-Id': direct.snapshot().runtimeInstanceId } }); assert.equal(forged.status, 400);
  assert.deepEqual((await record(unknown.connectionId)).scopes, inputRecord.scopes);
  assert.deepEqual(hashCore(), runningBefore, 'all management and MCP reads leave business bytes and existing execution lease unchanged');
  assert.equal(fixture.calls.submit.length, 0); assert.deepEqual(fs.readFileSync(pair.serverFile), staticBefore);
  await direct.dispose(); await api.dispose();
  assert.deepEqual(hashCore(), before, 'after explicit runner shutdown the complete Core tree matches its original bytes');
  const oldToken = session.accessToken, port = Number(new URL(session.origin).port);
  api = createLocalReadApi(options); session = await api.start({ port });
  assert.equal((await request('/api/v0/session', undefined, { token: oldToken })).status, 401);
  const restored = await list(); assert.equal(restored.filter(item => item.state === 'revoked').length, 4);
  assert(restored.filter(item => item.state === 'revoked').every(item => item.lastContact?.clientInfo && !item.instances.length));
  const firstConfig = await config(first.key); const stillWorks = httpMcpClient(session.origin, firstConfig.headers.Authorization.slice(7)); await stillWorks.initialize();
  assert.equal((await stillWorks.request('tools/list')).tools.length, 8);
  assert.deepEqual(fs.readFileSync(pair.serverFile), staticBefore);
  // A revoked caller loses access, while the already accepted Operation keeps its original identity.
  const full = await ok('/connections', { ...profile('Explicit operation'), scopes: ['read', 'create', 'execute', 'stop'] });
  const stored = readProfile(full.connectionId);
  const writer = createCoreServiceClient({ connection: { ...connection, connectionId: full.connectionId, accessToken: stored.accessToken,
    label: stored.label, tools: stored.tools, capabilities: stored.capabilities }, requestedScopes: stored.scopes }); clients.push(writer); await writer.connect();
  const source = await writer.createImage({ key: uuid(), bytes: FLOW_SOURCE, mediaType: 'image/png' });
  const run = await writer.createRun({ key: uuid(), value: { sourceArtifactId: source.artifact.artifactId, modelRef: FLOW_MODEL, prompt: 'Explicit controlled test only' } });
  let release; submitGate = new Promise(resolve => { release = resolve; });
  const accepted = await writer.continueRun({ key: uuid(), runId: run.flow.id, expectedRevision: run.flow.revision });
  await ok('/connections/' + full.connectionId + '/revoke', { expectedRevision: 1 });
  await assert.rejects(writer.models(), { code: 'IRIS_CONNECTION_AUTH_REQUIRED' }); release();
  let terminal;
  for (let index = 0; index < 200; index++) {
    terminal = (await request('/api/v0/operations/' + accepted.operation.id)).body.operation;
    if (!['queued', 'running'].includes(terminal.state)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(terminal.state, 'succeeded'); assert.equal(terminal.id, accepted.operation.id); assert.equal(fixture.calls.submit.length, 1);
  assert.equal((await record(full.connectionId)).state, 'revoked');
  await ok('/connections/' + full.connectionId + '/delete', { expectedRevision: 2 });
  assert.equal(await record(full.connectionId), undefined);
  assert.equal((await request('/api/v0/operations/' + accepted.operation.id)).body.operation.state, 'succeeded', 'deleting a grant preserves accepted work');
  const removedIds = [];
  const beforeDelete = hashCore();
  for (const transport of ['stdio', 'http']) {
    const input = profile('Delete connected ' + transport); await ok('/connections', input);
    const exported = await config(input.key, transport), token = readProfile(input.key).accessToken;
    const client = transport === 'stdio' ? stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read', { launch: exported })
      : httpMcpClient(session.origin, token);
    if (transport === 'stdio') children.push(client);
    await client.initialize(); await client.call('iris_core_models', {});
    const active = await record(input.key), route = BASE + '/connections/' + input.key + '/delete';
    const unprivileged = await request(route, { expectedRevision: 1 }, { token, headers: { 'Iris-Connection-Id': input.key, 'Iris-Runtime-Id': active.instances[0].runtimeInstanceId } });
    assert.equal(unprivileged.status, 403);
    assert.equal((await request(route, { expectedRevision: 1 }, { headers: { Origin: 'https://outside.invalid' } })).status, 403);
    assert.equal((await request(route, { expectedRevision: 0 })).status, 409);
    const staticDelete = await request(BASE + '/connections/' + pair.connectionId + '/delete', { expectedRevision: 1 });
    assert.equal(staticDelete.status, 409); assert.equal(staticDelete.body.error.code, 'IRIS_CONNECTION_NOT_FOUND', 'static grants cannot be deleted by management');
    assert.equal((await request(route, { expectedRevision: 1 })).body.deleted, true);
    assert.equal((await request(route, { expectedRevision: 1 })).body.idempotentReplay, true);
    assert.equal(await record(input.key), undefined);
    assert.equal((await request(BASE + '/connections', input)).status, 409, 'stale creation cannot revive a deleted grant');
    assert.equal((await request(BASE + '/connections/' + input.key + '/export', { transport, format: 'entry' })).status, 409);
    assert.equal((await request(BASE + '/connections/' + input.key + '/skill', {})).status, 409);
    if (transport === 'stdio') { assert.equal((await client.call('iris_core_models', {})).isError, true); assert.equal((await client.close()).status, 0); }
    else await assert.rejects(client.request('tools/list'), error => error.status === 401);
    removedIds.push(input.key);
  }
  assert.deepEqual(hashCore(), beforeDelete, 'deletion and MCP invalidation never modify business bytes');
  assert.deepEqual(fs.readFileSync(pair.serverFile), staticBefore);
  await api.dispose(); api = createLocalReadApi(options); session = await api.start({ port });
  assert((await list()).every(item => !removedIds.includes(item.connectionId) && item.connectionId !== full.connectionId));
  for (const id of removedIds) assert.equal((await ok('/connections/' + id + '/delete', { expectedRevision: 1 })).idempotentReplay, true);
  console.log('PASS delete connected stdio/HTTP grants, owner/Origin/CAS boundaries, replay/restart and accepted-operation preservation');
  console.log('PASS private exports, stable concurrent creation, arbitrary labels, default metadata unknown, persisted revoke and owner restart');
} finally {
  for (const child of children.reverse()) await child.kill();
  for (const client of clients) await client.dispose();
  await api?.dispose(); await app.dispose();
}
