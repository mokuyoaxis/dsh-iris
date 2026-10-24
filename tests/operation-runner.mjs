import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner, inspectExecutionLease } from '../lib/operation-runner.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { readOperation, readAllOperations } from '../lib/operation-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-operation-runner'), apps = [], runners = [];
const key = () => crypto.randomUUID();
async function setup(name, options) {
  const dataRoot = path.join(root, name), fixture = imageFlowFixture(dataRoot, options);
  const app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const flow = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'runner fixture' });
  const runner = createOperationRunner({ dataRoot, application: app, ...fixture }); runners.push(runner);
  return { dataRoot, app, fixture, flow, runner };
}
const input = flow => ({ key: key(), runId: flow.run.id, expectedRunRevision: flow.run.revision });
try {
  const sync = await setup('sync');
  assert.equal(sync.runner.snapshot().state, 'new'); assert.deepEqual(readFlowEvents(sync.dataRoot), []);
  await sync.runner.start(); assert.equal(inspectExecutionLease(sync.dataRoot).ownerStatus, 'alive');
  assert.equal(inspectCoreWriterLease(sync.dataRoot).status, 'absent');
  const second = createOperationRunner({ dataRoot: sync.dataRoot, ...sync.fixture });
  await assert.rejects(second.start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
  const call = input(sync.flow), accepted = await sync.runner.submit(call);
  assert.equal(accepted.operation.state, 'queued');
  await sync.runner.idle();
  assert.equal(readOperation(sync.dataRoot, accepted.operation.id).state, 'succeeded');
  assert.equal((await sync.app.execute('flow.inspect', { run_id: call.runId })).status, 'awaiting_selection');
  const events = readFlowEvents(sync.dataRoot);
  assert.equal(events.filter(event => event.kind === 'submit').length, 1);
  const replay = await sync.runner.submit(call); assert(replay.idempotentReplay); assert.equal(replay.operation.id, accepted.operation.id);
  assert.deepEqual(readFlowEvents(sync.dataRoot), events);
  assert.equal(sync.fixture.calls.submit.length, 1);
  await assert.rejects(sync.runner.submit({ ...call, expectedRunRevision: 99 }), { code: 'IRIS_OPERATION_KEY_CONFLICT' });
  assert.equal((await sync.runner.stop(accepted.operation.id)).localStopped, false);
  await sync.runner.dispose(); assert.equal(inspectExecutionLease(sync.dataRoot).status, 'absent');

  let entered;
  const sent = new Promise(resolve => { entered = resolve; });
  const stop = await setup('stop', { afterSend: ({ signal }) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(Object.assign(new Error('fixture stopped'), { name: 'AbortError' })), { once: true });
  }) });
  await stop.runner.start(); const pendingInput = input(stop.flow), pending = await stop.runner.submit(pendingInput); await sent;
  assert.equal(readOperation(stop.dataRoot, pending.operation.id).state, 'running');
  assert.equal((await stop.runner.submit(pendingInput)).operation.id, pending.operation.id, 'active replay needs no business writer');
  const stopped = await stop.runner.stop(pending.operation.id);
  assert.equal(stopped.operation.state, 'canceled'); assert.equal(stopped.localStopped, true); assert.equal(stopped.remoteCancellation, 'not_requested');
  assert.equal((await stop.runner.stop(pending.operation.id)).operation.revision, stopped.operation.revision);
  const original = await stop.app.execute('flow.inspect', { run_id: pendingInput.runId });
  assert.equal(original.task.attempts.length, 1); assert.equal(original.task.acceptance, 'unknown');
  const explicit = await stop.runner.submit({ ...pendingInput, key: key(), expectedRunRevision: original.run.revision }); await stop.runner.idle();
  assert.equal(readOperation(stop.dataRoot, explicit.operation.id).state, 'succeeded');
  assert.equal(readFlowEvents(stop.dataRoot).filter(event => event.kind === 'submit').length, 1, 'unknown acceptance is not resubmitted');
  assert.equal(stop.fixture.calls.cancel.length, 0, 'local stop never calls remote cancel');
  assert.equal(stop.fixture.calls.submit.length, 1);
  await stop.runner.dispose();

  const queued = await setup('queued');
  await queued.runner.start();
  const waiting = await queued.runner.submit(input(queued.flow));
  const canceled = await queued.runner.stop(waiting.operation.id); await queued.runner.idle();
  assert.equal(canceled.operation.state, 'canceled');
  assert.equal(readFlowEvents(queued.dataRoot).filter(event => event.kind === 'submit').length, 0);
  assert.equal(queued.fixture.calls.submit.length, 0);
  await queued.runner.dispose();

  const restart = await setup('restart');
  const prior = await restart.app.execute('operation.accept', { ...input(restart.flow), ownerInstanceId: key() });
  await restart.runner.start();
  assert.equal(readOperation(restart.dataRoot, prior.operation.id).state, 'interrupted');
  assert.equal(readAllOperations(restart.dataRoot).length, 1); assert.deepEqual(readFlowEvents(restart.dataRoot), []);
  await restart.runner.dispose();
  console.log('Operation runner: exclusive root, one finite continue, active replay, queued cancel, local stop/unknown preservation and explicit restart interruption OK');
} finally {
  for (const runner of runners.reverse()) await runner.dispose();
  for (const app of apps.reverse()) await app.dispose();
}
