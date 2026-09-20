import fs from 'node:fs';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-task-record-deletion-v2');
const tasks = await import('../lib/tasks.js');
const { runAction } = await import('../lib/actions.js');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

function makeUnknown(fields = {}) {
  const task = tasks.createV2({ cap: 'image', prompt: 'deletion contract', ...fields });
  const attempt = tasks.beginAttempt(task.id, {
    providerId: 'fixture-provider', providerName: 'Fixture',
    model: 'fixture-provider::image-v0', protocol: 'fixture'
  });
  tasks.recordAttemptResult(task.id, {
    ...attempt,
    acceptance: 'unknown', resultKind: 'acceptance_unknown',
    error: { acceptance: 'unknown', safeMessage: 'fixture response lost' }
  });
  return tasks.get(task.id);
}

const active = tasks.createV2({ cap: 'image', prompt: 'active task' });
const activeDelete = tasks.remove(active.id);
assert(!activeDelete.ok && tasks.get(active.id), '活跃 Task v2 必须继续禁止删除', activeDelete);

const open = makeUnknown({ prompt: 'unhandled unknown' });
const openDelete = tasks.remove(open.id);
assert(!openDelete.ok && tasks.get(open.id), '未处理的未知任务必须继续禁止删除', openDelete);

const acknowledged = makeUnknown({ prompt: 'acknowledged unknown' });
tasks.acknowledgeAttention(acknowledged.id, 'read');
const deleted = await runAction({}, 'tasks_delete', { task_id: acknowledged.id });
assert(deleted.ok && !tasks.get(acknowledged.id), '提醒已读后必须允许显式删除任务记录', deleted);

const retried = makeUnknown({
  prompt: 'retried unknown',
  manualRetries: [{ taskId: 't_replacement', createdAt: '2026-09-13T00:00:00.000Z' }]
});
assert(tasks.attentionDisposition(retried).status === 'acknowledged'
    && tasks.remove(retried.id).ok && !tasks.get(retried.id),
  '已建立重试关系的原任务必须可删除');

const batchAcknowledged = makeUnknown({ prompt: 'batch acknowledged' });
tasks.acknowledgeAttention(batchAcknowledged.id, 'read');
const batchRetried = makeUnknown({
  prompt: 'batch retried', manualRetries: [{ taskId: 't_batch_retry', createdAt: '2026-09-13T00:00:00.000Z' }]
});
const removed = tasks.prune(() => true);
assert(removed.includes(batchAcknowledged.id) && removed.includes(batchRetried.id)
    && !removed.includes(active.id) && !removed.includes(open.id)
    && tasks.get(active.id) && tasks.get(open.id),
  '批量清理必须删除已处理提醒，保留活跃和未处理任务', removed);

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert(source.includes("run('tasks_delete', { task_id: detail.id }")
    && source.includes('删除后无法再观察')
    && source.includes('DSH 后端尚未加载 Core 路由；请重启 DSH 后重试。'),
  '工作台必须提供有风险说明的单条删除，并区分旧后端 404');

console.log('Task v2 acknowledged/retried record deletion tests passed');
