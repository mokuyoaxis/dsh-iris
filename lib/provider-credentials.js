// Explicit process-environment references. Never mutate/persist resolved providers.
import { ProviderContractError } from './provider-contract.js';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function validateEnvironmentCredential(provider) {
  if (provider?.apiKeyEnv === undefined) return;
  if (typeof provider.apiKeyEnv !== 'string' || !ENV_NAME.test(provider.apiKeyEnv)) {
    fail('IRIS_CONFIG_INPUT_INVALID', 'apiKeyEnv 必须是最多128字符的环境变量名');
  }
  if (provider.apiKey !== undefined || provider.dshProvider !== undefined) {
    fail('IRIS_CONFIG_INPUT_INVALID', '环境凭据引用不能与内联密钥或 DSH 连接引用同时保存');
  }
}

/** Persistent sources remain exclusive; Host-resolved copies never pass this storage boundary. */
export function validateProviderCredential(provider) {
  for (const field of ['baseUrl', 'mediaBaseUrl', 'apiKey']) {
    if (provider?.[field] !== undefined && typeof provider[field] !== 'string') {
      fail('IRIS_CONFIG_INPUT_INVALID', field + ' 必须是字符串');
    }
  }
  validateEnvironmentCredential(provider);
  if (provider?.dshProvider !== undefined
      && (['apiKey', 'apiKeyEnv', 'baseUrl'].some(field => provider[field] !== undefined)
        || provider.mediaBaseUrl !== undefined && provider.mediaBaseUrl !== '')) {
    fail('IRIS_CONFIG_INPUT_INVALID', 'DSH 连接引用不能同时保存内联密钥、环境引用或手动 Base URL（含媒体地址）；请新建手动供应商');
  }
}

export function providerCredentialStatus(provider) {
  if (provider?.apiKeyEnv === undefined) return typeof provider?.apiKey === 'string' && provider.apiKey.trim() ? 'ready' : 'missing';
  const value = process.env[provider.apiKeyEnv];
  if (typeof value !== 'string' || !value.trim()) return 'missing';
  return value.length > 8192 || /[^\x20-\x7e]/.test(value) ? 'invalid' : 'ready';
}

/** Non-throwing for status/cache projections. Network boundaries assert readiness. */
export function providerCredentialValue(provider) {
  if (provider?.apiKeyEnv === undefined) return String(provider?.apiKey || '');
  return providerCredentialStatus(provider) === 'ready' ? process.env[provider.apiKeyEnv].trim() : '';
}

export function assertProviderCredential(provider) {
  // Runtime inputs may be ephemeral DSH copies with a resolved URL/key; stored sources were checked on read/write.
  validateEnvironmentCredential(provider);
  if (provider?.apiKeyEnv !== undefined && provider.auth !== 'none' && providerCredentialStatus(provider) !== 'ready') {
    fail('IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE', '环境凭据未就绪：请检查 Core 进程中的指定变量，值须为非空、最多8192字符的可打印 ASCII 文本');
  }
}

/** An explicit source edit replaces the previous source, never two at once. */
export function applyCredentialPatch(previous, patch) {
  const next = { ...previous, ...patch };
  if (Object.hasOwn(patch, 'apiKeyEnv') && !Object.hasOwn(patch, 'apiKey')) delete next.apiKey;
  if (Object.hasOwn(patch, 'apiKey') && !Object.hasOwn(patch, 'apiKeyEnv')) delete next.apiKeyEnv;
  validateProviderCredential(next);
  return next;
}

/** Legacy/custom transports receive one call's key through their existing API. */
export function resolveProviderCredential(provider) {
  assertProviderCredential(provider);
  if (provider.apiKeyEnv === undefined) return provider;
  const { apiKeyEnv, ...runtime } = provider;
  return { ...runtime, apiKey: provider.auth === 'none' ? '' : providerCredentialValue(provider) };
}

/** Capture explicitly configured sources once, including retained auth:none keys. */
export function createProviderSecretScrubber(providers) {
  const keys = providers.flatMap(provider => {
    const raw = provider.apiKeyEnv === undefined ? provider.apiKey : process.env[provider.apiKeyEnv];
    return typeof raw === 'string' && raw ? [...new Set([raw, raw.trim()].filter(Boolean))] : [];
  }).sort((a, b) => b.length - a.length);
  const scrub = item => typeof item === 'string' ? keys.reduce((text, key) => text.split(key).join('[redacted]'), item)
    : Array.isArray(item) ? item.map(scrub) : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [scrub(key), scrub(entry)])) : item;
  return scrub;
}

export function scrubProviderSecrets(value, providers) {
  return createProviderSecretScrubber(providers)(value);
}

/** Discovery metadata is untrusted; never turn an echoed key into a model ID. */
export function assertDiscoveryCredentials(value, key) {
  const models = Array.isArray(value) ? value : value?.models;
  if (!key || !Array.isArray(models)) return;
  if (models.some(model => {
    const id = String(typeof model === 'string' ? model : model?.id || '').trim();
    return id.includes(key);
  })) {
    throw new ProviderContractError('模型目录包含认证内容，已拒绝读取与保存；请检查上游服务', {
      stage: 'response', category: 'protocol', acceptance: 'not_accepted', providerCode: 'IRIS_PROVIDER_DIRECTORY_CREDENTIALS'
    });
  }
}
