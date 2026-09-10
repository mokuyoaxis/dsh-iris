'use strict';
/**
 * Iris 作品库 v0。
 *
 * 任务历史与作品生命周期相互独立：清除 tasks.json 不会让 outputs/ 中的作品
 * 从 UI 消失。这里只记录展示、分页和随机令牌授权所需的最小字段，不保留
 * prompt、Provider、Model 或任务关系；完整 Artifact Manifest 留给 0.2.0。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { irisHome } from './config.js';
import { atomicWritePrivate, chmodPrivateFile, ensurePrivateDir, privateSibling } from './private-storage.js';

const FILE = () => path.join(irisHome(), 'artifacts.json');
const OUTPUTS = () => path.join(irisHome(), 'outputs');
const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif'
};

let cache = null;
const changeListeners = new Set();

export function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function emitChange() {
  for (const fn of [...changeListeners]) {
    try { fn(); } catch (_) { /* 一个监听者不能阻断作品落盘 */ }
  }
}

function persist() {
  atomicWritePrivate(FILE(), JSON.stringify({ version: 1, artifacts: cache.artifacts }, null, 2));
  emitChange();
}

function mimeFor(name) {
  return MIME[path.extname(String(name)).toLowerCase()] || '';
}

function safeOutputFile(name) {
  const value = String(name || '');
  return value && path.basename(value) === value && value !== '.' && value !== '..' && mimeFor(value);
}

function outputStat(name) {
  if (!safeOutputFile(name)) return null;
  const abs = path.join(OUTPUTS(), name);
  try {
    const stat = fs.lstatSync(abs);
    return stat.isFile() && !stat.isSymbolicLink() ? { abs, stat } : null;
  } catch (_) {
    return null;
  }
}

function newEntry(name, stat) {
  return {
    id: 'a_' + crypto.randomBytes(12).toString('hex'),
    file: name,
    token: crypto.randomBytes(16).toString('hex'),
    mime: mimeFor(name),
    size: stat.size,
    createdAt: new Date(stat.mtimeMs || Date.now()).toISOString()
  };
}

function validateStored(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.artifacts)) throw new Error('artifacts 必须是数组');
  const ids = new Set();
  const files = new Set();
  for (const item of value.artifacts) {
    if (!item || typeof item !== 'object' || !String(item.id || '').startsWith('a_')
      || !/^[a-f0-9]{32}$/.test(String(item.token || '')) || !safeOutputFile(item.file)) {
      throw new Error('作品条目格式无效');
    }
    if (ids.has(item.id) || files.has(item.file)) throw new Error('作品条目重复');
    ids.add(item.id);
    files.add(item.file);
  }
}

function adoptOutputs() {
  ensurePrivateDir(OUTPUTS());
  const known = new Set(cache.artifacts.map((item) => item.file));
  let added = 0;
  for (const name of fs.readdirSync(OUTPUTS())) {
    if (known.has(name)) continue;
    const hit = outputStat(name);
    if (!hit) continue;
    cache.artifacts.push(newEntry(name, hit.stat));
    known.add(name);
    added++;
  }
  return added;
}

function load() {
  if (cache) return cache;
  const file = FILE();
  if (!fs.existsSync(file)) {
    cache = { version: 1, artifacts: [] };
    adoptOutputs(); // 升级时一次性接回现有 outputs；不读取任务历史。
    persist();
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateStored(raw);
    cache = { version: 1, artifacts: raw.artifacts.map((item) => ({ ...item })) };
  } catch (error) {
    const backup = privateSibling(file, 'corrupted');
    try {
      fs.renameSync(file, backup);
      chmodPrivateFile(backup);
    } catch (_) { /* 隔离失败仍继续用文件重建最小索引 */ }
    console.error('[iris] artifacts.json 已损坏，已隔离为 ' + backup + '：', error && error.message);
    cache = { version: 1, artifacts: [] };
    adoptOutputs();
    persist();
  }
  return cache;
}

export function resetCache() {
  cache = null;
}

export function all() {
  return [...load().artifacts].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function artifactUrl(entry) {
  const base = String(process.env.DSH_WEB_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  return `${base}/iris/media/artifact/${entry.id}/${entry.token}/${encodeURIComponent(entry.file)}`;
}

function publicEntry(item) {
  return {
    id: item.id,
    file: item.file,
    mime: item.mime || mimeFor(item.file),
    size: Number(item.size || 0),
    createdAt: item.createdAt || '',
    url: artifactUrl(item)
  };
}

export function page({ offset = 0, limit = 24 } = {}) {
  const sorted = all();
  const start = Math.max(0, Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0);
  const size = Math.max(1, Math.min(60, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 24));
  return { total: sorted.length, offset: start, limit: size, items: sorted.slice(start, start + size).map(publicEntry) };
}

export function register(absPath) {
  const resolved = path.resolve(String(absPath || ''));
  if (path.dirname(resolved) !== path.resolve(OUTPUTS())) throw new Error('作品必须位于 Iris outputs/');
  const name = path.basename(resolved);
  const hit = outputStat(name);
  if (!hit) throw new Error('作品文件不存在、类型不受支持或不是普通文件');
  const data = load();
  const existing = data.artifacts.find((item) => item.file === name);
  if (existing) {
    if (existing.size !== hit.stat.size || existing.mime !== mimeFor(name)) {
      existing.size = hit.stat.size;
      existing.mime = mimeFor(name);
      persist();
    }
    return publicEntry(existing);
  }
  const entry = newEntry(name, hit.stat);
  data.artifacts.push(entry);
  persist();
  return publicEntry(entry);
}

export function reindex() {
  const data = load();
  const before = data.artifacts.length;
  data.artifacts = data.artifacts.filter((item) => outputStat(item.file));
  const missing = before - data.artifacts.length;
  const added = adoptOutputs();
  if (missing || added) persist();
  return { added, missing, total: data.artifacts.length };
}

export function authorize(id, token, name) {
  const item = load().artifacts.find((entry) => entry.id === id && entry.token === token && entry.file === name);
  if (!item) return null;
  const hit = outputStat(item.file);
  if (!hit) return null;
  return { entry: item, abs: hit.abs, size: hit.stat.size };
}

export function remove(id) {
  const data = load();
  const index = data.artifacts.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, reason: '作品不存在' };
  const item = data.artifacts[index];
  const hit = outputStat(item.file);
  if (hit) fs.rmSync(hit.abs);
  data.artifacts.splice(index, 1);
  persist();
  return { ok: true, file: item.file };
}

export function clear() {
  const data = load();
  const kept = [];
  let deleted = 0;
  let bytes = 0;
  for (const item of data.artifacts) {
    const hit = outputStat(item.file);
    try {
      if (hit) {
        fs.rmSync(hit.abs);
        bytes += hit.stat.size;
      }
      deleted++;
    } catch (_) {
      kept.push(item);
    }
  }
  if (deleted) {
    data.artifacts = kept;
    persist();
  }
  return { deleted, failed: kept.length, bytes };
}
