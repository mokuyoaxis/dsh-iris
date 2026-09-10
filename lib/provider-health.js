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

function validTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

export function isDefinitiveHealthFailure(value) {
  const status = Number(value && (value.httpStatus ?? value.status));
  const category = String(value && value.category || '').toLowerCase();
  return status === 401 || status === 403 || DEFINITIVE_FAILURES.has(category);
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
