'use strict';
/**
 * Core Task 的用户侧只读投影。
 *
 * Core 事实轴（lib/task-semantics.js）保持不变；这里只做一层只读映射，
 * 把任务收敛成五类用户状态：running / observation_paused / attention /
 * delivery_failed / succeeded。投影不读文件、不写事实、不接触 Provider，
 * 也不包含 providerId、providerBinding、错误原文或任何路径。
 */

export const CORE_USER_STATES = Object.freeze([
  'running',
  'observation_paused',
  'attention',
  'delivery_failed',
  'succeeded'
]);

/**
 * 五类状态的判定与文案。终态事实（成功/失败/取消）优先于观察姿态：
 * 「已经明确失败」绝不能继续显示成「观察暂停」；观察暂停必须明确说明
 * 远端可能仍在运行，避免误导用户以为任务已经终止。
 */
export function projectCoreTaskUserView(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)
      || !['outcome', 'deliveryState', 'watchState', 'acceptance', 'phase'].some((axis) => axis in task)) {
    return Object.freeze({ state: 'attention', label: '记录无法识别，需要检查' });
  }
  const outcome = String(task.outcome || 'none');
  const delivery = String(task.deliveryState || 'none');
  const watch = String(task.watchState || 'idle');
  const acceptance = String(task.acceptance || 'none');
  if (outcome === 'succeeded' && delivery === 'ready') {
    return Object.freeze({ state: 'succeeded', label: '已完成，作品可用' });
  }
  if (outcome === 'succeeded' && delivery === 'failed') {
    return Object.freeze({ state: 'delivery_failed', label: '已生成，作品取回失败' });
  }
  if (outcome === 'succeeded') {
    return Object.freeze({ state: 'running', label: '已生成，正在保存作品' });
  }
  if (outcome === 'failed') {
    return Object.freeze({ state: 'attention', label: '已失败' });
  }
  if (outcome === 'canceled') {
    return Object.freeze({ state: 'attention', label: '已取消' });
  }
  if (outcome === 'unknown') {
    return Object.freeze({ state: 'attention', label: '任务结果未知，需要检查' });
  }
  if (acceptance === 'unknown') {
    return Object.freeze({ state: 'attention', label: '提交结果未知，请检查后处理' });
  }
  if (delivery === 'failed') {
    return Object.freeze({ state: 'attention', label: '结果状态异常，需要检查' });
  }
  if (watch === 'suspended' || watch === 'exhausted') {
    return Object.freeze({ state: 'observation_paused', label: '观察已暂停，远端可能仍在运行' });
  }
  return Object.freeze({ state: 'running', label: '运行中' });
}

/** 只有状态时（如客户端角标归类）使用；完整视图见 projectCoreTaskUserView。 */
export function projectCoreTaskUserState(task) {
  return projectCoreTaskUserView(task).state;
}

/**
 * 与 task.observe / task.reobserve 同一组受理事实门：已受理、有远端 ID、
 * 结果未定论且非终态。只读持久化事实轴，不解析 Provider、不接触网络；
 * 服务端的真正门禁仍在 Command Service（含 binding 与能力校验）。
 */
export function coreTaskObservable(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
  return String(task.acceptance || '') === 'accepted'
    && Boolean(String(task.remoteTaskId || '').trim())
    && ['none', 'unknown'].includes(String(task.outcome || 'none'))
    && String(task.phase || '') !== 'terminal';
}

/**
 * 与 task.redeliver 同一组交付事实门：远端已成功、产物取回失败、远端 ID 仍在。
 * 只读持久化事实轴，不解析 Provider、不接触网络；binding 与能力校验仍在
 * Command Service。五类状态里只有 delivery_failed 会标记 redeliverable。
 */
export function coreTaskRedeliverable(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
  return String(task.outcome || '') === 'succeeded'
    && String(task.deliveryState || '') === 'failed'
    && Boolean(String(task.remoteTaskId || '').trim());
}

/**
 * 与 task.cancel 同一组受理事实门：可观察门的超集条件（外加从未请求过取消）。
 * 只读持久化事实轴，不解析 Provider、不接触网络；Provider 是否支持远端取消
 * 只有 Command 层用真实 adapter 才能回答，这里不预演。
 */
export function coreTaskCancelable(task) {
  return coreTaskObservable(task) && String(task.cancelState || 'none') === 'none';
}

/**
 * 与 task.retry 同一组门：终态且未成功交付（succeeded+ready 的任务不需要重试；
 * delivery_failed 有 redeliver 但重试也合法）。重试产生新的真实计费，
 * 必须显式确认——门只决定入口是否出现，确认在动作侧强制。
 */
export function coreTaskRetryable(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
  return String(task.phase || '') === 'terminal'
    && !(String(task.outcome || '') === 'succeeded' && String(task.deliveryState || '') === 'ready');
}

function modelLabelOf(record) {
  const ref = String(record && record.modelRef || '');
  const separator = ref.indexOf('::');
  if (separator >= 0 && ref.slice(separator + 2)) return ref.slice(separator + 2);
  if (ref) return ref;
  const attempts = Array.isArray(record && record.attempts) ? record.attempts : [];
  const last = attempts[attempts.length - 1];
  const attemptModel = last && typeof last.model === 'string' ? last.model : '';
  const attemptSeparator = attemptModel.indexOf('::');
  if (attemptSeparator >= 0 && attemptModel.slice(attemptSeparator + 2)) {
    return attemptModel.slice(attemptSeparator + 2);
  }
  return attemptModel || '未记录';
}

/**
 * 生成用户任务区消费的安全行 DTO。
 * artifacts 是快照里已读出的 Artifact 摘要数组，用于把「作品可用」与实际的
 * Artifact 存在性对齐；DTO 绝不携带 supplier 身份、binding 或错误原文。
 */
export function projectCoreTaskUserRow(record, artifacts = []) {
  const view = projectCoreTaskUserView(record);
  const artifactList = Array.isArray(artifacts) ? artifacts : [];
  const knownIds = new Set(artifactList.map((item) => item && item.id));
  const rawIds = Array.isArray(record && record.artifactIds) ? record.artifactIds : [];
  const artifactIds = rawIds.filter((id) => typeof id === 'string');
  const mediaReady = Boolean(record)
    && record.outcome === 'succeeded'
    && record.deliveryState === 'ready'
    && artifactIds.length > 0
    && artifactIds.every((id) => knownIds.has(id));
  return Object.freeze({
    id: String(record && record.id || ''),
    capability: String(record && record.capability || 'image'),
    userState: view.state,
    label: view.label,
    model: modelLabelOf(record),
    updatedAt: String(record && record.updatedAt || ''),
    revision: Number.isSafeInteger(record && record.revision) ? record.revision : 0,
    artifactIds: Object.freeze(artifactIds),
    mediaReady,
    observable: coreTaskObservable(record),
    redeliverable: coreTaskRedeliverable(record),
    cancelable: coreTaskCancelable(record),
    retryable: coreTaskRetryable(record)
  });
}

/** 完成提示防重的稳定键：同一条 Task 同一 revision 只提示一次。 */
export function coreCompletionKey(row) {
  return 'core:' + String(row && row.id || '') + '@' + String(Number(row && row.revision) || 0);
}

/** 首次加载的基线：把既有完成项记为已见，避免会话开始时就刷一堆提示。 */
export function seedCoreCompletions(rows) {
  const keys = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && row.userState === 'succeeded') keys.add(coreCompletionKey(row));
  }
  return keys;
}

/**
 * 同一份快照重复渲染不应重复提示：返回相对 seen 新出现的完成项，
 * 以及合并后的键集合（调用方保存供下次比较）。提示不持久化，
 * 刷新页面后由事实快照重新计算基线。
 */
export function diffCoreCompletions(rows, seen) {
  const known = seen instanceof Set ? new Set(seen) : seedCoreCompletions(rows);
  const added = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.userState !== 'succeeded') continue;
    const key = coreCompletionKey(row);
    if (!known.has(key)) {
      known.add(key);
      added.push(row);
    }
  }
  return Object.freeze({ added: Object.freeze(added), keys: known });
}
