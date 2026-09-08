'use strict';
/**
 * Iris 任务框架 —— 从早期独立工作台演进而来的「宿内版」。
 *
 * 与 DSH 俱荣俱损的三条纪律：
 * - 无独立进程：盯守定时器全部 unref（不拖住 DSH 退出），且随插件 Fiber 清理（stopWatchAll）
 * - 注册表持久化 $DSH_HOME/iris/v1/tasks.json（只存元数据；产物文件在 ../outputs/）
 * - DSH 重启后 resumePending() 接管仍在服务端运行的远程任务（百炼结果 URL 存活 24h）
 *
 * 对前身的改进：
 * - 轮询容错：单次网络抖动不判死；v2 达到阈值后停止盯守并请求人工处理，旧任务维持兼容行为
 * - 状态机增加 canceled（工具取消信号传播）
 */
import fs from 'node:fs';
import path from 'node:path';
import { irisHome } from './config.js';
import { atomicWritePrivate, chmodPrivateFile, privateSibling } from './private-storage.js';
import { parseModelRef } from './models.js';
import { attentionDisposition, deriveLegacyStatus, deriveUserState, semanticViolations } from './task-semantics.js';
export { attentionDisposition } from './task-semantics.js';
import { providerErrorRecord, redactProviderMessage } from './provider-contract.js';

const FILE = () => path.join(irisHome(), 'tasks.json');
/** 产物目录：$DSH_HOME/iris/v1/outputs */
export function outputsDir() {
  return path.join(irisHome(), 'outputs');
}
const MAX_TASKS = 500;
/** 单个异步任务最长盯守时间 */
export const MAX_WATCH_MS = 20 * 60 * 1000;
/** 连续轮询失败多少次后停止本轮盯守（旧任务仍按兼容状态落盘） */
const POLL_ERROR_TOLERANCE = 5;

let cache = null;
/** taskId -> NodeJS.Timeout 轮询句柄 */
const watchers = new Map();
/** taskId -> 连续轮询错误计数 */
const errStreak = new Map();

/* ---------------- 状态变化总线（阶段 4 SSE：落盘即通知） ---------------- */
const changeListeners = new Set();
/** 订阅任务状态变化（create/update/cancel 都会触发）；返回退订函数 */
export function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function emitChange() {
  for (const fn of [...changeListeners]) {
    try { fn(); } catch (_) { /* 单个监听者异常不影响其余 */ }
  }
}

function persist() {
  atomicWritePrivate(FILE(), JSON.stringify({ version: 1, tasks: cache.tasks }, null, 2));
  emitChange(); // 任何任务落盘 = 状态变了 → SSE 推送
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateStoredTasks(value) {
  if (!isPlainObject(value)) throw new Error('任务根节点必须是对象');
  if (!Array.isArray(value.tasks)) throw new Error('tasks 必须是数组');
  for (const task of value.tasks) {
    if (!isPlainObject(task) || typeof task.id !== 'string' || !task.id.trim()) {
      throw new Error('task 条目必须是带非空 id 的对象');
    }
  }
}

function load() {
  if (cache) return cache;
  const file = FILE();
  if (!fs.existsSync(file)) {
    // 文件不存在 = 首次运行，正常初始化
    cache = { version: 1, tasks: [] };
    persist();
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateStoredTasks(raw);
    cache = { version: 1, tasks: raw.tasks };
  } catch (err) {
    // 文件存在但损坏：隔离，绝不静默覆盖证据
    const backup = privateSibling(file, 'corrupted');
    try {
      fs.renameSync(file, backup);
      chmodPrivateFile(backup);
    } catch (_) {
      /* 隔离失败也继续 */
    }
    console.error('[iris] tasks.json 已损坏，已隔离为 ' + backup + '：', err && err.message);
    cache = { version: 1, tasks: [] };
    persist();
  }
  return cache;
}

/** 任务列表（新→旧），可按能力过滤，最多 50 条 */
export function list(cap) {
  const filtered = cap ? load().tasks.filter((t) => t.cap === cap) : load().tasks;
  return [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
}

export function get(id) {
  return load().tasks.find((t) => t.id === id);
}

/** 测试/重载用：丢弃内存缓存，下次读取重新走盘 */
export function resetCache() {
  cache = null;
}

export function update(id, patch) {
  const t = get(id);
  if (!t) return undefined;
  if (isV2Task(t)) return mutateV2(id, (record) => Object.assign(record, patch));
  Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  persist();
  return t;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function appendTask(task) {
  const data = load();
  const previous = data.tasks;
  data.tasks = [...previous, task];
  // 只留最近 MAX_TASKS 条元数据
  if (data.tasks.length > MAX_TASKS) data.tasks.splice(0, data.tasks.length - MAX_TASKS);
  try {
    persist();
  } catch (error) {
    data.tasks = previous;
    throw error;
  }
  return task;
}

export function create(fields) {
  const t = {
    id: newId('t_'),
    status: 'running', // running | succeeded | failed | canceled
    files: [],         // 相对 outputs/ 的文件名
    ...fields,
    createdAt: new Date().toISOString()
  };
  return appendTask(t);
}

/** Task/Attempt v2 记录；旧任务继续由 create/update 维护。 */
export function createV2(fields = {}) {
  const now = new Date().toISOString();
  const t = {
    ...fields,
    id: newId('t_'),
    schemaVersion: 2,
    status: 'running',
    phase: 'queued',
    acceptance: 'none',
    watchState: 'idle',
    outcome: 'none',
    deliveryState: 'none',
    cancelState: 'none',
    attempts: [],
    files: [],
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
  const violations = semanticViolations(t);
  if (violations.length) throw new Error('Task v2 初始语义无效：' + violations.join(', '));
  return appendTask(t);
}

export function isV2Task(task) {
  return Boolean(task && task.schemaVersion === 2 && Array.isArray(task.attempts));
}

/**
 * v2 使用复制后落盘；写入失败时恢复内存旧值，避免“内存已受理、磁盘未受理”。
 */
function mutateV2(id, mutation) {
  const data = load();
  const index = data.tasks.findIndex((task) => task.id === id);
  if (index < 0) return undefined;
  const previous = data.tasks[index];
  if (!isV2Task(previous)) throw new TypeError('任务不是 Task v2：' + id);
  const next = structuredClone(previous);
  mutation(next);
  next.revision = Number(previous.revision || 0) + 1;
  next.updatedAt = new Date().toISOString();
  const violations = semanticViolations(next);
  if (violations.length) throw new Error('Task v2 语义冲突：' + violations.join(', '));
  next.status = deriveLegacyStatus(next);
  data.tasks[index] = next;
  try {
    persist();
  } catch (error) {
    data.tasks[index] = previous;
    throw error;
  }
  return next;
}

/** 在任何供应商请求发出前持久化稳定 Attempt ID。 */
export function beginAttempt(taskId, fields) {
  const providerId = String(fields && fields.providerId || '').trim();
  const model = String(fields && fields.model || '').trim();
  const parsed = parseModelRef(model);
  if (!providerId || !parsed || parsed.providerId !== providerId) {
    throw new TypeError('Attempt 必须包含身份一致的 providerId 与复合 model');
  }
  let created;
  mutateV2(taskId, (task) => {
    if (task.acceptance === 'accepted' || task.acceptance === 'unknown') {
      throw new Error('任务受理后禁止创建新的 Attempt');
    }
    const now = new Date().toISOString();
    created = {
      id: newId('a_'),
      ordinal: task.attempts.length + 1,
      providerId,
      providerName: String(fields.providerName || providerId),
      model,
      modelId: parsed.modelId,
      protocol: String(fields.protocol || ''),
      stage: 'submitting',
      acceptance: 'none',
      startedAt: now
    };
    if (typeof fields.idempotencyKey === 'string' && fields.idempotencyKey.trim()) {
      created.idempotencyKey = fields.idempotencyKey.trim();
    }
    task.attempts.push(created);
    task.phase = 'submitting';
    task.acceptance = 'none';
    task.watchState = 'idle';
    task.outcome = 'none';
    task.deliveryState = 'none';
    task.cancelState = 'none';
    task.activeAttemptId = created.id;
    task.providerId = providerId;
    task.providerName = created.providerName;
    task.modelRef = model;
    task.model = parsed.modelId; // 兼容 v0.1.2 UI；modelRef 才是权威身份。
    task.protocol = created.protocol;
    delete task.remoteTaskId;
    delete task.error;
    delete task.lastError;
  });
  return structuredClone(created);
}

/** 在上传、提交等副作用前推进 Attempt stage；失败会阻止后续网络动作。 */
export function markAttemptStage(taskId, attemptId, stage) {
  const allowed = ['validate', 'prepare', 'upload', 'submit', 'response'];
  if (!allowed.includes(stage)) throw new TypeError('未知 Attempt stage：' + String(stage));
  return mutateV2(taskId, (task) => {
    const attempt = task.attempts.find((item) => item.id === attemptId);
    if (!attempt) throw new Error('Attempt 不存在：' + String(attemptId));
    if (attempt.acceptance !== 'none') throw new Error('终态 Attempt 不能改变 stage');
    attempt.stage = stage;
  });
}

/** 持久化一次 Provider submit 的事实结果。 */
export function recordAttemptResult(taskId, snapshot) {
  return mutateV2(taskId, (task) => {
    const attempt = task.attempts.find((item) => item.id === snapshot.id);
    if (!attempt) throw new Error('Attempt 不存在：' + String(snapshot.id));
    if (attempt.acceptance !== 'none') throw new Error('Attempt 结果不可重复写入：' + attempt.id);
    if (snapshot.providerId !== attempt.providerId || snapshot.model !== attempt.model) {
      throw new Error('Attempt 结果身份与预写记录不一致');
    }
    const acceptance = snapshot.acceptance;
    if (!['accepted', 'not_accepted', 'unknown'].includes(acceptance)) {
      throw new TypeError('未知受理结果：' + String(acceptance));
    }
    attempt.acceptance = acceptance;
    attempt.resultKind = String(snapshot.resultKind || '');
    attempt.stage = snapshot.resultKind === 'completed'
      ? 'terminal'
      : (acceptance === 'accepted' ? 'accepted' : 'terminal');
    attempt.finishedAt = new Date().toISOString();
    if (snapshot.remoteTaskId) attempt.remoteTaskId = String(snapshot.remoteTaskId);
    if (snapshot.error) attempt.error = providerErrorRecord(snapshot.error, { acceptance });

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
    if (attempt.error) {
      task.lastError = attempt.error;
      task.error = attempt.error.safeMessage;
    } else {
      delete task.lastError;
      delete task.error;
    }
  });
}

/** 所有候选都明确未受理时，才可以把 Task 收口为生成失败。 */
export function finalizeNoAcceptance(taskId, error) {
  return mutateV2(taskId, (task) => {
    if (task.acceptance !== 'not_accepted') throw new Error('只有明确未受理才能收口为提交失败');
    const safe = providerErrorRecord(error, { stage: 'submit', acceptance: 'not_accepted' });
    task.phase = 'terminal';
    task.watchState = 'idle';
    task.outcome = 'failed';
    task.deliveryState = 'none';
    task.lastError = safe;
    task.error = safe.safeMessage;
    task.finishedAt = new Date().toISOString();
  });
}

/** 远端受理事实已落盘后，才进入轮询。 */
export function activateWatch(taskId) {
  return mutateV2(taskId, (task) => {
    if (task.acceptance !== 'accepted' || !task.remoteTaskId) {
      throw new Error('缺少已受理事实或远程任务 id，不能开始盯守');
    }
    task.phase = 'running';
    task.watchState = 'active';
    task.outcome = 'none';
    task.deliveryState = 'none';
    delete task.error;
    delete task.lastError;
    delete task.finishedAt;
  });
}

/** 同步生成已有成功证据后，单独推进本地产物交付。 */
export function beginDelivery(taskId) {
  return mutateV2(taskId, (task) => {
    if (task.acceptance !== 'accepted' || task.outcome !== 'succeeded') {
      throw new Error('只有已成功的受理结果才能开始交付');
    }
    if (task.deliveryState !== 'pending') {
      throw new Error('产物不处于待交付状态：' + task.deliveryState);
    }
    task.phase = 'running';
    task.watchState = 'idle';
    task.deliveryState = 'downloading';
  });
}

/** 用户显式要求重新交付；只重开交付轴，不改变远端成功事实。 */
export function prepareRedelivery(taskId) {
  return mutateV2(taskId, (task) => {
    if (task.outcome !== 'succeeded' || task.deliveryState !== 'failed') {
      throw new Error('任务不处于可重新交付状态');
    }
    task.phase = 'running';
    task.watchState = 'idle';
    task.deliveryState = 'pending';
    delete task.error;
    delete task.lastError;
    delete task.finishedAt;
  });
}

const ATTENTION_USER_STATES = new Set(['watching_paused', 'needs_attention', 'artifact_unavailable']);

function appendAttentionEvent(task, event) {
  const events = Array.isArray(task.attentionEvents) ? task.attentionEvents : [];
  events.push(event);
  task.attentionEvents = events.slice(-20);
}

/** 标为已读只关闭提醒，不把未知事实伪造成成功、失败或未受理。 */
export function acknowledgeAttention(taskId, reason = 'read', relatedTaskId) {
  return mutateV2(taskId, (task) => {
    if (!ATTENTION_USER_STATES.has(deriveUserState(task))) throw new Error('任务当前没有需要处置的提醒');
    if (attentionDisposition(task).status === 'acknowledged') throw new Error('任务提醒已经标为已读');
    const safeReason = reason === 'retried' ? 'retried' : 'read';
    appendAttentionEvent(task, {
      type: 'acknowledged', reason: safeReason, at: new Date().toISOString(),
      ...(relatedTaskId ? { relatedTaskId: String(relatedTaskId) } : {})
    });
  });
}

/** 恢复提醒同样只改变用户工作流元数据。 */
export function restoreAttention(taskId) {
  return mutateV2(taskId, (task) => {
    if (!ATTENTION_USER_STATES.has(deriveUserState(task))) throw new Error('任务事实已经不再需要提醒');
    if (attentionDisposition(task).status !== 'acknowledged') throw new Error('任务提醒尚未标为已读');
    appendAttentionEvent(task, { type: 'restored', reason: 'restored', at: new Date().toISOString() });
  });
}

/** 在原任务和用户明确授权的新任务之间记录关系，并原子归档原提醒。 */
export function linkManualRetry(taskId, retryTaskId) {
  return mutateV2(taskId, (task) => {
    const before = attentionDisposition(task);
    const links = Array.isArray(task.manualRetries) ? task.manualRetries : [];
    if (!links.some((item) => item && item.taskId === retryTaskId)) {
      links.push({ taskId: retryTaskId, createdAt: new Date().toISOString() });
    }
    task.manualRetries = links;
    if (ATTENTION_USER_STATES.has(deriveUserState(task))
        && !(before.status === 'acknowledged' && before.reason === 'retried' && before.relatedTaskId === retryTaskId)) {
      appendAttentionEvent(task, {
        type: 'acknowledged', reason: 'retried', relatedTaskId: String(retryTaskId), at: new Date().toISOString()
      });
    }
  });
}

export function completeDelivery(taskId, files) {
  return mutateV2(taskId, (task) => {
    if (task.outcome !== 'succeeded' || !['pending', 'downloading'].includes(task.deliveryState)) {
      throw new Error('产物不处于可完成的交付状态');
    }
    task.phase = 'terminal';
    task.watchState = 'idle';
    task.deliveryState = 'ready';
    task.files = Array.isArray(files) ? [...files] : [];
    task.progress = '100%';
    task.finishedAt = new Date().toISOString();
    delete task.error;
    delete task.lastError;
  });
}

export function failDelivery(taskId, error, files = []) {
  return mutateV2(taskId, (task) => {
    if (task.outcome !== 'succeeded') throw new Error('只有已成功生成的任务才能记录交付失败');
    const safe = providerErrorRecord(error, { stage: 'download', category: 'local_io', acceptance: 'accepted' });
    task.phase = 'terminal';
    task.watchState = 'idle';
    task.deliveryState = 'failed';
    task.files = Array.isArray(files) ? [...files] : [];
    task.lastError = safe;
    task.error = '结果转存失败：' + safe.safeMessage;
    task.finishedAt = new Date().toISOString();
  });
}

/** 全部任务记录（新→旧，不截断）——清理/孤儿扫描用 */
export function all() {
  return [...load().tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * 删除单条任务元数据（仅终态；运行中须先 cancel）。
 * 只删记录，产物文件留在 outputs/（媒体链接因 token 随记录消失而自然失效）。
 * @returns {{ok:boolean, reason?:string}}
 */
export function remove(id) {
  const t = get(id);
  if (!t) return { ok: false, reason: '任务不存在' };
  if (t.status === 'running') return { ok: false, reason: '运行中任务请先取消再删除' };
  const arr = load().tasks;
  const i = arr.findIndex((x) => x.id === id);
  if (i >= 0) arr.splice(i, 1);
  persist();
  return { ok: true };
}

/**
 * 批量裁剪：删除所有满足 pred(task) 的记录（运行中任务永不被 pred 命中——强制保护）。
 * @param {(t)=>boolean} pred
 * @returns {string[]} 被删除的任务 id
 */
export function prune(pred) {
  const arr = load().tasks;
  const removed = [];
  const kept = [];
  for (const t of arr) {
    if (t.status !== 'running' && pred(t)) removed.push(t.id);
    else kept.push(t);
  }
  if (removed.length) {
    load().tasks = kept;
    persist();
  }
  return removed;
}

/* ---------------- 盯守 ---------------- */

function stopWatch(taskId) {
  const h = watchers.get(taskId);
  if (h) clearTimeout(h);
  watchers.delete(taskId);
  errStreak.delete(taskId);
}

/** 停掉全部盯守句柄 —— 插件停用/更新时由 Fiber 清理调用 */
export function stopWatchAll() {
  for (const id of [...watchers.keys()]) stopWatch(id);
}

/**
 * 开始盯守一个异步任务（提交成功后调用）。
 * @param {object} task 已 create 的任务记录（须含 remoteTaskId）
 * @param {object} deps
 *   key(): string                                    —— 每次轮询现取凭据
 *   poll({key, remoteTaskId}): {done,ok,urls,message} —— 协议适配器的查询函数
 *   onSuccess(task, {urls}): string[]                 —— 结果转存，返回相对 outputs/ 的文件名列表
 *   intervalMs?: number                               —— 轮询间隔（默认 2500）
 *   maxWatchMs?: number                               —— 盯守上限（默认 20 分钟）
 *   allowEmptyResult?: boolean                          —— 文本任务允许成功但结果为空
 */
export function watch(task, deps) {
  stopWatch(task.id);
  let current = get(task.id);
  const v2 = isV2Task(current);
  if (v2 && current.watchState !== 'active') current = activateWatch(task.id);
  const intervalMs = deps.intervalMs || 2500;
  const startedAt = Date.now();
  errStreak.set(task.id, 0);
  let emptyOk = 0; // 状态已 SUCCEEDED 但 results 尚未填充的次数（服务端竞态）

  const finishLegacy = (patch) => {
    update(task.id, patch);
    stopWatch(task.id);
  };
  const finishV2 = (patch) => {
    try {
      return mutateV2(task.id, (record) => Object.assign(record, patch));
    } finally {
      stopWatch(task.id);
    }
  };

  const tick = async () => {
    const t = get(task.id);
    if (!t || t.status !== 'running') return stopWatch(task.id);
    if (Date.now() - startedAt > (deps.maxWatchMs || MAX_WATCH_MS)) {
      const message = '盯守超时：服务端可能仍在继续，可稍后用任务查询确认';
      if (!v2) return finishLegacy({ status: 'failed', error: message });
      return finishV2({
        phase: 'terminal', watchState: 'exhausted', outcome: 'unknown',
        lastError: providerErrorRecord(message, { stage: 'poll', category: 'timeout', acceptance: 'accepted', retryable: true }),
        error: message
      });
    }
    let r;
    try {
      r = await deps.poll({ key: deps.key(), remoteTaskId: t.remoteTaskId });
    } catch (err) {
      const n = (errStreak.get(task.id) || 0) + 1;
      errStreak.set(task.id, n);
      if (n >= POLL_ERROR_TOLERANCE) {
        const safe = providerErrorRecord(err, { stage: 'poll', acceptance: 'accepted', retryable: true });
        const message = '轮询连续失败 ' + n + ' 次：' + safe.safeMessage;
        if (!v2) return finishLegacy({ status: 'failed', error: message });
        return finishV2({ phase: 'terminal', watchState: 'exhausted', outcome: 'unknown', lastError: safe, error: message });
      }
      return schedule(); // 瞬时抖动，容忍
    }
    errStreak.set(task.id, 0);
    if (!r.done) {
      if (v2) mutateV2(task.id, (record) => { record.progress = r.status || 'running'; });
      else update(task.id, { progress: r.status || 'running' });
      return schedule();
    }
    if (!r.ok) {
      const message = redactProviderMessage(r.message || '任务失败');
      if (!v2) return finishLegacy({ status: 'failed', error: message });
      return finishV2({
        phase: 'terminal', watchState: 'idle', outcome: 'failed',
        lastError: providerErrorRecord(message, { stage: 'poll', category: 'provider', acceptance: 'accepted' }),
        error: message, finishedAt: new Date().toISOString()
      });
    }
    // 媒体结果 URL 未就绪时短等；文本转写可显式允许空结果。
    if (!deps.allowEmptyResult && !(r.urls || []).length && emptyOk < 10) {
      emptyOk++;
      return schedule();
    }
    if (v2 && !deps.allowEmptyResult && !(r.urls || []).length) {
      const message = '生成已成功，但服务端未提供可交付的结果 URL';
      return finishV2({
        phase: 'terminal', watchState: 'idle', outcome: 'succeeded', deliveryState: 'failed',
        lastError: providerErrorRecord(message, { stage: 'download', category: 'protocol', acceptance: 'accepted' }),
        error: message, finishedAt: new Date().toISOString()
      });
    }
    if (v2) {
      // 生成成功与产物交付是两个事实；先持久化成功，再执行下载。
      mutateV2(task.id, (record) => {
        record.phase = 'running';
        record.watchState = 'active';
        record.outcome = 'succeeded';
        record.deliveryState = 'downloading';
      });
    }
    try {
      const files = (await deps.onSuccess(get(task.id), r)) || [];
      // progress 一并收尾为数值：轮询期写入的 "RUNNING" 等文本不能残留到成功后
      if (!v2) return finishLegacy({ status: 'succeeded', files, progress: '100%', finishedAt: new Date().toISOString() });
      return finishV2({
        phase: 'terminal', watchState: 'idle', outcome: 'succeeded', deliveryState: 'ready',
        files, progress: '100%', finishedAt: new Date().toISOString()
      });
    } catch (err) {
      const safe = providerErrorRecord(err, { stage: 'download', category: 'local_io', acceptance: 'accepted' });
      const message = '结果转存失败：' + safe.safeMessage;
      if (!v2) return finishLegacy({ status: 'failed', error: message });
      return finishV2({
        phase: 'terminal', watchState: 'idle', outcome: 'succeeded', deliveryState: 'failed',
        lastError: safe, error: message, finishedAt: new Date().toISOString()
      });
    }
  };

  const schedule = () => {
    const h = setTimeout(() => {
      tick().catch(() => stopWatch(task.id));
    }, intervalMs);
    if (h.unref) h.unref(); // 永不拖住 DSH 进程退出
    watchers.set(task.id, h);
  };
  const h0 = setTimeout(() => {
    tick().catch(() => stopWatch(task.id));
  }, 500);
  if (h0.unref) h0.unref();
  watchers.set(task.id, h0);
}

/** 取消：v2 未得到远端确认时绝不伪装成“已取消”。 */
export function cancel(taskId, reason) {
  stopWatch(taskId);
  const t = get(taskId);
  if (!t || t.status !== 'running') return;
  if (!isV2Task(t)) {
    update(taskId, { status: 'canceled', error: reason || '已取消' });
    return;
  }
  if (!['none', 'unknown'].includes(t.outcome)) return;
  const message = redactProviderMessage(reason || '已停止本地盯守');
  mutateV2(taskId, (record) => {
    record.phase = 'terminal';
    record.watchState = record.acceptance === 'accepted' ? 'suspended' : 'idle';
    record.error = record.acceptance === 'accepted'
      ? message + '；远端取消状态未知'
      : message;
    if (record.acceptance === 'none' || record.acceptance === 'not_accepted') {
      record.outcome = 'canceled';
      record.cancelState = 'local_confirmed';
    } else {
      record.outcome = 'unknown';
      record.cancelState = 'unknown';
    }
  });
}

/**
 * 提交段守卫：包裹 create 之后、watch 之前的上传/提交调用。
 * fn 抛错 → 任务标 failed（带原因）并原样重抛。
 * 没有它，提交失败会留下 status=running 且无 remoteTaskId 的孤儿记录：
 * 没有盯守者、resumePending 也无法接管，永远占着「运行中」。
 */
export async function submitGuard(task, fn) {
  try {
    return await fn();
  } catch (err) {
    const canceled = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    update(task.id, {
      status: canceled ? 'canceled' : 'failed',
      error: canceled ? '提交已取消' : ('提交失败：' + String((err && err.message) || err))
    });
    throw err;
  }
}

/**
 * 重启恢复：接管仍在运行的远程任务。DSH 重启期间百炼任务在服务端继续跑，
 * 结果 URL 存活 24h，重启后重新盯守即可落袋。
 * @param {(task) => deps|null} depsFor 返回盯守依赖；null 表示无法接管（如供应商已删除）
 * @returns {string[]} 成功接管的任务 id
 */
export function resumePending(depsFor) {
  const resumed = [];
  for (const t of [...load().tasks]) {
    try {
      if (t.status !== 'running') continue;
      if (!isV2Task(t)) {
        if (!t.remoteTaskId) {
          update(t.id, { status: 'failed', error: '提交未完成（无远程任务 id），启动时标失败清理' });
          continue;
        }
        if (Date.now() - new Date(t.createdAt).getTime() > MAX_WATCH_MS) {
          update(t.id, { status: 'failed', error: '重启前任务已超时，请重新发起' });
          continue;
        }
        const deps = depsFor(t);
        if (!deps) {
          update(t.id, { status: 'failed', error: '无法恢复：对应供应商不可用' });
          continue;
        }
        watch(t, deps);
        resumed.push(t.id);
        continue;
      }

      if (t.outcome === 'succeeded') {
        if (t.deliveryState !== 'ready' && t.deliveryState !== 'failed') {
          mutateV2(t.id, (record) => {
            record.phase = 'terminal';
            record.watchState = 'idle';
            record.deliveryState = 'failed';
            record.error = '产物交付在进程退出前未完成；生成成功事实保持不变';
          });
        }
        continue;
      }
      if (t.outcome !== 'none') continue;
      if (!t.remoteTaskId) {
        if (t.acceptance === 'not_accepted') {
          finalizeNoAcceptance(t.id, t.lastError || '供应商明确未受理');
        } else {
          mutateV2(t.id, (record) => {
            record.phase = 'terminal';
            record.acceptance = 'unknown';
            record.watchState = 'idle';
            record.outcome = 'unknown';
            record.error = '提交在受理结果落盘前中断，远端受理状态未知；禁止自动重提';
          });
        }
        continue;
      }
      if (Date.now() - new Date(t.createdAt).getTime() > MAX_WATCH_MS) {
        mutateV2(t.id, (record) => {
          record.phase = 'terminal';
          record.watchState = 'exhausted';
          record.outcome = 'unknown';
          record.error = '重启前任务已超过自动盯守窗口；远端结果未知';
        });
        continue;
      }
      const deps = depsFor(t);
      if (!deps) {
        mutateV2(t.id, (record) => {
          record.phase = 'terminal';
          record.watchState = 'suspended';
          record.error = '无法恢复盯守：对应供应商不可用；远端任务状态未改变';
        });
        continue;
      }
      watch(t, deps);
      resumed.push(t.id);
    } catch (err) {
      if (!isV2Task(get(t.id))) {
        // 单条恢复失败只标死这一条，绝不让恢复循环（乃至宿主启动）陪葬
        update(t.id, { status: 'failed', error: '恢复异常：' + String((err && err.message) || err) });
      }
      // v2 持久化失败时保留原事实，不再进行可能导致重复计费的自动动作。
    }
  }
  return resumed;
}
