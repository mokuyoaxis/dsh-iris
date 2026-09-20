'use strict';
/**
 * Core 任务的注意力处置偏好（Host 侧，绝不写入 Core 数据根）。
 *
 * 语义（与 legacy attentionDisposition 对齐）：
 * - acknowledged：「不再提醒」——attention 行静默，仍留在历史与高级诊断；
 * - hidden：「移除」——从任务区/泡泡消失，Core 记录完整保留，诊断可查、可恢复；
 * - 只存 Task ID 与时间戳，不存任务内容、Prompt、远端 ID 或路径。
 *
 * 存储：$DSH_HOME/iris/v1/core-attention.json（0600，原子写 + rename）。
 * 读取纪律：文件缺失或损坏一律降级为"无偏好"，绝不报错；reader 路径不写文件。
 * 自动静默（重试成功）不落偏好，由快照从 retriedFrom + 后继终态实时派生。
 */
import fs from 'node:fs';
import path from 'node:path';
import { irisHome } from './config.js';
import { atomicWritePrivate } from './private-storage.js';

export const CORE_ATTENTION_VERSION = 1;
const TASK_ID = /^task_[a-f0-9]{24}$/;

function attentionFile() {
  return path.join(irisHome(), 'core-attention.json');
}

/** reader：缺失/损坏一律返回无偏好。绝不写文件。 */
export function readCoreAttentionPrefs() {
  try {
    const raw = fs.readFileSync(attentionFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      return { version: CORE_ATTENTION_VERSION, entries: {} };
    }
    const entries = {};
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (!TASK_ID.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const cleaned = {};
      for (const field of ['acknowledgedAt', 'hiddenAt', 'updatedAt']) {
        if (typeof entry[field] === 'string' && entry[field]) cleaned[field] = entry[field];
      }
      if (Object.keys(cleaned).length) entries[id] = cleaned;
    }
    return { version: Number(parsed.version) || CORE_ATTENTION_VERSION, entries };
  } catch (_) {
    return { version: CORE_ATTENTION_VERSION, entries: {} };
  }
}

/** 单条记录的处置态；hidden 优先（视觉上先消失）。 */
export function attentionDispositionOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.hiddenAt) return 'hidden';
  if (entry.acknowledgedAt) return 'acknowledged';
  return null;
}

/**
 * writer：应用一个处置动作并原子落盘。幂等——同一动作重复执行内容不变时不写盘。
 * 返回 { changed, entry }。
 */
export function applyCoreAttentionAction(taskId, action, { now = new Date().toISOString() } = {}) {
  const id = String(taskId || '').trim();
  if (!TASK_ID.test(id)) {
    const error = new Error('Core Task ID 无效');
    error.code = 'IRIS_DSH_TASK_INVALID';
    throw error;
  }
  if (!['acknowledge', 'restore', 'hide', 'unhide'].includes(action)) {
    const error = new Error('未知 Core 注意力处置动作：' + String(action));
    error.code = 'IRIS_DSH_ATTENTION_INVALID';
    throw error;
  }
  const prefs = readCoreAttentionPrefs();
  const previous = prefs.entries[id] || null;
  const entry = previous ? { ...previous } : {};
  // 幂等：目标状态已达即无操作（不刷时间戳、不写盘）。
  const noop = (action === 'acknowledge' && Boolean(entry.acknowledgedAt))
    || (action === 'restore' && !entry.acknowledgedAt)
    || (action === 'hide' && Boolean(entry.hiddenAt))
    || (action === 'unhide' && !entry.hiddenAt);
  if (!noop) {
    if (action === 'acknowledge') entry.acknowledgedAt = now;
    if (action === 'restore') delete entry.acknowledgedAt;
    if (action === 'hide') entry.hiddenAt = now;
    if (action === 'unhide') delete entry.hiddenAt;
    // updatedAt 只随有效处置留存；两个戳都没有的条目视为空并整体移除。
    if (entry.acknowledgedAt || entry.hiddenAt) entry.updatedAt = now;
  }
  const meaningful = Boolean(entry.acknowledgedAt || entry.hiddenAt);
  const afterDisposition = attentionDispositionOf(entry);
  const changed = !noop;
  if (changed) {
    const entries = { ...prefs.entries };
    if (meaningful) entries[id] = entry;
    else delete entries[id];
    atomicWritePrivate(attentionFile(), JSON.stringify({
      version: CORE_ATTENTION_VERSION,
      entries
    }, null, 2) + '\n');
  }
  return Object.freeze({ changed, entry: Object.freeze(entry), disposition: afterDisposition });
}
