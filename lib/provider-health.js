'use strict';

export const PROVIDER_HEALTH_SCHEMA_VERSION = 1;
export const PROVIDER_HEALTH_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const PROVIDER_HEALTH_STATES = Object.freeze([
  'unconfigured',
  'configured',
  'verified',
  'failed'
]);

const DEFINITIVE_FAILURES = new Set(['authentication', 'auth', 'permission']);
export const MODEL_RATE_LIMIT_COOLDOWN_MS = 60000;

export function retryAfterDelay(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return MODEL_RATE_LIMIT_COOLDOWN_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > now ? at - now : MODEL_RATE_LIMIT_COOLDOWN_MS;
}

/** 百炼“免费额度用完即停”返回 403，不应误归类为 Key 无效。 */
export function isFreeQuotaExhausted(value) {
  const status = Number(value?.httpStatus ?? value?.status);
  if (![403, 429].includes(status)) return false;
  return status === 403 && (value.category === 'quota' || value.code === 'IRIS_MODEL_RATE_LIMITED')
    || (value.providerCode || value.code) === 'AllocationQuota.FreeTierOnly'
    || /\bfree (?:allocated quota|quota|tier)\b[^\n]{0,120}\b(?:exhausted|expired|exceeded)\b/i.test(String(value.message || value.safeMessage || value.note || ''));
}

export function quotaExhaustionReason(value) {
  if (isFreeQuotaExhausted(value) || value?.reason === 'free_quota') return 'free_quota';
  const status = Number(value?.httpStatus ?? value?.status);
  if (status !== 429) return null;
  if ((value.providerCode || value.code) === 'BudgetLimitExceeded' || value.reason === 'budget') return 'budget';
  return null;
}

/** 短时限流到期即可参与候选；额度/预算耗尽只有成功实测才解除。 */
export function modelRateLimit(provider, modelId, { now = Date.now() } = {}) {
  const blocked = provider?.health?.rateLimits?.find(item => item.modelId === modelId);
  return blocked && (!blocked.until || Date.parse(blocked.until) > now) ? blocked : null;
}

export function recordModelRateLimit(provider, modelId, result) {
  const status = Number(result?.httpStatus ?? result?.status);
  const reason = quotaExhaustionReason(result);
  const category = reason ? 'quota' : status === 429 ? 'rate_limit' : null;
  const existing = modelRateLimit(provider, modelId);
  if (!category || !modelId || existing && (!reason || existing.reason)) return false;
  provider.health ||= { version: 1, revision: 0, observations: [] };
  provider.health.rateLimits ||= [];
  const at = Date.parse(result.at || '');
  const timestamp = Number.isFinite(at) ? at : Date.now();
  const delay = Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : MODEL_RATE_LIMIT_COOLDOWN_MS;
  provider.health.rateLimits = provider.health.rateLimits.filter(item => item.modelId !== modelId);
  provider.health.rateLimits.push({ modelId,
    at: new Date(timestamp).toISOString(),
    source: result.source === 'probe' ? 'probe' : 'task', category, httpStatus: status,
    ...(reason ? { reason } : { until: result.until || new Date(timestamp + Math.max(1000, delay)).toISOString() }) });
  return true;
}

/** 只有显式模型实测通过才调用；普通任务成功不能解除停用。 */
export function clearModelRateLimit(provider, modelId) {
  if (!provider?.health?.rateLimits) return;
  provider.health.rateLimits = provider.health.rateLimits.filter(item => item.modelId !== modelId);
  if (!provider.health.rateLimits.length) delete provider.health.rateLimits;
}

/** 配置改变时使一项能力验证失效；保留同模型的限流/耗尽资格和其他能力。 */
export function clearModelCapabilityHealth(provider, modelId, capability) {
  if (provider.health?.observations) {
    provider.health = { ...provider.health, revision: (provider.health.revision || 0) + 1,
      observations: provider.health.observations.filter(item => item.modelId !== modelId || item.capability !== capability) };
  }
  const entry = provider.models?.find(model => model?.id?.trim() === modelId);
  if (entry?.verified) {
    entry.verified = { ...entry.verified };
    delete entry.verified[capability];
  }
}

export function reportModelRateLimit(provider, modelId, result, onRateLimit, capability) {
  if (!recordModelRateLimit(provider, modelId, result)) return;
  const blocked = modelRateLimit(provider, modelId);
  try { onRateLimit?.({ providerId: provider.id, capability, ...blocked }); }
  catch (_) { console.warn('[iris] 模型停用状态未能持久化，请检查配置写入权限'); }
}

function validTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

export function isDefinitiveHealthFailure(value) {
  const status = Number(value && (value.httpStatus ?? value.status));
  const category = String(value && value.category || '').toLowerCase();
  return !isFreeQuotaExhausted(value) && (status === 401 || status === 403 || DEFINITIVE_FAILURES.has(category));
}

export function healthObservationState(observation, {
  now = Date.now(),
  freshMs = PROVIDER_HEALTH_FRESH_MS
} = {}) {
  if (!observation || typeof observation !== 'object') return 'configured';
  const successAt = validTime(observation.lastSuccess && observation.lastSuccess.at);
  const failureAt = validTime(observation.lastFailure && observation.lastFailure.at);
  const cutoff = Number(now) - Number(freshMs);

  if (failureAt >= cutoff && failureAt >= successAt
      && isDefinitiveHealthFailure(observation.lastFailure)) {
    return 'failed';
  }
  if (successAt >= cutoff && successAt > failureAt) return 'verified';
  return 'configured';
}

export function aggregateHealthStates(states) {
  const list = (Array.isArray(states) ? states : []).filter((state) =>
    PROVIDER_HEALTH_STATES.includes(state) && state !== 'unconfigured');
  if (!list.length) return 'unconfigured';
  if (list.includes('verified')) return 'verified';
  if (list.includes('configured')) return 'configured';
  return 'failed';
}

export function newestHealthEvidence(observation) {
  const entries = [
    observation && observation.lastSuccess,
    observation && observation.lastFailure,
    observation && observation.lastTransient
  ].filter((item) => item && validTime(item.at));
  entries.sort((a, b) => validTime(b.at) - validTime(a.at));
  return entries[0] || null;
}
