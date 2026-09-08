/**
 * Task/Attempt v2 语义真值表。
 * 纯函数、零网络、零 I/O；持续守卫已经接入持久化、API 与 Doctor 的行为。
 */
import {
  ACCEPTANCE_STATES,
  allowsAutomaticFailover,
  attentionDisposition,
  deriveLegacyStatus,
  deriveUserState,
  normalizeLegacyTask,
  semanticViolations
} from '../lib/task-semantics.js';

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

// 只有明确未受理允许自动切换。网络错误、retryable 等旁证不得放宽这条红线。
for (const acceptance of ACCEPTANCE_STATES) {
  const expected = acceptance === 'not_accepted';
  assert(
    allowsAutomaticFailover({ acceptance, retryable: true }) === expected,
    `failover 真值错误：${acceptance}`
  );
}
assert(!allowsAutomaticFailover(null), '空 Attempt 不允许自动 failover');

assert(attentionDisposition({}).status === 'open', '无处置事件的提醒默认开放');
assert(attentionDisposition({ attentionEvents: [{ type: 'acknowledged', reason: 'read', at: 'now' }] }).status === 'acknowledged',
  '已读事件关闭主动提醒');
assert(attentionDisposition({ attentionEvents: [
  { type: 'acknowledged', reason: 'read', at: 'before' }, { type: 'restored', at: 'after' }
] }).status === 'open', '恢复事件重新开放提醒');
const inferredRetry = attentionDisposition({ manualRetries: [{ taskId: 'retry-1', createdAt: 'then' }] });
assert(inferredRetry.status === 'acknowledged' && inferredRetry.reason === 'retried' && inferredRetry.inferred,
  '早期 manualRetries 关系应兼容推断为已通过重试处理', inferredRetry);

const base = {
  phase: 'running',
  acceptance: 'accepted',
  watchState: 'active',
  outcome: 'none',
  deliveryState: 'none',
  cancelState: 'none'
};
assert(semanticViolations(base).length === 0, '标准运行态应有效', semanticViolations(base));

const cases = [
  [{ ...base, phase: 'terminal', watchState: 'idle', outcome: 'succeeded', deliveryState: 'ready' }, 'succeeded', 'succeeded'],
  [{ ...base, phase: 'terminal', watchState: 'idle', outcome: 'succeeded', deliveryState: 'failed' }, 'running', 'artifact_unavailable'],
  [{ ...base, phase: 'terminal', watchState: 'exhausted', outcome: 'unknown' }, 'running', 'needs_attention'],
  [{ ...base, phase: 'running', watchState: 'suspended' }, 'running', 'watching_paused'],
  [{ ...base, phase: 'terminal', watchState: 'idle', outcome: 'failed' }, 'failed', 'failed'],
  [{ ...base, phase: 'terminal', watchState: 'idle', outcome: 'canceled', cancelState: 'remote_confirmed' }, 'canceled', 'canceled'],
  [{ ...base, phase: 'terminal', acceptance: 'unknown', watchState: 'idle', outcome: 'unknown' }, 'running', 'needs_attention'],
  [{ ...base, phase: 'queued', acceptance: 'none', watchState: 'idle' }, 'running', 'queued']
];
for (const [task, legacy, user] of cases) {
  assert(deriveLegacyStatus(task) === legacy, `legacy 状态应为 ${legacy}`, task);
  assert(deriveUserState(task) === user, `用户状态应为 ${user}`, task);
  assert(semanticViolations(task).length === 0, `案例应满足语义约束：${user}`, semanticViolations(task));
}

const invalid = [
  [{ ...base, acceptance: 'unknown', watchState: 'active' }, 'watch.active_requires_acceptance'],
  [{ ...base, phase: 'terminal' }, 'terminal.active_watch'],
  [{ ...base, outcome: 'failed', deliveryState: 'failed' }, 'delivery.requires_success'],
  [{ ...base, outcome: 'none', cancelState: 'remote_confirmed' }, 'cancel.confirmed_requires_canceled_outcome'],
  [{ ...base, outcome: 'canceled', cancelState: 'unknown' }, 'canceled.requires_confirmation']
];
for (const [task, code] of invalid) {
  assert(semanticViolations(task).includes(code), `应拒绝违反项 ${code}`, semanticViolations(task));
}

const legacySucceeded = { id: 'old-1', status: 'succeeded', files: ['a.png'] };
const normalizedSucceeded = normalizeLegacyTask(legacySucceeded);
assert(normalizedSucceeded !== legacySucceeded, '旧任务规范化不得修改原对象');
assert(normalizedSucceeded.outcome === 'succeeded' && normalizedSucceeded.deliveryState === 'ready', '旧成功任务应保留成功证据');
assert(!('phase' in legacySucceeded), '旧任务输入不得被原地扩展');

const normalizedRemote = normalizeLegacyTask({ id: 'old-2', status: 'running', remoteTaskId: 'remote-2' });
assert(normalizedRemote.acceptance === 'accepted' && normalizedRemote.watchState === 'suspended', '旧远端运行任务应等待恢复观察');

const normalizedOrphan = normalizeLegacyTask({ id: 'old-3', status: 'running' });
assert(normalizedOrphan.acceptance === 'unknown' && normalizedOrphan.outcome === 'unknown', '无远端 ID 的旧运行任务不得猜测未受理');

const normalizedDelivery = normalizeLegacyTask({ id: 'old-4', status: 'failed', error: '结果转存失败：disk full' });
assert(normalizedDelivery.outcome === 'succeeded' && normalizedDelivery.deliveryState === 'failed', '旧转存失败应保留远端成功事实');

const normalizedWatch = normalizeLegacyTask({ id: 'old-5', status: 'failed', remoteTaskId: 'remote-5', error: '轮询连续失败 5 次' });
assert(normalizedWatch.outcome === 'unknown' && normalizedWatch.watchState === 'exhausted', '旧轮询失败不得伪装远端失败');

const normalizedCanceled = normalizeLegacyTask({ id: 'old-6', status: 'canceled', remoteTaskId: 'remote-6' });
assert(normalizedCanceled.outcome === 'unknown' && normalizedCanceled.cancelState === 'unknown', '旧本地取消不得伪装远端已取消');

for (const normalized of [normalizedSucceeded, normalizedRemote, normalizedOrphan, normalizedDelivery, normalizedWatch, normalizedCanceled]) {
  assert(semanticViolations(normalized).length === 0, '旧任务规范化结果必须满足 v2 约束', semanticViolations(normalized));
}

console.log('ALL OK —— Task/Attempt v2 受理、交付、取消、旧状态、用户状态与旧任务规范化真值表通过');
