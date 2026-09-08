import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-task-store-v2');
const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tasks = await import('../lib/tasks.js');
const models = await import('../lib/models.js');

const task = tasks.createV2({ cap: 'image', prompt: 'v2' });
assert(task.schemaVersion === 2 && task.revision === 1 && task.phase === 'queued', 'createV2 初始化事实轴', task);

const ref1 = models.modelRef('p1', 'wan2.2-t2i-flash');
const attempt1 = tasks.beginAttempt(task.id, { providerId: 'p1', providerName: 'P1', model: ref1, protocol: 'dashscope' });
const diskAfterBegin = JSON.parse(fs.readFileSync(path.join(tasks.outputsDir(), '..', 'tasks.json'), 'utf8'));
const diskTask = diskAfterBegin.tasks.find((item) => item.id === task.id);
assert(diskTask.attempts[0].id === attempt1.id && diskTask.attempts[0].acceptance === 'none', 'Attempt 在提交前已落盘');
assert(diskTask.modelRef === ref1 && diskTask.model === 'wan2.2-t2i-flash', '复合身份权威字段与旧 UI 字段并存');

tasks.recordAttemptResult(task.id, {
  ...attempt1,
  resultKind: 'not_accepted',
  acceptance: 'not_accepted',
  error: { stage: 'submit', category: 'rate_limit', acceptance: 'not_accepted', safeMessage: '429', httpStatus: 429 }
});
const ref2 = models.modelRef('p2', 'qwen-image-plus');
const attempt2 = tasks.beginAttempt(task.id, { providerId: 'p2', providerName: 'P2', model: ref2, protocol: 'dashscope' });
tasks.recordAttemptResult(task.id, {
  ...attempt2,
  resultKind: 'accepted',
  acceptance: 'accepted',
  remoteTaskId: 'remote-v2'
});
tasks.activateWatch(task.id);
const accepted = tasks.get(task.id);
assert(accepted.attempts.length === 2 && accepted.acceptance === 'accepted' && accepted.watchState === 'active', '拒绝后第二次受理形成单 Task 多 Attempt', accepted);
assert(accepted.status === 'running' && accepted.remoteTaskId === 'remote-v2', '旧状态兼容视图仍为 running');

tasks.watch(accepted, {
  key: () => 'secret-key',
  intervalMs: 20,
  poll: async () => ({ done: true, ok: true, urls: ['https://result.invalid/a.png'] }),
  onSuccess: async () => { throw new Error('write /private/path failed'); }
});
await sleep(750);
const deliveryFailed = tasks.get(task.id);
assert(deliveryFailed.outcome === 'succeeded' && deliveryFailed.deliveryState === 'failed', '下载失败不改写生成成功事实', deliveryFailed);
assert(deliveryFailed.status === 'running' && /结果转存失败/.test(deliveryFailed.error), '旧四态不把交付失败伪装为生成失败', deliveryFailed);
assert(!JSON.stringify(deliveryFailed).includes('/private/path'), '持久化错误已移除绝对路径');

const canceled = tasks.createV2({ cap: 'image', prompt: 'cancel' });
const canceledAttempt = tasks.beginAttempt(canceled.id, { providerId: 'p1', model: ref1, protocol: 'dashscope' });
tasks.recordAttemptResult(canceled.id, {
  ...canceledAttempt, resultKind: 'accepted', acceptance: 'accepted', remoteTaskId: 'remote-cancel'
});
tasks.activateWatch(canceled.id);
tasks.cancel(canceled.id, '用户停止');
const canceledView = tasks.get(canceled.id);
assert(canceledView.cancelState === 'unknown' && canceledView.outcome === 'unknown', '仅停止本地盯守不伪装远端取消成功', canceledView);
assert(canceledView.status === 'running' && canceledView.watchState === 'suspended', '未知取消保持保守兼容状态', canceledView);

const interrupted = tasks.createV2({ cap: 'image', prompt: 'crash' });
tasks.beginAttempt(interrupted.id, { providerId: 'p1', model: ref1, protocol: 'dashscope' });
tasks.resetCache();
tasks.resumePending(() => null);
const recovered = tasks.get(interrupted.id);
assert(recovered.acceptance === 'unknown' && recovered.outcome === 'unknown', '提交中断恢复为受理未知', recovered);
assert(/禁止自动重提/.test(recovered.error || ''), '恢复提示明确禁止自动重提', recovered);

tasks.stopWatchAll();
console.log('ALL OK —— Task v2 预写、受理、交付、取消与中断恢复语义通过');
