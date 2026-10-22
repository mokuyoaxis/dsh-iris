import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { setImmediate } from 'node:timers/promises';
import { createDshRuntime } from '../lib/dsh-core-adapter.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { listCoreArtifacts, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { defineHostAdapter } from '../lib/host-contract.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-dsh-runtime');
const instances = [], failed = new Set();
const own = name => { const instance = createDshRuntime({ dataRoot: path.join(root, name) }); instances.push(instance); return instance; };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#8833aa' } }).png().toBuffer();
const other = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#116644' } }).png().toBuffer();
const complete = bytes => ({ kind: 'completed', value: { kind: 'image' },
  artifacts: [{ kind: 'inline-base64', data: bytes.toString('base64'), mediaType: 'image/png' }] });
const candidate = fake => ({ adapter: fake.adapter, model: fake.adapter.id + '::image-v0',
  providerBinding: 'sha256:' + 'a'.repeat(64), selectionReason: 'explicit' });
const submission = fake => ({ capability: 'image', candidates: [candidate(fake)], providerInput: { prompt: 'owned prompt', n: 1 } });
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const file = path.join(item.parentPath, item.name); return [path.relative(directory, file), sha(fs.readFileSync(file))]; }));
}

try {
  const untouched = own('untouched');
  assert(!fs.existsSync(untouched.dataRoot), 'construction must not create the root');
  assert.equal((await untouched.coreSnapshotForDsh()).available, false);
  assert(!fs.existsSync(untouched.dataRoot), 'empty reader must not initialize data');
  const stopped = untouched.dispose(); assert.equal(untouched.dispose(), stopped); await stopped;
  assert.equal(untouched.snapshot().state, 'closed');
  await assert.rejects(untouched.importImageForDsh({ imageBytes: source }), { code: 'IRIS_DSH_RUNTIME_CLOSED' });
  assert(!fs.existsSync(untouched.dataRoot));

  // Compound HTML, submit and import share one writer; only business inputs are copied.
  const core = own('queue'), entered = gate(), release = gate();
  let browserSignal;
  const html = core.htmlForDsh({ html: '<p>owned</p>', width: 32, height: 24, browser: {
    async renderHtml(input) { browserSignal = input.signal; entered.resolve(); await release.promise;
      return { bytes: source, mediaType: 'image/png' }; }
  } });
  await entered.promise;
  assert.equal(inspectCoreWriterLease(core.dataRoot).status, 'present');
  const fake = createFakeLifecycleProvider({ id: 'owned', submitSteps: [complete(source)] });
  const input = submission(fake), generated = core.submitProviderTaskForDsh(input);
  input.providerInput.prompt = 'MUTATED'; input.candidates[0].model = 'owned::changed'; input.candidates.length = 0;
  const importInput = { imageBytes: Buffer.from(source) }, imported = core.importImageForDsh(importInput);
  importInput.imageBytes.fill(0);
  const canceledBy = new AbortController();
  const canceled = core.importImageForDsh({ imageBytes: source, signal: canceledBy.signal });
  const canceledResult = assert.rejects(canceled, { name: 'AbortError' }); canceledBy.abort(); await canceledResult;
  assert.equal(fake.calls.submit.length, 0, 'queued submit has no Provider call');
  const beforeRead = tree(core.dataRoot); await core.coreSnapshotForDsh(); assert.deepEqual(tree(core.dataRoot), beforeRead);
  const independent = own('independent');
  const parallel = await independent.cropForDsh({ bytes: source, mediaType: 'image/png', left: 1, top: 2, width: 3, height: 4 });
  assert.equal(parallel.width, 3); assert.equal(browserSignal.aborted, false);
  const competing = createDshRuntime({ dataRoot: core.dataRoot }); instances.push(competing);
  await assert.rejects(competing.importImageForDsh({ imageBytes: source }), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
  assert.equal(inspectCoreWriterLease(core.dataRoot).status, 'present');
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'queue-alias'); fs.symlinkSync(core.dataRoot, alias, 'dir');
    const byAlias = createDshRuntime({ dataRoot: alias }); instances.push(byAlias);
    await assert.rejects(byAlias.importImageForDsh({ imageBytes: source }), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
  }
  release.resolve();
  const [rendered, submitted, upload] = await Promise.all([html, generated, imported]);
  assert.equal(sha(rendered.bytes), sha(source));
  assert.equal(submitted.task.modelRef, 'owned::image-v0');
  assert.equal(fake.calls.submit[0].input.input.prompt, 'owned prompt');
  assert.equal(sha(readCoreArtifactBytes(core.dataRoot, upload.artifact.id).bytes), sha(source));
  assert.equal(listCoreTasks(core.dataRoot).total, 1); assert.equal(listCoreArtifacts(core.dataRoot).total, 3);
  assert.equal(inspectCoreWriterLease(core.dataRoot).status, 'absent');
  const invalid = core.importImageForDsh({ imageBytes: Buffer.from('invalid') });
  const valid = core.importImageForDsh({ imageBytes: other });
  await assert.rejects(invalid, { code: 'IRIS_IMAGE_IMPORT_INVALID' }); await valid;
  assert.equal(core.snapshot().state, 'open', 'ordinary failure keeps the queue available');

  // Shutdown waits for a foreign submit even when that port ignores its AbortSignal.
  const shutdown = own('shutdown'), submitting = gate(), response = gate(); let submitSignal;
  const slow = createFakeLifecycleProvider({ id: 'slow', submitSteps: [async input => {
    submitSignal = input.signal; submitting.resolve(); await response.promise;
    return { kind: 'accepted', remoteTaskId: 'late-accepted' };
  }] });
  const running = shutdown.submitProviderTaskForDsh(submission(slow)); await submitting.promise;
  const runningResult = Promise.allSettled([running]);
  const queued = shutdown.importImageForDsh({ imageBytes: source });
  const queuedResult = assert.rejects(queued, { name: 'AbortError' });
  let disposed = false; const closing = shutdown.dispose(); assert.equal(shutdown.dispose(), closing);
  void closing.then(() => { disposed = true; });
  await queuedResult; await setImmediate();
  assert(submitSignal.aborted); assert.equal(disposed, false);
  assert.equal(inspectCoreWriterLease(shutdown.dataRoot).status, 'present');
  await assert.rejects(shutdown.runHostOperation(() => {}), { code: 'IRIS_DSH_RUNTIME_CLOSED' });
  response.resolve(); await runningResult; await closing;
  assert.equal(slow.calls.submit.length, 1); assert.equal(slow.calls.cancel.length, 0);
  const task = listCoreTasks(shutdown.dataRoot).tasks[0];
  assert.equal(listCoreTasks(shutdown.dataRoot).total, 1); assert.equal(task.attempts.length, 1);
  assert(['accepted', 'unknown'].includes(task.acceptance)); assert.notEqual(task.outcome, 'canceled');
  assert.equal(shutdown.snapshot().state, 'closed'); assert.equal(shutdown.snapshot().operations, 0);
  assert.equal(inspectCoreWriterLease(shutdown.dataRoot).status, 'absent');

  // Attachment delivery is owned too; closing cannot revoke already committed Core success.
  const projection = own('projection'), saving = gate(), attachment = gate();
  const ready = createFakeLifecycleProvider({ id: 'ready', submitSteps: [complete(source)] });
  const completed = await projection.submitProviderTaskForDsh(submission(ready));
  const saved = tree(projection.dataRoot);
  const host = defineHostAdapter({ id: 'projection', ports: { attachments: {
    async saveImage() { saving.resolve(); await attachment.promise; return { attachmentId: 'late', mediaType: 'image/png' }; },
    async readImage() { throw new Error('unused'); }
  } } });
  const projected = projection.projectCoreTaskForDsh(host, completed.task.id);
  const projectedResult = assert.rejects(projected, { name: 'AbortError' }); await saving.promise;
  let projectionClosed = false; const releaseProjection = projection.dispose();
  void releaseProjection.then(() => { projectionClosed = true; }); await setImmediate(); assert.equal(projectionClosed, false);
  attachment.resolve(); await projectedResult; await releaseProjection;
  assert.deepEqual(tree(projection.dataRoot), saved);
  assert.equal(listCoreTasks(projection.dataRoot).tasks[0].deliveryState, 'ready');

  // Store-check cleanup failure stays visible and stops future Host/Core operations.
  const guarded = own('bad-store'), initializer = createApplicationRuntime({ dataRoot: guarded.dataRoot });
  await initializer.execute('flow.init', {}); await initializer.execute('creation.init', {}); await initializer.dispose();
  fs.writeFileSync(path.join(guarded.dataRoot, 'creation-requests/v0/root.json'), 'BROKEN_FIXTURE');
  const foreign = gate(); let foreignSignal;
  const foreignOperation = guarded.runHostOperation(async signal => { foreignSignal = signal; await foreign.promise; });
  const rename = fs.renameSync;
  // Core resolves temporary-directory aliases before acquiring or releasing a lease.
  const leaseDirectory = path.join(fs.realpathSync.native(guarded.dataRoot), '.iris-runtime-writer-v0');
  let failedReleases = 0;
  fs.renameSync = function (from, to) {
    if (from === leaseDirectory) {
      failedReleases++;
      throw Object.assign(new Error('fixture release denied'), { code: 'EACCES' });
    }
    return rename.call(this, from, to);
  };
  try {
    await assert.rejects(guarded.importImageForDsh({ imageBytes: source }), { code: 'IRIS_CORE_LEASE_INVALID' });
    assert(guarded.snapshot().application.cleanupFailed); assert.equal(guarded.snapshot().state, 'closing');
    assert(foreignSignal.aborted, 'a failed Core release must also stop owned Host work');
    await assert.rejects(guarded.runHostOperation(() => {}), { code: 'IRIS_DSH_RUNTIME_CLOSED' });
    const failedDisposal = guarded.dispose(); assert.equal(guarded.dispose(), failedDisposal); failed.add(guarded);
    let released = false; void failedDisposal.catch(() => { released = true; });
    await setImmediate(); assert.equal(released, false, 'failed cleanup still drains foreign operations');
    foreign.resolve(); await foreignOperation;
    await assert.rejects(failedDisposal, { code: 'IRIS_CORE_LEASE_INVALID' });
    assert.equal(failedReleases, 1, 'the physical lease release is denied once and retained without retry');
    assert.equal(guarded.snapshot().state, 'closing'); assert.equal(inspectCoreWriterLease(guarded.dataRoot).status, 'present');
  } finally { foreign.resolve(); fs.renameSync = rename; }
  console.log('DSH runtime: zero-I/O assembly, owned snapshots/ports, compound FIFO, root isolation/busy, queued/active cancellation, attachment drain and retained cleanup failure OK');
} finally {
  for (const instance of instances) if (!failed.has(instance)) await instance.dispose();
}
