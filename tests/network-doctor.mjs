import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { useTempDshHome } from './test-env.js';
import { createNetworkProxyFixture } from './fixtures/network-proxy-fixture.mjs';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { networkManagementSettings } from '../lib/network-management.js';
import { networkDoctor, probeNetworkRoute } from '../lib/network-doctor.js';
import { encodeProviderConfig, wrapProviderCatalog } from '../lib/provider-config-format.js';
const { root } = useTempDshHome('iris-network-doctor'), fixture = await createNetworkProxyFixture(root);
const networkConfigPath = path.join(root, 'network.json'), providerConfigPath = path.join(root, 'providers.json');
const requirement = { schemaVersion: 1, configId: crypto.randomUUID(), catalogId: crypto.randomUUID() };
let manager;
try {
  const proxy = await fixture.createProxy({ tag: 'doctor' }), secure = await fixture.createProxy({ tag: 'doctor-tls', tls: true });
  const config = { schemaVersion: 2, configId: requirement.configId, generation: 1, nodes: [{ id: 'proxy', protocol: 'http', host: '127.0.0.1', port: proxy.port },
    { id: 'secure', protocol: 'https', host: '127.0.0.1', port: secure.port }],
    pools: [{ id: 'pool', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'proxy' }] }, { id: 'secure-pool', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'secure' }] }],
    bindings: [{ catalogId: requirement.catalogId, providerId: 'p', poolId: 'pool' }, { catalogId: requirement.catalogId, providerId: 'q', poolId: 'secure-pool' }] };
  fs.writeFileSync(networkConfigPath, JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(providerConfigPath, JSON.stringify(encodeProviderConfig(wrapProviderCatalog({ providers: [{ id: 'p', name: 'Fixture', baseUrl: fixture.httpOrigin,
    mediaProtocol: 'openai-images', apiKey: 'synthetic-doctor-key', models: [] }, { id: 'q', name: 'Secure fixture', baseUrl: fixture.httpsOrigin,
    mediaProtocol: 'openai-images', auth: 'none', models: [] }] }, requirement))), { mode: 0o600 });
  manager = createProviderNetworkManager({ networkConfigPath, tls: { ca: fixture.ca }, proxyTls: { ca: fixture.ca } });
  const opts = { networkConfigPath, providerConfigPath, resolveProviderNetwork: manager.resolveProviderNetwork };
  const savedNetwork = fs.readFileSync(networkConfigPath), savedProvider = fs.readFileSync(providerConfigPath), state = networkManagementSettings(opts);
  const input = { expectedRevision: state.network.revision, expectedProviderRevision: state.catalog.revision, providerId: 'p', target: 'ip', url: fixture.httpOrigin + '/doctor/ip' };
  networkDoctor(opts); assert.equal(fixture.requests.length, 0); assert.equal(proxy.connects.length, 0);
  const result = await probeNetworkRoute(opts, input);
  assert.equal(result.ok, true); assert.equal(result.observedIp, '203.0.113.8'); assert.equal(result.route.nodeId, 'proxy'); assert.equal(result.responseReceived, true);
  assert.equal(fixture.requests.length, 1); assert(proxy.connects.length > 0);
  assert.equal(fixture.requests[0].method, 'GET'); assert.equal(fixture.requests[0].headers.authorization, undefined); assert.equal(fixture.requests[0].headers['proxy-authorization'], undefined);
  assert(!JSON.stringify(result).includes('fixture response body')); assert(!JSON.stringify(result).includes('synthetic-doctor-key'));
  const wrongContext = await probeNetworkRoute({ ...opts, resolveProviderNetwork: () => manager.resolveProviderNetwork({ providerId: 'other', networkRequirement: requirement }) }, input);
  assert.equal(wrongContext.issue, 'IRIS_NETWORK_CONTEXT_REQUIRED'); assert.equal(wrongContext.dispatchStarted, false); assert.equal(fixture.requests.length, 1);
  await assert.rejects(probeNetworkRoute(opts, { ...input, expectedRevision: 'stale' }), { code: 'IRIS_NETWORK_CONFIG_CHANGED' });
  await assert.rejects(probeNetworkRoute(opts, { ...input, url: 'http://user:password@127.0.0.1' }), { code: 'IRIS_NETWORK_PROBE_INVALID' });
  assert.equal(fixture.requests.length, 1);
  const redirected = await probeNetworkRoute(opts, { ...input, target: 'custom', url: fixture.httpOrigin + '/doctor/redirect' });
  assert.equal(redirected.ok, false); assert.equal(fixture.requests.filter(row => row.path === '/doctor/ip').length, 1, 'no follow-up GET on redirect');
  const large = await probeNetworkRoute(opts, { ...input, target: 'custom', url: fixture.httpOrigin + '/doctor/large' });
  assert.equal(large.issue, 'IRIS_NETWORK_PROBE_TOO_LARGE'); assert.equal(large.reachable, true);
  const denied = await probeNetworkRoute(opts, { ...input, target: 'custom', url: fixture.httpOrigin + '/doctor/error' });
  assert.equal(denied.httpStatus, 403); assert.equal(denied.reachable, true); assert(!JSON.stringify(denied).includes('fixture private upstream detail'));
  const controller = new AbortController(), pending = probeNetworkRoute(opts, { ...input, target: 'custom', url: fixture.httpOrigin + '/hold/doctor' }, { signal: controller.signal });
  const canceled = assert.rejects(pending, error => error.name === 'AbortError'); await fixture.waitForRequests(row => row.path === '/hold/doctor'); controller.abort(); await canceled; fixture.release('/hold/doctor');
  const tls = await probeNetworkRoute(opts, { ...input, providerId: 'q', url: fixture.httpsOrigin + '/doctor/ip' });
  assert.equal(tls.ok, true); assert.equal(tls.route.nodeId, 'secure'); assert(secure.connects.some(row => row.tls)); assert(fixture.requests.at(-1).tls);
  const timeout = await probeNetworkRoute(opts, { ...input, target: 'custom', url: fixture.httpOrigin + '/hold/doctor-timeout' });
  assert.equal(timeout.issue, 'IRIS_NETWORK_PROBE_TIMEOUT'); assert.equal(timeout.dispatchStarted, true); assert.equal(timeout.responseReceived, false); fixture.release('/hold/doctor-timeout');
  assert.deepEqual(fs.readFileSync(networkConfigPath), savedNetwork); assert.deepEqual(fs.readFileSync(providerConfigPath), savedProvider);
  assert(fixture.requests.every(row => row.method === 'GET')); assert(!fs.existsSync(path.join(root, 'task-store')));
  console.log('PASS actual Core-client HTTP/HTTPS proxy GET, finite IP observation, no provider key/body echo, static zero-network, redirect/body limits, 8-second timeout, cancellation and no config/Task writes');
} finally { await fixture.close(); await manager?.dispose(); }
