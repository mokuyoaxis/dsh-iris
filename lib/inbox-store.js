// Read-only owner-configured inbox directory for large media imports without MCP Base64 overhead.
// No HTTP, MCP, Provider or Runtime dependencies. Never mutates or deletes host files.
import fs from 'node:fs';
import path from 'node:path';
import { MAX_IMPORT_IMAGE_BYTES } from './image-import.js';
import { MAX_AUDIO_INPUT_BYTES } from './audio-flow-input.js';

export const MAX_INBOX_FILE_BYTES = Math.min(MAX_IMPORT_IMAGE_BYTES, MAX_AUDIO_INPUT_BYTES);
export const MAX_INBOX_LIST_LIMIT = 50;
export const MAX_INBOX_SCAN_ENTRIES = 500;

export const INBOX_IMAGE_EXTENSIONS = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
});
export const INBOX_AUDIO_EXTENSIONS = Object.freeze({
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac'
});

const SAFE_NAME = /^(?!\.)[^/\\\x00-\x1f\x7f]{1,255}$/;

export function inboxFail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function resolveMaybeMissing(target) {
  try { return fs.realpathSync.native(target); } catch (_) { /* resolve nearest existing ancestor */ }
  const parts = [];
  let cursor = path.resolve(target);
  while (true) {
    try { return path.join(fs.realpathSync.native(cursor), ...parts.reverse()); }
    catch (_) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target);
      parts.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function pathsOverlap(a, b) {
  const relA = path.relative(a, b), relB = path.relative(b, a);
  return relA === '' || (!relA.startsWith('..' + path.sep) && relA !== '..' && !path.isAbsolute(relA))
    || relB === '' || (!relB.startsWith('..' + path.sep) && relB !== '..' && !path.isAbsolute(relB));
}

export function resolveInboxDirectory(directory, forbiddenPaths = []) {
  if (typeof directory !== 'string' || !directory.trim() || !path.isAbsolute(directory)) {
    inboxFail('IRIS_INBOX_CONFIG_INVALID', '收件目录必须是已存在的绝对路径');
  }
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (_) { inboxFail('IRIS_INBOX_CONFIG_INVALID', '收件目录不存在或不可访问'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    inboxFail('IRIS_INBOX_CONFIG_INVALID', '收件目录必须是真实目录，不接受符号链接或普通文件');
  }
  let physical;
  try {
    physical = fs.realpathSync.native(directory);
    fs.accessSync(physical, fs.constants.R_OK);
  } catch (_) {
    inboxFail('IRIS_INBOX_CONFIG_INVALID', '收件目录不可读');
  }
  for (const forbidden of forbiddenPaths) {
    if (!forbidden || typeof forbidden !== 'string') continue;
    if (pathsOverlap(physical, resolveMaybeMissing(forbidden))) {
      inboxFail('IRIS_INBOX_CONFIG_INVALID', '收件目录不能与 Core 数据根或私有配置/凭据目录重叠');
    }
  }
  return physical;
}

function assertPinnedInbox(physicalInbox) {
  let stat, actual;
  try {
    stat = fs.lstatSync(physicalInbox);
    actual = fs.realpathSync.native(physicalInbox);
  } catch (_) {
    inboxFail('IRIS_INBOX_UNAVAILABLE', '收件目录当前不可访问');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || actual !== physicalInbox) {
    inboxFail('IRIS_INBOX_UNAVAILABLE', '收件目录身份已变化或不再是真实目录');
  }
}

export function isSafeInboxFilename(name) {
  return typeof name === 'string' && SAFE_NAME.test(name) && name !== '.' && name !== '..' && path.basename(name) === name;
}

export function classifyInboxFilename(name) {
  if (!isSafeInboxFilename(name)) return null;
  const ext = path.extname(name).toLowerCase();
  if (Object.hasOwn(INBOX_IMAGE_EXTENSIONS, ext)) return { kind: 'image', mediaType: INBOX_IMAGE_EXTENSIONS[ext] };
  if (Object.hasOwn(INBOX_AUDIO_EXTENSIONS, ext)) return { kind: 'audio', mediaType: INBOX_AUDIO_EXTENSIONS[ext] };
  return null;
}

/** List bounded safe metadata of top-level supported regular files. Never exposes host paths or follows symlinks. */
export function listInboxFiles(physicalInbox, { audioEnabled = false, kind = 'all', limit = 30 } = {}) {
  if (!['all', 'image', 'audio'].includes(kind)) inboxFail('IRIS_INBOX_INPUT_INVALID', '收件目录筛选类别无效');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INBOX_LIST_LIMIT) {
    inboxFail('IRIS_INBOX_INPUT_INVALID', '收件目录 limit 必须是 1–50 的整数');
  }
  assertPinnedInbox(physicalInbox);
  let entries;
  try { entries = fs.readdirSync(physicalInbox, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (_) { inboxFail('IRIS_INBOX_UNAVAILABLE', '无法读取收件目录列表'); }
  const truncated = entries.length > MAX_INBOX_SCAN_ENTRIES;
  const files = [];
  for (const entry of entries.slice(0, MAX_INBOX_SCAN_ENTRIES)) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const info = classifyInboxFilename(entry.name);
    if (!info) continue;
    if (info.kind === 'audio' && !audioEnabled) continue;
    if (kind !== 'all' && info.kind !== kind) continue;
    let stat;
    try { stat = fs.lstatSync(path.join(physicalInbox, entry.name)); } catch (_) { continue; }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_INBOX_FILE_BYTES) continue;
    files.push({
      name: entry.name,
      kind: info.kind,
      mediaType: info.mediaType,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    });
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
  return { total: files.length, truncated, files: files.slice(0, limit) };
}

/** Atomically open and read one top-level regular file with O_NOFOLLOW and strict 20 MiB cap. */
export function readInboxFile(physicalInbox, name, { audioEnabled = false } = {}) {
  if (!isSafeInboxFilename(name)) {
    inboxFail('IRIS_INBOX_INPUT_INVALID', '文件名无效；仅接受收件目录顶层普通文件名，不含路径分隔符或隐藏前缀');
  }
  const info = classifyInboxFilename(name);
  if (!info) inboxFail('IRIS_INBOX_MEDIA_UNSUPPORTED', '仅支持 PNG/JPEG/WebP 图片或 WAV/MP3/OGG/FLAC 音频文件');
  if (info.kind === 'audio' && !audioEnabled) {
    inboxFail('IRIS_FLOW_AUDIO_ROOT_REQUIRED', '导入音频需要新的音频执行根；原根不迁移');
  }
  assertPinnedInbox(physicalInbox);
  const target = path.join(physicalInbox, name);
  let lstat;
  try { lstat = fs.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') inboxFail('IRIS_INBOX_NOT_FOUND', '收件目录中不存在该文件');
    inboxFail('IRIS_INBOX_UNAVAILABLE', '无法读取该收件文件');
  }
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    inboxFail('IRIS_INBOX_INPUT_INVALID', '不接受符号链接或非普通文件');
  }
  let fd;
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  try { fd = fs.openSync(target, openFlags); }
  catch (error) {
    if (error?.code === 'ENOENT') inboxFail('IRIS_INBOX_NOT_FOUND', '收件目录中不存在该文件');
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') inboxFail('IRIS_INBOX_INPUT_INVALID', '不接受符号链接');
    inboxFail('IRIS_INBOX_UNAVAILABLE', '无法安全打开收件文件');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) inboxFail('IRIS_INBOX_INPUT_INVALID', '收件目标必须是普通文件');
    if (stat.size < 1) inboxFail('IRIS_INBOX_INPUT_INVALID', '收件文件为空');
    if (stat.size > MAX_INBOX_FILE_BYTES) inboxFail('IRIS_INBOX_TOO_LARGE', '收件文件超过 20 MiB 上限');
    const chunks = [];
    const scratch = Buffer.allocUnsafe(Math.min(256 * 1024, MAX_INBOX_FILE_BYTES));
    let total = 0;
    while (true) {
      const read = fs.readSync(fd, scratch, 0, scratch.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_INBOX_FILE_BYTES) inboxFail('IRIS_INBOX_TOO_LARGE', '收件文件超过 20 MiB 上限');
      chunks.push(Buffer.from(scratch.subarray(0, read)));
    }
    if (total < 1) inboxFail('IRIS_INBOX_INPUT_INVALID', '收件文件为空');
    return { name, kind: info.kind, mediaType: info.mediaType, bytes: Buffer.concat(chunks, total) };
  } finally {
    fs.closeSync(fd);
  }
}
