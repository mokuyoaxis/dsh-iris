// Private, explicit network resources. This schema does not activate routing.
import { isIP } from 'node:net';
import { redactProviderMessage } from './provider-contract.js';

export const NETWORK_CONFIG_VERSION = 1;
export const NETWORK_ROUTING_CONFIG_VERSION = 2;
export const NETWORK_CONFIG_MAX_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function networkConfigFail(code, message) { throw Object.assign(new Error(message), { code }); }
const invalid = message => networkConfigFail('IRIS_NETWORK_CONFIG_INVALID', message);
export function networkFields(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    invalid('网络配置字段不符合约定，请检查对应对象的字段名称与必填项');
  }
}

function identity(value) {
  if (typeof value !== 'string' || !ID.test(value)) invalid('资源 ID 须为1–64字符的字母、数字、点、短横线或下划线，且以字母或数字开头');
  return value;
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) invalid('资源名称须为非空且最多120字符的单行文本');
  return value.trim();
}

export function normalizeNetworkNode(value) {
  networkFields(value, ['id', 'label', 'enabled', 'protocol', 'host', 'port', 'auth'], ['id', 'protocol', 'host', 'port']);
  const id = identity(value.id);
  if (!['http', 'https'].includes(value.protocol)) invalid('代理协议当前只接受 http 或 https；协议声明不代表已完成连通测试');
  if (typeof value.host !== 'string' || !value.host || value.host.length > 253 || /[\s/\\@?#%]/.test(value.host)
      || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) invalid('代理 host 和 port 无效；请分开填写主机与1–65535端口，不填写认证 URL');
  let host = value.host;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.includes(':') && isIP(host) !== 6) invalid('代理 IPv6 地址无效');
  try {
    const url = new URL(`${value.protocol}://${isIP(host) === 6 ? '[' + host + ']' : host}:${value.port}`);
    if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid('代理 host 无效');
    host = url.hostname.replace(/^\[|\]$/g, '');
  } catch (error) {
    if (error.code === 'IRIS_NETWORK_CONFIG_INVALID') throw error;
    invalid('代理 host 无效');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid('enabled 必须是布尔值');
  let auth;
  if (value.auth !== undefined && value.auth !== null) {
    networkFields(value.auth, ['usernameEnv', 'passwordEnv'], ['usernameEnv', 'passwordEnv']);
    if (![value.auth.usernameEnv, value.auth.passwordEnv].every(name => typeof name === 'string' && ENV.test(name))) invalid('代理认证只接受成对的用户名/密码环境变量名');
    auth = { usernameEnv: value.auth.usernameEnv, passwordEnv: value.auth.passwordEnv };
  }
  return { id, label: label(value.label === undefined ? id : value.label), enabled: value.enabled ?? true, protocol: value.protocol, host, port: value.port, ...(auth ? { auth } : {}) };
}

export function normalizeNetworkPool(value) {
  networkFields(value, ['id', 'label', 'enabled', 'mode', 'candidates'], ['id', 'mode', 'candidates']);
  const id = identity(value.id);
  if (!['fixed', 'ordered'].includes(value.mode) || !Array.isArray(value.candidates)
      || value.candidates.length > (value.mode === 'fixed' ? 1 : 16)) invalid('池需要 fixed（最多1候选）或 ordered（最多16候选），空候选仅为草稿');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid('enabled 必须是布尔值');
  const seen = new Set();
  const candidates = value.candidates.map(candidate => {
    networkFields(candidate, ['kind', 'nodeId'], ['kind']);
    let next, key;
    if (candidate.kind === 'node') { next = { kind: 'node', nodeId: identity(candidate.nodeId) }; key = 'node:' + next.nodeId; }
    else if (candidate.kind === 'direct' && !Object.hasOwn(candidate, 'nodeId')) { next = { kind: 'direct' }; key = 'direct'; }
    else invalid('池候选必须是明确的 node 引用或 direct');
    if (seen.has(key)) invalid('池中不能重复引用同一节点或直连候选');
    seen.add(key); return next;
  });
  return { id, label: label(value.label === undefined ? id : value.label), enabled: value.enabled ?? true, mode: value.mode, candidates };
}

export function validateNetworkConfig(value) {
  if (![NETWORK_CONFIG_VERSION, NETWORK_ROUTING_CONFIG_VERSION].includes(value?.schemaVersion)) networkConfigFail('IRIS_NETWORK_CONFIG_VERSION', '不支持此网络配置版本；请使用兼容版本，原文件不会自动迁移或覆盖');
  const routing = value.schemaVersion === NETWORK_ROUTING_CONFIG_VERSION;
  const fields = ['schemaVersion', 'configId', 'generation', 'nodes', 'pools', ...(routing ? ['bindings'] : [])];
  networkFields(value, fields, fields);
  if (typeof value.configId !== 'string' || !UUID.test(value.configId) || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !Array.isArray(value.nodes) || !Array.isArray(value.pools) || value.nodes.length > 256 || value.pools.length > 256) invalid('网络配置身份、修订或资源列表无效（节点/池各最多256项）');
  const nodes = value.nodes.map(normalizeNetworkNode), pools = value.pools.map(normalizeNetworkPool);
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length || new Set(pools.map(pool => pool.id)).size !== pools.length) invalid('同类资源 ID 不能重复');
  for (const pool of pools) for (const candidate of pool.candidates) {
    if (candidate.kind === 'node' && !ids.has(candidate.nodeId)) invalid('池引用了不存在的节点；请先添加节点或显式编辑候选');
  }
  let bindings;
  if (routing) {
    if (!Array.isArray(value.bindings) || value.bindings.length > 1024) invalid('网络绑定必须是最多1024项的列表');
    const seen = new Set(), poolIds = new Set(pools.map(pool => pool.id));
    bindings = value.bindings.map(binding => {
      networkFields(binding, ['catalogId', 'providerId', 'poolId'], ['catalogId', 'providerId', 'poolId']);
      if (typeof binding.catalogId !== 'string' || !UUID.test(binding.catalogId)
          || typeof binding.providerId !== 'string' || !binding.providerId.trim() || binding.providerId.length > 256
          || /[\x00-\x1f\x7f]/.test(binding.providerId)) invalid('绑定需要有效的目录身份与供应商 ID');
      const poolId = identity(binding.poolId), key = JSON.stringify([binding.catalogId, binding.providerId]);
      if (seen.has(key) || !poolIds.has(poolId)) invalid('绑定重复或引用了不存在的池');
      seen.add(key);
      return { catalogId: binding.catalogId, providerId: binding.providerId, poolId };
    });
  }
  return { schemaVersion: value.schemaVersion, configId: value.configId, generation: value.generation, nodes, pools, ...(routing ? { bindings } : {}) };
}

export function networkNodeCredentialStatus(node, env = process.env) {
  if (!node.auth) return 'none';
  const values = [env[node.auth.usernameEnv], env[node.auth.passwordEnv]];
  if (values.some(value => typeof value !== 'string' || !value.length)) return 'missing';
  return values.some(value => value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) || values[0].includes(':') ? 'invalid' : 'ready';
}

export function projectNetworkConfig(config, revision, env = process.env) {
  const secrets = [...new Set(config.nodes.flatMap(node => node.auth ? [env[node.auth.usernameEnv], env[node.auth.passwordEnv]] : [])
    .filter(value => typeof value === 'string' && value.length))].sort((a, b) => b.length - a.length);
  const display = value => redactProviderMessage(secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value));
  const nodes = config.nodes.map(node => ({ ...node, label: display(node.label), host: display(node.host), credentialStatus: networkNodeCredentialStatus(node, env),
    referencedBy: config.pools.filter(pool => pool.candidates.some(candidate => candidate.kind === 'node' && candidate.nodeId === node.id)).map(pool => pool.id) }));
  const pools = config.pools.map(pool => ({ ...pool, label: display(pool.label),
    ...(config.bindings ? { referencedBy: config.bindings.filter(binding => binding.poolId === pool.id).map(({ catalogId, providerId }) => ({ catalogId, providerId })) } : {}),
    status: !pool.enabled ? 'disabled' : !pool.candidates.length ? 'empty'
    : pool.candidates.some(candidate => candidate.kind === 'direct' || nodes.some(node => node.id === candidate.nodeId && node.enabled && ['none', 'ready'].includes(node.credentialStatus))) ? 'configured' : 'unavailable' }));
  return { schemaVersion: config.schemaVersion, configId: config.configId, generation: config.generation, revision,
    ...(config.bindings ? { routingConfigured: config.bindings.length > 0, runtimeStatus: 'not_observed' } : { routingActive: false }), nodes, pools,
    ...(config.bindings ? { bindings: config.bindings.map(binding => ({ ...binding })) } : {}) };
}
