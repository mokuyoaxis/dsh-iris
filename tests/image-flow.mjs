import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { createCoreTask, listCoreTasks, claimFlowTask } from '../lib/core-tasks.js';
import { readFlowRun, flowSha256 } from '../lib/flow-store.js';
import { planCoreCleanup, planCoreDeletion } from '../lib/core-maintenance.js';
import { FLOW_BINDING, FLOW_MODEL, FLOW_SOURCE, FLOW_RESULT, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-image-flow');
const apps = [];
function app(dataRoot, ports = {}) { const value = createApplicationRuntime({ dataRoot, ...ports }); apps.push(value); return value; }
function tree(directory) {
  if (!fs.existsSync(directory)) return {};
  const files = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const [name, digest] of Object.entries(tree(file))) files[entry.name + '/' + name] = digest;
    else files[entry.name] = flowSha256(fs.readFileSync(file));
  }
  return files;
}
async function create(dataRoot, ports) {
  const value = app(dataRoot, ports);
  await value.execute('flow.init', {});
  const source = (await value.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const created = await value.execute('flow.create', { prompt: 'Change rectangle to green', model_ref: FLOW_MODEL, source_artifact_id: source.id });
  return { value, source, created, input: { run_id: created.run.id } };
}

try {
  const absent = path.join(root, 'absent'), unused = app(absent);
  await assert.rejects(unused.execute('flow.list', {}), { code: 'IRIS_CORE_DATA_ROOT_NOT_FOUND' });
  assert.equal(fs.existsSync(absent), false);
  const legacyRoot = path.join(root, 'legacy'), legacy = app(legacyRoot);
  await legacy.execute('artifact.import', { image_bytes: FLOW_SOURCE });
  const legacyBytes = tree(legacyRoot);
  await assert.rejects(legacy.execute('flow.init', {}), { code: 'IRIS_FLOW_ROOT_NOT_EMPTY' });
  assert.deepEqual(tree(legacyRoot), legacyBytes, '旧数据根不能被隐式迁移');

  const dataRoot = path.join(root, 'main');
  const fixture = imageFlowFixture(dataRoot, { beforeSubmit: (_input, context) => {
    const run = readFlowRun(dataRoot, created.run.id);
    assert.equal(run.edit.claimed, true);
    const task = listCoreTasks(dataRoot).tasks[0];
    assert.equal(task.id, run.edit.taskId); assert.equal(task.id, context.taskId);
    assert.equal(task.phase, 'submitting'); assert.equal(task.attempts.length, 1);
    assert.equal(task.flowBinding.inputDigest, run.inputDigest);
  } });
  const { value, source, created, input } = await create(dataRoot, fixture);
  const runFile = path.join(dataRoot, 'flow-store/v0/runs', created.run.id + '.json');
  assert.equal(created.status, 'not_started'); assert.equal(created.task, null);
  assert.equal(readFlowEvents(dataRoot).length, 0);
  const beforeReads = tree(dataRoot);
  assert.equal((await value.execute('flow.inspect', input)).status, 'not_started');
  assert.equal((await value.execute('flow.list', {})).total, 1);
  assert.deepEqual(tree(dataRoot), beforeReads, '读取不得创建 Task、租约或更新 Run');
  assert.deepEqual((await value.execute('flow.init', {})).root, (await value.execute('flow.init', {})).root);
  await assert.rejects(value.execute('flow.create', { ...created.run.input, n: 2 }), { code: 'IRIS_FLOW_INPUT_INVALID' });
  const [result, concurrentDuplicate] = await Promise.all([value.execute('flow.continue', input), value.execute('flow.continue', input)]);
  assert.deepEqual(concurrentDuplicate, result, '同一 Run 连续点击由实例队列接回同一结果');
  assert.equal(result.status, 'awaiting_selection'); assert.equal(result.task.id, created.run.edit.taskId);
  assert.equal(result.run.comparison.artifactId, created.run.compare.artifactId);
  assert.equal(result.metrics.diffPixels, 48 * 32);
  assert.equal(result.run.output.sha256, flowSha256(FLOW_RESULT));
  assert.equal(readFlowEvents(dataRoot).filter(event => event.kind === 'submit').length, 1);
  assert.equal((await value.execute('task.list', {})).total, 1);

  await value.dispose();
  const reopened = app(dataRoot);
  const completeBytes = tree(dataRoot);
  const repeated = await reopened.execute('flow.continue', input);
  assert.deepEqual(repeated, result); assert.deepEqual(tree(dataRoot), completeBytes);
  await assert.rejects(reopened.execute('flow.export', { ...input, output_path: path.join(root, 'unselected.png') }), { code: 'IRIS_FLOW_SELECTION_REQUIRED' });
  await assert.rejects(reopened.execute('flow.select', { ...input, artifact_id: result.run.comparison.artifactId }), { code: 'IRIS_FLOW_SELECTION_INVALID' });
  const selected = await reopened.execute('flow.select', { ...input, artifact_id: result.run.output.artifactId });
  assert.equal(selected.status, 'selected');
  assert.equal((await reopened.execute('flow.select', { ...input, artifact_id: result.run.output.artifactId })).run.revision, selected.run.revision);
  const output = path.join(root, 'selected.png');
  await reopened.execute('flow.export', { ...input, output_path: output });
  assert.equal(flowSha256(fs.readFileSync(output)), flowSha256(FLOW_RESULT));
  await assert.rejects(reopened.execute('flow.export', { ...input, output_path: output }), { code: 'IRIS_ARTIFACT_EXPORT_EXISTS' });
  await reopened.execute('flow.select', { ...input, artifact_id: source.id });
  const original = path.join(root, 'original.png');
  await reopened.execute('flow.export', { ...input, output_path: original });
  assert.equal(flowSha256(fs.readFileSync(original)), flowSha256(FLOW_SOURCE));
  const blocked = planCoreDeletion(dataRoot, { task_ids: [result.task.id], artifact_ids: [source.id, result.run.output.artifactId, result.run.comparison.artifactId] });
  assert.equal(blocked.allowed, false);
  assert(blocked.blockers.some(item => item.reason === 'flow_task_reference'));
  assert.equal(blocked.blockers.filter(item => item.reason === 'flow_artifact_reference').length, 3);
  const taskFile = path.join(dataRoot, 'task-store/v0/tasks', result.task.id + '.json'), taskBytes = fs.readFileSync(taskFile);
  assert(!taskBytes.includes(Buffer.from('Change rectangle')) && !taskBytes.includes(Buffer.from('prompt')));
  assert(!fs.readFileSync(runFile, 'utf8').includes(dataRoot));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(runFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(runFile)).mode & 0o777, 0o700);
  }
  const conflicting = JSON.parse(taskBytes); conflicting.flowBinding.inputDigest = 'sha256:' + 'b'.repeat(64);
  fs.writeFileSync(taskFile, JSON.stringify(conflicting));
  await assert.rejects(reopened.execute('flow.continue', input), { code: 'IRIS_FLOW_TASK_CONFLICT' });
  fs.writeFileSync(taskFile, taskBytes);
  const wrongProvider = JSON.parse(taskBytes); wrongProvider.providerId = 'other-provider';
  wrongProvider.attempts[0].providerId = 'other-provider';
  fs.writeFileSync(taskFile, JSON.stringify(wrongProvider));
  await assert.rejects(reopened.execute('flow.inspect', input), { code: 'IRIS_FLOW_TASK_CONFLICT' });
  fs.writeFileSync(taskFile, taskBytes);
  fs.renameSync(taskFile, taskFile + '.held');
  await assert.rejects(reopened.execute('flow.continue', input), { code: 'IRIS_FLOW_TASK_CONFLICT' });
  assert.throws(() => planCoreCleanup(dataRoot), { code: 'IRIS_FLOW_TASK_CONFLICT' });
  fs.renameSync(taskFile + '.held', taskFile);
  const sourceObject = path.join(dataRoot, 'artifact-store/v0/objects', source.id + '.png');
  fs.renameSync(sourceObject, sourceObject + '.held');
  await assert.rejects(reopened.execute('flow.continue', input), error => error.code.startsWith('IRIS_ARTIFACT_'));
  fs.renameSync(sourceObject + '.held', sourceObject);
  const runBytes = fs.readFileSync(runFile);
  fs.writeFileSync(runFile, '{broken');
  assert.throws(() => planCoreDeletion(dataRoot, { artifact_ids: [source.id] }), { code: 'IRIS_FLOW_RECORD_INVALID' });
  assert.throws(() => planCoreCleanup(dataRoot), { code: 'IRIS_FLOW_RECORD_INVALID' });
  fs.writeFileSync(runFile, runBytes);
  const changedInput = JSON.parse(runBytes); changedInput.input.prompt = 'Changed after submission';
  fs.writeFileSync(runFile, JSON.stringify(changedInput));
  await assert.rejects(reopened.execute('flow.inspect', input), { code: 'IRIS_FLOW_RECORD_INVALID' });
  fs.writeFileSync(runFile, runBytes);
  if (process.platform !== 'win32') {
    fs.renameSync(runFile, runFile + '.held');
    fs.symlinkSync(runFile + '.held', runFile);
    await assert.rejects(reopened.execute('flow.inspect', input), { code: 'IRIS_FLOW_RECORD_INVALID' });
    fs.renameSync(runFile, runFile + '.symlink-held');
    fs.renameSync(runFile + '.held', runFile);
    fs.renameSync(runFile + '.symlink-held', path.join(root, 'held-run-symlink'));
  }

  const driftRoot = path.join(root, 'drift'), driftPorts = imageFlowFixture(driftRoot);
  const drift = await create(driftRoot, driftPorts);
  const driftApp = app(driftRoot, { resolveImageCandidates: request => driftPorts.resolveImageCandidates(request).map(item => ({ ...item, providerBinding: 'sha256:' + 'b'.repeat(64) })) });
  await assert.rejects(driftApp.execute('flow.continue', drift.input), { code: 'IRIS_FLOW_PROVIDER_CHANGED' });
  assert.equal(listCoreTasks(driftRoot).total, 0); assert.equal(readFlowEvents(driftRoot).length, 0);
  const reserved = path.join(driftRoot, 'artifact-store/v0/objects', drift.created.run.compare.artifactId + '.png');
  fs.writeFileSync(reserved, FLOW_RESULT); fs.utimesSync(reserved, new Date(0), new Date(0));
  assert(!planCoreCleanup(driftRoot, { older_than_ms: 60000 }).candidates.some(entry => entry.path.includes(drift.created.run.compare.artifactId)));
  assert.equal(planCoreDeletion(driftRoot, { artifact_ids: [drift.source.id] }).allowed, false);
  const firstClaim = claimFlowTask(driftRoot, drift.created.run.id);
  assert.deepEqual(claimFlowTask(driftRoot, drift.created.run.id), firstClaim, '同一意图不能覆盖已建立的 Task');
  const legacyTask = createCoreTask(driftRoot, { capability: 'image' });
  assert.equal(legacyTask.flowBinding, undefined);

  const unknownRoot = path.join(root, 'unknown'), unknown = await create(unknownRoot, imageFlowFixture(unknownRoot, { mode: 'unknown' }));
  assert.equal((await unknown.value.execute('flow.continue', unknown.input)).status, 'needs_attention');
  assert.equal((await app(unknownRoot).execute('flow.continue', unknown.input)).status, 'needs_attention');
  assert.equal(readFlowEvents(unknownRoot).length, 1);

  const asyncRoot = path.join(root, 'async'), asyncPorts = imageFlowFixture(asyncRoot, { mode: 'async', pendingPoll: true });
  const asynchronous = await create(asyncRoot, asyncPorts);
  assert.equal((await asynchronous.value.execute('flow.continue', asynchronous.input)).status, 'running');
  assert.equal((await asynchronous.value.execute('flow.continue', asynchronous.input)).status, 'running');
  const asyncResult = await asynchronous.value.execute('flow.continue', asynchronous.input);
  assert.equal(asyncResult.status, 'awaiting_selection'); assert.equal(asyncResult.task.deliveryCache, true);
  assert.equal(readFlowEvents(asyncRoot).filter(event => event.kind === 'submit').length, 1);
  assert.equal(readFlowEvents(asyncRoot).filter(event => event.kind === 'poll').length, 2);
  await app(asyncRoot).execute('flow.continue', asynchronous.input);
  assert.equal(readFlowEvents(asyncRoot).length, 3);
  assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  console.log('PASS Image Flow：专用根、零调用创建/读取、稳定 Task/比较图、重复继续/选择/导出、漂移/损坏/丢失拒绝、引用保护、未知零重提、异步单次观察');
} finally { await Promise.allSettled(apps.map(value => value.dispose())); }
