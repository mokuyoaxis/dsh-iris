// Durable, non-executing local intentions. Call mutations under the supplied Core writer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicCreatePrivate, atomicWritePrivate } from './private-storage.js';
import { inspectLocalRequestRoot, initializeLocalRequestRoot, requestDirectory } from './local-request-root.js';
import { listCreationRequests } from './creation-request-store.js';
import { readFlowRun, flowStep } from './flow-store.js';
import { findFlowTask } from './core-tasks.js';

const ID = /^op_[a-f0-9]{64}$/;
const RUN = /^run_[a-f0-9]{24}$/;
const TASK = /^task_[a-f0-9]{24}$/;
const ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted']);
const ACTIVE = new Set(['queued', 'running']);
const FAILURE_CODES = new Set(['run_changed', 'execution_failed']);
export const MAX_ACTIVE_OPERATIONS = 8;
export function operationFail(code, message) { throw Object.assign(new Error(message), { code }); }
const invalid = () => operationFail('IRIS_OPERATION_STORE_INVALID', 'Operation 记录未知、损坏或与请求容器不一致');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const positive = value => Number.isSafeInteger(value) && value >= 1;
function keys(value, allowed, required = allowed) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)));
}
function input(value, allowed, required = allowed) {
  if (!keys(value, allowed, required)) operationFail('IRIS_OPERATION_INPUT_INVALID', 'Operation 输入包含缺失或不支持的字段');
}
export function inspectExecutionRoot(root) {
  const marker = inspectLocalRequestRoot(root, { allowAbsent: true });
  if (![1, 2].includes(marker?.schemaVersion)) operationFail('IRIS_OPERATION_ROOT_REQUIRED', 'Operation 需要新的专用执行根，请显式执行 execution init；不转换原根');
  return marker;
}
export function initializeExecutionRoot(root, { imageGeneration = false } = {}) {
  const marker = initializeLocalRequestRoot(root, imageGeneration ? 2 : 1);
  listCreationRequests(root); readAllOperations(root);
  return marker;
}
export function operationId(marker, key) {
  if (!UUID.test(key)) operationFail('IRIS_OPERATION_KEY_INVALID', 'Operation Key 须为小写 UUIDv4');
  return 'op_' + hash(JSON.stringify(['operation/v0', marker.rootId, key]));
}
function inputDigest(runId, revision) {
  return 'sha256:' + hash(JSON.stringify(['operation-call/v0', 'flow.continue', runId, revision]));
}
const bindingFor = run => ({ taskId: flowStep(run).taskId, sourceArtifactId: run.source?.artifactId ?? null,
  comparisonArtifactId: run.compare?.artifactId ?? null, inputDigest: run.inputDigest });
const artifactsFor = run => [...new Set([run.source?.artifactId, run.output?.artifactId, run.comparison?.artifactId, run.selection?.artifactId].filter(Boolean))];
function validate(record, id, marker) {
  if (!keys(record, ['schemaVersion', 'id', 'rootId', 'revision', 'action', 'runId', 'expectedRunRevision', 'inputDigest',
    'ownerInstanceId', 'binding', 'createdAt', 'updatedAt', 'state', 'cancelRequested', 'startedAt', 'finishedAt', 'result', 'failureCode'],
  ['schemaVersion', 'id', 'rootId', 'revision', 'action', 'runId', 'expectedRunRevision', 'inputDigest',
    'ownerInstanceId', 'binding', 'createdAt', 'updatedAt', 'state', 'cancelRequested'])
      || record.schemaVersion !== 0 || !ID.test(id) || record.id !== id || record.rootId !== marker.rootId
      || !positive(record.revision) || record.action !== 'flow.continue' || !RUN.test(record.runId)
      || !positive(record.expectedRunRevision) || record.inputDigest !== inputDigest(record.runId, record.expectedRunRevision)
      || !UUID.test(record.ownerInstanceId) || !STATES.has(record.state) || typeof record.cancelRequested !== 'boolean'
      || !iso(record.createdAt) || !iso(record.updatedAt) || record.updatedAt < record.createdAt
      || !keys(record.binding, ['taskId', 'sourceArtifactId', 'comparisonArtifactId', 'inputDigest'])
      || !TASK.test(record.binding.taskId) || !(record.binding.sourceArtifactId === null && record.binding.comparisonArtifactId === null && marker.schemaVersion === 2
        || ARTIFACT.test(record.binding.sourceArtifactId) && ARTIFACT.test(record.binding.comparisonArtifactId))
      || !DIGEST.test(record.binding.inputDigest)) invalid();
  const hasStarted = Object.hasOwn(record, 'startedAt');
  if (record.revision !== (record.state === 'queued' ? 1 : record.state === 'running' || !hasStarted ? 2 : 3)) invalid();
  if (hasStarted && (!iso(record.startedAt) || record.startedAt < record.createdAt || record.startedAt > record.updatedAt)) invalid();
  if (record.state === 'queued' && (record.revision !== 1 || record.updatedAt !== record.createdAt || hasStarted || record.cancelRequested)
      || record.state === 'running' && (!hasStarted || record.cancelRequested)
      || record.state === 'succeeded' && (!hasStarted || record.cancelRequested)
      || record.cancelRequested !== (record.state === 'canceled')
      || record.state === 'failed' && (!FAILURE_CODES.has(record.failureCode) || !hasStarted && record.failureCode !== 'run_changed')
      || record.state !== 'failed' && Object.hasOwn(record, 'failureCode')) invalid();
  if (ACTIVE.has(record.state)) {
    if (Object.hasOwn(record, 'finishedAt') || Object.hasOwn(record, 'result')) invalid();
  } else {
    if (!iso(record.finishedAt) || record.finishedAt !== record.updatedAt || record.finishedAt < record.createdAt
        || !keys(record.result, ['runRevision', 'taskId', 'artifactIds']) || !positive(record.result.runRevision)
        || record.result.runRevision < record.expectedRunRevision
        || record.result.taskId !== null && record.result.taskId !== record.binding.taskId
        || !Array.isArray(record.result.artifactIds) || record.binding.sourceArtifactId !== null && !record.result.artifactIds.length
        || new Set(record.result.artifactIds).size !== record.result.artifactIds.length
        || !record.result.artifactIds.every(value => ARTIFACT.test(value))
        || record.binding.sourceArtifactId !== null && !record.result.artifactIds.includes(record.binding.sourceArtifactId)
        || record.state === 'succeeded' && !record.result.taskId) invalid();
  }
  return record;
}
function validateBinding(root, record) {
  const run = readFlowRun(root, record.runId), task = findFlowTask(root, run);
  if (Object.entries(bindingFor(run)).some(([key, value]) => record.binding[key] !== value) || run.revision < record.expectedRunRevision
      || record.result && (record.result.runRevision > run.revision || record.result.taskId && !task
        || record.result.artifactIds.some(id => !artifactsFor(run).includes(id)))) {
    operationFail('IRIS_OPERATION_BINDING_CONFLICT', 'Operation 与原 Run/Task/作品绑定冲突，停止操作并保留原记录');
  }
  return { run, task };
}
function fileFor(root, marker, id) {
  if (!ID.test(id)) operationFail('IRIS_OPERATION_INPUT_INVALID', 'Operation ID 格式无效');
  return path.join(requestDirectory(root, marker, 'operations'), id + '.json');
}
export function readOperation(root, id, marker = inspectExecutionRoot(root)) {
  const file = fileFor(root, marker, id);
  let record;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) invalid();
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { invalid(); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  validate(record, id, marker); validateBinding(root, record);
  return structuredClone(record);
}
export function readAllOperations(root) {
  const marker = inspectLocalRequestRoot(root, { allowAbsent: true });
  if (!marker || marker.schemaVersion === 0) return [];
  const records = [];
  for (const name of fs.readdirSync(requestDirectory(root, marker, 'operations'))) {
    if (/^op_[a-f0-9]{64}\.json\.tmp-[1-9][0-9]*-[a-f0-9]{12}$/.test(name)) continue;
    if (!/^op_[a-f0-9]{64}\.json$/.test(name)) invalid();
    const record = readOperation(root, name.slice(0, -5), marker);
    if (!record) invalid();
    records.push(record);
  }
  const active = records.filter(record => ACTIVE.has(record.state));
  if (active.length > MAX_ACTIVE_OPERATIONS || new Set(active.map(record => record.runId)).size !== active.length) invalid();
  return records;
}

export function acceptOperation(root, value) {
  input(value, ['key', 'runId', 'expectedRunRevision', 'ownerInstanceId']);
  if (!RUN.test(value.runId) || !positive(value.expectedRunRevision) || !UUID.test(value.ownerInstanceId)) {
    operationFail('IRIS_OPERATION_INPUT_INVALID', '需要明确 Run、正整数 revision 与 owner 实例 UUID');
  }
  const marker = inspectExecutionRoot(root), id = operationId(marker, value.key);
  const fingerprint = inputDigest(value.runId, value.expectedRunRevision), previous = readOperation(root, id, marker);
  if (previous) {
    if (previous.inputDigest !== fingerprint) operationFail('IRIS_OPERATION_KEY_CONFLICT', '该 Key 已绑定其他操作输入');
    return { operation: previous, idempotentReplay: true };
  }
  const run = readFlowRun(root, value.runId); findFlowTask(root, run);
  if (run.revision !== value.expectedRunRevision) operationFail('IRIS_OPERATION_RUN_CHANGED', 'Run revision 已改变，请读取原流程后明确操作');
  const active = readAllOperations(root).filter(record => ACTIVE.has(record.state));
  const conflicting = active.find(record => record.runId === run.id);
  if (conflicting) throw Object.assign(new Error('此 Run 已有未结束的 Operation'), { code: 'IRIS_OPERATION_RUN_BUSY', operationId: conflicting.id });
  if (active.length >= MAX_ACTIVE_OPERATIONS) operationFail('IRIS_OPERATION_QUEUE_FULL', '未结束的 Operation 已达上限，本次未接收');
  const now = new Date().toISOString();
  const record = { schemaVersion: 0, id, rootId: marker.rootId, revision: 1, action: 'flow.continue', runId: run.id,
    expectedRunRevision: value.expectedRunRevision, inputDigest: fingerprint, ownerInstanceId: value.ownerInstanceId,
    binding: bindingFor(run), createdAt: now, updatedAt: now, state: 'queued', cancelRequested: false };
  validate(record, id, marker);
  atomicCreatePrivate(fileFor(root, marker, id), JSON.stringify(record, null, 2) + '\n');
  return { operation: structuredClone(record), idempotentReplay: false };
}

/** Store-only CAS. It neither runs flow.continue nor delivers an abort signal or remote cancel. */
export function transitionOperation(root, value) {
  input(value, ['id', 'expectedRevision', 'state', 'failureCode'], ['id', 'expectedRevision', 'state']);
  if (!positive(value.expectedRevision) || !STATES.has(value.state)) operationFail('IRIS_OPERATION_INPUT_INVALID', 'Operation 状态或 revision 无效');
  const marker = inspectExecutionRoot(root), current = readOperation(root, value.id, marker);
  if (!current) operationFail('IRIS_OPERATION_NOT_FOUND', 'Operation 不存在');
  if (current.revision !== value.expectedRevision) operationFail('IRIS_OPERATION_REVISION_CONFLICT', 'Operation 已改变，请先读取原记录');
  const allowed = current.state === 'queued' ? ['running', 'canceled', 'interrupted', 'failed']
    : current.state === 'running' ? ['succeeded', 'failed', 'canceled', 'interrupted'] : [];
  if (!allowed.includes(value.state)) operationFail('IRIS_OPERATION_TRANSITION_INVALID', '不允许此 Operation 状态转换；结束记录不重新排队');
  if (value.state === 'failed' ? !FAILURE_CODES.has(value.failureCode) || current.state === 'queued' && value.failureCode !== 'run_changed'
    : Object.hasOwn(value, 'failureCode')) operationFail('IRIS_OPERATION_INPUT_INVALID', '失败记录只接受有限错误类别，不保存异常原文');
  const { run, task } = validateBinding(root, current);
  if (value.state === 'running' && run.revision !== current.expectedRunRevision) operationFail('IRIS_OPERATION_RUN_CHANGED', 'Run revision 已改变，未开始本次调用');
  if (value.state === 'succeeded' && !task) operationFail('IRIS_OPERATION_RESULT_INVALID', '没有原 Task 事实，不能记录调用成功');
  const now = new Date(Math.max(Date.now(), Date.parse(current.updatedAt))).toISOString();
  const next = { ...current, revision: current.revision + 1, state: value.state, updatedAt: now,
    cancelRequested: value.state === 'canceled',
    ...(value.state === 'running' ? { startedAt: now } : { finishedAt: now,
      result: { runRevision: run.revision, taskId: task?.id || null, artifactIds: artifactsFor(run) } }),
    ...(value.state === 'failed' ? { failureCode: value.failureCode } : {}) };
  validate(next, next.id, marker);
  atomicWritePrivate(fileFor(root, marker, next.id), JSON.stringify(next, null, 2) + '\n');
  return structuredClone(next);
}

export function listOperations(root, value = {}) {
  input(value, ['runId', 'limit', 'cursor'], []);
  if (value.runId !== undefined && !RUN.test(value.runId) || value.limit !== undefined && (!positive(value.limit) || value.limit > 30)
      || value.cursor !== undefined && !ID.test(value.cursor)) operationFail('IRIS_OPERATION_INPUT_INVALID', 'Operation 列表参数无效');
  inspectExecutionRoot(root);
  const ordered = readAllOperations(root).filter(record => value.runId === undefined || record.runId === value.runId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const offset = value.cursor === undefined ? 0 : ordered.findIndex(record => record.id === value.cursor) + 1;
  if (value.cursor !== undefined && offset === 0) operationFail('IRIS_OPERATION_INPUT_INVALID', 'Operation 游标不属于当前列表');
  const page = ordered.slice(offset, offset + (value.limit ?? 20));
  return { operations: page, total: ordered.length, nextCursor: offset + page.length < ordered.length ? page.at(-1).id : null };
}
export function operationReferences(root) {
  return readAllOperations(root).map(record => ({ operationId: record.id, runId: record.runId,
    taskIds: [record.binding.taskId], artifactIds: [...new Set([record.binding.sourceArtifactId,
      record.binding.comparisonArtifactId, ...(record.result?.artifactIds || [])].filter(Boolean))] }));
}
export function projectOperation(record) {
  return { contractVersion: 0, id: record.id, action: record.action, runId: record.runId,
    revision: record.revision, expectedRunRevision: record.expectedRunRevision, state: record.state,
    createdAt: record.createdAt, updatedAt: record.updatedAt, cancelRequested: record.cancelRequested,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}), ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.result ? { result: structuredClone(record.result) } : {}), ...(record.failureCode ? { failureCode: record.failureCode } : {}) };
}
