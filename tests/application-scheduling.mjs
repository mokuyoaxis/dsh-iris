import assert from 'node:assert/strict';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreRuntime, inspectCoreWriterLease } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-application-scheduling'), apps = [], releases = [], expectedCleanupFailures = new Set();
const policy = { schemaVersion: 1, httpConcurrency: 4, requestsPerSecond: 100, remoteLimit: 10, queueTimeoutMs: 3000 };
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); releases.push(resolve); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); } assert.fail('fixture condition did not become true'); }
function waiting(signal, value) {
  return Promise.race([value, new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })]);
}
function setup(name, fake, scheduling = policy) {
  const dataRoot = path.join(root, name);
  const app = createApplicationRuntime({ dataRoot, scheduling,
    resolveImageCandidates: ({ modelRef }) => [{ adapter: fake.adapter, model: modelRef }], resolveTaskAdapter: () => fake.adapter });
  apps.push(app); return { app, dataRoot };
}
const input = model => ({ model_ref: `fixture::${model}`, prompt: 'bounded scheduler fixture' });
try {
  const entered = [], store = new AsyncLocalStorage(), gates = [gate(), gate(), gate()];
  const fake = createFakeLifecycleProvider({ id: 'fixture', submitSteps: gates.map((g, i) => async request => {
    entered.push({ model: request.model, label: store.getStore() });
    return waiting(request.signal, g.promise);
  }) });
  const { app, dataRoot } = setup('overlap', fake);
  const cancel = new AbortController();
  const jobs = ['a', 'b', 'c'].map((name, i) => store.run(name, () => app.generateImage(input(name), i === 1 ? { signal: cancel.signal } : {})));
  await until(() => entered.length === 3);
  assert.deepEqual(entered, ['a', 'b', 'c'].map(name => ({ model: name, label: name })), 'queued actions retain the caller async context');
  assert.equal(app.snapshot().waitingWrites, 3);
  assert.equal(inspectCoreWriterLease(dataRoot).ownerStatus, 'alive');
  const contender = createCoreRuntime({ dataRoot });
  assert.throws(() => contender.start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' }); await contender.dispose();
  assert.equal(await app.transaction(runtime => runtime.run('execute', () => 'short transaction')), 'short transaction');
  let exclusive = false;
  const unknownPlugin = app.run('writer', runtime => runtime.run('execute', () => { exclusive = true; }));
  await delay(10); assert.equal(exclusive, false, 'unknown writer callbacks remain exclusive');
  cancel.abort(); const stopped = await jobs[1];
  assert.equal(stopped.task.acceptance, 'unknown'); assert.equal(exclusive, false);
  gates[0].resolve({ kind: 'accepted', remoteTaskId: 'original-a' });
  gates[2].resolve({ kind: 'accepted', remoteTaskId: 'original-c' });
  const [a, c] = await Promise.all([jobs[0], jobs[2]]); await unknownPlugin;
  assert.equal(a.task.remoteTaskId, 'original-a'); assert.equal(c.task.remoteTaskId, 'original-c');
  assert.equal(exclusive, true); assert.equal(fake.calls.submit.length, 3);
  await app.dispose(); assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');

  const limitedFake = createFakeLifecycleProvider({ id: 'fixture', cancelSteps: [{ kind: 'canceled' }] });
  const limited = setup('remote-cap', limitedFake, { ...policy, remoteLimit: 1 });
  const accepted = await limited.app.generateImage(input('one'));
  const second = limited.app.generateImage(input('two'));
  await until(() => limited.app.snapshot().waitingWrites === 1);
  assert.equal(limitedFake.calls.submit.length, 1);
  assert.equal((await limited.app.execute('task.list', {})).total, 1, 'remote capacity wait creates no extra Task');
  assert.equal((await limited.app.execute('task.cancel', { task_id: accepted.taskId })).task.outcome, 'canceled');
  assert.equal((await second).task.acceptance, 'accepted'); assert.equal(limitedFake.calls.submit.length, 2);
  await limited.app.dispose();

  const unknown = setup('unknown-cap', createFakeLifecycleProvider({ id: 'fixture', submitSteps: [{ kind: 'acceptance_unknown', error: 'fixture ambiguity' }] }),
    { ...policy, remoteLimit: 1, queueTimeoutMs: 80 });
  const first = await unknown.app.generateImage(input('unknown'));
  assert.equal(first.task.acceptance, 'unknown');
  await assert.rejects(unknown.app.generateImage(input('blocked')), { code: 'IRIS_SCHEDULER_QUEUE_TIMEOUT' });
  assert.equal((await unknown.app.execute('task.list', {})).total, 1);
  await unknown.app.dispose();

  const legacyLabels = [], firstGate = gate();
  const legacyApp = createApplicationRuntime({ dataRoot: path.join(root, 'legacy-fifo') }); apps.push(legacyApp);
  const l1 = store.run('first', () => legacyApp.run('writer', async () => { legacyLabels.push(store.getStore()); await firstGate.promise; }));
  const l2 = store.run('second', () => legacyApp.run('writer', () => { legacyLabels.push(store.getStore()); }));
  await until(() => legacyLabels.length === 1); firstGate.resolve(); await Promise.all([l1, l2]);
  assert.deepEqual(legacyLabels, ['first', 'second']);

  const pollGate = gate(), pollEntered = gate();
  const pollFake = createFakeLifecycleProvider({ id: 'fixture', pollSteps: [() => { pollEntered.resolve(); return pollGate.promise; }] });
  const lifecycle = setup('same-task', pollFake);
  const original = await lifecycle.app.generateImage(input('a'));
  const observing = lifecycle.app.execute('task.observe', { task_id: original.taskId }); await pollEntered.promise;
  const revision = (await lifecycle.app.execute('task.inspect', { task_id: original.taskId })).task.revision;
  await assert.rejects(lifecycle.app.runMedia(runtime => createProviderTaskRunner(runtime).recover(original.taskId, pollFake.adapter)), { code: 'IRIS_PROVIDER_TASK_BUSY' });
  assert.equal((await lifecycle.app.execute('task.inspect', { task_id: original.taskId })).task.revision, revision);
  pollGate.resolve({ kind: 'pending' }); await observing;

  const scoped = setup('scoped-runtime', createFakeLifecycleProvider({ id: 'fixture' }));
  const inner = gate(); let runtimeView, finished = false;
  const unreturned = scoped.app.run('writer', runtime => {
    runtimeView = runtime; void runtime.run('execute', async () => { await inner.promise; });
  }).then(() => { finished = true; });
  await delay(10); assert.equal(finished, false, 'job must drain its own runtime calls before releasing its turn');
  inner.resolve(); await unreturned;
  assert.equal(runtimeView.signal.aborted, true);
  assert.throws(() => runtimeView.run('execute', () => {}), { code: 'IRIS_APP_CLOSED' });

  const broken = setup('cleanup-failure', createFakeLifecycleProvider({ id: 'fixture' })), cleanupError = new Error('fixture cleanup failure');
  expectedCleanupFailures.add(broken.app);
  await assert.rejects(broken.app.run('writer', runtime => runtime.run('execute', () => {
    runtime.onDispose(() => { throw cleanupError; });
  })), error => error === cleanupError || error.errors?.includes(cleanupError));
  assert.equal(broken.app.snapshot().cleanupFailed, true);
  assert.equal(inspectCoreWriterLease(broken.dataRoot).ownerStatus, 'alive');
  await assert.rejects(broken.app.dispose());
  console.log('Application scheduling: single root lease, overlapping media, serial checkpoints/exclusive callbacks, caller context, independent cancel and durable remote capacity OK');
} finally {
  for (const resolve of releases) resolve({ kind: 'accepted', remoteTaskId: 'fixture-cleanup' });
  for (const app of apps.reverse()) if (!expectedCleanupFailures.has(app)) await app.dispose();
}
