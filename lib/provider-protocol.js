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

/** 模型图片协议只覆盖生图；auto 沿用账号级默认，不另外猜测端点。 */
export function normalizeImageProtocol(value) {
  const protocol = typeof value === 'string' ? value.trim() : '';
  if (!['auto', 'dashscope', 'openai-images', 'openai-chat-images', 'openai-responses-images'].includes(protocol)) {
    throw Object.assign(new TypeError('imageProtocol 必须是 auto、dashscope、openai-images、openai-chat-images 或 openai-responses-images'), {
      code: 'IRIS_PROVIDER_IMAGE_PROTOCOL_INVALID'
    });
  }
  return protocol;
}

export function selectImageProtocol(provider, modelId) {
  const entry = Array.isArray(provider?.models) ? provider.models.find(model => model?.id?.trim() === modelId) : null;
  if (entry?.imageProtocol === undefined) return selectMediaProtocol(provider);
  const protocol = normalizeImageProtocol(entry.imageProtocol);
  return protocol === 'auto' ? selectMediaProtocol(provider) : { mediaProtocol: protocol, protocolInferred: false };
}

/** 给已绑定图片模型的 Adapter/binding 投影协议，不改写账号默认值。 */
export function providerForImageModel(provider, modelId) {
  return { ...provider, ...selectImageProtocol(provider, modelId) };
}

export function normalizeMusicProtocol(value) {
  if (value !== 'gemini-web-music') throw Object.assign(new TypeError('musicProtocol 必须是 gemini-web-music'), {
    code: 'IRIS_PROVIDER_MUSIC_PROTOCOL_INVALID'
  });
  return value;
}

export function providerForMusicModel(provider, modelId) {
  const entry = provider.models?.find(model => model?.id?.trim() === modelId);
  return { ...provider, mediaProtocol: normalizeMusicProtocol(entry?.musicProtocol), protocolInferred: false };
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

/**
 * 生图尺寸的协议差异集中在这里，调用点不再自带厂商假设。
 *
 * 分隔符（2026-10-11 实测线上端点）：
 * - dashscope 用 `宽*高`；多模态端点严格校验格式，传 `100x100` 直接回
 *   `Invalid size format`；旧异步端点提交期完全不校验（`100x100`/`100X100`/`auto` 均 200），
 *   由具体模型在生成期报错。
 * - OpenAI 兼容三家用 `宽x高`；尺寸集合由各家网关决定，只做格式归一，不设数值白名单。
 *
 * 数值边界只登记服务端确证会拒绝的那一条：
 * - dashscope 多模态：`Image area must be between 262144 (512x512) and 4194304 (2048x2048)`。
 * - 其余协议暂无证据，一律留空 —— 本地不拦，交给上游报错，避免比服务端更严。
 */
export const IMAGE_SIZE_RULES = Object.freeze({
  dashscope: Object.freeze({ separator: '*' }),
  'openai-images': Object.freeze({ separator: 'x' }),
  'openai-chat-images': Object.freeze({ separator: 'x' }),
  'openai-responses-images': Object.freeze({ separator: 'x' }),
  'dashscope/multimodal-sync': Object.freeze({
    separator: '*', minArea: 262144, maxArea: 4194304
  })
});

/** 协议级规则优先于账号级；都没有则返回 null（= 本地不约束）。 */
export function imageSizeRule(protocol, mode) {
  const key = mode ? String(protocol) + '/' + String(mode) : String(protocol);
  return IMAGE_SIZE_RULES[key] || IMAGE_SIZE_RULES[String(protocol)] || null;
}

/** 解析 `宽<分隔符>高`；无法识别返回 null（含 `auto` 这类自由取值）。 */
export function parseImageSize(size) {
  const m = /^(\d+)\s*([*x×X])\s*(\d+)$/.exec(String(size ?? '').trim());
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[3]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, separator: m[2] };
}

/** 把尺寸归一成该协议的规范分隔符；无法识别的原样返回。 */
export function normalizeImageSize({ protocol, mode, size } = {}) {
  const rule = imageSizeRule(protocol, mode);
  if (!rule || !rule.separator) return size;
  const parsed = parseImageSize(size);
  if (!parsed) return size;
  return parsed.width + rule.separator + parsed.height;
}

/** 返回违规说明；合规、无规则或无法识别时返回 null。纯函数：不抛错、不依赖具体错误类型。 */
export function imageSizeViolation({ protocol, mode, size } = {}) {
  const rule = imageSizeRule(protocol, mode);
  if (!rule || rule.minArea === undefined) return null;
  const parsed = parseImageSize(size);
  if (!parsed) return null;
  const { width, height } = parsed;
  const area = width * height;
  if (area >= rule.minArea && area <= rule.maxArea) return null;
  const label = mode ? protocol + '/' + mode : protocol;
  return `尺寸 ${width}*${height} 不被 ${label} 接受：总像素需在 ${rule.minArea}–${rule.maxArea} 之间`;
}
