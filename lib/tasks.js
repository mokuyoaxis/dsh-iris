'use strict';
/**
 * Iris 任务框架 —— ai-paint/lib/tasks.js 的「宿内版」。
 *
 * 与 DSH 俱荣俱损的三条纪律：
 * - 无独立进程：盯守定时器全部 unref（不拖住 DSH 退出），且随插件 Fiber 清理（stopWatchAll）
 * - 注册表持久化 $DSH_HOME/iris/v1/tasks.json（只存元数据；产物文件在 ../outputs/）
 * - DSH 重启后 resumePending() 接管仍在服务端运行的远程任务（百炼结果 URL 存活 24h）
 *
 * 对前身的改进：
 * - 轮询容错：单次网络抖动不判死，连续 POLL_ERROR_TOLERANCE 次失败才判定任务失败
 * - 状态机增加 canceled（工具取消信号传播）
 */
import fs from 'node:fs';
import path from 'node:path';
import { irisHome } from './config.js';

const FILE = () => path.join(irisHome(), 'tasks.json');
const MAX_TASKS = 200;
/** 单个异步任务最长盯守时间 */
export const MAX_WATCH_MS = 20 * 60 * 1000;
/** 连续轮询失败多少次才判定任务失败（容忍瞬时网络抖动） */
const POLL_ERROR_TOLERANCE = 5;

let cache = null;
/** taskId -> NodeJS.Timeout 轮询句柄 */
const watchers = new Map();
/** taskId -> 连续轮询错误计数 */
const errStreak = new Map();

function persist() {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: cache.tasks }, null, 2));
  fs.renameSync(tmp, FILE());
  try {
    fs.chmodSync(FILE(), 0o600);
  } catch (_) {
    /* ignore */
  }
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = { version: 1, tasks: Array.isArray(raw.tasks) ? raw.tasks : [] };
  } catch (_) {
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

export function update(id, patch) {
  const t = get(id);
  if (!t) return undefined;
  Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  persist();
  return t;
}

export function create(fields) {
  const t = {
    id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: 'running', // running | succeeded | failed | canceled
    files: [],         // 相对 outputs/ 的文件名
    ...fields,
    createdAt: new Date().toISOString()
  };
  load().tasks.push(t);
  // 只留最近 MAX_TASKS 条元数据
  if (load().tasks.length > MAX_TASKS) load().tasks.splice(0, load().tasks.length - MAX_TASKS);
  persist();
  return t;
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
 */
export function watch(task, deps) {
  stopWatch(task.id);
  const intervalMs = deps.intervalMs || 2500;
  const startedAt = Date.now();
  errStreak.set(task.id, 0);
  let emptyOk = 0; // 状态已 SUCCEEDED 但 results 尚未填充的次数（服务端竞态）

  const finish = (patch) => {
    update(task.id, patch);
    stopWatch(task.id);
  };

  const tick = async () => {
    const t = get(task.id);
    if (!t || t.status !== 'running') return stopWatch(task.id);
    if (Date.now() - startedAt > (deps.maxWatchMs || MAX_WATCH_MS)) {
      return finish({ status: 'failed', error: '盯守超时：服务端可能仍在继续，可稍后用任务查询确认' });
    }
    let r;
    try {
      r = await deps.poll({ key: deps.key(), remoteTaskId: t.remoteTaskId });
    } catch (err) {
      const n = (errStreak.get(task.id) || 0) + 1;
      errStreak.set(task.id, n);
      if (n >= POLL_ERROR_TOLERANCE) {
        return finish({ status: 'failed', error: '轮询连续失败 ' + n + ' 次：' + String((err && err.message) || err) });
      }
      return schedule(); // 瞬时抖动，容忍
    }
    errStreak.set(task.id, 0);
    if (!r.done) {
      update(task.id, { progress: r.status || 'running' });
      return schedule();
    }
    if (!r.ok) return finish({ status: 'failed', error: r.message || '任务失败' });
    // 成功但结果 URL 未就绪：短等重试，避免空文件落袋
    if (!(r.urls || []).length && emptyOk < 10) {
      emptyOk++;
      return schedule();
    }
    try {
      const files = (await deps.onSuccess(t, r)) || [];
      finish({ status: 'succeeded', files, finishedAt: new Date().toISOString() });
    } catch (err) {
      finish({ status: 'failed', error: '结果转存失败：' + String((err && err.message) || err) });
    }
  };

  const schedule = () => {
    const h = setTimeout(() => {
      tick().catch(() => {});
    }, intervalMs);
    if (h.unref) h.unref(); // 永不拖住 DSH 进程退出
    watchers.set(task.id, h);
  };
  const h0 = setTimeout(() => {
    tick().catch(() => {});
  }, 500);
  if (h0.unref) h0.unref();
  watchers.set(task.id, h0);
}

/** 取消：停止盯守并标记 canceled（工具收到 abort 信号时调用） */
export function cancel(taskId, reason) {
  stopWatch(taskId);
  const t = get(taskId);
  if (t && t.status === 'running') update(taskId, { status: 'canceled', error: reason || '已取消' });
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
    if (t.status !== 'running' || !t.remoteTaskId) continue;
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
  }
  return resumed;
}
