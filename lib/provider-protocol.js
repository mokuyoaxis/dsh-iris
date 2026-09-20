'use strict';
/** 供应商媒体协议判断与 DashScope 凭据边界。 */

const DASH_SCOPE_HOST = /^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/i;
const REGIONAL_HOST = /^cn-hongkong\.dashscope\.aliyuncs\.com$/i;
const WORKSPACE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:cn-beijing|ap-southeast-1|eu-central-1|ap-northeast-1|us-east-1)\.maas\.aliyuncs\.com$/i;

/** 可选媒体端点；空值沿用普通/视觉端点。 */
export function providerMediaBaseUrl(provider) {
  return String(provider?.mediaBaseUrl || '').trim() || String(provider?.baseUrl || '').trim();
}

export function isDashScopeBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !url.username && !url.password
      && (DASH_SCOPE_HOST.test(url.hostname) || REGIONAL_HOST.test(url.hostname) || WORKSPACE_HOST.test(url.hostname));
  } catch (_) {
    return false;
  }
}

export function inferMediaProtocol(baseUrl) {
  return detectMediaProtocol(baseUrl) || 'openai-images';
}

/** 未识别的端点不等于已验证的兼容协议。 */
export function detectMediaProtocol(baseUrl) {
  if (isDashScopeBaseUrl(baseUrl)) return 'dashscope';
  try {
    const url = new URL(String(baseUrl || '').trim());
    if (url.protocol === 'https:' && !url.username && !url.password
        && url.hostname === 'api.openai.com') return 'openai-images';
  } catch (_) { /* 未知端点保留兼容回退，由调用方展示推断状态 */ }
  return null;
}

export function selectMediaProtocol(provider) {
  const explicit = typeof provider?.mediaProtocol === 'string' ? provider.mediaProtocol.trim() : '';
  if (explicit && explicit !== 'auto'
      && (provider?.protocolInferred !== true || explicit !== 'openai-images')) {
    return { mediaProtocol: explicit, protocolInferred: false };
  }
  const detected = detectMediaProtocol(providerMediaBaseUrl(provider));
  return { mediaProtocol: detected || 'openai-images', protocolInferred: !detected };
}

export function unsupportedProtocolError(protocol, kind = 'media') {
  const safeName = /^[a-z][a-z0-9-]{0,63}$/.test(String(protocol)) ? protocol : '(invalid)';
  const error = new TypeError('iris: 不支持的 ' + (kind === 'vision' ? 'Vision' : 'Provider') + ' 协议：' + safeName);
  error.code = kind === 'vision' ? 'IRIS_VISION_PROTOCOL_UNSUPPORTED' : 'IRIS_PROVIDER_PROTOCOL_UNSUPPORTED';
  return error;
}

/** 返回官方 DashScope API 根；不满足边界时在 fetch 前拒绝。 */
export function dashscopeApiBase(baseUrl) {
  if (!isDashScopeBaseUrl(baseUrl)) {
    throw new Error('iris: DashScope 协议只允许使用阿里云官方 HTTPS Base URL；已阻止发送 API Key');
  }
  return new URL('/api/v1', String(baseUrl).trim()).toString().replace(/\/$/, '');
}

/** 无认证模式不发送保留的旧凭据；未声明模式保持 bearer 兼容。 */
export function providerApiKey(provider) {
  return provider?.auth === 'none' ? '' : String(provider?.apiKey || '');
}

/** 配置管理与 headless 候选链共用可用性门，未声明 enabled 时默认启用。 */
export function isConfiguredProvider(provider) {
  return Boolean(provider && provider.enabled !== false
    && typeof provider.id === 'string' && provider.id.trim()
    && providerMediaBaseUrl(provider)
    && (provider.auth === 'none' || (typeof provider.apiKey === 'string' && provider.apiKey.trim())));
}
