'use strict';
/** 供应商媒体协议判断与 DashScope 凭据边界。 */

const DASH_SCOPE_HOST = /^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/i;

export function isDashScopeBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !url.username && !url.password && DASH_SCOPE_HOST.test(url.hostname);
  } catch (_) {
    return false;
  }
}

export function inferMediaProtocol(baseUrl) {
  return isDashScopeBaseUrl(baseUrl) ? 'dashscope' : 'openai-images';
}

/** 返回官方 DashScope API 根；不满足边界时在 fetch 前拒绝。 */
export function dashscopeApiBase(baseUrl) {
  if (!isDashScopeBaseUrl(baseUrl)) {
    throw new Error('iris: DashScope 协议只允许使用阿里云官方 HTTPS Base URL；已阻止发送 API Key');
  }
  return new URL('/api/v1', String(baseUrl).trim()).toString().replace(/\/$/, '');
}
