import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-network-client-retirement'), file = path.join(root, 'network.json');
const requirement = { schemaVersion: 1, configId: crypto.randomUUID(), catalogId: crypto.randomUUID() };
const config = { schemaVersion: 2, configId: requirement.configId, generation: 1,
  nodes: [{ id: 'proxy', protocol: 'http', host: '127.0.0.1', port: 12345 }],
  pools: [{ id: 'out', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'proxy' }] }],
  bindings: ['p', 'q'].map(providerId => ({ catalogId: requirement.catalogId, providerId, poolId: 'out' })) };
const write = () => fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); write();
const agents = [], managers = [], proxyHeaders = [];
let failClose = false;
class Client {
  async connect({ headers }) { proxyHeaders.push(headers); return { statusCode: 200, socket: { destroy() {} } }; }
  async destroy() {}
}
class Agent {
  constructor(options) { this.options = options; this.closed = false; this.closes = 0; agents.push(this); }
  async close() {
    this.closes++;
    if (failClose) { failClose = false; throw new Error('fixture retirement close failure'); }
    this.closed = true;
  }
}
class ProxyAgent extends Agent {}
const hostDispatcher = { close() { throw new Error('borrowed host dispatcher must not close'); } };
const transport = { Client, Agent, ProxyAgent, getGlobalDispatcher: () => hostDispatcher,
  async fetch() { return new Response('fixture response'); } };
const make = options => {
  const manager = createProviderNetworkManager({ networkConfigPath: file, loadTransport: async () => transport, ...options });
  managers.push(manager); return manager;
};
const resolve = (manager, providerId = 'p', modelRef) => manager.resolveProviderNetwork({ providerId, modelRef, networkRequirement: requirement });
const run = client => client.run(async fetch => (await fetch('https://fixture.invalid/models')).text(), { operation: 'discover' });
async function closed(client) {
  for (let i = 0; i < 100 && client.snapshot().state !== 'closed'; i++) await delay(10);
  assert.equal(client.snapshot().state, 'closed');
}
const userEnv = 'IRIS_TEST_RETIREMENT_PROXY_USER', passwordEnv = 'IRIS_TEST_RETIREMENT_PROXY_PASSWORD';
assert.equal(process.env[userEnv], undefined); assert.equal(process.env[passwordEnv], undefined);
try {
  const manager = make(); let current = resolve(manager);
  assert.equal(resolve(manager), current); await run(current);
  for (let n = 0; n < 12; n++) {
    const old = current; config.generation++; write(); current = resolve(manager);
    assert.notEqual(old, current);
    assert.equal(old.snapshot().state, 'closing', 'configuration replacement must retire an idle historical client');
    await closed(old);
    await assert.rejects(run(old), { code: 'IRIS_PROVIDER_NETWORK_CLOSED' });
    await run(current);
    assert.equal(agents.filter(agent => !agent.closed).length, 1, 'historical dispatchers must not accumulate until owner shutdown');
  }
  console.log(JSON.stringify({ rotations: 12, dispatchersCreated: agents.length, dispatchersClosedBeforeOwnerShutdown: agents.filter(a => a.closed).length }));

  // A global file revision also retires an idle provider that is never resolved again.
  const other = resolve(manager, 'q'); await run(other);
  config.generation++; write(); current = resolve(manager);
  assert.equal(other.snapshot().state, 'closing'); await closed(other);
  await run(current);

  // Credentials change without a file revision: replace this logical route, not its neighbors.
  config.nodes[0].auth = { usernameEnv: userEnv, passwordEnv };
  process.env[userEnv] = 'fixture-user'; process.env[passwordEnv] = 'first-fixture-password';
  config.generation++; write();
  const first = resolve(manager); await run(first);
  process.env[passwordEnv] = 'second-fixture-password';
  const second = resolve(manager); assert.notEqual(first, second); await closed(first); await run(second);
  assert.equal(proxyHeaders.at(-1)['proxy-authorization'], 'Basic ' + Buffer.from('fixture-user:second-fixture-password').toString('base64'));

  // Scheduler-only inherited clients keep their own identity and never own the host pool.
  const scheduler = { dispatcher: dispatcher => dispatcher };
  const scheduled = make({ scheduler });
  const inherited = scheduled.resolveProviderNetwork({ providerId: 'legacy', modelRef: 'legacy::model' });
  const one = resolve(scheduled, 'p', 'p::one'), two = resolve(scheduled, 'p', 'p::two');
  assert.notEqual(one, two); assert.equal(resolve(scheduled, 'p', 'p::one'), one);
  config.generation++; write(); resolve(scheduled, 'p', 'p::one');
  await closed(one); await closed(two);
  assert.equal(inherited.snapshot().state, 'open');
  assert.equal(scheduled.resolveProviderNetwork({ providerId: 'legacy', modelRef: 'legacy::model' }), inherited);

  // An invalid/disabled new binding cannot leave the previous route accepting new work.
  config.pools[0].candidates = []; config.generation++; write();
  assert.throws(() => resolve(manager), { code: 'IRIS_NETWORK_POOL_UNAVAILABLE' });
  await closed(second);
  config.pools[0].candidates = [{ kind: 'node', nodeId: 'proxy' }]; config.generation++; write();

  // Failed retirement remains visible at owner disposal and is never retried implicitly.
  const broken = make(), doomed = resolve(broken); await run(doomed); const badAgent = agents.at(-1);
  failClose = true; config.generation++; write(); resolve(broken); await closed(doomed);
  assert.equal(doomed.snapshot().cleanupFailed, true);
  await assert.rejects(broken.dispose(), /网络管理实例释放失败/);
  await assert.rejects(broken.dispose(), /网络管理实例释放失败/);
  assert.equal(badAgent.closes, 1);
  assert.equal(manager.dispose(), manager.dispose()); await manager.dispose(); await scheduled.dispose();
  assert(agents.every(agent => agent.closes === 1));
  console.log('PASS retired clients, coalescing, global revision sweep, proxy credential replacement, scheduler model identity and visible cleanup failure');
} finally {
  delete process.env[userEnv]; delete process.env[passwordEnv];
  await Promise.allSettled(managers.map(manager => manager.dispose()));
}
