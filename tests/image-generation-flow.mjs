import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner } from '../lib/operation-runner.js';
import { inspectCoreTask } from '../lib/core-tasks.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { planCoreDeletion } from '../lib/core-maintenance.js';
import { FLOW_MODEL, FLOW_RESULT, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-image-generation-flow'), apps = [], runners = [];
const input = { modelRef: FLOW_MODEL, prompt: 'Generate an iris illustration' };
function app(dataRoot, ports = {}) { const value = createApplicationRuntime({ dataRoot, ...ports }); apps.push(value); return value; }
async function setup(name, options) {
  const dataRoot = path.join(root, name), ports = imageFlowFixture(dataRoot, options), value = app(dataRoot, ports);
  await value.execute('flow.init', {}); await value.execute('execution.init', { imageGeneration: true });
  return { dataRoot, ports, value };
}
try {
  const oldRoot = path.join(root, 'old'), old = app(oldRoot, imageFlowFixture(oldRoot));
  await old.execute('flow.init', {}); await old.execute('execution.init', {});
  await assert.rejects(old.execute('creation.generate', { key: crypto.randomUUID(), value: input }), { code: 'IRIS_FLOW_GENERATION_ROOT_REQUIRED' });
  assert.equal((await old.execute('flow.list', {})).total, 0); assert.equal(readFlowEvents(oldRoot).length, 0);
  await assert.rejects(old.execute('execution.init', { imageGeneration: true }), { code: 'IRIS_CREATION_ROOT_VERSION_CONFLICT' });

  const { dataRoot, ports, value } = await setup('sync', { beforeSubmit: (request, context) => {
    assert.equal(request.input.image, undefined, 'generation never reads or invents a source image');
    assert.equal(context.taskId, reservedTask);
  } });
  const key = crypto.randomUUID(), created = await value.execute('creation.generate', { key, value: input });
  const runId = created.flow.run.id, reservedTask = created.flow.run.generate.taskId;
  assert.equal(created.flow.run.recipe, 'image-generate/v0'); assert.equal(created.flow.run.source, undefined);
  assert.equal(created.flow.run.compare, undefined); assert.equal(created.flow.task, null);
  assert.deepEqual((await value.execute('creation.lookup', { kind: 'generation-create', key })).result, { runId });
  assert.equal((await value.execute('creation.generate', { key, value: input })).flow.run.id, runId);
  await assert.rejects(value.execute('creation.generate', { key, value: { ...input, prompt: 'different' } }), { code: 'IRIS_CREATION_KEY_CONFLICT' });
  await assert.rejects(value.execute('creation.flow', { key: crypto.randomUUID(), value: input }), { code: 'IRIS_CREATION_INPUT_INVALID' });
  await assert.rejects(value.execute('creation.generate', { key: crypto.randomUUID(), value: { ...input, sourceArtifactId: 'artifact_' + 'a'.repeat(24) } }), { code: 'IRIS_CREATION_INPUT_INVALID' });
  assert.equal(readFlowEvents(dataRoot).length, 0);

  const runner = createOperationRunner({ dataRoot, application: value, ...ports }); runners.push(runner); await runner.start();
  const opKey = crypto.randomUUID(), accepted = await runner.submit({ key: opKey, runId, expectedRunRevision: 1 });
  for (let i = 0; i < 100; i++) {
    const operation = (await value.execute('operation.inspect', { id: accepted.operation.id })).operation;
    if (!['queued', 'running'].includes(operation.state)) { assert.equal(operation.state, 'succeeded'); break; }
    await new Promise(resolve => setTimeout(resolve, 10));
    assert(i < 99, 'finite runner completes');
  }
  const result = await value.execute('flow.inspect', { run_id: runId });
  assert.equal(result.status, 'awaiting_selection'); assert.equal(result.run.comparison, undefined);
  assert.equal(result.task.id, reservedTask); assert.equal(result.task.flowBinding.stepId, 'generate');
  assert.equal(result.task.sourceArtifactId, undefined);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, result.run.output.artifactId).bytes, FLOW_RESULT);
  assert.equal(planCoreDeletion(dataRoot, { artifact_ids: [result.run.output.artifactId], task_ids: [reservedTask] }).allowed, false);
  assert.equal((await runner.submit({ key: opKey, runId, expectedRunRevision: 1 })).idempotentReplay, true);
  await runner.dispose();
  await value.dispose();
  const reopened = app(dataRoot);
  const repeated = await reopened.execute('flow.continue', { run_id: runId });
  assert.deepEqual(repeated, result); assert.equal(readFlowEvents(dataRoot).length, 1);
  const selected = await reopened.execute('flow.select', { run_id: runId, artifact_id: result.run.output.artifactId, expected_revision: result.run.revision });
  assert.equal(selected.status, 'selected');
  const output = path.join(root, 'generated.png');
  await reopened.execute('flow.export', { run_id: runId, output_path: output });
  assert.deepEqual(fs.readFileSync(output), FLOW_RESULT);
  const taskFile = path.join(dataRoot, 'task-store/v0/tasks', reservedTask + '.json'), original = fs.readFileSync(taskFile);
  const corrupt = JSON.parse(original); corrupt.flowBinding.stepId = 'edit'; fs.writeFileSync(taskFile, JSON.stringify(corrupt));
  await assert.rejects(reopened.execute('flow.continue', { run_id: runId }), { code: 'IRIS_FLOW_TASK_CONFLICT' });
  fs.writeFileSync(taskFile, original);
  assert.equal(inspectCoreTask(dataRoot, reservedTask).attempts.length, 1);

  for (const mode of ['unknown', 'async']) {
    const fixture = await setup(mode, { mode });
    const saved = await fixture.value.execute('creation.generate', { key: crypto.randomUUID(), value: input });
    const run_id = saved.flow.run.id;
    const first = await fixture.value.execute('flow.continue', { run_id });
    assert.equal(first.status, mode === 'unknown' ? 'needs_attention' : 'running');
    const next = await fixture.value.execute('flow.continue', { run_id });
    assert.equal(next.status, mode === 'unknown' ? 'needs_attention' : 'awaiting_selection');
    assert.equal(readFlowEvents(fixture.dataRoot).filter(event => event.kind === 'submit').length, 1);
  }
  // A queued generation can stop before a Task/output exists; empty result references are truthful.
  const stopped = await setup('queued-stop');
  const saved = await stopped.value.execute('creation.generate', { key: crypto.randomUUID(), value: input });
  const queued = await stopped.value.execute('operation.accept', { key: crypto.randomUUID(), runId: saved.flow.run.id,
    expectedRunRevision: 1, ownerInstanceId: crypto.randomUUID() });
  const canceled = await stopped.value.execute('operation.transition', { id: queued.operation.id, expectedRevision: 1, state: 'canceled' });
  assert.deepEqual(canceled.operation.result.artifactIds, []); assert.equal(canceled.operation.result.taskId, null);
  assert.equal(readFlowEvents(stopped.dataRoot).length, 0);
  console.log('PASS image generation: explicit v2 gate, zero-call creation/lookup, stable Run/Task/Operation, no source/diff, exact output, restart, unknown acceptance, selection and stop');
} finally { await Promise.allSettled(runners.map(value => value.dispose())); await Promise.allSettled(apps.map(value => value.dispose())); }
