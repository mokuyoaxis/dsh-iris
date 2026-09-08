'use strict';
/**
 * Iris Task/Attempt v2 的纯语义契约。
 *
 * 本模块只定义名称、派生规则和不可违反的约束，不直接读写任务或调用供应商；
 * tasks、API 与 Doctor 共同消费这里的语义，避免各自解释状态。
 */

export const TASK_PHASES = Object.freeze(['queued', 'submitting', 'accepted', 'running', 'terminal']);
export const ACCEPTANCE_STATES = Object.freeze(['none', 'not_accepted', 'accepted', 'unknown']);
export const WATCH_STATES = Object.freeze(['idle', 'active', 'suspended', 'exhausted']);
export const TASK_OUTCOMES = Object.freeze(['none', 'succeeded', 'failed', 'canceled', 'unknown']);
export const DELIVERY_STATES = Object.freeze(['none', 'pending', 'downloading', 'ready', 'failed']);
export const CANCEL_STATES = Object.freeze(['none', 'requested', 'remote_confirmed', 'local_confirmed', 'unknown']);

export const USER_STATES = Object.freeze([
  'queued',
  'running',
  'watching_paused',
  'needs_attention',
  'artifact_unavailable',
  'succeeded',
  'failed',
  'canceled'
]);

const includes = (values, value) => values.includes(value);

/**
 * 自动 failover 的唯一许可条件。
 * retryable、HTTP 状态或网络错误本身都不能推翻受理边界。
 */
export function allowsAutomaticFailover(attempt) {
  return Boolean(attempt && attempt.acceptance === 'not_accepted');
}

/**
 * 给仍只理解 running/succeeded/failed/canceled 的旧消费者提供保守视图。
 * 无法准确表达的未知、观察暂停和交付失败一律不伪装成终态。
 */
export function deriveLegacyStatus(task) {
  if (!task || typeof task !== 'object') return 'running';
  if (task.outcome === 'succeeded' && task.deliveryState === 'ready') return 'succeeded';
  if (task.outcome === 'failed') return 'failed';
  if (
    task.outcome === 'canceled' &&
    (task.cancelState === 'remote_confirmed' || task.cancelState === 'local_confirmed')
  ) return 'canceled';
  return 'running';
}

/** 面向工作台的稳定语义；UI 文案可以本地化，但不能改变事实分类。 */
export function deriveUserState(task) {
  if (!task || typeof task !== 'object') return 'needs_attention';
  if (task.outcome === 'succeeded' && task.deliveryState === 'ready') return 'succeeded';
  if (task.outcome === 'succeeded' && task.deliveryState === 'failed') return 'artifact_unavailable';
  if (task.outcome === 'failed') return 'failed';
  if (
    task.outcome === 'canceled' &&
    (task.cancelState === 'remote_confirmed' || task.cancelState === 'local_confirmed')
  ) return 'canceled';
  if (
    task.acceptance === 'unknown' ||
    task.outcome === 'unknown' ||
    task.cancelState === 'unknown'
  ) return 'needs_attention';
  if (task.watchState === 'suspended' || task.watchState === 'exhausted') return 'watching_paused';
  if (task.phase === 'queued') return 'queued';
  return 'running';
}

/**
 * 提醒处置是事实轴之外的用户工作流视图。事件优先；早期 0.1.3 只有
 * manualRetries 的记录也应视为已通过重试处理，避免升级后重复提醒。
 */
export function attentionDisposition(task) {
  const events = Array.isArray(task && task.attentionEvents) ? task.attentionEvents : [];
  const last = [...events].reverse().find((item) => item && ['acknowledged', 'restored'].includes(item.type));
  if (last) {
    return {
      status: last.type === 'acknowledged' ? 'acknowledged' : 'open',
      reason: last.reason || (last.type === 'restored' ? 'restored' : 'read'),
      updatedAt: last.at || '',
      ...(last.relatedTaskId ? { relatedTaskId: last.relatedTaskId } : {})
    };
  }
  const retries = Array.isArray(task && task.manualRetries) ? task.manualRetries : [];
  const retry = retries[retries.length - 1];
  if (retry && retry.taskId) {
    return {
      status: 'acknowledged', reason: 'retried', updatedAt: retry.createdAt || '',
      relatedTaskId: retry.taskId, inferred: true
    };
  }
  return { status: 'open', reason: '', updatedAt: '' };
}

/**
 * 校验 v2 记录内部是否自洽。返回稳定错误码，调用方决定如何展示。
 * 这里只检查不可违反的事实关系，不替持久化层补默认值。
 */
export function semanticViolations(task) {
  const errors = [];
  if (!task || typeof task !== 'object' || Array.isArray(task)) return ['task.object'];

  if (!includes(TASK_PHASES, task.phase)) errors.push('task.phase');
  if (!includes(ACCEPTANCE_STATES, task.acceptance)) errors.push('task.acceptance');
  if (!includes(WATCH_STATES, task.watchState)) errors.push('task.watchState');
  if (!includes(TASK_OUTCOMES, task.outcome)) errors.push('task.outcome');
  if (!includes(DELIVERY_STATES, task.deliveryState)) errors.push('task.deliveryState');
  if (!includes(CANCEL_STATES, task.cancelState)) errors.push('task.cancelState');

  if (task.watchState === 'active' && task.acceptance !== 'accepted') {
    errors.push('watch.active_requires_acceptance');
  }
  if (task.phase === 'terminal' && task.watchState === 'active') {
    errors.push('terminal.active_watch');
  }
  if (task.deliveryState !== 'none' && task.outcome !== 'succeeded') {
    errors.push('delivery.requires_success');
  }
  if (
    (task.cancelState === 'remote_confirmed' || task.cancelState === 'local_confirmed') &&
    task.outcome !== 'canceled'
  ) {
    errors.push('cancel.confirmed_requires_canceled_outcome');
  }
  if (
    task.outcome === 'canceled' &&
    task.cancelState !== 'remote_confirmed' &&
    task.cancelState !== 'local_confirmed'
  ) {
    errors.push('canceled.requires_confirmation');
  }
  return errors;
}

const V2_FIELDS = ['phase', 'acceptance', 'watchState', 'outcome', 'deliveryState', 'cancelState'];
const DELIVERY_FAILURE = /转存失败|下载[^：:]*失败|落盘失败|delivery/i;
const WATCH_FAILURE = /盯守超时|轮询连续失败|无法恢复|任务已超时/;

function hasCompleteV2Shape(task) {
  return V2_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(task, field));
}

/**
 * 将旧四态任务转换为保守的 v2 内存视图，不修改输入，也不执行磁盘写入。
 * 无法从旧记录证明的受理、结果与取消事实一律使用 unknown。
 */
export function normalizeLegacyTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new TypeError('旧任务必须是对象');
  }
  const out = {
    ...task,
    ...(Array.isArray(task.attempts) ? { attempts: task.attempts.map((attempt) => ({ ...attempt })) } : {})
  };
  if (hasCompleteV2Shape(out)) return out;

  const status = String(task.status || 'running');
  const hasRemoteId = typeof task.remoteTaskId === 'string' && Boolean(task.remoteTaskId.trim());
  const error = String(task.error || '');
  const defaults = {
    phase: 'terminal',
    acceptance: hasRemoteId ? 'accepted' : 'unknown',
    watchState: 'idle',
    outcome: 'unknown',
    deliveryState: 'none',
    cancelState: 'none'
  };

  if (status === 'succeeded') {
    Object.assign(defaults, {
      acceptance: 'accepted',
      outcome: 'succeeded',
      deliveryState: 'ready'
    });
  } else if (status === 'running' && hasRemoteId) {
    Object.assign(defaults, {
      phase: 'running',
      acceptance: 'accepted',
      watchState: 'suspended',
      outcome: 'none'
    });
  } else if (status === 'failed' && DELIVERY_FAILURE.test(error)) {
    Object.assign(defaults, {
      acceptance: 'accepted',
      outcome: 'succeeded',
      deliveryState: 'failed'
    });
  } else if (status === 'failed' && WATCH_FAILURE.test(error)) {
    Object.assign(defaults, {
      acceptance: hasRemoteId ? 'accepted' : 'unknown',
      watchState: hasRemoteId ? 'exhausted' : 'idle',
      outcome: 'unknown'
    });
  } else if (status === 'canceled') {
    Object.assign(defaults, {
      acceptance: hasRemoteId ? 'accepted' : 'unknown',
      outcome: 'unknown',
      cancelState: 'unknown'
    });
  }

  for (const field of V2_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(out, field)) out[field] = defaults[field];
  }
  return out;
}
