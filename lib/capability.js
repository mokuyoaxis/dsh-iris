'use strict';
/**
 * Iris Provider 能力系统（阶段 1）。
 *
 * 目标（对齐 PLAN 阶段 1 与 RESEARCH 的 "test it, don't guess it"）：
 * - 能力常量：image-gen / video-gen / tts / vision
 * - 严格选择：不具备某能力的 Provider 不得被兜底选中
 * - 有序 failover：同一能力按 providers.json 声明顺序返回，调用方按序尝试
 * - 旧配置迁移：老 provider（无 capabilities 数组）按模型字段推断能力
 *
 * 本模块是纯函数，不读写磁盘；只吃 provider 记录、吐能力判断。
 */
export const CAPABILITIES = Object.freeze({
  IMAGE: 'image-gen',
  VIDEO: 'video-gen',
  TTS: 'tts',
  VISION: 'vision'
});

/** 已知能力集合（用于过滤非法能力名） */
const KNOWN = new Set(Object.values(CAPABILITIES));

/** 旧配置迁移：能力 → 推断来源模型字段 */
const INFER_FIELD = {
  [CAPABILITIES.IMAGE]: 'imageModel',
  [CAPABILITIES.VIDEO]: 'videoModel',
  [CAPABILITIES.TTS]: 'ttsModel',
  [CAPABILITIES.VISION]: 'visionModel'
};

export function isKnownCapability(capability) {
  return KNOWN.has(capability);
}

/**
 * 一个 provider 的能力列表（去重、只留已知能力）。
 * 迁移规则（旧配置）：
 *   ① capabilities 显式声明 → 权威（严格使用，不额外推断）；
 *   ② 否则按模型字段推断（imageModel→image-gen 等）；
 *   ③ 仍为空且是 DashScope 端点 → 全部媒体能力
 *      （百炼单一 API 服务 t2i/t2v/tts/compatible-vision，裸账号常见于迁移期）。
 * @param {object} p provider 记录
 * @returns {string[]}
 */
export function capabilitiesOf(p) {
  const declared = Array.isArray(p && p.capabilities) ? p.capabilities : [];
  if (declared.some((c) => isKnownCapability(c))) {
    return [...new Set(declared)].filter(isKnownCapability);
  }
  // 旧配置迁移：按模型字段推断（有该能力模型才认为具备该能力）
  const inferred = [];
  for (const [cap, field] of Object.entries(INFER_FIELD)) {
    if (p && p[field]) inferred.push(cap);
  }
  if (inferred.length) return inferred;
  // 裸 DashScope 账号兜底迁移
  if (p && /dashscope/i.test(String(p.baseUrl || ''))) {
    return Object.values(CAPABILITIES);
  }
  return [];
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
