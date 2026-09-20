/**
 * Core Task 用户侧只读投影（lib/core-user-projection.js）真值表与安全 DTO 验收。
 * 运行：node tests/core-user-projection.mjs
 */
import {
  CORE_USER_STATES,
  coreCompletionKey,
  diffCoreCompletions,
  projectCoreTaskUserRow,
  projectCoreTaskUserState,
  projectCoreTaskUserView,
  seedCoreCompletions
} from '../lib/core-user-projection.js';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

/* ---------- 五类状态 → 人类文案真值表（文案与状态一一对应，逐条锁定） ---------- */
const CASES = [
  // [事实轴输入, 期望 userState, 期望 label]
  [{ outcome: 'succeeded', deliveryState: 'ready', watchState: 'idle', acceptance: 'accepted' }, 'succeeded', '已完成，作品可用'],
  [{ outcome: 'succeeded', deliveryState: 'ready', watchState: 'exhausted', acceptance: 'accepted' }, 'succeeded', '已完成，作品可用'],
  [{ outcome: 'succeeded', deliveryState: 'failed', watchState: 'idle', acceptance: 'accepted' }, 'delivery_failed', '已生成，作品取回失败'],
  [{ outcome: 'succeeded', deliveryState: 'none', watchState: 'idle', acceptance: 'accepted' }, 'running', '已生成，正在保存作品'],
  [{ outcome: 'succeeded', deliveryState: 'pending', watchState: 'idle', acceptance: 'accepted' }, 'running', '已生成，正在保存作品'],
  [{ outcome: 'succeeded', deliveryState: 'downloading', watchState: 'active', acceptance: 'accepted' }, 'running', '已生成，正在保存作品'],
  [{ outcome: 'failed', deliveryState: 'none', watchState: 'idle', acceptance: 'accepted' }, 'attention', '已失败'],
  // 终态失败优先于观察姿态：已明确失败绝不能显示成暂停
  [{ outcome: 'failed', deliveryState: 'none', watchState: 'exhausted', acceptance: 'accepted' }, 'attention', '已失败'],
  [{ outcome: 'canceled', deliveryState: 'none', watchState: 'idle', acceptance: 'accepted' }, 'attention', '已取消'],
  [{ outcome: 'canceled', deliveryState: 'none', watchState: 'suspended', acceptance: 'accepted' }, 'attention', '已取消'],
  [{ outcome: 'unknown', deliveryState: 'none', watchState: 'active', acceptance: 'unknown' }, 'attention', '任务结果未知，需要检查'],
  [{ outcome: 'none', deliveryState: 'none', watchState: 'active', acceptance: 'unknown' }, 'attention', '提交结果未知，请检查后处理'],
  [{ outcome: 'none', deliveryState: 'failed', watchState: 'idle', acceptance: 'accepted' }, 'attention', '结果状态异常，需要检查'],
  // 观察暂停必须说明远端可能仍在运行，而不是伪装成失败或终止
  [{ outcome: 'none', deliveryState: 'none', watchState: 'suspended', acceptance: 'accepted' }, 'observation_paused', '观察已暂停，远端可能仍在运行'],
  [{ outcome: 'none', deliveryState: 'none', watchState: 'exhausted', acceptance: 'accepted' }, 'observation_paused', '观察已暂停，远端可能仍在运行'],
  [{ outcome: 'none', deliveryState: 'pending', watchState: 'exhausted', acceptance: 'accepted' }, 'observation_paused', '观察已暂停，远端可能仍在运行'],
  [{ outcome: 'none', deliveryState: 'none', watchState: 'idle', acceptance: 'none' }, 'running', '运行中'],
  [{ outcome: 'none', deliveryState: 'none', watchState: 'active', acceptance: 'accepted' }, 'running', '运行中'],
  [{ outcome: 'none', deliveryState: 'pending', watchState: 'idle', acceptance: 'accepted' }, 'running', '运行中'],
  [{ outcome: 'none', deliveryState: 'downloading', watchState: 'idle', acceptance: 'accepted' }, 'running', '运行中'],
  [{ outcome: 'none', deliveryState: 'none', watchState: 'idle', acceptance: 'not_accepted' }, 'running', '运行中']
];
const seenStates = new Set();
for (const [input, state, label] of CASES) {
  const view = projectCoreTaskUserView({ phase: 'running', cancelState: 'none', ...input });
  assert(view.state === state && view.label === label,
    `真值表 ${JSON.stringify(input)} → 期望 ${state}/${label}，实际 ${view.state}/${view.label}`);
  assert(CORE_USER_STATES.includes(view.state), '投影状态必须收敛进五类枚举', view);
  assert(projectCoreTaskUserState({ ...input }) === state, 'state 便捷函数必须与完整视图一致');
  seenStates.add(state);
}
assert(seenStates.size === CORE_USER_STATES.length, '真值表必须覆盖全部五类用户状态', [...seenStates]);

/* 防御性输入：损坏/缺失记录不得让投影崩溃，统一落到 attention。 */
for (const malformed of [null, undefined, {}, [], 'task_x', 42]) {
  const view = projectCoreTaskUserView(malformed);
  assert(view.state === 'attention' && view.label === '记录无法识别，需要检查',
    '无法识别的记录必须落入 attention 并保留人类文案', view);
}

/* ---------- 行 DTO：形状 + 敏感字段零泄漏 ---------- */
const record = {
  id: 'task_abcdef0123456789abcdef',
  capability: 'image',
  modelRef: 'dashscope::qwen-image',
  providerId: 'dashscope',
  providerBinding: 'sha256:' + 'a'.repeat(64),
  remoteTaskId: 'remote-secret-001',
  lastError: { code: 'IRIS_PROVIDER_HTTP', safeMessage: '供应商返回 401 认证失败', status: 401 },
  phase: 'terminal',
  acceptance: 'accepted',
  watchState: 'idle',
  outcome: 'succeeded',
  deliveryState: 'ready',
  cancelState: 'none',
  attempts: [{
    id: 'attempt_abcdef0123456789abcdef', ordinal: 1, providerId: 'dashscope',
    model: 'dashscope::qwen-image', providerBinding: 'sha256:' + 'b'.repeat(64),
    error: { safeMessage: 'Attempt 错误原文', raw: 'database stack trace' }
  }],
  artifactIds: ['artifact_0123456789abcdef01234567'],
  revision: 7,
  createdAt: '2026-09-15T01:00:00.000Z',
  updatedAt: '2026-09-15T02:00:00.000Z'
};
const artifact = { id: 'artifact_0123456789abcdef01234567', mediaType: 'image/png' };
const row = projectCoreTaskUserRow(record, [artifact]);
assert(JSON.stringify(Object.keys(row)) === JSON.stringify([
  'id', 'capability', 'userState', 'label', 'model', 'updatedAt', 'revision', 'artifactIds', 'mediaReady', 'observable', 'redeliverable', 'cancelable', 'retryable'
]), '行 DTO 只能包含十三个安全字段', Object.keys(row));
assert(row.id === record.id && row.userState === 'succeeded' && row.label === '已完成，作品可用'
    && row.model === 'qwen-image' && row.updatedAt === record.updatedAt
    && row.revision === 7 && row.mediaReady === true && row.observable === false
    && JSON.stringify(row.artifactIds) === JSON.stringify(record.artifactIds),
  '行 DTO 必须携带稳定 ID、模型（去供应商前缀）、更新时间与关联作品，终态不可观察', row);
// D1：observable 只跟受理事实轴走——这条记录已受理且有远端 ID 但已是终态成功。
assert(projectCoreTaskUserRow({ ...record, outcome: 'none', phase: 'running' }, []).observable === true,
  '已受理且未定论的任务必须标记可观察');
assert(projectCoreTaskUserRow({ ...record, outcome: 'none', phase: 'running', remoteTaskId: '' }, []).observable === false,
  '缺少远端 ID 的任务必须标记不可观察');
// D2：redeliverable 只跟交付事实轴走——唯一开放的是 succeeded+failed。
assert(row.redeliverable === false, '已 ready 的任务不可重新交付');
assert(projectCoreTaskUserRow({ ...record, deliveryState: 'failed', phase: 'running' }, []).redeliverable === true,
  '成功但取回失败的任务必须标记可重新交付');
assert(projectCoreTaskUserRow({ ...record, deliveryState: 'failed', phase: 'running', remoteTaskId: '' }, []).redeliverable === false,
  '缺少远端 ID 的成功任务必须标记不可重新交付');
// D3：cancelable 是 observable 的超集（外加从未请求过取消）。
assert(row.cancelable === false, '终态任务不可取消');
assert(projectCoreTaskUserRow({ ...record, outcome: 'none', phase: 'running' }, []).cancelable === true,
  '已受理且未定论且未请求过取消的任务必须标记可取消');
assert(projectCoreTaskUserRow({ ...record, outcome: 'none', phase: 'running', cancelState: 'unknown' }, []).cancelable === false,
  '已请求过取消但远端未确认的任务不得再次开放取消入口');
// D4：retryable = 终态且未成功交付。
assert(row.retryable === false, '已成功交付的任务不可重试');
assert(projectCoreTaskUserRow({ ...record, outcome: 'failed', deliveryState: 'none', artifactIds: [] }, []).retryable === true,
  '终态失败任务必须标记可重试为新任务');
assert(projectCoreTaskUserRow({ ...record, outcome: 'none', phase: 'running' }, []).retryable === false,
  '非终态任务不得标记可重试');
const serialized = JSON.stringify(row);
for (const leak of ['dashscope', 'providerId', 'providerBinding', 'sha256:', 'remoteTaskId',
  'remote-secret-001', 'lastError', 'safeMessage', '401 认证失败', 'Attempt 错误原文', 'stack trace']) {
  assert(!serialized.includes(leak), '行 DTO 不得泄漏供应商身份/binding/错误原文：' + leak, serialized);
}
assert(Object.isFrozen(row) && Object.isFrozen(row.artifactIds), '行 DTO 必须冻结，防止呈现层反悔修改');

/* mediaReady 必须与事实对齐：Artifact 不在快照里 → 不能宣称作品可用。 */
assert(projectCoreTaskUserRow(record, []).mediaReady === false, '关联 Artifact 缺失时 mediaReady 必须为 false');
const stillRunning = projectCoreTaskUserRow({ ...record, outcome: 'none', deliveryState: 'none', watchState: 'active', artifactIds: [] }, [artifact]);
assert(stillRunning.userState === 'running' && stillRunning.mediaReady === false,
  '尚未交付的运行中任务不得宣称媒体就绪', stillRunning);
/* 无 modelRef 时从最后一次 Attempt 的复合模型取（仍去掉供应商前缀）。 */
const attemptOnly = projectCoreTaskUserRow({ ...record, modelRef: undefined, artifactIds: [] }, []);
assert(attemptOnly.model === 'qwen-image' && !JSON.stringify(attemptOnly).includes('dashscope'),
  'Attempt 复合模型的投影模型名同样不得带供应商前缀', attemptOnly);

/* ---------- 完成提示只出现一次：同一快照重复渲染不重复提示 ---------- */
const doneRow = { id: 'task_a', userState: 'succeeded', revision: 3 };
const liveRow = { id: 'task_b', userState: 'running', revision: 1 };
assert(coreCompletionKey(doneRow) === 'core:task_a@3', '完成键必须带 core 命名空间与 revision');
const baseline = seedCoreCompletions([doneRow, liveRow]);
assert(baseline.size === 1 && baseline.has('core:task_a@3'), '基线只收录既有完成项');
const sameAgain = diffCoreCompletions([doneRow, liveRow], baseline);
assert(sameAgain.added.length === 0, '同一 snapshot 重复渲染不得重复产生完成提示');
const fresh = diffCoreCompletions([{ id: 'task_a', userState: 'succeeded', revision: 4 }], sameAgain.keys);
assert(fresh.added.length === 1 && fresh.added[0].revision === 4, '事实新增完成项必须只提示一次');
const third = diffCoreCompletions([{ id: 'task_a', userState: 'succeeded', revision: 4 }], fresh.keys);
assert(third.added.length === 0, '刷新后相同事实不得再次提示');
const firstLoad = diffCoreCompletions([doneRow]);
assert(firstLoad.added.length === 0, '首屏基线不得把既有完成项当成新提示');
assert(Object.isFrozen(firstLoad) && Object.isFrozen(firstLoad.added), '去重结果必须冻结');

console.log('ALL OK —— Core 用户投影五类真值表、安全 DTO 与完成提示去重全部通过');
