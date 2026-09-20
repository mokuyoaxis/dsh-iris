/**
 * 注意力处置在用户投影里的验收：acknowledged 不进需要处理、hidden 过滤但诊断可见、
 * 重试成功自动静默（事实派生、可撤销、无缓存漂移）。
 * 运行：node tests/core-attention-projections.mjs
 *
 * 零写入纪律：读取快照不得改动 Core 记录字节，也不得改动偏好文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

const { root, cleanup } = useTempDshHome('iris-core-attention-projections');
const config = await import('../lib/config.js');
const { createCoreRuntime } = await import('../lib/core-runtime.js');
const { createCoreTask } = await import('../lib/core-tasks.js');
const { applyCoreAttentionAction } = await import('../lib/core-attention.js');
const { coreSnapshotForDsh, dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const taskFile = (taskId) => path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks', taskId + '.json');

async function writeRecord(prepare) {
  const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'writer' });
  runtime.start();
  try {
    return await runtime.run('execute', async ({ dataRoot }) => {
      const task = createCoreTask(dataRoot, { capability: 'image' });
      await prepare(dataRoot, task.id);
      return task.id;
    });
  } finally {
    await runtime.dispose();
  }
}

/** 直接落盘一个终态失败任务（fixture 语义；不经过 Provider）。 */
async function seedFailedTask() {
  return writeRecord(async (dataRoot, taskId) => {
    const file = path.join(dataRoot, 'task-store', 'v0', 'tasks', taskId + '.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.attempts = [{
      id: 'attempt_' + 'a'.repeat(24), ordinal: 1, providerId: 'fixture', model: 'fixture::v0',
      stage: 'terminal', acceptance: 'not_accepted', resultKind: 'not_accepted',
      startedAt: record.createdAt, finishedAt: record.updatedAt,
      error: { stage: 'submit', category: 'provider', acceptance: 'not_accepted', retryable: true, safeMessage: 'fixture failure' }
    }];
    record.acceptance = 'not_accepted';
    record.outcome = 'failed';
    record.status = 'failed';
    record.phase = 'terminal';
    record.revision += 1;
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  });
}

/** canceled 的事实轴保持 attention，但 DSH 呈现必须标为历史。 */
async function seedCanceledTask() {
  return writeRecord(async (dataRoot, taskId) => {
    const file = path.join(dataRoot, 'task-store', 'v0', 'tasks', taskId + '.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.attempts = [{
      id: 'attempt_' + 'c'.repeat(24), ordinal: 1, providerId: 'fixture', model: 'fixture::v0',
      stage: 'terminal', acceptance: 'accepted', resultKind: 'accepted', remoteTaskId: 'remote-canceled',
      startedAt: record.createdAt, finishedAt: record.updatedAt
    }];
    record.acceptance = 'accepted';
    record.outcome = 'canceled';
    record.cancelState = 'remote_confirmed';
    record.status = 'canceled';
    record.phase = 'terminal';
    record.revision += 1;
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  });
}

/** 直接落盘一个成功交付的后继任务（retriedFrom = 旧任务）。 */
async function seedRetrySuccess(retriedFrom) {
  return writeRecord(async (dataRoot, taskId) => {
    const file = path.join(dataRoot, 'task-store', 'v0', 'tasks', taskId + '.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.attempts = [{
      id: 'attempt_' + 'b'.repeat(24), ordinal: 1, providerId: 'fixture', model: 'fixture::v0',
      stage: 'accepted', acceptance: 'accepted', resultKind: 'accepted', remoteTaskId: 'remote-retry-success',
      startedAt: record.createdAt, finishedAt: record.updatedAt
    }];
    record.acceptance = 'accepted';
    record.outcome = 'succeeded';
    record.deliveryState = 'ready';
    record.status = 'succeeded';
    record.phase = 'terminal';
    record.retriedFrom = retriedFrom;
    record.revision += 1;
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  });
}

async function flipToFailed(taskId) {
  const file = taskFile(taskId);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.outcome = 'failed';
  record.deliveryState = 'none';
  record.status = 'failed';
  record.phase = 'terminal';
  record.revision += 1;
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

const rowOf = (snapshot, id) => snapshot.userTasks.find((row) => row.id === id);
const snapshotBytes = () => {
  const dir = path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks');
  return fs.readdirSync(dir).sort().map((name) => name + ':' + fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
};

try {
  const attentionTaskId = await seedFailedTask();
  const plainTaskId = await seedFailedTask();
  const canceledTaskId = await seedCanceledTask();

  /* 无偏好：两个失败任务都是普通 attention 行，无 disposition/suppressed */
  let snapshot = await coreSnapshotForDsh({ limit: 20 });
  let row = rowOf(snapshot, attentionTaskId);
  assert(row.userState === 'attention' && row.disposition === null && row.suppressed === false && row.historical === false,
    '未处置的 attention 行必须 disposition=null、suppressed=false', row);
  const canceled = rowOf(snapshot, canceledTaskId);
  assert(canceled.userState === 'attention' && canceled.label === '已取消' && canceled.historical === true,
    'canceled 必须保持事实投影 attention，同时用 historical 进入历史呈现', canceled);

  /* 受理：acknowledged，行仍在快照（诊断可见），suppressed 仍 false */
  applyCoreAttentionAction(attentionTaskId, 'acknowledge');
  snapshot = await coreSnapshotForDsh({ limit: 20 });
  row = rowOf(snapshot, attentionTaskId);
  assert(row.disposition === 'acknowledged' && row.suppressed === false
      && row.userState === 'attention',
    'acknowledged 必须留在快照并如实标记', row);

  /* 隐藏：hidden 优先于 acknowledged；诊断仍能看到完整记录 */
  applyCoreAttentionAction(attentionTaskId, 'hide');
  const coreBytesBefore = snapshotBytes();
  const prefsBefore = fs.readFileSync(path.join(config.irisHome(), 'core-attention.json'), 'utf8');
  snapshot = await coreSnapshotForDsh({ limit: 20 });
  row = rowOf(snapshot, attentionTaskId);
  assert(row.disposition === 'hidden', 'hidden 优先于 acknowledged', row);
  assert(snapshot.tasks.recent.some((task) => task.id === attentionTaskId),
    '高级诊断的全量记录必须不受偏好影响');
  assert(snapshotBytes() === coreBytesBefore
      && fs.readFileSync(path.join(config.irisHome(), 'core-attention.json'), 'utf8') === prefsBefore,
    '读取快照不得改写 Core 记录或偏好文件');

  /* 恢复显示：disposition 回到 acknowledged（hide 撤销、受理保留） */
  applyCoreAttentionAction(attentionTaskId, 'unhide');
  snapshot = await coreSnapshotForDsh({ limit: 20 });
  assert(rowOf(snapshot, attentionTaskId).disposition === 'acknowledged', 'unhide 后回到 acknowledged');

  /* 自动静默派生：X failed + Y(succeeded, retriedFrom=X) → X suppressed */
  const silentTaskId = await seedFailedTask();
  let preSilence = rowOf(await coreSnapshotForDsh({ limit: 20 }), silentTaskId);
  assert(preSilence.suppressed === false && preSilence.disposition === null,
    '后继成功前不得静默', preSilence);
  const successorId = await seedRetrySuccess(silentTaskId);
  snapshot = await coreSnapshotForDsh({ limit: 20 });
  const silenced = rowOf(snapshot, silentTaskId);
  assert(silenced.suppressed === true && silenced.disposition === null,
    '重试成功必须让旧任务自动静默（纯派生）', silenced);
  assert(rowOf(snapshot, successorId).userState === 'succeeded',
    '后继任务自身不受影响');

  /* 刷新两次结果一致（无缓存漂移） */
  const again = await coreSnapshotForDsh({ limit: 20 });
  assert(JSON.stringify(rowOf(again, silentTaskId)) === JSON.stringify(silenced),
    '两次快照的派生静默必须一致', { silenced, again: rowOf(again, silentTaskId) });

  /* 撤销：后继后续失败 → 静默随之取消 */
  await flipToFailed(successorId);
  snapshot = await coreSnapshotForDsh({ limit: 20 });
  assert(rowOf(snapshot, silentTaskId).suppressed === false,
    '后继失败必须撤销旧任务的自动静默', rowOf(snapshot, silentTaskId));

  /* 手动 hidden 与派生 suppressed 相互独立（hidden 优先过滤，但 beide 无 Core 写入） */
  applyCoreAttentionAction(plainTaskId, 'hide');
  snapshot = await coreSnapshotForDsh({ limit: 20 });
  assert(rowOf(snapshot, plainTaskId).disposition === 'hidden'
      && rowOf(snapshot, plainTaskId).suppressed === false,
    '手动隐藏与派生静默互不串扰', rowOf(snapshot, plainTaskId));

  console.log('ALL OK —— 注意力投影：受理/隐藏/恢复、重试成功派生静默与撤销、零写入');
} finally {
  cleanup();
}
