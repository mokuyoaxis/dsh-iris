import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner, inspectExecutionLease } from '../lib/operation-runner.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { readOperation } from '../lib/operation-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-runner-scheduling-failures');
const apps = [], runners = [], releases = [], failed = new Set();
const policy = { schemaVersion: 1, requestsPerSecond: 100, remoteLimit: 4, queueLimit: 8, queueTimeoutMs: 150 };
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  releases.push(resolve); return { promise, resolve };
}
async function until(check, details = () => ({})) {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) { if (check()) return; await delay(5); }
  assert.fail('runner scheduling fixture did not reach its checkpoint: ' + JSON.stringify(details()));
}
async function setup(name, options, wrap = value => value) {
  const dataRoot = path.join(root, name), fixture = imageFlowFixture(dataRoot, options);
  const app = createApplicationRuntime({ dataRoot, ...fixture, scheduling: policy }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const flows = [];
  for (let i = 0; i < 3; i++) flows.push(await app.execute('flow.create', {
    source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: name + '-' + i
  }));
  const errors = [];
  const runner = createOperationRunner({ dataRoot, application: wrap(app), ...fixture,
    onExecutionError(error, id) { errors.push({ code: error.code, id }); } });
  runners.push(runner); await runner.start();
  return { dataRoot, fixture, app, runner, flows, errors };
}
const input = flow => ({ key: crypto.randomUUID(), runId: flow.run.id, expectedRunRevision: flow.run.revision });
try {
  // A stays parked in the provider while a separate admitted writer holds the turn.
  // B expires after acceptance; its terminal write must survive that same wait.
  const sent = gate(), response = gate(), writeEntered = gate(), writeRelease = gate();
  let injectWriter = false, slowWrite;
  const concurrent = await setup('timeout', { afterSend: async () => { sent.resolve(); await response.promise; } }, app => ({
    ...app, async transaction(action, options) {
      const result = await app.transaction(action, options);
      if (injectWriter && result?.operation) {
        injectWriter = false;
        slowWrite = app.runMedia(runtime => runtime.run('execute', async () => {
          writeEntered.resolve(); await writeRelease.promise;
        }));
        await writeEntered.promise;
      }
      return result;
    }
  }));
  const a = await concurrent.runner.submit(input(concurrent.flows[0])); await sent.promise;
  injectWriter = true;
  const bInput = input(concurrent.flows[1]), b = await concurrent.runner.submit(bInput);
  await delay(policy.queueTimeoutMs + 60);
  assert.equal(concurrent.runner.snapshot().state, 'open');
  assert.equal(readOperation(concurrent.dataRoot, a.operation.id).state, 'running');
  assert.equal(concurrent.app.snapshot().queuedWrites, 1, 'terminal persistence survives the expired start budget');
  writeRelease.resolve(); await slowWrite;
  await until(() => readOperation(concurrent.dataRoot, b.operation.id).state === 'failed'
    && concurrent.errors.some(error => error.code === 'IRIS_SCHEDULER_QUEUE_TIMEOUT' && error.id === b.operation.id), () => ({
    runner: concurrent.runner.snapshot(), application: concurrent.app.snapshot(),
    operation: readOperation(concurrent.dataRoot, b.operation.id), errors: concurrent.errors
  }));
  const rejected = readOperation(concurrent.dataRoot, b.operation.id);
  assert.equal(rejected.failureCode, 'execution_failed'); assert.equal(rejected.startedAt, undefined);
  assert.equal(rejected.result.taskId, null); assert.equal(concurrent.fixture.calls.submit.length, 1);
  assert.equal(concurrent.runner.snapshot().state, 'open');
  assert.equal(readOperation(concurrent.dataRoot, a.operation.id).state, 'running');
  assert(concurrent.errors.some(error => error.code === 'IRIS_SCHEDULER_QUEUE_TIMEOUT' && error.id === b.operation.id));
  assert.equal((await concurrent.runner.submit(bInput)).idempotentReplay, true);
  response.resolve(); await concurrent.runner.idle();
  assert.equal(readOperation(concurrent.dataRoot, a.operation.id).state, 'succeeded');
  const c = await concurrent.runner.submit(input(concurrent.flows[2])); await concurrent.runner.idle();
  assert.equal(readOperation(concurrent.dataRoot, c.operation.id).state, 'succeeded');
  assert.equal(concurrent.fixture.calls.submit.length, 2);
  await concurrent.runner.dispose(); await concurrent.app.dispose();
  assert.equal(inspectExecutionLease(concurrent.dataRoot).status, 'absent');
  assert.equal(inspectCoreWriterLease(concurrent.dataRoot).status, 'absent');

  // Fill the real writer queue after durable acceptance, before the runner starts B.
  // Finalization must neither fail admission nor expire behind the held writer.
  const held = gate(), entered = gate(); let inject = false, holder, waiting;
  const full = await setup('full', {}, app => ({ ...app, async transaction(action, options) {
    const result = await app.transaction(action, options);
    if (inject && result?.operation) {
      inject = false;
      holder = app.run('writer', async () => { entered.resolve(); await held.promise; }); await entered.promise;
      waiting = Promise.allSettled(Array.from({ length: 7 }, () => app.run('writer', () => {})));
    }
    return result;
  } }));
  inject = true;
  const accepted = await full.runner.submit(input(full.flows[0]));
  await delay(policy.queueTimeoutMs + 60);
  assert.equal(full.runner.snapshot().state, 'open');
  assert.equal(readOperation(full.dataRoot, accepted.operation.id).state, 'queued');
  assert.equal(full.app.snapshot().queuedWrites, 1, 'only the admitted Operation terminal write remains pending');
  held.resolve(); await holder; await waiting; await full.runner.idle();
  assert.equal(readOperation(full.dataRoot, accepted.operation.id).failureCode, 'execution_failed');
  assert(full.errors.some(error => error.code === 'IRIS_SCHEDULER_QUEUE_FULL'));
  assert.equal(full.fixture.calls.submit.length, 0);
  await full.runner.dispose(); await full.app.dispose();
  assert.equal(inspectExecutionLease(full.dataRoot).status, 'absent');

  // Root-busy work waits for an explicit replay; repeated stop requests share one
  // terminal write rather than bypassing the queue budget with duplicate writes.
  const busyHeld = gate(), busyEntered = gate(); let blockBusy = false, busyHolder;
  const busy = await setup('busy', {}, app => ({ ...app,
    runMedia() { return Promise.reject(Object.assign(new Error('controlled other writer'), { code: 'IRIS_CORE_DATA_ROOT_BUSY' })); },
    async transaction(action, options) {
      const result = await app.transaction(action, options);
      if (blockBusy && result?.operation) {
        blockBusy = false;
        busyHolder = app.run('writer', async () => { busyEntered.resolve(); await busyHeld.promise; });
        await busyEntered.promise;
      }
      return result;
    }
  }));
  blockBusy = true;
  const busyInput = input(busy.flows[0]), busyAccepted = await busy.runner.submit(busyInput);
  await busy.runner.idle(); assert.equal(busy.runner.snapshot().queued, 1);
  assert.equal(readOperation(busy.dataRoot, busyAccepted.operation.id).state, 'queued');
  assert.equal((await busy.runner.submit(busyInput)).idempotentReplay, true);
  await busy.runner.idle();
  const stopped = Promise.all(Array.from({ length: 5 }, () => busy.runner.stop(busyAccepted.operation.id)));
  await delay(policy.queueTimeoutMs + 60);
  assert.equal(busy.app.snapshot().queuedWrites, 1);
  busyHeld.resolve(); await busyHolder;
  assert((await stopped).every(result => result.operation.state === 'canceled'));
  assert.equal(busy.runner.snapshot().queued, 0); assert.equal(busy.fixture.calls.submit.length, 0);
  await busy.runner.dispose(); await busy.app.dispose();
  assert.equal(inspectExecutionLease(busy.dataRoot).status, 'absent');

  // Saving the terminal failure is still a durability boundary, not a best effort.
  const broken = await setup('persistence', {}, app => ({ ...app, runMedia() {
    return Promise.reject(Object.assign(new Error('controlled admission failure'), { code: 'IRIS_SCHEDULER_QUEUE_FULL' }));
  } }));
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).includes(path.sep + 'operations' + path.sep)
        && JSON.parse(fs.readFileSync(from, 'utf8')).state === 'failed') {
      throw Object.assign(new Error('controlled persistence failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  try {
    await broken.runner.submit(input(broken.flows[0]));
    await assert.rejects(broken.runner.idle(), { code: 'EIO' });
    failed.add(broken.runner);
    assert.equal(broken.runner.snapshot().state, 'failed');
    await assert.rejects(broken.runner.dispose(), { code: 'EIO' });
    assert.equal(inspectExecutionLease(broken.dataRoot).ownerStatus, 'alive');
    assert.equal(broken.fixture.calls.submit.length, 0);
  } finally { fs.renameSync = rename; }
  console.log('Runner admission failures: isolated timeout/full queue, durable unstarted failure/replay, bounded terminal drain, healthy sibling/new work and retained persistence-failure lease OK');
} finally {
  for (const resolve of releases) resolve();
  for (const runner of runners.reverse()) if (!failed.has(runner)) await runner.dispose();
  for (const app of apps.reverse()) await app.dispose();
}
