import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-network-invalidation'), file = path.join(root, 'network.json');
const requirement = { schemaVersion: 1, configId: crypto.randomUUID(), catalogId: crypto.randomUUID() };
const otherRequirement = { ...requirement, catalogId: crypto.randomUUID() };
const config = { schemaVersion: 2, configId: requirement.configId, generation: 1,
  nodes: [{ id: 'proxy', protocol: 'http', host: '127.0.0.1', port: 12345 }],
  pools: [{ id: 'out', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'proxy' }] }],
  bindings: [requirement, otherRequirement].map(({ catalogId }) => ({ catalogId, providerId: 'p', poolId: 'out' })) };
const write = (value = config) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const agents = [];
let holdNext = false, releaseBody, bodyReady;
class Client {
  async connect() { return { statusCode: 200, socket: { destroy() {} } }; }
  async destroy() {}
}
class Agent {
  constructor() { this.closes = 0; agents.push(this); }
  async close() { this.closes++; }
}
const transport = { Client, Agent, ProxyAgent: Agent, async fetch() {
  if (!holdNext) return new Response('fixture response');
  holdNext = false;
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('first-'));
    releaseBody = () => { controller.enqueue(new TextEncoder().encode('last')); controller.close(); };
    bodyReady();
  } }));
} };
const resolve = (manager, networkRequirement = requirement) => manager.resolveProviderNetwork({ providerId: 'p', networkRequirement });
const run = client => client.run(async fetch => (await fetch('https://fixture.invalid/models')).text(), { operation: 'discover' });
async function closed(client) {
  for (let n = 0; n < 100 && client.snapshot().state !== 'closed'; n++) await delay(10);
  assert.equal(client.snapshot().state, 'closed');
}
const cases = [
  ['identity-replacement', () => write({ ...config, configId: crypto.randomUUID() }), 'IRIS_NETWORK_CONFIG_MISMATCH'],
  ['schema-downgrade', () => { const { bindings: _bindings, ...legacy } = config; write({ ...legacy, schemaVersion: 1 }); }, 'IRIS_NETWORK_CONFIG_MISMATCH'],
  ['invalid-json', () => fs.writeFileSync(file, '{incomplete'), 'IRIS_NETWORK_CONFIG_INVALID'],
  ['invalid-policy', () => write({ ...config, nodes: null }), 'IRIS_NETWORK_CONFIG_INVALID'],
  ['missing-file', () => fs.renameSync(file, file + '.moved'), 'IRIS_NETWORK_CONFIG_IO']
];
if (process.platform !== 'win32') cases.push(['unsafe-permissions', () => fs.chmodSync(file, 0o644), 'IRIS_NETWORK_CONFIG_PERMISSIONS']);
for (const [name, invalidate, code] of cases) {
  write();
  const manager = createProviderNetworkManager({ networkConfigPath: file, loadTransport: async () => transport,
    scheduler: { dispatcher: dispatcher => dispatcher } });
  const inherited = manager.resolveProviderNetwork({ providerId: 'legacy' });
  let active;
  try {
    const old = resolve(manager), neighbor = resolve(manager, otherRequirement);
    await run(old); await run(neighbor);
    assert.equal(old.snapshot().state, 'open', 'two legitimate catalogs may coexist');
    assert.equal(resolve(manager), old);
    assert.throws(() => resolve(manager, { ...requirement, configId: crypto.randomUUID() }), { code: 'IRIS_NETWORK_CONFIG_MISMATCH' });
    assert.equal(old.snapshot().state, 'open', 'an unrelated caller mismatch must not invalidate unchanged policy');
    assert.equal(neighbor.snapshot().state, 'open');
    const owned = agents.slice(-2);
    if (name === 'identity-replacement') {
      holdNext = true;
      const ready = new Promise(resolveReady => { bodyReady = resolveReady; });
      active = old.run(async fetch => {
        const text = await (await fetch('https://fixture.invalid/body')).text();
        return text + '/' + await (await fetch('https://fixture.invalid/next-hop')).text();
      }, { operation: 'discover' });
      await ready;
    }
    invalidate();
    const invalidBytes = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
    assert.throws(() => resolve(manager), { code });
    assert.equal(old.snapshot().state, 'closing', name + ' must retire historical routed clients');
    assert.equal(neighbor.snapshot().state, 'closing', 'policy invalidation also retires unresolved catalogs');
    await assert.rejects(run(old), { code: 'IRIS_PROVIDER_NETWORK_CLOSED' });
    assert.equal(inherited.snapshot().state, 'open', 'scheduler-only inherited clients do not own this policy');
    assert.equal(manager.resolveProviderNetwork({ providerId: 'legacy' }), inherited);
    if (active) {
      assert.equal(owned[0].closes, 0, 'an admitted body and next hop must drain before closing');
      releaseBody(); releaseBody = undefined;
      assert.equal(await active, 'first-last/fixture response');
      active = undefined;
    }
    await closed(old); await closed(neighbor);
    assert(owned.every(agent => agent.closes === 1));
    if (invalidBytes) assert.deepEqual(fs.readFileSync(file), invalidBytes, 'resolution must not repair user configuration');
    else { assert(!fs.existsSync(file)); fs.renameSync(file + '.moved', file); }
    fs.chmodSync(file, 0o600); write();
    const restored = resolve(manager);
    assert.notEqual(restored, old); await run(restored);
    assert.equal(restored.snapshot().state, 'open');
    console.log('PASS network client invalidation: ' + name);
  } finally {
    releaseBody?.();
    await active?.catch(() => {});
    await manager.dispose();
  }
}
assert(agents.every(agent => agent.closes === 1));
console.log('PASS policy invalidation drains owned clients, preserves unrelated contexts and recovers without reviving stale clients');
