import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { ProviderContractError } from '../lib/provider-contract.js';
import { createFakeLifecycleProvider, FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-application-runtime');
const applications = [];
const gates = [];
const app = options => { const value = createApplicationRuntime(options); applications.push(value); return value; };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const gate = { promise, resolve }; gates.push(gate); return gate;
}
function hashes(directory) {
  const result = {};
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[path.relative(directory, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  visit(directory); return result;
}
const candidates = (fake, model) => [{ adapter: fake.adapter, model, selectionReason: 'explicit' }];
const input = model => ({ prompt: 'fixture prompt', model_ref: model });

try {
  assert.throws(() => createApplicationRuntime({ dataRoot: './relative' }), { code: 'IRIS_CORE_OPTIONS_INVALID' });
  const untouched = path.join(root, 'must-not-be-created');
  let unexpectedResolverCalls = 0;
  const lazy = app({ dataRoot: untouched, resolveImageCandidates: () => { unexpectedResolverCalls++; } });
  assert.equal(fs.existsSync(untouched), false);
  await assert.rejects(lazy.execute('constructor', {}), { code: 'IRIS_APP_COMMAND_UNSUPPORTED' });
  await assert.rejects(lazy.execute('core.delete', {}), { code: 'IRIS_APP_COMMAND_UNSUPPORTED' });
  await assert.rejects(lazy.execute('artifact.list', {}), { code: 'IRIS_CORE_DATA_ROOT_NOT_FOUND' });
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(lazy.generateImage(input('none::image'), { signal: preAborted.signal }), { name: 'AbortError' });
  const immediateAbort = new AbortController();
  const immediate = lazy.generateImage(input('none::image'), { signal: immediateAbort.signal });
  const immediateCheck = assert.rejects(immediate, { code: 'IRIS_APP_ABORTED' });
  immediateAbort.abort(); await immediateCheck;
  assert.equal(unexpectedResolverCalls, 0);
  assert.equal(fs.existsSync(untouched), false, 'construction/read/pre-abort must not create a writer root');
  await lazy.dispose();

  const aRoot = path.join(root, 'a');
  const entered = deferred(), release = deferred();
  const fakeA = createFakeLifecycleProvider({ id: 'alpha', submitSteps: [
    () => { entered.resolve(); return release.promise; },
    { kind: 'accepted', remoteTaskId: 'remote-last' }
  ] });
  const resolverError = new Error('fixture resolver error');
  const resolvedModels = [];
  const a = app({ dataRoot: aRoot, resolveImageCandidates: ({ modelRef }) => {
    resolvedModels.push(modelRef);
    if (modelRef === 'alpha::bad') throw resolverError;
    return candidates(fakeA, modelRef);
  } });
  const source = await a.execute('artifact.import', { image_bytes: FAKE_PNG });
  assert.equal(inspectCoreWriterLease(aRoot).status, 'absent', 'idle application has no writer lease');
  const firstInput = input('alpha::first');
  const first = a.generateImage(firstInput);
  firstInput.prompt = 'mutated by caller';
  await entered.promise;
  const beforeReader = hashes(aRoot);
  assert.equal((await a.execute('artifact.inspect', { artifact_id: source.artifact.id })).artifact.id, source.artifact.id);
  assert.equal((await a.execute('task.list', {})).total, 1);
  assert.deepEqual(hashes(aRoot), beforeReader, 'reader must neither queue behind writer nor mutate records');

  const cancelled = new AbortController();
  const skipped = a.generateImage(input('alpha::skipped'), { signal: cancelled.signal });
  const skipCheck = assert.rejects(skipped, { code: 'IRIS_APP_ABORTED' });
  const importBytes = new Uint8Array(FAKE_PNG);
  const queuedImport = a.execute('artifact.import', { image_bytes: importBytes });
  importBytes.fill(0);
  const failed = a.generateImage(input('alpha::bad'));
  const failureCheck = assert.rejects(failed, error => error === resolverError);
  const last = a.generateImage(input('alpha::last'));
  cancelled.abort(); await skipCheck;
  assert.equal(a.snapshot().queuedWrites, 3);
  assert.deepEqual(resolvedModels, ['alpha::first'], 'queued cancellation must not resolve configuration');
  assert.equal(inspectCoreWriterLease(aRoot).status, 'present');

  const bRoot = path.join(root, 'b');
  const fakeB = createFakeLifecycleProvider({ id: 'beta' });
  const b = app({ dataRoot: bRoot, resolveImageCandidates: ({ modelRef }) => candidates(fakeB, modelRef) });
  const parallel = await b.generateImage(input('beta::image'));
  assert.equal(parallel.task.providerId, 'beta');
  assert.equal(fakeB.calls.submit.length, 1, 'B must execute while A is blocked');
  const contender = app({ dataRoot: aRoot });
  await assert.rejects(contender.execute('artifact.import', { image_bytes: FAKE_PNG }), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
  await contender.dispose();
  const moduleUrl = new URL('../lib/core-runtime.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { createCoreRuntime } from ' + JSON.stringify(moduleUrl) + '; const r=createCoreRuntime({dataRoot:process.argv[1]}); '
      + 'try {r.start(); process.exitCode=1;} catch(e) {console.log(e.code);} finally {await r.dispose();}', aRoot],
  { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'IRIS_CORE_DATA_ROOT_BUSY');

  release.resolve({ kind: 'accepted', remoteTaskId: 'remote-first' });
  await first;
  assert.equal((await queuedImport).artifact.digest.value, source.artifact.digest.value, 'queued byte inputs are owned snapshots');
  await failureCheck;
  const final = await last;
  assert.equal(final.task.modelRef, 'alpha::last');
  assert.equal(fakeA.calls.submit.length, 2);
  assert.equal(fakeA.calls.submit[0].input.input.prompt, 'fixture prompt');
  assert.deepEqual(resolvedModels, ['alpha::first', 'alpha::bad', 'alpha::last']);
  assert.equal((await a.execute('task.list', {})).total, 2, 'cancelled or failed resolver creates no Task');
  assert.equal(a.snapshot().queuedWrites, 0);
  assert.equal(a.snapshot().activeWrites, 0);
  assert.equal(inspectCoreWriterLease(aRoot).status, 'absent');

  await assert.rejects(a.execute('task.observe', { task_id: final.task.id }), { code: 'IRIS_COMMAND_PROVIDER_REQUIRED' });
  assert.equal(fakeA.calls.poll.length, 0, 'no implicit resolver or background observation');

  // Explicit single observations and redelivery share the FIFO, never the submission path.
  const observedRoot = path.join(root, 'manual-observation');
  const complete = { kind: 'succeeded', artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/original.png', mediaType: 'image/png' }] };
  const observedFake = createFakeLifecycleProvider({ id: 'observed', pollSteps: [
    { kind: 'pending' }, complete, complete
  ], downloadSteps: [{ throw: new Error('fixture first download failed') }], cancelSteps: [{ kind: 'canceled' }] });
  let taskResolverCalls = 0;
  const observed = app({ dataRoot: observedRoot, resolveImageCandidates: ({ modelRef }) => candidates(observedFake, modelRef),
    resolveTaskAdapter: (task, { signal }) => {
      assert.equal(signal.aborted, false); assert.equal(task.providerId, 'observed');
      taskResolverCalls++; return observedFake.adapter;
    } });
  const accepted = await observed.generateImage(input('observed::image'));
  await observed.execute('task.inspect', { task_id: accepted.task.id });
  assert.equal(observedFake.calls.poll.length, 0);
  await observed.execute('task.observe', { task_id: accepted.task.id });
  assert.equal(observedFake.calls.poll.length, 1);
  const deliveryFailed = await observed.execute('task.reobserve', { task_id: accepted.task.id });
  assert.equal(deliveryFailed.task.outcome, 'succeeded');
  assert.equal(deliveryFailed.task.deliveryState, 'failed');
  const delivered = await observed.execute('task.redeliver', { task_id: accepted.task.id });
  assert.equal(delivered.task.deliveryState, 'ready');
  assert.equal(delivered.task.id, accepted.task.id);
  assert.equal(observedFake.calls.submit.length, 1);
  assert.equal(observedFake.calls.poll.length, 3);
  const toCancel = await observed.generateImage(input('observed::image'));
  assert.equal(observedFake.calls.cancel.length, 0);
  const remoteCancelled = await observed.execute('task.cancel', { task_id: toCancel.task.id });
  assert.equal(remoteCancelled.task.outcome, 'canceled');
  assert.equal(observedFake.calls.cancel.length, 1);
  assert.equal(taskResolverCalls, 4);

  // Cancellation after submit preserves uncertainty and does not cancel/fallback at the Provider.
  const submitEntered = deferred();
  const cancellable = createFakeLifecycleProvider({ id: 'cancel-fake', submitSteps: [({ signal }) => {
    submitEntered.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new ProviderContractError('fixture interrupted', {
      stage: 'submit', category: 'aborted', acceptance: 'unknown'
    })), { once: true }));
  }] });
  const fallback = createFakeLifecycleProvider({ id: 'unused-fallback' });
  const cRoot = path.join(root, 'cancel');
  const c = app({ dataRoot: cRoot, resolveImageCandidates: () => [
    ...candidates(cancellable, 'cancel-fake::image'), ...candidates(fallback, 'unused-fallback::image')
  ] });
  const activeAbort = new AbortController();
  const inFlight = c.generateImage(input('cancel-fake::image'), { signal: activeAbort.signal });
  await submitEntered.promise;
  const afterCancel = c.execute('artifact.import', { image_bytes: FAKE_PNG });
  activeAbort.abort();
  const uncertain = await inFlight;
  assert.equal(uncertain.task.acceptance, 'unknown');
  assert.equal(uncertain.task.outcome, 'unknown');
  assert.equal(cancellable.calls.submit.length, 1);
  assert.equal(cancellable.calls.cancel.length, 0, 'local abort is not a remote cancel request');
  assert.equal(fallback.calls.submit.length, 0, 'unknown acceptance must not trigger fallback');
  await afterCancel;
  assert.equal(inspectCoreWriterLease(cRoot).status, 'absent');

  // Closing waits even for a configuration resolver that has not yet acknowledged abort.
  const resolverEntered = deferred(), resolverRelease = deferred();
  const dRoot = path.join(root, 'closing');
  const d = app({ dataRoot: dRoot, resolveImageCandidates: () => { resolverEntered.resolve(); return resolverRelease.promise; } });
  const held = d.generateImage(input('beta::image'));
  const heldCheck = assert.rejects(held, { code: 'IRIS_APP_ABORTED' });
  await resolverEntered.promise;
  const notStarted = d.execute('artifact.import', { image_bytes: FAKE_PNG });
  const notStartedCheck = assert.rejects(notStarted, { code: 'IRIS_APP_CLOSED' });
  let didClose = false;
  const closing = d.dispose(); closing.then(() => { didClose = true; });
  assert.equal(d.dispose(), closing);
  await notStartedCheck;
  await assert.rejects(d.generateImage(input('beta::image')), { code: 'IRIS_APP_CLOSED' });
  assert.equal(didClose, false);
  assert.equal(d.snapshot().state, 'closing');
  resolverRelease.resolve(candidates(fakeB, 'beta::image'));
  await heldCheck; await closing;
  assert.equal(d.snapshot().state, 'closed');
  assert.equal(fakeB.calls.submit.length, 1, 'aborted resolver must never reach submit');
  assert.equal(fs.existsSync(path.join(dRoot, 'task-store')), false);
  assert.equal(inspectCoreWriterLease(dRoot).status, 'absent');
  assert.equal((await b.execute('task.inspect', { task_id: parallel.task.id })).task.id, parallel.task.id);

  // Failed release stays visible and fails closed instead of starting the next writer.
  const corruptRoot = path.join(root, 'release-failure');
  let corruptResolverCalls = 0;
  const corrupt = app({ dataRoot: corruptRoot, resolveImageCandidates: () => {
    corruptResolverCalls++;
    fs.writeFileSync(path.join(corruptRoot, '.iris-runtime-writer-v0/owner.json'), JSON.stringify({ instanceId: 'fixture-tampered-owner' }));
    throw resolverError;
  } });
  const damaged = corrupt.generateImage(input('alpha::image'));
  const damagedCheck = assert.rejects(damaged, error => error instanceof AggregateError && error.errors[0] === resolverError
    && error.errors[1].code === 'IRIS_CORE_LEASE_INVALID');
  const notRun = corrupt.execute('artifact.import', { image_bytes: FAKE_PNG });
  const notRunCheck = assert.rejects(notRun, { code: 'IRIS_APP_CLOSED' });
  await damagedCheck; await notRunCheck;
  await assert.rejects(corrupt.dispose(), { code: 'IRIS_CORE_LEASE_INVALID' });
  assert.equal(corrupt.snapshot().state, 'closing');
  assert.equal(corrupt.snapshot().cleanupFailed, true);
  assert.equal(corruptResolverCalls, 1);
  assert(fs.existsSync(path.join(corruptRoot, '.iris-runtime-writer-v0')));

  console.log('PASS Application Runtime：FIFO、输入快照、排队零 Task 取消、活动取消保留未知、错误后继续、A/B 隔离、跨进程 busy、reader 零写、关闭等待与清理失败可见');
} finally {
  for (const gate of gates) gate.resolve({ kind: 'accepted', remoteTaskId: 'fixture-cleanup' });
  await Promise.allSettled(applications.map(value => value.dispose()));
}
