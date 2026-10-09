import assert from 'node:assert/strict';
import {
  PROVIDER_HEALTH_FRESH_MS,
  aggregateHealthStates,
  healthObservationState,
  isDefinitiveHealthFailure,
  newestHealthEvidence,
  isFreeQuotaExhausted,
  retryAfterDelay, recordModelRateLimit, modelRateLimit, clearModelRateLimit
} from '../lib/provider-health.js';

const now = Date.parse('2026-09-09T12:00:00.000Z');
const ago = (ms) => new Date(now - ms).toISOString();

assert.equal(healthObservationState(null, { now }), 'configured');
assert.equal(healthObservationState({ lastSuccess: { at: ago(1000), category: 'success' } }, { now }), 'verified');
assert.equal(healthObservationState({ lastSuccess: { at: ago(PROVIDER_HEALTH_FRESH_MS + 1) } }, { now }), 'configured');
assert.equal(healthObservationState({
  lastSuccess: { at: ago(2000) },
  lastFailure: { at: ago(1000), category: 'authentication', httpStatus: 401 }
}, { now }), 'failed');
assert.equal(healthObservationState({
  lastSuccess: { at: ago(1000) },
  lastFailure: { at: ago(2000), category: 'authentication', httpStatus: 401 }
}, { now }), 'verified');
assert.equal(healthObservationState({
  lastSuccess: { at: ago(1000) },
  lastTransient: { at: new Date(now).toISOString(), category: 'rate_limit', httpStatus: 429 }
}, { now }), 'verified', '旧临时观察不推断新的停用锁；模型停用另按账号 × 模型记录');
assert.equal(healthObservationState({
  lastTransient: { at: new Date(now).toISOString(), category: 'network' }
}, { now }), 'configured', '临时错误保持待验证');
assert.equal(isDefinitiveHealthFailure({ status: 403 }), true);
assert.equal(isDefinitiveHealthFailure({ category: 'permission' }), true);
assert.equal(isDefinitiveHealthFailure({ status: 429, category: 'quota' }), false);
assert.equal(isFreeQuotaExhausted({ status: 403, code: 'AllocationQuota.FreeTierOnly' }), true);
assert.equal(isFreeQuotaExhausted({ status: 403, message: 'Free quota exhausted.' }), true);
assert.equal(isFreeQuotaExhausted({ status: 429, message: 'Free allocated quota exceeded.' }), true);
assert.equal(isFreeQuotaExhausted({ status: 429, code: 'Throttling.AllocationQuota', message: 'Allocated quota exceeded, please increase your quota limit.' }), false,
  'Token 频率限制不等同于免费额度耗尽');
assert.equal(isFreeQuotaExhausted({ status: 403, code: 'Workspace.AccessDenied' }), false);
assert.equal(isFreeQuotaExhausted({ status: 401, message: 'Free quota exhausted.' }), false);
assert.equal(isDefinitiveHealthFailure({ status: 403, category: 'quota' }), false, '明确额度耗尽不能显示 Key 认证失败');
assert.equal(aggregateHealthStates([]), 'unconfigured');
assert.equal(aggregateHealthStates(['failed', 'configured']), 'configured');
assert.equal(aggregateHealthStates(['failed', 'verified']), 'verified');
assert.equal(aggregateHealthStates(['failed', 'failed']), 'failed');
assert.equal(newestHealthEvidence({
  lastSuccess: { at: ago(3000), source: 'task' },
  lastTransient: { at: ago(1000), source: 'probe' }
}).source, 'probe');

assert.equal(retryAfterDelay('120', now), 120000);
assert.equal(retryAfterDelay(new Date(now + 90000).toUTCString(), now), 90000);
assert.equal(retryAfterDelay('', now), 60000);
assert.equal(retryAfterDelay('invalid', now), 60000);
assert.equal(retryAfterDelay('-1', now), 60000);
for (const [status, code, message, reason] of [
  [429, 'Throttling.AllocationQuota', 'Allocated quota exceeded, please increase your quota limit.', null],
  [429, 'Throttling.ConcurrentRequests', 'Concurrent requests exceeded.', null],
  [429, 'ServiceOverloaded', 'Service busy', null],
  [429, 'unknown', 'quota limit exceeded', null],
  [429, 'BudgetLimitExceeded', 'Budget exceeded', 'budget'],
  [429, 'Throttling.AllocationQuota', 'Free allocated quota exceeded.', 'free_quota'],
  [403, 'AllocationQuota.FreeTierOnly', 'Free quota exhausted.', 'free_quota'],
  [403, 'Workspace.AccessDenied', 'Permission denied', undefined],
  [401, 'InvalidApiKey', 'Invalid key', undefined],
  [500, 'ServerError', 'Server failure', undefined]
]) {
  const provider = {};
  const changed = recordModelRateLimit(provider, 'model', { status, code, message, at: new Date(now).toISOString(), retryAfterMs: 90000 });
  assert.equal(changed, reason !== undefined, code);
  const blocked = modelRateLimit(provider, 'model', { now });
  if (reason === undefined) { assert.equal(blocked, null); continue; }
  assert.equal(blocked.reason, reason || undefined);
  assert.equal(modelRateLimit(provider, 'model', { now: now + 90000 }) !== null, !!reason, code + ' 到期资格');
  clearModelRateLimit(provider, 'model'); assert.equal(modelRateLimit(provider, 'model', { now }), null);
}
console.log('ALL OK —— 健康证据、错误码分类、Retry-After、冷却到期和明确耗尽恢复通过');
