// Nonsecret dispatch intentions. These records do not prove receipt or public IP.
import { checkedNetworkRequirement } from './network-policy.js';

export const MAX_NETWORK_ROUTE_FACTS = 128;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ATTEMPT = /^attempt_[a-f0-9]{24}$/;
const SHA = /^[a-f0-9]{64}$/;
const OPERATIONS = ['discover', 'prepareInput', 'submit', 'poll', 'download', 'cancel', 'vision'];
const FIELDS = ['schemaVersion', 'configId', 'catalogId', 'configGeneration', 'configRevision', 'providerId', 'operation', 'route', 'poolId', 'nodeId', 'attemptId'];
const invalid = () => { throw Object.assign(new Error('网络路线事实包含无效身份、阶段或未允许字段'), { code: 'IRIS_NETWORK_ROUTE_INVALID' }); };

export function checkedNetworkRouteFact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.includes(key))
      || value.schemaVersion !== 1 || !Number.isSafeInteger(value.configGeneration) || value.configGeneration < 1 || !SHA.test(value.configRevision)
      || typeof value.providerId !== 'string' || !value.providerId || value.providerId.length > 256 || /[\x00-\x1f\x7f]/.test(value.providerId)
      || !OPERATIONS.includes(value.operation) || !['inherit', 'direct', 'proxy'].includes(value.route)
      || value.poolId !== undefined && !ID.test(value.poolId) || value.nodeId !== undefined && !ID.test(value.nodeId)
      || value.attemptId !== undefined && !ATTEMPT.test(value.attemptId)
      || value.route === 'proxy' && (!value.poolId || !value.nodeId)
      || value.route !== 'proxy' && value.nodeId !== undefined || value.route === 'inherit' && value.poolId !== undefined) invalid();
  try { checkedNetworkRequirement({ schemaVersion: 1, configId: value.configId, catalogId: value.catalogId }); }
  catch (_) { invalid(); }
  return { schemaVersion: 1, configId: value.configId, catalogId: value.catalogId,
    configGeneration: value.configGeneration, configRevision: value.configRevision, providerId: value.providerId,
    operation: value.operation, route: value.route,
    ...(value.poolId !== undefined ? { poolId: value.poolId } : {}), ...(value.nodeId !== undefined ? { nodeId: value.nodeId } : {}),
    ...(value.attemptId !== undefined ? { attemptId: value.attemptId } : {}) };
}

export const networkRouteFactKey = value => JSON.stringify(checkedNetworkRouteFact(value));
export function checkedNetworkRouteRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const { firstAt, lastAt, requestCount, phase, ...fact } = value;
  const checked = checkedNetworkRouteFact(fact);
  const iso = time => typeof time === 'string' && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;
  if (phase !== 'dispatch_started' || !iso(firstAt) || !iso(lastAt) || lastAt < firstAt || !Number.isSafeInteger(requestCount) || requestCount < 1) invalid();
  return { ...checked, phase, firstAt, lastAt, requestCount };
}
