import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { useTempDshHome } from './test-env.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair, readConnectionGrants } from '../lib/core-connections.js';
import { encodeProviderConfig, wrapProviderCatalog } from '../lib/provider-config-format.js';
import { createNetworkProxyFixture } from './fixtures/network-proxy-fixture.mjs';
const { root } = useTempDshHome('iris-network-api-owner');
const dataRoot = path.join(root, 'core'), networkConfigPath = path.join(root, 'network.json'), providerConfigPath = path.join(root, 'providers.json');
const app = createApplicationRuntime({ dataRoot }), servers = [], fixture = await createNetworkProxyFixture(root);
const start = async options => { const api = createLocalReadApi({ dataRoot, providerConfigPath, networkConfigPath, ...options }); servers.push(api); return { ...await api.start(), api }; };
const call = async (session, action, body, extra = {}) => {
  const response = await fetch(session.origin + '/api/v0/' + action, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + session.accessToken,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
try {
  fs.writeFileSync(providerConfigPath, JSON.stringify({ providers: [] }), { mode: 0o600 });
  await app.execute('flow.init', {}); await app.execute('execution.init', {}); await app.dispose();
  assert.throws(() => createLocalReadApi({ dataRoot, allowNetworkManagement: true }), { code: 'IRIS_API_CONFIG_INVALID' });
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'pair'), origin: 'http://127.0.0.1:1', label: 'Unprivileged fixture', scopes: ['read'], capabilities: ['image-edit'] });
  const limited = await start({}); assert.equal((await call(limited, 'network-management/settings')).status, 405); await limited.api.dispose();
  const session = await start({ allowNetworkManagement: true, connectionsFile: pair.serverFile });
  assert.equal((await call(session, 'session')).body.networkManagement, true);
  const grant = readConnectionGrants(pair.serverFile)[0];
  for (const [action, value] of [['settings', undefined], ['doctor', undefined], ['init', {}], ['probe', {}]]) {
    assert.equal((await call(session, 'network-management/' + action, value, { Authorization: 'Bearer ' + grant.accessToken, 'Iris-Connection-Id': grant.connectionId })).status, 403);
  }
  assert(!fs.existsSync(networkConfigPath)); assert.equal(fixture.requests.length, 0);
  assert.equal((await call(session, 'network-management/init', {}, { Origin: 'https://outside.invalid' })).status, 403);
  let current = await call(session, 'network-management/settings'); assert.equal(current.body.storage, 'missing'); assert(!fs.existsSync(networkConfigPath));
  const initialized = await call(session, 'network-management/init', {}); assert.equal(initialized.status, 200); current = { body: initialized.body.settings };
  assert.equal((await call(session, 'network-management/init', {})).status, 409);
  const cfg = current.body.network;
  fs.writeFileSync(providerConfigPath, JSON.stringify(encodeProviderConfig(wrapProviderCatalog({ providers: [{ id: 'p', name: 'Fixture', baseUrl: fixture.httpOrigin,
    mediaProtocol: 'openai-images', apiKey: 'synthetic-api-owner-key', models: [] }] }, { schemaVersion: 1, configId: cfg.configId, catalogId: crypto.randomUUID() }))), { mode: 0o600 });
  current = await call(session, 'network-management/settings');
  const mutate = async (action, fields) => { const result = await call(session, 'network-management/' + action, { expectedRevision: current.body.network.revision, ...fields });
    assert.equal(result.status, 200, JSON.stringify(result.body)); current = { body: result.body.settings }; return result; };
  await mutate('pools/add', { pool: { id: 'empty', mode: 'fixed', candidates: [] } });
  await mutate('bindings/set', { expectedProviderRevision: current.body.catalog.revision, providerId: 'p', poolId: 'empty' });
  assert.equal(current.body.providers[0].route.state, 'blocked');
  const input = { expectedRevision: current.body.network.revision, expectedProviderRevision: current.body.catalog.revision, providerId: 'p', target: 'ip', url: fixture.httpOrigin + '/doctor/ip' };
  const blocked = await call(session, 'network-management/probe', input);
  assert.equal(blocked.status, 200); assert.equal(blocked.body.ok, false); assert.equal(blocked.body.dispatchStarted, false); assert.equal(fixture.requests.length, 0);
  await mutate('bindings/remove', { catalogId: current.body.catalog.catalogId, providerId: 'p', confirm: true });
  const before = fs.readFileSync(networkConfigPath);
  const doctor = await call(session, 'network-management/doctor'); assert.equal(doctor.body.networkTested, false); assert.equal(doctor.body.source, 'core-process'); assert.equal(fixture.requests.length, 0);
  const tested = await call(session, 'network-management/probe', { ...input, expectedRevision: current.body.network.revision });
  assert.equal(tested.status, 200); assert.equal(tested.body.observedIp, '203.0.113.8'); assert.equal(tested.body.route.route, 'inherit');
  assert.equal(fixture.requests.length, 1); assert.equal(fixture.requests[0].headers.authorization, undefined);
  assert(!JSON.stringify(tested.body).includes('synthetic-api-owner-key')); assert.deepEqual(fs.readFileSync(networkConfigPath), before);
  assert.equal((await call(session, 'network-management/pools/remove', { expectedRevision: 'stale', id: 'empty', confirm: true })).status, 409);
  assert.equal((await call(session, 'network-management/probe', { ...input, expectedRevision: current.body.network.revision, arbitraryKey: 'forbidden' })).status, 409);
  fs.writeFileSync(networkConfigPath, '{invalid-json');
  const invalid = await call(session, 'network-management/doctor'); assert.equal(invalid.status, 200); assert.equal(invalid.body.configuration.state, 'invalid');
  assert.equal(invalid.body.environment.systemTunnel, 'unknown'); assert.equal(invalid.body.networkTested, false); fs.writeFileSync(networkConfigPath, before);
  console.log('PASS owner opt-in API, scoped connection/Origin denial before I/O, exclusive init, CAS/bindings, blocked pool without GET, process Doctor and key-free explicit probe');
} finally { for (const api of servers) await api.dispose(); await app.dispose(); await fixture.close(); }
