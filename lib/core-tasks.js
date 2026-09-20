'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWritePrivate, ensurePrivateDir } from './private-storage.js';
import { parseModelRef } from './models.js';
import { providerErrorRecord } from './provider-contract.js';
import { deriveLegacyStatus, semanticViolations } from './task-semantics.js';

const STORE_DIR = 'task-store';
const STORE_VERSION = 'v0';
const TASK_ID = /^task_[a-f0-9]{24}$/;
const ATTEMPT_ID = /^attempt_[a-f0-9]{24}$/;
const PROVIDER_BINDING = /^sha256:[a-f0-9]{64}$/;
const CAPABILITIES = new Set(['image', 'video', 'tts', 'transcribe']);
const ATTEMPT_SELECTION_REASONS = new Set(['explicit', 'assignment', 'pool']);
const ATTEMPT_STAGE_TIMESTAMPS = Object.freeze([
  'queuedAt', 'submitStartedAt', 'submittedAt', 'remoteCompletedAt',
  'downloadStartedAt', 'downloadedAt', 'localProcessedAt'
]);

export class CoreTaskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoreTaskError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoreTaskError(code, message);
}

function taskDirectory(dataRoot) {
  return path.join(dataRoot, STORE_DIR, STORE_VERSION, 'tasks');
}

function taskFile(dataRoot, id) {
  const stableId = String(id || '');
  if (!TASK_ID.test(stableId)) fail('IRIS_TASK_ID_INVALID', 'Task ID 格式无效');
  return path.join(taskDirectory(dataRoot), stableId + '.json');
}

function clone(value) {
  return structuredClone(value);
}

function publicTask(record) {
  return Object.freeze(clone(record));
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function validAttemptStageTimestamps(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !ATTEMPT_STAGE_TIMESTAMPS.includes(key))) return false;
  let previous = -Infinity;
  let gap = false;
  for (const key of ATTEMPT_STAGE_TIMESTAMPS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      gap = true;
      continue;
    }
    if (gap || !validIsoTimestamp(value[key])) return false;
    const current = Date.parse(value[key]);
    if (current < previous) return false;
    previous = current;
  }
  return true;
}

function timestampAfter(...values) {
  const floor = values.reduce((latest, value) => {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
  return new Date(Math.max(Date.now(), floor)).toISOString();
}

function activeAttempt(task) {
  return task.attempts.find((item) => item.id === task.activeAttemptId);
}

function appendAttemptStage(attempt, key, reference) {
  if (!attempt?.stageTimestamps) return undefined;
  if (attempt.stageTimestamps[key]) return attempt.stageTimestamps[key];
  const previousKey = ATTEMPT_STAGE_TIMESTAMPS[ATTEMPT_STAGE_TIMESTAMPS.indexOf(key) - 1];
  if (previousKey && !attempt.stageTimestamps[previousKey]) return undefined;
  const stamped = timestampAfter(attempt.stageTimestamps[previousKey], reference);
  attempt.stageTimestamps[key] = stamped;
  return stamped;
}

function validateRecord(record, expectedId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.schemaVersion !== 0 || record.semanticsVersion !== 2
      || record.id !== expectedId || !CAPABILITIES.has(record.capability)
      || !Array.isArray(record.attempts) || !Array.isArray(record.artifactIds)
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
      || (record.providerBinding !== undefined && !PROVIDER_BINDING.test(record.providerBinding))
      || (record.retriedFrom !== undefined && !TASK_ID.test(record.retriedFrom))) {
    fail('IRIS_TASK_INVALID', 'Task 记录结构无效');
  }
  if (record.attempts.some((attempt, index) => !attempt || !ATTEMPT_ID.test(attempt.id)
      || attempt.ordinal !== index + 1 || typeof attempt.providerId !== 'string'
      || typeof attempt.model !== 'string'
      || (attempt.providerBinding !== undefined && !PROVIDER_BINDING.test(attempt.providerBinding))
      || (attempt.selectionReason !== undefined && !ATTEMPT_SELECTION_REASONS.has(attempt.selectionReason))
      || !validAttemptStageTimestamps(attempt.stageTimestamps))) {
    fail('IRIS_TASK_INVALID', 'Task Attempt 记录结构无效');
  }
  const violations = semanticViolations(record);
  if (violations.length) fail('IRIS_TASK_INVALID', 'Task 事实语义冲突：' + violations.join(', '));
  return record;
}

function readRecord(dataRoot, id) {
  const file = taskFile(dataRoot, id);
  let source;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('IRIS_TASK_INVALID', 'Task 记录不是普通文件');
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof CoreTaskError) throw error;
    fail('IRIS_TASK_NOT_FOUND', 'Task 不存在或记录无法读取');
  }
  let record;
  try { record = JSON.parse(source); }
  catch (_) { fail('IRIS_TASK_INVALID', 'Task 记录不是有效 JSON'); }
  return validateRecord(record, id);
}

function writeRecord(dataRoot, record) {
  validateRecord(record, record.id);
  try {
    ensurePrivateDir(taskDirectory(dataRoot));
    atomicWritePrivate(taskFile(dataRoot, record.id), JSON.stringify(record, null, 2) + '\n');
  } catch (error) {
    if (error instanceof CoreTaskError) throw error;
    fail('IRIS_TASK_WRITE_FAILED', 'Task 无法安全写入');
  }
  return publicTask(record);
}

function mutate(dataRoot, id, callback) {
  const previous = readRecord(dataRoot, id);
  const next = clone(previous);
  callback(next);
  next.revision = previous.revision + 1;
  next.updatedAt = new Date().toISOString();
  next.status = deriveLegacyStatus(next);
  return writeRecord(dataRoot, next);
}

function safeError(error, overrides) {
  return providerErrorRecord(error, overrides);
}

export function createCoreTask(dataRoot, input = {}) {
  const capability = String(input.capability || '').trim();
  if (!CAPABILITIES.has(capability)) fail('IRIS_TASK_INPUT_INVALID', 'Task capability 无效');
  const retriedFrom = input.retriedFrom === undefined ? undefined : String(input.retriedFrom);
  if (retriedFrom !== undefined && !TASK_ID.test(retriedFrom)) fail('IRIS_TASK_INPUT_INVALID', 'retriedFrom 必须是合法 Task ID');
  const now = new Date().toISOString();
  return writeRecord(dataRoot, {
    schemaVersion: 0,
    semanticsVersion: 2,
    id: 'task_' + crypto.randomBytes(12).toString('hex'),
    capability,
    status: 'running',
    phase: 'queued',
    acceptance: 'none',
    watchState: 'idle',
    outcome: 'none',
    deliveryState: 'none',
    cancelState: 'none',
    attempts: [],
    artifactIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    // D4 retry as new task：显式单向关系（新任务指向旧任务），绝不复制 Prompt。
    ...(retriedFrom !== undefined ? { retriedFrom } : {})
  });
}

export function inspectCoreTask(dataRoot, id) {
  return publicTask(readRecord(dataRoot, id));
}

/**
 * reader 列表不创建 task-store；存在的合法记录按更新时间倒序返回。
 * skipInvalid 只服务用户侧只读投影：单条损坏记录跳过并计入 dropped，
 * 其余记录照常返回；默认严格模式不变，损坏记录仍使整体读取失败。
 */
export function listCoreTasks(dataRoot, { offset = 0, limit = 50, skipInvalid = false } = {}) {
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  const size = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50)));
  const directory = taskDirectory(dataRoot);
  let names;
  for (const managed of [
    path.join(dataRoot, STORE_DIR), path.join(dataRoot, STORE_DIR, STORE_VERSION), directory
  ]) {
    let stat;
    try { stat = fs.lstatSync(managed); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return Object.freeze({
          schemaVersion: 0, total: 0, offset: start, limit: size, dropped: 0,
          tasks: Object.freeze([])
        });
      }
      fail('IRIS_TASK_STORE_INVALID', 'Task Store 无法读取');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('IRIS_TASK_STORE_INVALID', 'Task Store 目录不安全');
  }
  try { names = fs.readdirSync(directory); }
  catch (_) { fail('IRIS_TASK_STORE_INVALID', 'Task Store 无法读取'); }
  const records = [];
  let dropped = 0;
  for (const name of names) {
    if (!/^task_[a-f0-9]{24}\.json$/.test(name)) continue;
    try { records.push(readRecord(dataRoot, name.slice(0, -5))); }
    catch (error) {
      if (!skipInvalid) throw error;
      dropped += 1;
    }
  }
  records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return Object.freeze({
    schemaVersion: 0, total: records.length, offset: start, limit: size, dropped,
    tasks: Object.freeze(records.slice(start, start + size).map(publicTask))
  });
}

/** 必须在调用 Provider submit 之前完成。 */
export function beginCoreAttempt(dataRoot, taskId, fields = {}) {
  const providerId = String(fields.providerId || '').trim();
  const model = String(fields.model || '').trim();
  const parsed = parseModelRef(model);
  if (!providerId || !parsed || parsed.providerId !== providerId
      || (fields.providerBinding !== undefined && !PROVIDER_BINDING.test(fields.providerBinding))
      || (fields.selectionReason !== undefined && !ATTEMPT_SELECTION_REASONS.has(fields.selectionReason))) {
    fail('IRIS_ATTEMPT_INPUT_INVALID', 'Attempt 的 providerId 与复合 model 必须一致');
  }
  let created;
  mutate(dataRoot, taskId, (task) => {
    if (task.acceptance === 'accepted' || task.acceptance === 'unknown') {
      fail('IRIS_TASK_RESUBMIT_FORBIDDEN', 'Task 已受理或受理未知，禁止创建新 Attempt');
    }
    const previousAttempt = task.attempts[task.attempts.length - 1];
    const queuedAt = previousAttempt?.finishedAt || task.createdAt;
    const submitStartedAt = timestampAfter(queuedAt);
    created = {
      id: 'attempt_' + crypto.randomBytes(12).toString('hex'),
      ordinal: task.attempts.length + 1,
      providerId,
      model,
      stage: 'submitting',
      acceptance: 'none',
      startedAt: submitStartedAt,
      stageTimestamps: { queuedAt, submitStartedAt },
      ...(fields.selectionReason !== undefined ? { selectionReason: fields.selectionReason } : {}),
      ...(fields.providerBinding !== undefined ? { providerBinding: fields.providerBinding } : {})
    };
    task.attempts.push(created);
    task.activeAttemptId = created.id;
    task.providerId = providerId;
    task.modelRef = model;
    if (created.providerBinding) task.providerBinding = created.providerBinding;
    else delete task.providerBinding;
    task.phase = 'submitting';
    task.acceptance = 'none';
    task.watchState = 'idle';
    task.outcome = 'none';
    task.deliveryState = 'none';
    task.cancelState = 'none';
    delete task.remoteTaskId;
    delete task.lastError;
  });
  return Object.freeze(clone(created));
}

export function recordCoreAttemptResult(dataRoot, taskId, snapshot) {
  return mutate(dataRoot, taskId, (task) => {
    const attempt = task.attempts.find((item) => item.id === snapshot?.id);
    if (!attempt) fail('IRIS_ATTEMPT_NOT_FOUND', 'Attempt 不存在');
    if (attempt.acceptance !== 'none') fail('IRIS_ATTEMPT_RESULT_EXISTS', 'Attempt 结果不可重复写入');
    if (attempt.providerId !== snapshot.providerId || attempt.model !== snapshot.model) {
      fail('IRIS_ATTEMPT_IDENTITY_MISMATCH', 'Attempt 结果身份与写前记录不一致');
    }
    const acceptance = snapshot.acceptance;
    if (!['accepted', 'not_accepted', 'unknown'].includes(acceptance)) {
      fail('IRIS_ATTEMPT_RESULT_INVALID', 'Attempt 受理结果无效');
    }
    attempt.acceptance = acceptance;
    attempt.resultKind = String(snapshot.resultKind || '');
    attempt.stage = snapshot.resultKind === 'completed'
      ? 'terminal' : (acceptance === 'accepted' ? 'accepted' : 'terminal');
    const submittedAt = appendAttemptStage(attempt, 'submittedAt') || new Date().toISOString();
    attempt.finishedAt = submittedAt;
    if (snapshot.resultKind === 'completed') appendAttemptStage(attempt, 'remoteCompletedAt');
    if (snapshot.remoteTaskId) attempt.remoteTaskId = String(snapshot.remoteTaskId);
    if (snapshot.error) attempt.error = safeError(snapshot.error, { acceptance });

    task.acceptance = acceptance;
    task.phase = acceptance === 'accepted' ? 'accepted' : 'terminal';
    task.watchState = 'idle';
    if (acceptance === 'unknown') task.outcome = 'unknown';
    if (acceptance === 'accepted' && snapshot.resultKind === 'completed') {
      task.phase = 'running';
      task.outcome = 'succeeded';
      task.deliveryState = 'pending';
    }
    if (snapshot.remoteTaskId) task.remoteTaskId = String(snapshot.remoteTaskId);
    if (attempt.error) task.lastError = attempt.error;
    else delete task.lastError;
  });
}

export function finalizeCoreNoAcceptance(dataRoot, taskId, error) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.acceptance !== 'not_accepted') {
      fail('IRIS_TASK_ACCEPTANCE_REQUIRED', '只有全部候选明确未受理才能记为提交失败');
    }
    task.phase = 'terminal';
    task.watchState = 'idle';
    task.outcome = 'failed';
    task.lastError = safeError(error, { stage: 'submit', acceptance: 'not_accepted' });
    task.finishedAt = new Date().toISOString();
  });
}

export function activateCoreWatch(dataRoot, taskId) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.acceptance !== 'accepted' || !task.remoteTaskId || !['none', 'unknown'].includes(task.outcome)) {
      fail('IRIS_TASK_NOT_OBSERVABLE', 'Task 缺少可观察的远端受理事实');
    }
    if (task.watchState === 'active') {
      fail('IRIS_TASK_WATCH_ACTIVE', 'Task 已有观察操作正在执行');
    }
    task.phase = 'running';
    task.watchState = 'active';
    task.outcome = 'none';
    delete task.lastError;
  });
}

export function recordCorePollResult(dataRoot, taskId, result) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.acceptance !== 'accepted' || !task.remoteTaskId) {
      fail('IRIS_TASK_NOT_OBSERVABLE', 'Task 缺少可观察的远端受理事实');
    }
    if (result.kind === 'pending') {
      task.phase = 'running';
      task.watchState = 'suspended';
      task.outcome = 'none';
      if (result.progress) task.progress = String(result.progress);
      return;
    }
    if (['succeeded', 'failed', 'canceled'].includes(result.kind)) {
      appendAttemptStage(activeAttempt(task), 'remoteCompletedAt');
    }
    task.phase = 'terminal';
    task.watchState = result.kind === 'unknown' ? 'exhausted' : 'idle';
    if (result.kind === 'succeeded') {
      task.phase = 'running';
      task.outcome = 'succeeded';
      task.deliveryState = 'pending';
      delete task.lastError;
      return;
    }
    if (result.kind === 'canceled') {
      task.outcome = 'canceled';
      task.cancelState = 'remote_confirmed';
    } else if (result.kind === 'failed') task.outcome = 'failed';
    else task.outcome = 'unknown';
    if (result.error) task.lastError = safeError(result.error, { stage: 'poll', acceptance: 'accepted' });
    task.finishedAt = new Date().toISOString();
  });
}

export function recordCoreWatchError(dataRoot, taskId, error) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.acceptance !== 'accepted') fail('IRIS_TASK_NOT_OBSERVABLE', 'Task 尚未被远端受理');
    task.phase = 'running';
    task.watchState = 'suspended';
    task.outcome = 'unknown';
    task.lastError = safeError(error, { stage: 'poll', acceptance: 'accepted', retryable: true });
  });
}

export function beginCoreDelivery(dataRoot, taskId) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.outcome !== 'succeeded' || task.deliveryState !== 'pending') {
      fail('IRIS_TASK_NOT_DELIVERABLE', 'Task 不处于待交付状态');
    }
    task.phase = 'running';
    task.watchState = 'idle';
    task.deliveryState = 'downloading';
    const attempt = activeAttempt(task);
    if (attempt?.stageTimestamps) {
      delete attempt.stageTimestamps.downloadStartedAt;
      delete attempt.stageTimestamps.downloadedAt;
      delete attempt.stageTimestamps.localProcessedAt;
      appendAttemptStage(attempt, 'downloadStartedAt');
    }
  });
}

/** 全部远端字节已经落入并校验 staging；Artifact 提交尚未开始。 */
export function recordCoreDownloadCompleted(dataRoot, taskId) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.outcome !== 'succeeded' || task.deliveryState !== 'downloading') {
      fail('IRIS_TASK_NOT_DELIVERABLE', 'Task 交付状态无效');
    }
    appendAttemptStage(activeAttempt(task), 'downloadedAt');
  });
}

export function prepareCoreRedelivery(dataRoot, taskId) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.outcome !== 'succeeded' || task.deliveryState !== 'failed' || !task.remoteTaskId) {
      fail('IRIS_TASK_NOT_REDELIVERABLE', 'Task 不处于可重新交付状态');
    }
    task.phase = 'running';
    task.deliveryState = 'pending';
    delete task.lastError;
  });
}

export function completeCoreDelivery(dataRoot, taskId, artifactIds) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.outcome !== 'succeeded' || task.deliveryState !== 'downloading') {
      fail('IRIS_TASK_NOT_DELIVERABLE', 'Task 交付状态无效');
    }
    task.phase = 'terminal';
    task.watchState = 'idle';
    task.deliveryState = 'ready';
    task.artifactIds = [...new Set((artifactIds || []).map(String))];
    const attempt = activeAttempt(task);
    appendAttemptStage(attempt, 'downloadedAt');
    task.finishedAt = appendAttemptStage(attempt, 'localProcessedAt')
      || new Date().toISOString();
    delete task.lastError;
  });
}

export function failCoreDelivery(dataRoot, taskId, error) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.outcome !== 'succeeded') fail('IRIS_TASK_NOT_DELIVERABLE', '只有生成成功的 Task 能记录交付失败');
    task.phase = 'terminal';
    task.watchState = 'idle';
    task.deliveryState = 'failed';
    task.lastError = safeError(error, { stage: 'download', category: 'local_io', acceptance: 'accepted' });
    task.finishedAt = new Date().toISOString();
  });
}

export function requestCoreCancel(dataRoot, taskId) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.acceptance !== 'accepted' || !task.remoteTaskId || !['none', 'unknown'].includes(task.outcome)) {
      fail('IRIS_TASK_NOT_CANCELABLE', 'Task 缺少可取消的远端受理事实');
    }
    task.cancelState = 'requested';
    task.watchState = 'suspended';
  });
}

export function recordCoreCancelResult(dataRoot, taskId, result) {
  return mutate(dataRoot, taskId, (task) => {
    if (task.cancelState !== 'requested') fail('IRIS_TASK_CANCEL_NOT_REQUESTED', 'Task 尚未请求取消');
    // 远端事实优先：竞态下 poll/交付已沉淀终态结果，取消结果不得覆盖它。
    if (['succeeded', 'failed', 'canceled'].includes(task.outcome)) {
      task.cancelState = task.outcome === 'canceled' ? 'remote_confirmed' : 'none';
      return;
    }
    if (result.kind === 'canceled') {
      task.phase = 'terminal';
      task.watchState = 'idle';
      task.outcome = 'canceled';
      task.cancelState = 'remote_confirmed';
      task.finishedAt = new Date().toISOString();
      return;
    }
    if (result.kind === 'not_supported') {
      // Provider 明确不支持远端取消：确认取消未发生，回到可继续观察的真实状态；绝不伪造 canceled。
      task.cancelState = 'none';
      task.watchState = 'suspended';
      if (result.error) task.lastError = safeError(result.error, { stage: 'cancel', acceptance: 'accepted' });
      return;
    }
    // unknown/网络或超时失败：无法确认远端；保持非终态与真实 outcome，显式 reobserve 可收敛。
    task.outcome = 'unknown';
    task.cancelState = 'unknown';
    task.watchState = 'suspended';
    if (result.error) task.lastError = safeError(result.error, { stage: 'cancel', acceptance: 'accepted' });
  });
}

/**
 * 进程在 submit 返回落盘前退出时，没有 remoteTaskId 可以安全观察；恢复只能把
 * 事实收口为受理未知。已经落盘 remoteTaskId 的任务保持可观察，绝不新建 Attempt。
 */
export function recoverCoreTask(dataRoot, taskId) {
  const current = readRecord(dataRoot, taskId);
  if (current.cancelState === 'requested') {
    return mutate(dataRoot, taskId, (task) => {
      task.phase = 'terminal';
      task.watchState = 'suspended';
      task.outcome = 'unknown';
      task.cancelState = 'unknown';
      task.lastError = safeError('取消响应在落盘前中断', {
        stage: 'cancel', category: 'unknown', acceptance: 'accepted'
      });
    });
  }
  if (current.outcome === 'succeeded' && ['pending', 'downloading'].includes(current.deliveryState)) {
    return mutate(dataRoot, taskId, (task) => {
      task.phase = 'terminal';
      task.watchState = 'idle';
      task.deliveryState = 'failed';
      task.lastError = safeError('产物交付在完成落盘前中断', {
        stage: 'download', category: 'local_io', acceptance: 'accepted'
      });
      task.finishedAt = new Date().toISOString();
    });
  }
  if (current.acceptance === 'accepted' && current.watchState === 'active') {
    return mutate(dataRoot, taskId, (task) => { task.watchState = 'suspended'; });
  }
  if (current.phase !== 'submitting' || current.acceptance !== 'none') return publicTask(current);
  return mutate(dataRoot, taskId, (task) => {
    const attempt = task.attempts.find((item) => item.id === task.activeAttemptId);
    if (attempt && attempt.acceptance === 'none') {
      attempt.acceptance = 'unknown';
      attempt.resultKind = 'acceptance_unknown';
      attempt.stage = 'terminal';
      attempt.finishedAt = new Date().toISOString();
      attempt.error = safeError('提交进程在受理结果落盘前中断', {
        stage: 'response', category: 'unknown', acceptance: 'unknown'
      });
      task.lastError = attempt.error;
    }
    task.phase = 'terminal';
    task.acceptance = 'unknown';
    task.watchState = 'idle';
    task.outcome = 'unknown';
    task.finishedAt = new Date().toISOString();
  });
}
