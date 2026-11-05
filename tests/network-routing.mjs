import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { useTempDshHome } from './test-env.js';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { wrapProviderCatalog } from '../lib/provider-config-format.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';
import { createNetworkAttemptBudget } from '../lib/network-policy.js';

const { root } = useTempDshHome('iris-routing-policy');
const file = path.join(root, 'network.json'), configId = crypto.randomUUID(), catalogId = crypto.randomUUID();
const requirement = { schemaVersion: 1, configId, catalogId };
const config = { schemaVersion: 2, configId, generation: 1,
  nodes: [{ id: 'bad', protocol: 'http', host: '127.0.0.1', port: 1 }, { id: 'good', protocol: 'http', host: '127.0.0.1', port: 2 }, { id: 'other', protocol: 'https', host: '127.0.0.1', port: 3 }],
  pools: [{ id: 'primary', mode: 'ordered', candidates: [{ kind: 'node', nodeId: 'bad' }, { kind: 'node', nodeId: 'good' }] }, { id: 'secondary', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'other' }] }],
  bindings: [{ catalogId, providerId: 'p', poolId: 'primary' }, { catalogId, providerId: 'q', poolId: 'secondary' }] };
fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
const checks = [], connects = [], dispatches = [], agents = [], facts = [];
let closed = 0, mode = 'success', globalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { globalCalls++; throw new Error('explicit client must not inherit'); };
class Client {
  constructor(uri) { this.uri = uri; }
  async connect({ path: authority, headers, signal }) {
    signal?.throwIfAborted(); connects.push({ uri: this.uri, authority, headers });
    if (mode === 'programming') throw Object.assign(new TypeError('fixture invalid transport argument'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (this.uri.endsWith(':1')) throw Object.assign(new Error('fixture connection refused'), { code: 'ECONNREFUSED' });
    return { statusCode: 200, socket: { destroy() {} } };
  }
  async destroy() {}
}
class Agent { constructor(options) { this.options = options; agents.push(this); } async close() { closed++; } }
class ProxyAgent extends Agent {}
const transport = { Client, Agent, ProxyAgent, async fetch(url, options) {
  dispatches.push({ url: String(url), dispatcher: options.dispatcher, method: options.method });
  if (mode === 'reset') throw Object.assign(new TypeError('fixture lost response after POST'), { code: 'ECONNRESET' });
  return Response.json({ data: [{ b64_json: 'Zml4dHVyZQ==' }] });
} };
const managers = [];
const make = options => { const value = createProviderNetworkManager({ networkConfigPath: file, loadTransport: async () => transport, onRoute: (fact, context) => facts.push({ fact, context }), ...options }); managers.push(value); return value; };
const manager = make();
const p = manager.resolveProviderNetwork({ providerId: 'p', networkRequirement: requirement });
const q = manager.resolveProviderNetwork({ providerId: 'q', networkRequirement: requirement });
const provider = wrapProviderCatalog({ providers: [{ id: 'p', mediaProtocol: 'openai-images', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-key' }] }, requirement).providers[0];
try {
  assert.equal(manager.resolveProviderNetwork({ providerId: 'legacy' }), undefined);
  assert.throws(() => manager.resolveProviderNetwork({ providerId: 'p', networkRequirement: { ...requirement, configId: crypto.randomUUID() } }), { code: 'IRIS_NETWORK_CONFIG_MISMATCH' });
  await Promise.all([p.run(fetch => fetch('https://provider.invalid/v1/models').then(r => r.json()), { operation: 'discover' }),
    p.run(fetch => fetch('https://provider.invalid/v1/models').then(r => r.json()), { operation: 'discover' }),
    q.run(fetch => fetch('https://other.invalid/v1/models').then(r => r.json()), { operation: 'discover' })]);
  assert.equal(agents.length, 2, 'concurrent operations share one owned dispatcher per route');
  assert.equal(dispatches.filter(row => row.url.includes('provider.invalid')).every(row => row.dispatcher.options.uri.endsWith(':2')), true);
  assert.equal(dispatches.find(row => row.url.includes('other.invalid')).dispatcher.options.uri.endsWith(':3'), true);
  assert.equal(globalCalls, 0); assert.equal(facts.length, 3);
  checks.push('only the independent preflight selects a backup; two providers and concurrent operations keep isolated owned dispatchers');

  mode = 'programming';
  const beforeBug = dispatches.length, beforeBugProbes = connects.length;
  await assert.rejects(p.run(fetch => fetch('https://provider.invalid/v1/models'), { operation: 'discover' }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(connects.length - beforeBugProbes, 1); assert.equal(dispatches.length, beforeBug);
  checks.push('coded programming errors surface immediately instead of selecting a backup proxy');

  mode = 'reset'; const before = dispatches.length;
  const unknown = await invokeProviderOperation(createConfiguredProviderAdapter(provider, { network: p }), 'submit', { capability: 'image', model: 'image', input: { prompt: 'fixture' } });
  assert.equal(unknown.kind, 'acceptance_unknown'); assert.equal(dispatches.length - before, 1);
  assert.equal(dispatches.at(-1).dispatcher.options.uri.endsWith(':2'), true);
  checks.push('business dispatch failure remains unknown and is not replayed through another proxy or global fetch');

  const failureManager = make({ onRoute() { throw Object.assign(new Error('fixture evidence write failed'), { code: 'IRIS_TASK_WRITE_FAILED' }); } });
  const failureClient = failureManager.resolveProviderNetwork({ providerId: 'p', networkRequirement: requirement });
  const count = dispatches.length;
  const refused = await invokeProviderOperation(createConfiguredProviderAdapter(provider, { network: failureClient }), 'submit', { capability: 'image', model: 'image', input: { prompt: 'fixture' } });
  assert.equal(refused.kind, 'not_accepted'); assert.equal(refused.error.category, 'local_io'); assert.equal(dispatches.length, count);
  checks.push('evidence failure before dispatch records no business request and cannot be mistaken for a remote acceptance');

  await assert.rejects(p.run(fetch => fetch('https://provider.invalid/v1/unguarded'), { operation: 'submit', taskId: 'fixture-task' }),
    error => error.providerCode === 'IRIS_NETWORK_EVIDENCE_REQUIRED' && error.acceptance === 'not_accepted');
  await assert.rejects(p.run(fetch => fetch('https://provider.invalid/v1/write-failed'), { operation: 'submit', taskId: 'fixture-task',
    recordNetworkRoute() { throw Object.assign(new Error('fixture disk permission error'), { code: 'EACCES' }); } }),
    error => error.providerCode === 'IRIS_NETWORK_ROUTE_WRITE_FAILED' && error.acceptance === 'not_accepted');
  assert.equal(dispatches.length, count);
  checks.push('Task dispatch requires Core-owned evidence persistence, including borrowed managers; disk errors stop before sending');

  const empty = structuredClone(config); empty.generation++; empty.pools[0].candidates = [];
  fs.writeFileSync(file, JSON.stringify(empty));
  assert.throws(() => manager.resolveProviderNetwork({ providerId: 'p', networkRequirement: requirement }), { code: 'IRIS_NETWORK_POOL_UNAVAILABLE' });
  empty.pools[0].candidates = [{ kind: 'node', nodeId: 'bad' }];
  fs.writeFileSync(file, JSON.stringify(empty));
  const down = manager.resolveProviderNetwork({ providerId: 'p', networkRequirement: requirement });
  const unavailable = await invokeProviderOperation(createConfiguredProviderAdapter(provider, { network: down }), 'submit', { capability: 'image', model: 'image', input: { prompt: 'fixture' } });
  assert.equal(unavailable.kind, 'not_accepted'); assert.equal(dispatches.length, count);
  const shared = createNetworkAttemptBudget(), connected = connects.length;
  for (const model of ['first-model', 'next-model']) {
    const result = await invokeProviderOperation(createConfiguredProviderAdapter(provider, { network: down }), 'submit', { capability: 'image', model, input: { prompt: 'fixture' } }, { networkBudget: shared });
    assert.equal(result.kind, 'not_accepted');
  }
  assert.equal(connects.length - connected, 1, 'changing model cannot multiply already-failed exit probes');
  assert.equal(shared.remaining, 15);
  assert.equal(globalCalls, 0);
  checks.push('empty pools and exhausted preflight do not silently inherit or send generation');
  for (const value of managers) await value.dispose();
  assert.equal(closed, agents.length); await manager.dispose(); assert.equal(closed, agents.length);
  assert.throws(() => manager.resolveProviderNetwork({ providerId: 'p', networkRequirement: requirement }), { code: 'IRIS_PROVIDER_NETWORK_CLOSED' });
  console.log(JSON.stringify({ ok: true, checks, note: 'Injected transport policy tests; real proxy/TLS validation is separate' }));
} finally { globalThis.fetch = originalFetch; for (const value of managers) await value.dispose(); }
