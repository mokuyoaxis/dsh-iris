import assert from 'node:assert/strict';
import {
  PROVIDER_HEALTH_FRESH_MS,
  aggregateHealthStates,
  healthObservationState,
  isDefinitiveHealthFailure,
  newestHealthEvidence
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
}, { now }), 'verified', '429 不得覆盖近期成功');
assert.equal(healthObservationState({
  lastTransient: { at: new Date(now).toISOString(), category: 'network' }
}, { now }), 'configured', '临时错误保持待验证');
assert.equal(isDefinitiveHealthFailure({ status: 403 }), true);
assert.equal(isDefinitiveHealthFailure({ category: 'permission' }), true);
assert.equal(isDefinitiveHealthFailure({ status: 429, category: 'quota' }), false);
assert.equal(aggregateHealthStates([]), 'unconfigured');
assert.equal(aggregateHealthStates(['failed', 'configured']), 'configured');
assert.equal(aggregateHealthStates(['failed', 'verified']), 'verified');
assert.equal(aggregateHealthStates(['failed', 'failed']), 'failed');
assert.equal(newestHealthEvidence({
  lastSuccess: { at: ago(3000), source: 'task' },
  lastTransient: { at: ago(1000), source: 'probe' }
}).source, 'probe');

console.log('ALL OK —— Provider 健康新鲜度、认证失败、429 与 failover 汇总语义通过');
