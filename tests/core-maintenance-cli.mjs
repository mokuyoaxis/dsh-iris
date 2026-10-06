import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCoreArtifact, inspectCoreArtifact } from '../lib/core-artifacts.js';
import { createCoreTask, beginCoreAttempt, recordCoreAttemptResult, finalizeCoreNoAcceptance } from '../lib/core-tasks.js';
import { planCoreDeletion, quarantineCoreFiles } from '../lib/core-maintenance.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-maintenance-')), dataRoot = path.join(root, 'core');
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
const ids = await runtime.run('execute', ({ dataRoot }) => {
  const source = createCoreArtifact(dataRoot, { bytes: Buffer.from('original media'), mediaType: 'image/png', kind: 'original' });
  const derived = createCoreArtifact(dataRoot, { bytes: Buffer.from('derived media'), mediaType: 'image/png', kind: 'crop', relations: [{ type: 'derived-from', artifactId: source.id }] });
  const task = createCoreTask(dataRoot, { capability: 'video' });
  const attempt = beginCoreAttempt(dataRoot, task.id, { providerId: 'fixture', model: 'fixture::video' });
  recordCoreAttemptResult(dataRoot, task.id, { id: attempt.id, providerId: 'fixture', model: 'fixture::video', acceptance: 'not_accepted', resultKind: 'not_accepted' });
  finalizeCoreNoAcceptance(dataRoot, task.id, '拒绝');
  const pending = createCoreTask(dataRoot, { capability: 'video' });
  return { source, derived, terminal: task.id, pending: pending.id };
});
await runtime.dispose();
const cli = (args, status = 0) => {
  const result = spawnSync(process.execPath, ['bin/dsh-iris.js', ...args, '--data-root', dataRoot], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, status, result.stderr); return result.stdout ? JSON.parse(result.stdout) : null;
};
const selection = { artifact_ids: [ids.source.id, ids.derived.id], task_ids: [ids.terminal] };
const snapshotFiles = () => {
  const result = {}; for (const directory of ['task-store/v0/tasks', 'artifact-store/v0/records', 'artifact-store/v0/manifests', 'artifact-store/v0/objects']) {
    for (const file of fs.readdirSync(path.join(dataRoot, directory))) result[directory + '/' + file] = fs.readFileSync(path.join(dataRoot, directory, file));
  } return result;
};
try {
  const before = snapshotFiles();
  const blocked = cli(['core', 'delete', '--input', JSON.stringify({ artifact_ids: [ids.source.id] })], 1);
  assert.equal(blocked.blockers[0].reason, 'artifact_relation');
  cli(['core', 'delete', '--input', JSON.stringify({ task_ids: [ids.pending] }), '--confirm-delete'], 1);
  assert.deepEqual(snapshotFiles(), before);
  const preview = cli(['core', 'delete', '--input', JSON.stringify(selection)]);
  assert.equal(preview.preview, true); assert.equal(preview.allowed, true);
  assert.equal(fs.existsSync(path.join(dataRoot, 'maintenance')), false, '预览不能写隔离目录');
  const deleted = cli(['core', 'delete', '--input', JSON.stringify(selection), '--confirm-delete']);
  assert.equal(deleted.recoverable, true); assert.equal(deleted.files, 7);
  assert.equal(cli(['artifact', 'list']).total, 0); assert.equal(cli(['task', 'list']).total, 1);
  assert.equal(cli(['core', 'transactions']).transactions[0].state, 'committed');
  const restored = cli(['core', 'restore', deleted.transactionId]);
  assert.equal(restored.state, 'restored'); assert.deepEqual(snapshotFiles(), before);
  assert.equal(cli(['artifact', 'list']).total, 2);
  const again = cli(['core', 'delete', '--input', JSON.stringify({ artifact_ids: [ids.derived.id] }), '--confirm-delete']);
  const destination = path.join(dataRoot, 'artifact-store/v0/objects', ids.derived.id + '.png');
  fs.writeFileSync(destination, 'new data');
  cli(['core', 'restore', again.transactionId], 1);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new data', '恢复不能覆盖冲突文件');
  fs.renameSync(destination, path.join(root, 'conflict-preserved.png'));
  cli(['core', 'restore', again.transactionId]);
  const staging = path.join(dataRoot, 'provider-staging/v0'); fs.mkdirSync(staging, { recursive: true });
  const stale = path.join(staging, 'download-99999999-' + 'a'.repeat(16) + '.part');
  const live = path.join(staging, 'download-' + process.pid + '-' + 'b'.repeat(16) + '.part');
  for (const file of [stale, live]) { fs.writeFileSync(file, 'temporary'); fs.utimesSync(file, 0, 0); }
  const unknown = path.join(staging, 'unknown-user-file'); fs.writeFileSync(unknown, 'keep');
  const staleRelative = path.relative(dataRoot, stale).split(path.sep).join('/');
  const cleanPreview = cli(['core', 'cleanup']);
  assert.equal(cleanPreview.candidates.length, 1); assert.equal(cleanPreview.candidates[0].path, staleRelative);
  assert.equal(fs.existsSync(stale), true);
  cli(['core', 'cleanup', '--confirm-delete'], 1);
  cli(['core', 'cleanup', '--input', '{"paths":["../../outside"]}', '--confirm-delete'], 1);
  const cleaned = cli(['core', 'cleanup', '--input', JSON.stringify({ paths: [staleRelative] }), '--confirm-delete']);
  assert.equal(fs.existsSync(stale), false); assert.equal(fs.existsSync(live), true); assert.equal(fs.readFileSync(unknown, 'utf8'), 'keep');
  cli(['core', 'restore', cleaned.transactionId]); assert.equal(fs.existsSync(stale), true);
  const writer = createCoreRuntime({ dataRoot, mode: 'writer' }); writer.start();
  try {
    await writer.run('execute', ({ dataRoot }) => {
      const plan = planCoreDeletion(dataRoot, { artifact_ids: [ids.derived.id] });
      const original = fs.renameSync; let moves = 0;
      fs.renameSync = function(source, destination) {
        const quarantineSegment = path.sep + 'quarantine' + path.sep;
        if (String(destination).includes(quarantineSegment) && !String(source).includes(quarantineSegment) && !String(destination).endsWith(path.sep + 'transaction.json')) {
          moves++; if (moves === 2) throw new Error('injected disk failure');
        }
        return original(source, destination);
      };
      try { assert.throws(() => quarantineCoreFiles(dataRoot, plan), { code: 'IRIS_CORE_MAINTENANCE_FAILED' }); }
      finally { fs.renameSync = original; }
      assert.equal(inspectCoreArtifact(dataRoot, ids.derived.id).digest.value, ids.derived.digest.value, '中途失败必须补偿已移动文件');
    });
  } finally { await writer.dispose(); }
  console.log('PASS Core 删除/清理：只读预览、活跃任务/引用保护、隔离与精确恢复、索引一致、冲突不覆盖、失效 staging 显式清理、未知文件保留、中途失败补偿');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
