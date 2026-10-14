import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCommandService } from '../lib/command-service.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { defineProviderAdapter } from '../lib/provider-adapter.js';
import { providerErrorRecord } from '../lib/provider-contract.js';
import { inspectCoreTask, recoverCoreTask } from '../lib/core-tasks.js';
import { coreTaskRedeliverable } from '../lib/core-user-projection.js';
import { inspectCoreArtifact } from '../lib/core-artifacts.js';
import { readDeliveryCache } from '../lib/core-delivery-cache.js';
import { readWriterLease } from '../lib/core-writer-lease.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { planCoreDeletion, quarantineCoreFiles, restoreCoreTransaction } from '../lib/core-maintenance.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-sync-recovery-'));
const copy = fs.copyFileSync, rename = fs.renameSync;
let copyFailure = 0, copyCalls = 0, renameFailure;
fs.copyFileSync = (source, target, ...args) => {
  if (String(target).includes(path.join('artifact-store', 'v0', 'objects'))) {
    copyCalls++;
    if (copyFailure && --copyFailure === 0) throw Object.assign(new Error('fixture artifact ENOSPC'), { code: 'ENOSPC' });
  }
  return copy(source, target, ...args);
};
fs.renameSync = (source, target) => {
  if (renameFailure?.(source, target)) {
    renameFailure = null;
    throw Object.assign(new Error('fixture commit interruption'), { code: 'ENOSPC' });
  }
  return rename(source, target);
};

function fixture({ url = false, count = 1, failDownload = false } = {}) {
  const calls = { submit: 0, download: 0 };
  const artifacts = Array.from({ length: count }, () => url
    ? { kind: 'remote-url', url: 'https://fixture.invalid/image?signature=fixture-private-url', mediaType: 'image/png' }
    : { kind: 'inline-base64', data: FAKE_PNG.toString('base64'), mediaType: 'image/png' });
  const adapter = defineProviderAdapter({ id: 'sync-recovery', protocol: 'fixture', capabilities: ['image'],
    operations: {
      async submit() { calls.submit++; return { kind: 'completed', artifacts }; },
      async download({ targetPath }) {
        calls.download++;
        fs.writeFileSync(targetPath, FAKE_PNG, { flag: 'wx', mode: 0o600 });
        if (failDownload) { failDownload = false; throw new Error('fixture response interrupted'); }
        return { bytes: FAKE_PNG.length };
      },
      mapError: providerErrorRecord
    }, unsupported: { discover: 'fixture', poll: 'sync has no remote ID', cancel: 'fixture' }
  });
  return { adapter, calls };
}
function runtimeAt(name) {
  const dataRoot = path.join(base, name);
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
  return { dataRoot, runtime, runner: createProviderTaskRunner(runtime) };
}
const submit = (runner, item) => runner.submit({ capability: 'image',
  candidates: [{ adapter: item.adapter, model: 'sync-recovery::image', providerBinding: 'sha256:' + 'a'.repeat(64) }] });
function failed(task) {
  assert.equal(task.acceptance, 'accepted'); assert.equal(task.outcome, 'succeeded');
  assert.equal(task.deliveryState, 'failed'); assert.equal(task.remoteTaskId, undefined);
  assert.equal(task.deliveryCache, true); assert.equal(task.attempts.length, 1);
  assert.equal(coreTaskRedeliverable(task), true);
}
function ready(dataRoot, task, count = 1) {
  assert.equal(task.deliveryState, 'ready'); assert.equal(task.artifactIds.length, count);
  assert.equal(task.attempts.length, 1);
  for (const id of task.artifactIds) assert.equal(inspectCoreArtifact(dataRoot, id).size, FAKE_PNG.length);
}

try {
  // inline 完整字节：第一次写 Artifact 失败，重启后无配置、无 Provider 完成交付。
  let state = runtimeAt('inline'); const inline = fixture(); copyFailure = 1;
  const initial = await submit(state.runner, inline); failed(initial.task);
  assert.equal(inline.calls.download, 0);
  assert(!JSON.stringify(initial).includes(FAKE_PNG.toString('base64')));
  const cacheRoot = path.join(state.dataRoot, 'delivery-cache/v0', initial.taskId);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(cacheRoot).mode & 0o777, 0o700);
    for (const file of fs.readdirSync(cacheRoot)) assert.equal(fs.statSync(path.join(cacheRoot, file)).mode & 0o777, 0o600);
  }
  await state.runtime.dispose(); state = runtimeAt('inline');
  const restored = await createCommandService(state.runtime).execute('task.redeliver', { task_id: initial.taskId });
  ready(state.dataRoot, restored.task); assert.equal(inline.calls.submit, 1);
  await assert.rejects(createCommandService(state.runtime).execute('task.redeliver', { task_id: initial.taskId }),
    e => e.code === 'IRIS_TASK_NOT_REDELIVERABLE');
  await state.runtime.dispose();

  // URL 失败保留原 URL；重交付不 poll。已下载字节在下一次本地失败后不重复下载。
  state = runtimeAt('url'); const url = fixture({ url: true, failDownload: true });
  const remote = await submit(state.runner, url); failed(remote.task);
  assert(!JSON.stringify(remote).includes('fixture-private-url'));
  assert(!fs.readFileSync(path.join(state.dataRoot, 'task-store/v0/tasks', remote.taskId + '.json'), 'utf8').includes('fixture.invalid'));
  copyFailure = 1;
  const commands = createCommandService(state.runtime, { resolveTaskAdapter: () => url.adapter });
  failed((await commands.execute('task.redeliver', { task_id: remote.taskId })).task);
  assert.equal(url.calls.download, 2);
  ready(state.dataRoot, (await createCommandService(state.runtime).execute('task.redeliver', { task_id: remote.taskId })).task);
  assert.deepEqual(url.calls, { submit: 1, download: 2 });
  await state.runtime.dispose();

  // 第一件已提交、第二件复制失败：重启沿预留 ID 恢复，不重复第一件。
  state = runtimeAt('multiple'); const multiple = fixture({ count: 2 }); copyFailure = 2;
  const batch = await submit(state.runner, multiple); failed(batch.task);
  const ids = readDeliveryCache(state.dataRoot, batch.task).items.map(item => item.artifactId);
  assert.equal(inspectCoreArtifact(state.dataRoot, ids[0]).id, ids[0]);
  assert.equal(planCoreDeletion(state.dataRoot, { artifact_ids: [ids[0]] }).allowed, false,
    '未完成同步交付缓存保护已经提交的第一件作品');
  await state.runtime.dispose(); state = runtimeAt('multiple');
  const batchReady = (await createCommandService(state.runtime).execute('task.redeliver', { task_id: batch.taskId })).task;
  ready(state.dataRoot, batchReady, 2); assert.deepEqual(batchReady.artifactIds, ids);
  assert.equal(fs.readdirSync(path.join(state.dataRoot, 'artifact-store/v0/records')).length, 2);
  assert.equal(multiple.calls.submit, 1); await state.runtime.dispose();

  // Artifact 对象/Manifest 已写、提交 Record 写入失败：恢复同一对象与 ID。
  state = runtimeAt('artifact-commit'); const commit = fixture();
  renameFailure = (_source, target) => String(target).includes(path.join('artifact-store/v0/records'));
  const interrupted = await submit(state.runner, commit); failed(interrupted.task);
  await state.runtime.dispose();
  const cli = spawnSync(process.execPath, ['bin/dsh-iris.js', 'task', 'redeliver', interrupted.taskId,
    '--data-root', state.dataRoot], { encoding: 'utf8', env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  assert.equal(cli.status, 0, cli.stderr);
  ready(state.dataRoot, JSON.parse(cli.stdout).task);
  assert.equal(commit.calls.submit, 1);

  // 全部 Artifact 已提交，但 Task ready 落盘失败：再次交付零新作品、零复制。
  state = runtimeAt('task-commit'); const taskCommit = fixture({ count: 2 });
  renameFailure = (source, target) => String(target).includes(path.join('task-store/v0/tasks'))
    && JSON.parse(fs.readFileSync(source, 'utf8')).deliveryState === 'ready';
  const lostReady = await submit(state.runner, taskCommit); failed(lostReady.task);
  const copiesBefore = copyCalls;
  ready(state.dataRoot, (await createCommandService(state.runtime).execute('task.redeliver', { task_id: lostReady.taskId })).task, 2);
  assert.equal(copyCalls, copiesBefore); await state.runtime.dispose();

  // 完整缓存先发布、Attempt 完成写入失败：显式恢复读取证据，不伪造 unknown。
  state = runtimeAt('completion-proof'); const proof = fixture();
  renameFailure = (source, target) => String(target).includes(path.join('task-store/v0/tasks'))
    && JSON.parse(fs.readFileSync(source, 'utf8')).deliveryState === 'pending';
  const lostCompletion = await submit(state.runner, proof);
  assert.equal(lostCompletion.task.acceptance, 'none'); assert(lostCompletion.localError);
  failed(recoverCoreTask(state.dataRoot, lostCompletion.taskId));
  ready(state.dataRoot, (await createCommandService(state.runtime).execute('task.redeliver', { task_id: lostCompletion.taskId })).task);
  assert.equal(proof.calls.submit, 1); await state.runtime.dispose();

  // 缓存发布失败仍保持已生成事实，不能以局部写失败重新生成。
  state = runtimeAt('cache-write'); const write = fixture();
  renameFailure = (_source, target) => path.basename(String(target)) === 'result.json';
  const cacheFailed = await submit(state.runner, write);
  assert.equal(cacheFailed.task.outcome, 'succeeded'); assert.equal(cacheFailed.task.deliveryState, 'failed');
  assert.equal(cacheFailed.task.deliveryCache, undefined); assert.equal(coreTaskRedeliverable(cacheFailed.task), false);
  assert.equal(write.calls.submit, 1); await state.runtime.dispose();

  // 完整缓存字节损坏：明确失败，不 fallback 到下载、poll 或 submit。
  state = runtimeAt('corrupt'); const corrupt = fixture(); copyFailure = 1;
  const damaged = await submit(state.runner, corrupt); failed(damaged.task);
  const damagedCache = readDeliveryCache(state.dataRoot, damaged.task);
  fs.writeFileSync(path.join(state.dataRoot, 'delivery-cache/v0', damaged.taskId, damagedCache.items[0].payload.file), 'bad');
  const rejected = await createCommandService(state.runtime).execute('task.redeliver', { task_id: damaged.taskId });
  failed(rejected.task); assert.equal(rejected.task.lastError.providerCode, 'IRIS_DELIVERY_CACHE_INVALID');
  assert.deepEqual(corrupt.calls, { submit: 1, download: 0 }); await state.runtime.dispose();

  // 删除任务事实时连同私有缓存一起隔离；恢复后仍可离线交付，保留作品语义。
  state = runtimeAt('quarantine'); const removal = fixture(); copyFailure = 1;
  const removable = await submit(state.runner, removal); failed(removable.task);
  const deletion = planCoreDeletion(state.dataRoot, { task_ids: [removable.taskId] });
  assert.equal(deletion.allowed, true);
  assert(deletion.entries.some(entry => entry.path.startsWith('delivery-cache/')));
  const quarantined = quarantineCoreFiles(state.dataRoot, deletion);
  assert.throws(() => inspectCoreTask(state.dataRoot, removable.taskId), e => e.code === 'IRIS_TASK_NOT_FOUND');
  restoreCoreTransaction(state.dataRoot, quarantined.transactionId);
  ready(state.dataRoot, (await createCommandService(state.runtime).execute('task.redeliver', { task_id: removable.taskId })).task);
  assert.equal(removal.calls.submit, 1); await state.runtime.dispose();

  // 真实进程强杀：缓存已提交而完成事实未提交，显式回收租约后原 Attempt 离线恢复。
  const killedRoot = path.join(base, 'real-kill');
  const killed = spawnSync(process.execPath, ['tests/fixtures/sync-delivery-crash-child.mjs', killedRoot],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  assert(killed.stdout.includes('CHECKPOINT completion-after-cache'), killed.stderr);
  if (process.platform === 'win32') { assert.equal(killed.status, 1); assert.equal(killed.signal, null); }
  else assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const taskId = fs.readdirSync(path.join(killedRoot, 'task-store/v0/tasks'))[0].slice(0, -5);
  assert.equal(inspectCoreTask(killedRoot, taskId).acceptance, 'none');
  const lease = readWriterLease(killedRoot);
  recoverCoreWriterLease(killedRoot, { confirmStalePid: lease.owner.pid });
  state = runtimeAt('real-kill');
  failed(recoverCoreTask(state.dataRoot, taskId));
  ready(state.dataRoot, (await createCommandService(state.runtime).execute('task.redeliver', { task_id: taskId })).task);
  assert.equal(inspectCoreTask(state.dataRoot, taskId).attempts.length, 1);
  await state.runtime.dispose();

  console.log('PASS 同步交付恢复：无远端 ID、离线重启、URL/部分下载、稳定多产物 ID、提交中断、缓存失败/损坏、私有证据与零重复生成');
} finally {
  fs.copyFileSync = copy; fs.renameSync = rename;
  fs.rmSync(base, { recursive: true, force: true });
}
