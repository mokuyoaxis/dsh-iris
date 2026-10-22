import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { createDshRuntime } from '../lib/dsh-core-adapter.js';
import { defineHostAdapter } from '../lib/host-contract.js';
import { providerTaskBinding } from '../lib/provider-catalog.js';
import * as store from '../lib/config.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-dsh-observers'), instances = [];
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1', reference = { provider: 'owned', settingsNs: 'fixture' };
const provider = store.upsert({ name: 'owned', enabled: true, dshProvider: reference, mediaProtocol: 'dashscope',
  models: [{ id: 'image-v0', capabilities: ['image-gen'] }] });
const binding = providerTaskBinding({ ...provider, baseUrl: endpoint, apiKey: 'fixture' });
function host(id, resolve) { return defineHostAdapter({ id, ports: { providerConnections: { resolve } } }); }
function own(name, getHost, dataRoot = path.join(root, name)) {
  const instance = createDshRuntime({ dataRoot, getHost }); instances.push(instance); return instance;
}
async function seed(core) {
  const fake = createFakeLifecycleProvider({ id: provider.id });
  const result = await core.submitProviderTaskForDsh({ capability: 'image', candidates: [{ adapter: fake.adapter,
    model: provider.id + '::image-v0', providerBinding: binding }], providerInput: { prompt: 'fixture' } });
  return { taskId: result.task.id, fake };
}
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const file = path.join(item.parentPath, item.name);
      return [path.relative(directory, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]; }));
}
const fetch = globalThis.fetch; let network = 0;
globalThis.fetch = () => { network++; throw new Error('observer setup must not send a request'); };
try {
  // Two concurrent setup calls can both await credentials; only one may publish a watcher.
  const both = gate(), credentials = gate(); let reads = 0, key = 'fixture-one', currentEndpoint = endpoint;
  const core = own('race', () => host('race', async () => {
    if (++reads === 2) both.resolve(); await credentials.promise; return { baseUrl: currentEndpoint, apiKey: key };
  }));
  const { taskId, fake } = await seed(core), before = tree(core.dataRoot);
  const first = core.watchProviderTaskForDsh({ taskId, intervalMs: 60000 });
  const second = core.watchProviderTaskForDsh({ taskId, intervalMs: 60000 });
  await both.promise; key = 'fixture-two'; credentials.resolve();
  assert.deepEqual((await Promise.all([first, second])).sort(), [false, true]);
  assert.equal(core.snapshot().watchers, 1); await core.stopProviderTaskWatchesForDsh();
  assert.equal(core.snapshot().watchers, 0); assert.equal(fake.calls.submit.length, 1);
  assert.equal(network, 0); assert.deepEqual(tree(core.dataRoot), before);
  currentEndpoint = 'https://dashscope-us-east-1.aliyuncs.com/compatible-mode/v1';
  await assert.rejects(core.watchProviderTaskForDsh({ taskId }), { code: 'IRIS_PROVIDER_TASK_BINDING_MISMATCH' });
  assert.deepEqual(tree(core.dataRoot), before); assert.equal(network, 0);

  // A closing instance cannot publish a late watcher or clear a replacement instance's watcher.
  const lookup = gate(), late = gate(); let resolverSignal;
  const old = own('old', () => host('old', async (_reference, { signal }) => {
    resolverSignal = signal; lookup.resolve(); await late.promise; return { baseUrl: endpoint, apiKey: key };
  }), core.dataRoot);
  const oldSetup = old.watchProviderTaskForDsh({ taskId, intervalMs: 60000 });
  const oldResult = assert.rejects(oldSetup, { name: 'AbortError' }); await lookup.promise;
  let drained = false; const closing = old.dispose(); void closing.then(() => { drained = true; });
  await setImmediate(); assert(resolverSignal.aborted); assert.equal(drained, false);
  const replacement = own('replacement', () => host('replacement', async () => ({ baseUrl: endpoint, apiKey: key })), core.dataRoot);
  assert.equal(await replacement.watchProviderTaskForDsh({ taskId, intervalMs: 60000 }), true);
  late.resolve(); await oldResult; await closing;
  assert.equal(old.snapshot().watchers, 0); assert.equal(replacement.snapshot().watchers, 1);
  await replacement.stopProviderTaskWatchesForDsh();
  assert.equal(network, 0); assert.deepEqual(tree(core.dataRoot), before);

  // Startup takeover is owned work too, including the credential lookup before local recovery.
  const entering = gate(), release = gate(); let startupSignal;
  const startup = own('startup', () => host('startup', async (_reference, { signal }) => {
    startupSignal = signal; entering.resolve(); await release.promise; return { baseUrl: endpoint, apiKey: key };
  }));
  const pending = await seed(startup), startupBefore = tree(startup.dataRoot);
  const resume = startup.resumeProviderTaskWatchesForDsh({ intervalMs: 60000 });
  const resumed = assert.rejects(resume, { name: 'AbortError' }); await entering.promise;
  let finished = false; const stopped = startup.dispose(); void stopped.then(() => { finished = true; });
  await setImmediate(); assert(startupSignal.aborted); assert.equal(finished, false);
  release.resolve(); await resumed; await stopped;
  assert.deepEqual(tree(startup.dataRoot), startupBefore); assert.equal(startup.snapshot().watchers, 0);
  assert.equal(pending.fake.calls.submit.length, 1); assert.equal(pending.fake.calls.poll.length, 0); assert.equal(network, 0);
  console.log('DSH observers: concurrent setup coalesces after credentials, binding drift rejects without poll, late setup cannot survive close or affect replacement, startup takeover drains without replay OK');
} finally {
  for (const instance of instances) await instance.dispose();
  globalThis.fetch = fetch;
}
