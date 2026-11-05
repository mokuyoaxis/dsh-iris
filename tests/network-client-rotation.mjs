import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { createNetworkProxyFixture, within } from './fixtures/network-proxy-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-network-client-rotation'), fixture = await createNetworkProxyFixture(root);
void globalThis.Request;
const undici = await import('undici'), originalFetch = globalThis.fetch, originalDispatcher = undici.getGlobalDispatcher();
const agents = [], jobs = [], facts = [], file = path.join(root, 'network.json');
function measured(Parent, kind) {
  return class extends Parent {
    constructor(options) {
      super(options); let resolve;
      this.row = { kind, uri: options.uri, closes: 0, closed: false, done: new Promise(done => { resolve = done; }), resolve };
      agents.push(this.row);
    }
    async close() {
      this.row.closes++;
      await new Promise((resolve, reject) => super.close(error => error ? reject(error) : resolve()));
      this.row.closed = true; this.row.resolve();
    }
  };
}
const a = await fixture.createProxy({ tag: 'a' }), b = await fixture.createProxy({ tag: 'b' });
const requirement = { schemaVersion: 1, configId: crypto.randomUUID(), catalogId: crypto.randomUUID() };
const config = { schemaVersion: 2, configId: requirement.configId, generation: 1,
  nodes: [{ id: 'a', protocol: 'http', host: '127.0.0.1', port: a.port }, { id: 'b', protocol: 'http', host: '127.0.0.1', port: b.port }],
  pools: [{ id: 'out', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'a' }] }],
  bindings: [{ catalogId: requirement.catalogId, providerId: 'p', poolId: 'out' }] };
const write = () => fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); write();
const manager = createProviderNetworkManager({ networkConfigPath: file,
  loadTransport: async () => ({ ...undici, Agent: measured(undici.Agent, 'direct'), ProxyAgent: measured(undici.ProxyAgent, 'proxy') }),
  onRoute: (fact, context) => facts.push({ ...fact, tag: context.tag }) });
const resolve = () => manager.resolveProviderNetwork({ providerId: 'p', networkRequirement: requirement });
const rotate = candidate => { config.pools[0].candidates = [candidate]; config.generation++; write(); };
const track = promise => { jobs.push(promise); void promise.catch(() => {}); return promise; };
const run = (client, suffix) => client.run(async fetch => (await fetch(fixture.httpOrigin + suffix)).text(), { operation: 'discover' });
const userEnv = 'IRIS_TEST_REAL_RETIREMENT_USER', passwordEnv = 'IRIS_TEST_REAL_RETIREMENT_PASSWORD';
assert.equal(process.env[userEnv], undefined); assert.equal(process.env[passwordEnv], undefined);
try {
  const first = resolve(); let ready;
  const headers = new Promise(done => { ready = done; });
  const old = track(first.run(async fetch => {
    const response = await fetch(fixture.httpOrigin + '/slow-body'); ready();
    const body = await response.text();
    const second = await fetch(fixture.httpOrigin + '/old-second-hop');
    return { body, second: await second.json() };
  }, { operation: 'download', tag: 'old' }));
  await within(headers); const oldAgent = agents.at(-1);
  rotate({ kind: 'node', nodeId: 'b' }); const second = resolve();
  assert.equal(first.snapshot().state, 'closing'); assert.equal(oldAgent.closes, 0);
  await run(second, '/new-revision');
  assert.equal(oldAgent.closes, 0, 'rotation cannot cut off a response body or its later hop');
  fixture.release('/slow-body'); const completed = await within(old);
  assert.equal(completed.body, 'first-last'); assert.equal(completed.second.path, '/old-second-hop');
  await within(oldAgent.done, 'retired proxy A close');
  const oldFacts = facts.filter(row => row.tag === 'old');
  assert.equal(oldFacts.length, 2); assert(oldFacts.every(row => row.nodeId === 'a'));
  assert.equal(oldFacts[0].configRevision, oldFacts[1].configRevision);
  assert(facts.some(row => row.nodeId === 'b' && row.configRevision !== oldFacts[0].configRevision));

  const controller = new AbortController(); let gotBody;
  const bodyReady = new Promise(done => { gotBody = done; });
  const canceled = track(second.run(async fetch => {
    const response = await fetch(fixture.httpOrigin + '/slow-body', { signal: controller.signal }); gotBody(); return response.text();
  }, { operation: 'download' }));
  await within(bodyReady); const secondAgent = agents.at(-1);
  rotate({ kind: 'direct' }); let current = resolve();
  assert.equal(second.snapshot().state, 'closing'); assert.equal(secondAgent.closes, 0);
  controller.abort(new Error('fixture body cancellation'));
  await assert.rejects(canceled); fixture.release('/slow-body');
  await within(secondAgent.done, 'retired proxy B close after abort');
  await run(current, '/new-direct');

  for (let index = 0; index < 12; index++) {
    const previous = agents.at(-1);
    rotate({ kind: 'node', nodeId: index % 2 ? 'b' : 'a' }); current = resolve();
    await within(previous.done, 'idle previous revision close');
    await run(current, '/rotation-' + index);
    assert.equal(agents.filter(row => !row.closed).length, 1);
  }
  process.env[userEnv] = 'fixture-user'; process.env[passwordEnv] = 'old-fixture-password';
  config.nodes[0].auth = { usernameEnv: userEnv, passwordEnv };
  rotate({ kind: 'node', nodeId: 'a' }); current = resolve(); await run(current, '/old-credential');
  const credentialAgent = agents.at(-1), connectsBefore = a.connects.length;
  process.env[passwordEnv] = 'new-fixture-password'; const credentialReplacement = resolve();
  assert.notEqual(credentialReplacement, current); await within(credentialAgent.done);
  await run(credentialReplacement, '/new-credential'); current = credentialReplacement;
  const expected = 'Basic ' + Buffer.from('fixture-user:new-fixture-password').toString('base64');
  assert(a.connects.slice(connectsBefore).every(row => row.headers['proxy-authorization'] === expected));
  assert(a.connects.length > connectsBefore);
  const closedBeforeOwnerShutdown = agents.filter(row => row.closed).length;

  // Shutdown must include an active client already removed from the current cache.
  let shutdownHeaders;
  const shutdownReady = new Promise(done => { shutdownHeaders = done; });
  const held = track(current.run(async fetch => {
    const response = await fetch(fixture.httpOrigin + '/slow-body'); shutdownHeaders();
    const body = await response.text(); await (await fetch(fixture.httpOrigin + '/shutdown-second-hop')).text(); return body;
  }, { operation: 'download' }));
  await within(shutdownReady); const lastAgent = agents.at(-1);
  rotate({ kind: 'node', nodeId: 'b' }); const unused = resolve();
  let disposed = false;
  const disposal = manager.dispose().then(() => { disposed = true; });
  await delay(30); assert.equal(disposed, false); assert.equal(lastAgent.closes, 0);
  fixture.release('/slow-body'); assert.equal(await within(held), 'first-last');
  await within(disposal); assert(agents.every(row => row.closed && row.closes === 1));
  await assert.rejects(run(unused, '/after-shutdown'), { code: 'IRIS_PROVIDER_NETWORK_CLOSED' });
  console.log(JSON.stringify({ realRevisionReplacements: config.generation - 1, realCredentialReplacements: 1,
    realDispatchersCreated: agents.length, closedBeforeOwnerShutdown,
    oldBodyAndSecondHopCompleted: true, oldBodyAbortDrained: true, shutdownDrainedRetiredOperation: true }));
  assert.equal(fixture.requests.filter(row => row.path === '/old-second-hop').length, 1);
  assert.deepEqual(fixture.errors, []); assert.equal(globalThis.fetch, originalFetch); assert.equal(undici.getGlobalDispatcher(), originalDispatcher);
  console.log('PASS actual CONNECT/direct rotation, full response/multi-hop drain, cancellation, idle socket-pool closure and unchanged host dispatcher');
} finally {
  delete process.env[userEnv]; delete process.env[passwordEnv];
  await fixture.close(); await Promise.allSettled(jobs); await manager.dispose();
}
