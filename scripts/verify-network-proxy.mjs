// Explicit local HTTP/HTTPS integration check. Requires the approved Undici dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNetworkProxyFixture, within } from '../tests/fixtures/network-proxy-fixture.mjs';

const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === '--package-root' && path.isAbsolute(args[1]), 'Usage: [--package-root <absolute-unpacked-package>]');
const sourceRoot = args[1] || fileURLToPath(new URL('..', import.meta.url));
const { createProviderNetworkManager } = await import(pathToFileURL(path.join(sourceRoot, 'lib/network-routing.js')));
const { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-real-proxy-'));
const fixture = await createNetworkProxyFixture(root), managers = [], checks = [], facts = [];
const originalDispatcher = getGlobalDispatcher(), originalFetch = globalThis.fetch;
const envNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'IRIS_PROXY_TEST_USER', 'IRIS_PROXY_TEST_PASSWORD'];
const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const user = 'fixture-proxy-user', password = 'fixture-proxy-password';
const authorization = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
const hostDispatcher = new ProxyAgent({ uri: 'http://127.0.0.1:1', connectTimeout: 1000 });
let inheritedCalls = 0;
const make = options => {
  const manager = createProviderNetworkManager({ networkConfigPath: file, tls: { ca: fixture.ca }, proxyTls: { ca: fixture.ca },
    onRoute: (fact, context) => facts.push({ fact, context }), preflightTimeoutMs: 1500, ...options });
  managers.push(manager); return manager;
};
const configId = crypto.randomUUID(), catalogId = crypto.randomUUID(), requirement = { schemaVersion: 1, configId, catalogId };
const file = path.join(root, 'network.json');
try {
  process.env.IRIS_PROXY_TEST_USER = user; process.env.IRIS_PROXY_TEST_PASSWORD = password;
  process.env.HTTP_PROXY = 'http://127.0.0.1:1'; process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  setGlobalDispatcher(hostDispatcher); // Simulate a host-owned global policy, only in this test process.
  globalThis.fetch = (...args) => { inheritedCalls++; return originalFetch(...args); };
  const inheritedFetch = globalThis.fetch;
  const a = await fixture.createProxy({ tag: 'a', auth: authorization });
  const b = await fixture.createProxy({ tag: 'b', tls: true });
  const bad = await fixture.createProxy({ tag: 'rejected', rejectStatus: 407 });
  const config = { schemaVersion: 2, configId, generation: 1,
    nodes: [
      { id: 'a', protocol: 'http', host: '127.0.0.1', port: a.port, auth: { usernameEnv: 'IRIS_PROXY_TEST_USER', passwordEnv: 'IRIS_PROXY_TEST_PASSWORD' } },
      { id: 'b', protocol: 'https', host: '127.0.0.1', port: b.port },
      { id: 'rejected', protocol: 'http', host: '127.0.0.1', port: bad.port }
    ], pools: [
      { id: 'pa', mode: 'ordered', candidates: [{ kind: 'node', nodeId: 'rejected' }, { kind: 'node', nodeId: 'a' }, { kind: 'node', nodeId: 'b' }] },
      { id: 'pb', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'b' }] },
      { id: 'direct', mode: 'fixed', candidates: [{ kind: 'direct' }] },
      { id: 'down', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'rejected' }] }
    ], bindings: [['p', 'pa'], ['q', 'pb'], ['r', 'direct'], ['z', 'down']].map(([providerId, poolId]) => ({ catalogId, providerId, poolId })) };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const manager = make();
  const client = id => manager.resolveProviderNetwork({ providerId: id, networkRequirement: requirement });
  const p = client('p'), q = client('q'), direct = client('r');
  const [one, two] = await Promise.all([
    p.run(async fetch => (await fetch(fixture.httpOrigin + '/provider/p', { headers: { Authorization: 'Bearer provider-p' } })).json(), { operation: 'discover' }),
    q.run(async fetch => (await fetch(fixture.httpsOrigin + '/provider/q', { headers: { Authorization: 'Bearer provider-q' } })).json(), { operation: 'discover' })
  ]);
  assert.equal(one.authorization, 'Bearer provider-p'); assert.equal(two.authorization, 'Bearer provider-q');
  assert(a.connects.some(row => row.authority === new URL(fixture.httpOrigin).host));
  assert(b.connects.some(row => row.authority === new URL(fixture.httpsOrigin).host));
  assert(a.connects.every(row => row.headers['proxy-authorization'] === authorization));
  assert(a.connects.every(row => row.headers.authorization === undefined));
  assert(fixture.requests.every(row => row.headers['proxy-authorization'] === undefined));
  assert.equal(inheritedCalls, 0);
  assert.equal(globalThis.fetch, inheritedFetch); assert.equal(getGlobalDispatcher(), hostDispatcher);
  checks.push('real HTTP and HTTPS proxies carry isolated providers via CONNECT; credentials reach only their intended endpoints');

  const directResult = await direct.run(async fetch => (await fetch(fixture.httpOrigin + '/direct')).json(), { operation: 'discover' });
  assert.equal(directResult.path, '/direct'); assert.equal(inheritedCalls, 0);
  assert(facts.some(value => value.fact.providerId === 'r' && value.fact.route === 'direct'));
  await assert.rejects(client('unbound').run(fetch => fetch(fixture.httpOrigin + '/unbound'), { operation: 'discover' }));
  assert.equal(inheritedCalls, 1, 'unbound providers still use the host policy');
  assert(!fixture.requests.some(row => row.path === '/unbound'));
  checks.push('explicit direct and proxy policies override host dispatcher/environment only for bound requests; unbound requests inherit');

  const redirected = await p.run(async fetch => Buffer.from(await (await fetch(fixture.httpOrigin + '/cdn/redirect')).arrayBuffer()), { operation: 'download' });
  assert.deepEqual(redirected, fixture.media);
  assert(fixture.requests.filter(row => row.path.startsWith('/cdn/')).every(row => !row.headers.authorization && !row.headers['proxy-authorization']));
  checks.push('cross-origin HTTP to HTTPS CDN redirect remains on the selected route without Provider or proxy credentials reaching the CDN');

  const standbyBefore = b.connects.length;
  await assert.rejects(p.run(fetch => fetch(fixture.httpOrigin + '/received-then-reset', { method: 'POST', body: 'generation' }), { operation: 'submit' }), { code: 'IRIS_NETWORK_TRANSPORT' });
  assert.equal(fixture.requests.filter(row => row.path === '/received-then-reset' && row.method === 'POST').length, 1);
  assert.equal(b.connects.length, standbyBefore, 'response loss cannot trigger another exit or replay');
  const beforeDown = inheritedCalls, beforeRequests = fixture.requests.length;
  await assert.rejects(client('z').run(fetch => fetch(fixture.httpOrigin + '/must-not-submit', { method: 'POST' }), { operation: 'submit' }), error => error.acceptance === 'not_accepted' && error.providerCode === 'IRIS_NETWORK_POOL_EXHAUSTED');
  assert.equal(inheritedCalls, beforeDown); assert.equal(fixture.requests.length, beforeRequests);
  checks.push('only preflight failures choose backups; server-received POST response loss is never replayed; exhausted pools never inherit');

  const untrusted = make({ tls: undefined });
  const untrustedClient = untrusted.resolveProviderNetwork({ providerId: 'q', networkRequirement: requirement });
  const tlsBefore = fixture.requests.length;
  await assert.rejects(untrustedClient.run(fetch => fetch(fixture.httpsOrigin + '/untrusted'), { operation: 'discover' }), { code: 'IRIS_NETWORK_TRANSPORT' });
  assert.equal(fixture.requests.length, tlsBefore);
  checks.push('target certificate validation remains enabled; fixture CA is confined to explicitly trusted test clients');

  const controller = new AbortController();
  const canceled = p.run(async fetch => (await fetch(fixture.httpOrigin + '/hold/p', { signal: controller.signal })).json(), { operation: 'discover' });
  const canceledCheck = assert.rejects(canceled, error => error.name === 'AbortError');
  const unaffected = q.run(async fetch => (await fetch(fixture.httpOrigin + '/hold/q')).json(), { operation: 'discover' });
  await fixture.waitForRequests(row => row.path === '/hold/p'); await fixture.waitForRequests(row => row.path === '/hold/q');
  controller.abort(); await within(canceledCheck); fixture.release('/hold/p');
  fixture.release('/hold/q'); assert.equal((await within(unaffected)).path, '/hold/q');

  let ready;
  const headers = new Promise(resolve => { ready = resolve; });
  const body = p.run(async fetch => { const response = await fetch(fixture.httpOrigin + '/slow-body'); ready(); return response.text(); }, { operation: 'download' });
  await within(headers); const closing = p.dispose();
  assert.equal(p.snapshot().state, 'closing'); assert.equal(p.snapshot().activeOperations, 1);
  fixture.release('/slow-body'); assert.equal(await within(body), 'first-last'); await within(closing);
  await q.run(async fetch => (await fetch(fixture.httpOrigin + '/after-p-close')).text(), { operation: 'discover' });
  checks.push('cancellation and disposal are per client; close waits for response body while another client remains usable');
  assert.equal(getGlobalDispatcher(), hostDispatcher); assert.equal(globalThis.fetch, inheritedFetch);
  assert.equal(fixture.plainProxyRequests.length, 0); assert.deepEqual(fixture.errors, []);
  console.log(JSON.stringify({ ok: true, checks, root, connects: fixture.connects.length, upstreamRequests: fixture.requests.length,
    note: 'All endpoints are controlled loopback fixtures; no real provider, Clash or system TUN certification.' }, null, 2));
} finally {
  globalThis.fetch = originalFetch; setGlobalDispatcher(originalDispatcher);
  for (const name of envNames) { if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name]; }
  await fixture.close();
  await Promise.allSettled(managers.map(value => value.dispose())); await hostDispatcher.close();
}
