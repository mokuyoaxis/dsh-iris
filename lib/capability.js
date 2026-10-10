'use strict';
/**
 * Iris Provider 能力系统（阶段 1）。
 *
 * 目标（“实际验证，不只猜测”）：
 * - 能力常量：image-gen / video-gen / tts / transcribe / vision
 * - 严格选择：不具备某能力的 Provider 不得被兜底选中
 * - 有序 failover：同一能力按 providers.json 声明顺序返回，调用方按序尝试
 * - 能力只来自明确标签或旧模型字段绑定，不按供应商端点赋能
 *
 * 本模块是纯函数，不读写磁盘；只吃 provider 记录、吐能力判断。
 */
export const CAPABILITIES = Object.freeze({
  IMAGE: 'image-gen',
  VIDEO: 'video-gen',
  TTS: 'tts',
  TRANSCRIBE: 'transcribe',
  VISION: 'vision'
});

/** 已知能力集合（用于过滤非法能力名） */
const KNOWN = new Set(Object.values(CAPABILITIES));

/** 旧配置迁移：能力 → 推断来源模型字段 */
const INFER_FIELD = {
  [CAPABILITIES.IMAGE]: 'imageModel',
  [CAPABILITIES.VIDEO]: 'videoModel',
  [CAPABILITIES.TTS]: 'ttsModel',
  [CAPABILITIES.TRANSCRIBE]: 'transcribeModel',
  [CAPABILITIES.VISION]: 'visionModel'
};

/** 模型级明确标签优先；旧能力字段只为同名模型提供明确绑定。 */
export function configuredModelCapabilities(provider, model) {
  if (Array.isArray(model?.capabilities)) {
    return [...new Set(model.capabilities.filter(isKnownCapability))];
  }
  const id = typeof model === 'string' ? model.trim() : String(model?.id || '').trim();
  if (!id) return [];
  const bound = Object.entries(INFER_FIELD)
    .filter(([, field]) => typeof provider?.[field] === 'string' && provider[field].trim() === id)
    .map(([capability]) => capability);
  return Array.isArray(provider?.capabilities) ? bound.filter((capability) => provider.capabilities.includes(capability)) : bound;
}

export function isKnownCapability(capability) {
  return KNOWN.has(capability);
}

/**
 * 一个 provider 的能力列表（去重、只留已知能力）。
 * 显式模型池优先，包括空池；其次是账号明确标签（含空数组），
 * 最后兼容旧能力字段绑定。账号地址和模型名称都不证明能力。
 * @param {object} p provider 记录
 * @returns {string[]}
 */
export function capabilitiesOf(p) {
  if (Array.isArray(p?.models)) {
    return [...new Set(p.models.flatMap((model) => configuredModelCapabilities(p, model)))];
  }
  if (Array.isArray(p?.capabilities)) {
    return [...new Set(p.capabilities.filter(isKnownCapability))];
  }
  // 旧配置迁移：按模型字段推断（有该能力模型才认为具备该能力）
  const inferred = [];
  for (const [cap, field] of Object.entries(INFER_FIELD)) {
    if (typeof p?.[field] === 'string' && p[field].trim()) inferred.push(cap);
  }
  return inferred;
}

/**
 * 声明（或推断）了某能力的 provider 有序列表。
 * @param {Array} providers 已启用的 provider 列表
 * @param {string} capability 能力常量
 * @returns {Array}
 */
export function providersWith(providers, capability) {
  return (Array.isArray(providers) ? providers : []).filter((p) => capabilitiesOf(p).includes(capability));
}

/**
 * 严格选择：只挑声明了该能力的 provider，无则 null（不被兜底选中）。
 * @param {Array} providers
 * @param {string} capability
 * @returns {object|null}
 */
export function pickFor(providers, capability) {
  return providersWith(providers, capability)[0] || null;
}

/**
 * 有序 failover 辅助：依次尝试每个 provider 的能力函数，失败继续下一个。
 * @param {Array} providers 有序 provider 列表
 * @param {Function} run async (provider, index) => T
 * @returns {{value: T|null, provider: object|null, errors: Array}}
 */
export async function tryOrdered(providers, run) {
  const errors = [];
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    try {
      const value = await run(p, i);
      if (value !== undefined && value !== null) return { value, provider: p, errors };
    } catch (err) {
      errors.push({ providerId: p && p.id, message: String((err && err.message) || err) });
    }
  }
  return { value: null, provider: null, errors };
}
