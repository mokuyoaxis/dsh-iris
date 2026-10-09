/** 工作台显式选择/详情/下载和可恢复管理；不修改既有 Core 维护语义。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import * as legacy from './artifacts.js';
import { mimeOf } from './media.js';
import { inspectWorkbenchArtifactForDsh, inspectProviderTaskForDsh, maintainWorkbenchForDsh, readCoreArtifactMediaForDsh } from './dsh-core-adapter.js';
import { workbenchZip } from './workbench-zip.js';

export const MAX_WORKBENCH_SELECTION = 200;
export const MAX_WORKBENCH_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const CORE_ID = /^artifact_[a-f0-9]{24}$/, LEGACY_ID = /^a_[a-f0-9]{24}$/, TASK_ID = /^task_[a-f0-9]{24}$/;
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
  'audio/flac': '.flac', 'text/plain': '.txt', 'application/json': '.json' };
const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), { code, statusCode }); };
function active(signal) { if (signal?.aborted) throw Object.assign(new Error('作品操作已取消'), { name: 'AbortError' }); }
function exact(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    fail('IRIS_COMMAND_INPUT_INVALID', '作品操作参数无效');
  }
}
function validItem(item) {
  exact(item, ['source', 'id']);
  if (!(item.source === 'core' ? CORE_ID.test(item.id) : item.source === 'legacy' && LEGACY_ID.test(item.id))) {
    fail('IRIS_COMMAND_INPUT_INVALID', '作品来源或 ID 无效');
  }
  return item;
}
function selection(input) {
  exact(input, ['items']);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_WORKBENCH_SELECTION) {
    fail('IRIS_COMMAND_INPUT_INVALID', '请明确选择 1–200 个作品');
  }
  const items = input.items.map(validItem);
  if (new Set(items.map(item => item.source + ':' + item.id)).size !== items.length) fail('IRIS_COMMAND_INPUT_INVALID', '选中作品不能重复');
  return items;
}

function legacyFile(id) {
  const entry = legacy.all().find(item => item.id === id);
  const hit = entry && legacy.authorize(entry.id, entry.token, entry.file);
  if (!hit) fail('IRIS_WORK_NOT_FOUND', '作品文件不存在或不可读取', 404);
  return { entry, ...hit };
}
function safeMetadata(metadata) {
  const result = {};
  for (const key of ['width', 'height', 'durationMs', 'frameCount', 'frameIndex', 'sourceFrameIndex', 'timeMs']) {
    if (typeof metadata[key] === 'number' && Number.isFinite(metadata[key])) result[key] = metadata[key];
  }
  if (TASK_ID.test(metadata.taskId)) result.taskId = metadata.taskId;
  return result;
}

export async function workbenchDetail(source, id, options = {}) {
  validItem({ source, id }); active(options.signal);
  if (source === 'core') {
    const artifact = await inspectWorkbenchArtifactForDsh(id, options);
    return { item: { id, source, file: id + EXTENSIONS[artifact.mediaType], mime: artifact.mediaType,
      kind: artifact.kind, size: artifact.size, createdAt: artifact.createdAt, digest: artifact.digest.value,
      relations: artifact.relations, metadata: safeMetadata(artifact.metadata), integrity: 'verified',
      url: '/iris/api/core/artifact/' + id + '/media' } };
  }
  const hit = legacyFile(id), entry = hit.entry;
  return { item: { id, source, file: entry.file, mime: entry.mime || mimeOf(entry.file), size: hit.size,
    kind: 'legacy-output', createdAt: entry.createdAt || '', integrity: 'file-exists', url: legacy.artifactUrl(entry) } };
}

export async function downloadWorkbenchSelection(input, options = {}) {
  const items = selection(input), details = [];
  let bytes = 0;
  for (const item of items) {
    active(options.signal);
    const detail = (await workbenchDetail(item.source, item.id, options)).item;
    bytes += detail.size;
    if (bytes > MAX_WORKBENCH_DOWNLOAD_BYTES) fail('IRIS_WORK_DOWNLOAD_TOO_LARGE', '单次下载最多 128 MiB，请减少选中作品', 413);
    details.push(detail);
    await setImmediate();
  }
  const entries = [], manifest = [];
  bytes = 0;
  for (const detail of details) {
    active(options.signal);
    const data = detail.source === 'core' ? (await readCoreArtifactMediaForDsh(detail.id, options)).bytes : fs.readFileSync(legacyFile(detail.id).abs);
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (detail.source === 'core' && digest !== detail.digest) fail('IRIS_ARTIFACT_DIGEST_MISMATCH', '选中作品内容已改变', 409);
    bytes += data.length;
    if (bytes > MAX_WORKBENCH_DOWNLOAD_BYTES) fail('IRIS_WORK_DOWNLOAD_TOO_LARGE', '单次下载最多 128 MiB，请减少选中作品', 413);
    const name = detail.source + '/' + detail.id + path.extname(detail.file).toLowerCase();
    entries.push({ name, bytes: data });
    manifest.push({ source: detail.source, id: detail.id, file: detail.file, archiveFile: name, mime: detail.mime,
      size: data.length, createdAt: detail.createdAt, digest });
    await setImmediate();
  }
  active(options.signal);
  return workbenchZip([{ name: 'works.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 0, items: manifest }, null, 2) + '\n') }, ...entries]);
}

export async function deleteWorkbenchArtifacts(input, options = {}) {
  exact(input, ['artifact_ids', 'task_ids', 'confirm_delete']);
  const chosen = selection({ items: Array.isArray(input.artifact_ids) ? input.artifact_ids.map(id => ({ source: 'core', id })) : null });
  if (input.confirm_delete !== undefined && typeof input.confirm_delete !== 'boolean') fail('IRIS_COMMAND_INPUT_INVALID', 'confirm_delete 必须是布尔值');
  const taskIds = input.task_ids ?? [];
  if (!Array.isArray(taskIds) || taskIds.length > 200 || !taskIds.every(id => typeof id === 'string' && TASK_ID.test(id))
      || new Set(taskIds).size !== taskIds.length) fail('IRIS_COMMAND_INPUT_INVALID', '关联任务 ID 无效');
  active(options.signal);
  const artifactIds = chosen.map(item => item.id);
  const base = await maintainWorkbenchForDsh('core.delete', { artifact_ids: artifactIds }, options);
  const referencing = [...new Set(base.blockers.filter(blocker => ['task_artifact_reference', 'task_input_reference'].includes(blocker.reason)).map(blocker => blocker.referencedBy))];
  if (taskIds.some(id => !referencing.includes(id))) fail('IRIS_COMMAND_INPUT_INVALID', '只能显式选择这些作品直接关联的任务');
  if (input.confirm_delete === true) return { ok: true, ...await maintainWorkbenchForDsh('core.delete', {
    artifact_ids: artifactIds, task_ids: taskIds, confirm_delete: true }, options) };
  const plan = taskIds.length ? await maintainWorkbenchForDsh('core.delete', { artifact_ids: artifactIds, task_ids: taskIds }, options) : base;
  const tasks = [];
  for (const id of referencing) {
    const task = await inspectProviderTaskForDsh(id, options);
    tasks.push({ id, settled: task.phase === 'terminal' && task.acceptance !== 'unknown' && task.outcome !== 'unknown' });
  }
  return { ok: true, preview: true, allowed: plan.allowed, artifactIds, taskIds, files: plan.entries.length,
    bytes: plan.bytes, blockers: plan.blockers, referencingTasks: tasks };
}

export async function workbenchTransactions(options = {}) {
  return { ok: true, ...await maintainWorkbenchForDsh('core.transactions', {}, options) };
}

export async function restoreWorkbenchTransaction(input, options = {}) {
  exact(input, ['transaction_id', 'confirm_restore']);
  if (input.confirm_restore !== true) fail('IRIS_WORK_RESTORE_CONFIRM_REQUIRED', '请明确确认恢复此隔离事务');
  if (typeof input.transaction_id !== 'string' || !/^delete_[a-f0-9]{24}$/.test(input.transaction_id)) fail('IRIS_COMMAND_INPUT_INVALID', '隔离事务 ID 无效');
  active(options.signal);
  return { ok: true, ...await maintainWorkbenchForDsh('core.restore', { transaction_id: input.transaction_id }, options) };
}

/** API 边界只返回固定提示和稳定码，避免底层 ENOENT/JSON 错误带出文件路径。 */
export function workbenchError(error) {
  if (error.name === 'AbortError') return error;
  const code = String(error.code || 'IRIS_WORK_FAILED');
  const messages = { IRIS_CORE_DELETE_BLOCKED: '作品仍被引用或任务尚未结束，请重新查看删除预览',
    IRIS_CORE_MAINTENANCE_FAILED: '隔离操作未完成，恢复清单已保留，请查看 Core 回收区',
    IRIS_CORE_RESTORE_CONFLICT: '恢复目标已存在，未覆盖已有作品', IRIS_CORE_RESTORE_INVALID: '此事务当前不可恢复',
    IRIS_CORE_DATA_ROOT_BUSY: 'Core 正在被其他进程写入，请稍后重试',
    IRIS_ARTIFACT_DIGEST_MISMATCH: '作品内容哈希核验失败', IRIS_WORK_DOWNLOAD_TOO_LARGE: '单次下载最多 128 MiB，请减少选中作品',
    IRIS_WORK_RESTORE_CONFIRM_REQUIRED: '请明确确认恢复此隔离事务', IRIS_COMMAND_INPUT_INVALID: '作品操作参数无效' };
  const missing = code === 'ENOENT' || /NOT_FOUND/.test(code);
  return Object.assign(new Error(messages[code] || (missing ? '作品或隔离事务不存在' : '作品操作失败，请刷新后重试')), {
    code, statusCode: error.statusCode || (missing ? 404 : code === 'IRIS_COMMAND_INPUT_INVALID' || code === 'IRIS_WORK_RESTORE_CONFIRM_REQUIRED' ? 400 : 409),
    ...(error.transactionId ? { transactionId: error.transactionId } : {})
  });
}
