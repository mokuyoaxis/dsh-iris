// Nonsecret identity shared by persisted records and owned Provider assembly.
export const CATALOG_NETWORK = Symbol('iris.catalog-network');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function checkedNetworkRequirement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 3 || Object.keys(value).some(key => !['schemaVersion', 'configId', 'catalogId'].includes(key))
      || value.schemaVersion !== 1 || !UUID.test(value.configId) || !UUID.test(value.catalogId)) {
    throw Object.assign(new Error('网络要求身份或版本无效'), { code: 'IRIS_NETWORK_REQUIREMENT_INVALID' });
  }
  return { schemaVersion: 1, configId: value.configId, catalogId: value.catalogId };
}
export function sameNetworkRequirement(a, b) {
  return a === undefined || b === undefined ? a === b : a.schemaVersion === b.schemaVersion && a.configId === b.configId && a.catalogId === b.catalogId;
}
export function providerNetworkRequirement(provider) { return provider?.[CATALOG_NETWORK]; }
export function createNetworkAttemptBudget() { return { remaining: 16, probes: new Map() }; }
export function networkPolicyError(code, message, stage = 'validate') {
  return Object.assign(new Error(message), { code, stage, category: 'invalid_request', acceptance: 'not_accepted' });
}
