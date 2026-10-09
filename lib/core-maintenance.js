import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectCoreArtifact, refreshCoreArtifactInventory } from './core-artifacts.js';
import { inspectCoreTask, listCoreTasks } from './core-tasks.js';
import { atomicWritePrivate } from './private-storage.js';

const TASK = /^task_[a-f0-9]{24}$/;
const ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const TRANSACTION = /^delete_[a-f0-9]{24}$/;
const MANAGED = /^(?:task-store\/v0\/tasks\/task_[a-f0-9]{24}\.json|artifact-store\/v0\/(?:records|manifests)\/artifact_[a-f0-9]{24}\.json|artifact-store\/v0\/objects\/artifact_[a-f0-9]{24}\.(?:png|jpg|webp|gif|mp4|webm|wav|mp3|ogg|flac|txt|json)|provider-staging\/v0\/download-[1-9][0-9]*-[a-f0-9]{16}\.part)$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function fileDigest(file) {
  const hash = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(file, 'r');
  try { let size; while ((size = fs.readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function directory(root, relative, create = false) {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('IRIS_CORE_MAINTENANCE_UNSAFE', 'Core 管理目录不安全');
  }
  return current;
}

function managedFile(root, relative) {
  if (!MANAGED.test(relative)) fail('IRIS_CORE_MAINTENANCE_UNSAFE', '不是可管理的 Core 文件');
  directory(root, path.posix.dirname(relative));
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('IRIS_CORE_MAINTENANCE_UNSAFE', 'Core 文件不是普通文件');
  return { path: relative, size: stat.size, digest: fileDigest(file) };
}

function names(root, relative) {
  if (!fs.existsSync(path.join(root, relative))) return [];
  return fs.readdirSync(directory(root, relative));
}

function inventory(root) {
  const tasks = [];
  for (let offset = 0; ; offset += 200) {
    const page = listCoreTasks(root, { offset, limit: 200 }); tasks.push(...page.tasks);
    if (offset + 200 >= page.total) break;
  }
  const artifacts = names(root, 'artifact-store/v0/records').filter(name => ARTIFACT.test(name.slice(0, -5)) && name.endsWith('.json'))
    .map(name => inspectCoreArtifact(root, name.slice(0, -5)));
  return { tasks, artifacts };
}

function ids(value, pattern, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200 || !value.every(id => typeof id === 'string' && pattern.test(id)) || new Set(value).size !== value.length) fail('IRIS_COMMAND_INPUT_INVALID', label + ' 必须是不重复的 Core ID 数组，最多 200 条');
  return value;
}

export function planCoreDeletion(root, input) {
  const taskIds = ids(input.task_ids, TASK, 'task_ids'), artifactIds = ids(input.artifact_ids, ARTIFACT, 'artifact_ids');
  if (!taskIds.length && !artifactIds.length) fail('IRIS_COMMAND_INPUT_INVALID', '请明确指定 Task 或 Artifact ID');
  const existing = inventory(root), selectedTasks = new Set(taskIds), selectedArtifacts = new Set(artifactIds);
  const blockers = [], files = [];
  for (const id of taskIds) {
    const task = inspectCoreTask(root, id);
    if (task.phase !== 'terminal' || task.acceptance === 'unknown' || task.outcome === 'unknown') blockers.push({ id, reason: 'task_not_settled' });
    files.push(managedFile(root, 'task-store/v0/tasks/' + id + '.json'));
  }
  for (const id of artifactIds) {
    inspectCoreArtifact(root, id);
    const recordPath = 'artifact-store/v0/records/' + id + '.json';
    const recordFile = managedFile(root, recordPath);
    const record = JSON.parse(fs.readFileSync(path.join(root, recordPath)));
    const manifestPath = 'artifact-store/v0/manifests/' + id + '.json';
    const manifest = record.schemaVersion === 1 ? JSON.parse(fs.readFileSync(path.join(root, manifestPath))) : record;
    files.push(recordFile);
    if (record.schemaVersion === 1) files.push(managedFile(root, manifestPath));
    files.push(managedFile(root, 'artifact-store/v0/objects/' + manifest.object));
  }
  for (const task of existing.tasks) {
    if (selectedTasks.has(task.id)) continue;
    for (const id of task.artifactIds) if (selectedArtifacts.has(id)) blockers.push({ id, referencedBy: task.id, reason: 'task_artifact_reference' });
    if (selectedArtifacts.has(task.sourceArtifactId)) blockers.push({ id: task.sourceArtifactId, referencedBy: task.id, reason: 'task_input_reference' });
    if (selectedTasks.has(task.retriedFrom)) blockers.push({ id: task.retriedFrom, referencedBy: task.id, reason: 'retry_reference' });
  }
  for (const artifact of existing.artifacts) {
    if (selectedArtifacts.has(artifact.id)) continue;
    if (selectedTasks.has(artifact.metadata.taskId)) blockers.push({ id: artifact.metadata.taskId, referencedBy: artifact.id, reason: 'artifact_task_reference' });
    for (const edge of artifact.relations) if (selectedArtifacts.has(edge.artifactId)) blockers.push({ id: edge.artifactId, referencedBy: artifact.id, reason: 'artifact_relation' });
  }
  // 未提交 Manifest 也可能仍引用目标；未知或损坏的条目保留并阻止误判。
  const committed = new Set(existing.artifacts.map(artifact => artifact.id));
  for (const name of names(root, 'artifact-store/v0/manifests')) {
    if (!/^artifact_[a-f0-9]{24}\.json$/.test(name) || committed.has(name.slice(0, -5))) continue;
    const relative = 'artifact-store/v0/manifests/' + name; managedFile(root, relative);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, relative)));
    for (const edge of manifest.relations || []) if (selectedArtifacts.has(edge.artifactId)) blockers.push({ id: edge.artifactId, referencedBy: name.slice(0, -5), reason: 'uncommitted_relation' });
  }
  return { operation: 'delete', task_ids: taskIds, artifact_ids: artifactIds, allowed: !blockers.length, blockers,
    entries: files, bytes: files.reduce((sum, entry) => sum + entry.size, 0) };
}

export function planCoreCleanup(root, { older_than_ms = 3600000 } = {}) {
  if (!Number.isSafeInteger(older_than_ms) || older_than_ms < 60000) fail('IRIS_COMMAND_INPUT_INVALID', 'older_than_ms 至少为 60000');
  const existing = inventory(root);
  const referenced = new Set(existing.artifacts.map(artifact => artifact.id));
  for (const artifact of existing.artifacts) for (const edge of artifact.relations) referenced.add(edge.artifactId);
  for (const task of existing.tasks) for (const id of task.artifactIds) referenced.add(id);
  for (const task of existing.tasks) if (task.sourceArtifactId) referenced.add(task.sourceArtifactId);
  for (const name of names(root, 'artifact-store/v0/manifests')) {
    if (/^artifact_[a-f0-9]{24}\.json$/.test(name)) {
      referenced.add(name.slice(0, -5));
      const relative = 'artifact-store/v0/manifests/' + name; managedFile(root, relative);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, relative)));
      for (const edge of manifest.relations || []) referenced.add(edge.artifactId);
    }
  }
  const candidates = [];
  for (const relativeDirectory of ['provider-staging/v0', 'artifact-store/v0/objects']) {
    for (const name of names(root, relativeDirectory)) {
      const relative = relativeDirectory + '/' + name;
      if (!MANAGED.test(relative)) continue;
      const stat = fs.lstatSync(path.join(root, relative));
      if (!stat.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < older_than_ms) continue;
      if (relativeDirectory === 'provider-staging/v0') {
        const pid = Number(name.split('-')[1]);
        try { process.kill(pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
      } else if (referenced.has(name.slice(0, name.lastIndexOf('.')))) continue;
      candidates.push(managedFile(root, relative));
    }
  }
  return { operation: 'cleanup', candidates, bytes: candidates.reduce((sum, entry) => sum + entry.size, 0) };
}

const transactionDirectory = (root, id, create = false) => {
  if (!TRANSACTION.test(id)) fail('IRIS_COMMAND_INPUT_INVALID', '隔离事务 ID 无效');
  return directory(root, 'maintenance/v0/quarantine/' + id, create);
};
const refresh = root => { if (fs.existsSync(path.join(root, 'artifact-store/v0'))) refreshCoreArtifactInventory(root); };

/** 写前清单 + rename；失败时补偿，保留事务用于检查/恢复，绝不永久 unlink 媒体。 */
export function quarantineCoreFiles(root, plan) {
  if (!plan.allowed || !plan.entries.length) fail('IRIS_CORE_DELETE_BLOCKED', '删除计划为空或仍被引用，不能执行');
  const id = 'delete_' + crypto.randomBytes(12).toString('hex'), base = transactionDirectory(root, id, true);
  const journal = { schemaVersion: 0, id, state: 'prepared', createdAt: new Date().toISOString(), operation: plan.operation, entries: plan.entries };
  const journalFile = path.join(base, 'transaction.json');
  atomicWritePrivate(journalFile, JSON.stringify(journal, null, 2) + '\n');
  const moved = [];
  try {
    for (const entry of journal.entries) {
      const actual = managedFile(root, entry.path);
      if (actual.digest !== entry.digest || actual.size !== entry.size) fail('IRIS_CORE_MAINTENANCE_CHANGED', '预览后文件发生变化');
      directory(base, path.posix.dirname(entry.path), true);
      fs.renameSync(path.join(root, entry.path), path.join(base, entry.path)); moved.push(entry);
    }
    refresh(root);
    journal.state = 'committed'; atomicWritePrivate(journalFile, JSON.stringify(journal, null, 2) + '\n');
    return { transactionId: id, state: journal.state, files: moved.length, bytes: moved.reduce((sum, entry) => sum + entry.size, 0), recoverable: true };
  } catch (error) {
    try {
      for (const entry of [...moved].reverse()) fs.renameSync(path.join(base, entry.path), path.join(root, entry.path));
      refresh(root); journal.state = 'rolled-back';
    } catch (_) { journal.state = 'interrupted'; }
    atomicWritePrivate(journalFile, JSON.stringify(journal, null, 2) + '\n');
    throw Object.assign(new Error('Core 隔离操作未完成，已保留恢复清单：' + id + '（' + journal.state + '）'), { code: 'IRIS_CORE_MAINTENANCE_FAILED', transactionId: id, state: journal.state, cause: error });
  }
}

export function inspectCoreTransactions(root) {
  return names(root, 'maintenance/v0/quarantine').filter(id => TRANSACTION.test(id)).map(id => {
    const base = transactionDirectory(root, id);
    const file = path.join(base, 'transaction.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('IRIS_CORE_MAINTENANCE_UNSAFE', '隔离清单不是普通文件');
    const journal = JSON.parse(fs.readFileSync(file));
    return { transactionId: id, state: journal.state, operation: journal.operation, createdAt: journal.createdAt, files: journal.entries.length };
  });
}

export function restoreCoreTransaction(root, id) {
  const base = transactionDirectory(root, id), journalFile = path.join(base, 'transaction.json');
  const stat = fs.lstatSync(journalFile);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('IRIS_CORE_MAINTENANCE_UNSAFE', '隔离清单不安全');
  const journal = JSON.parse(fs.readFileSync(journalFile));
  if (journal.schemaVersion !== 0 || journal.id !== id || !Array.isArray(journal.entries)
      || !['prepared', 'committed', 'interrupted'].includes(journal.state)) fail('IRIS_CORE_RESTORE_INVALID', '事务不处于可恢复状态');
  const restoring = [];
  for (const entry of journal.entries) {
    if (!MANAGED.test(entry.path)) fail('IRIS_CORE_MAINTENANCE_UNSAFE', '隔离清单包含不支持的路径');
    if (fs.existsSync(path.join(base, entry.path))) {
      const actual = managedFile(base, entry.path);
      if (actual.digest !== entry.digest || actual.size !== entry.size) fail('IRIS_CORE_MAINTENANCE_CHANGED', '隔离文件哈希或大小改变');
      if (fs.existsSync(path.join(root, entry.path))) fail('IRIS_CORE_RESTORE_CONFLICT', '恢复目标已存在，不覆盖已有数据');
      directory(root, path.posix.dirname(entry.path)); restoring.push(entry);
    } else {
      const actual = managedFile(root, entry.path);
      if (actual.digest !== entry.digest) fail('IRIS_CORE_MAINTENANCE_CHANGED', '事务原位置文件改变');
    }
  }
  const moved = [];
  try {
    for (const entry of restoring) { fs.renameSync(path.join(base, entry.path), path.join(root, entry.path)); moved.push(entry); }
    refresh(root);
    journal.state = 'restored'; atomicWritePrivate(journalFile, JSON.stringify(journal, null, 2) + '\n');
    return { transactionId: id, state: 'restored', files: moved.length };
  } catch (_) {
    for (const entry of [...moved].reverse()) fs.renameSync(path.join(root, entry.path), path.join(base, entry.path));
    refresh(root);
    fail('IRIS_CORE_RESTORE_FAILED', '恢复失败，文件已回到隔离目录');
  }
}
