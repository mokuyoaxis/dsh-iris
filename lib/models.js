'use strict';
/**
 * Iris 模型发现规则（阶段 6）。
 *
 * 目标：把「账号（key）」与「能力」解耦——一个 key 提供模型池，能力从池里选模型。
 * 本模块是纯静态规则（零 API 调用）：模型名 → 能力标签。
 *
 * 池的来源：
 *   ① provider 显式 `models` 数组（未来配置，可带 capabilities 覆盖）
 *   ② 旧模型字段迁移：imageModel→image-gen、videoModel→video-gen、ttsModel→tts、
 *      transcribeModel→transcribe、visionModel→vision
 * 旧裸账号的已知目录仅由配置写入边界物化，不参与运行时回退。
 */
import { CAPABILITIES } from './capability.js';
import { isDashScopeBaseUrl, selectMediaProtocol } from './provider-protocol.js';

/** 能力 → provider 上的模型字段（保持向后兼容的返回形状） */
export const CAP_FIELD = {
  [CAPABILITIES.IMAGE]: 'imageModel',
  [CAPABILITIES.VIDEO]: 'videoModel',
  [CAPABILITIES.TTS]: 'ttsModel',
  [CAPABILITIES.TRANSCRIBE]: 'transcribeModel',
  [CAPABILITIES.VISION]: 'visionModel'
};

const MODEL_REF_SEP = '::';

/** 稳定的模型复合引用；provider/model 分别编码，避免同名模型跨账号碰撞。 */
export function modelRef(providerId, modelId) {
  return encodeURIComponent(String(providerId || '')) + MODEL_REF_SEP + encodeURIComponent(String(modelId || ''));
}

/** 解析复合引用；旧的纯 model id 返回 null，由配置层按兼容规则解析。 */
export function parseModelRef(ref) {
  if (typeof ref !== 'string') return null;
  const i = ref.indexOf(MODEL_REF_SEP);
  if (i <= 0) return null;
  try {
    const providerId = decodeURIComponent(ref.slice(0, i));
    const modelId = decodeURIComponent(ref.slice(i + MODEL_REF_SEP.length));
    return providerId && modelId ? { providerId, modelId } : null;
  } catch (_) {
    return null;
  }
}

/** 模型名模式 → 能力（静态规则，来源为 DashScope/OpenAI 已知模型命名族） */
const MODEL_CAP_RULES = [
  // 视频先于图像：wan*-t2v/s2v/i2v/video 不能被图像规则误吞
  [/^wan.*-(t2v|s2v|i2v|r2v|video)/i, [CAPABILITIES.VIDEO]],
  [/^wan.*-t2i/i, [CAPABILITIES.IMAGE]],
  [/^wan.*image/i, [CAPABILITIES.IMAGE]], // wan2.7-image / -pro
  [/^qwen-image-edit/i, []], // 纯编辑模型没有文生图能力，不自动加入 iris_draw_image
  [/^qwen-image/i, [CAPABILITIES.IMAGE]], // qwen-image-3.0 / -max
  [/^z-image/i, [CAPABILITIES.IMAGE]],
  [/^qwen\d?-vl/i, [CAPABILITIES.VISION]], // qwen-vl / qwen3-vl / -max / -ocr
  [/^qwen\d?-tts/i, [CAPABILITIES.TTS]], // qwen-tts / qwen3-tts-flash
  [/^cosyvoice/i, [CAPABILITIES.TTS]],
  [/^(?:qwen-audio-.*-asr-.*filetrans|qwen3-asr-.*filetrans|fun-asr(?:-|$)|paraformer)/i, [CAPABILITIES.TRANSCRIBE]],
  [/^(?:qwen-audio-turbo|sensevoice)/i, []], // 音频理解模型/待下线模型不自动分配给文件转写
  [/^gpt-image/i, [CAPABILITIES.IMAGE]],
  [/^dall-e/i, [CAPABILITIES.IMAGE]],
  [/^gemini/i, [CAPABILITIES.VISION]] // Gemini 默认按视觉能力纳入（可被显式配置覆盖）
];

/** 仅供配置写入时接回旧裸账号，不参与运行时选型。 */
const KNOWN_MODELS_BY_PROTOCOL = { dashscope: [
  { id: 'wan2.2-t2i-flash', caps: [CAPABILITIES.IMAGE] },
  { id: 'wan2.2-t2v-flash', caps: [CAPABILITIES.VIDEO] },
  { id: 'wan2.2-s2v-flash', caps: [CAPABILITIES.VIDEO] },
  { id: 'qwen-vl-plus', caps: [CAPABILITIES.VISION] },
  // VERIFY 2026-09-03 实证：locate grounding 零偏差（qwen-vl-plus 仅 25x25 框选）
  { id: 'qwen3-vl-235b-a22b-thinking', caps: [CAPABILITIES.VISION] },
  { id: 'qwen-tts-latest', caps: [CAPABILITIES.TTS] },
  { id: 'qwen-audio-3.0-asr-flash-filetrans', caps: [CAPABILITIES.TRANSCRIBE] }
] };

export function migrateProviderModels(provider) {
  if (Array.isArray(provider.models) || Object.values(CAP_FIELD).some((field) => provider[field])) return false;
  const protocol = selectMediaProtocol(provider).mediaProtocol;
  if (!isDashScopeBaseUrl(provider.baseUrl) || !Object.hasOwn(KNOWN_MODELS_BY_PROTOCOL, protocol)) return false;
  provider.models = KNOWN_MODELS_BY_PROTOCOL[protocol].map((m) => ({
    id: m.id, capabilities: [...m.caps], source: 'migration'
  }));
  return true;
}

/** 按模型名规则推断能力 */
export function capabilitiesOfModel(modelName) {
  const name = String(modelName || '');
  for (const [re, caps] of MODEL_CAP_RULES) {
    if (re.test(name)) return [...caps];
  }
  return [];
}

/** 官方模型目录能力代码 → Iris 能力。未识别代码保守忽略。 */
const DISCOVERY_CAPABILITIES = Object.freeze({
  IG: CAPABILITIES.IMAGE, IMAGE: CAPABILITIES.IMAGE, 'IMAGE-GEN': CAPABILITIES.IMAGE,
  VG: CAPABILITIES.VIDEO, VIDEO: CAPABILITIES.VIDEO, 'VIDEO-GEN': CAPABILITIES.VIDEO,
  TTS: CAPABILITIES.TTS, ASR: CAPABILITIES.TRANSCRIBE,
  TRANSCRIBE: CAPABILITIES.TRANSCRIBE, VU: CAPABILITIES.VISION, VISION: CAPABILITIES.VISION
});

/** 发现元数据优先，名称规则兜底；用户保存后的显式 capabilities 仍是最终覆盖。 */
export function capabilitiesOfDiscoveredModel(model) {
  const id = String(typeof model === 'string' ? model : model?.id || '').trim();
  const declared = Array.isArray(model?.capabilities)
    ? [...new Set(model.capabilities.map((value) => DISCOVERY_CAPABILITIES[String(value).toUpperCase()]).filter(Boolean))]
    : [];
  if (declared.length) return declared;
  return capabilitiesOfModel(id);
}

/** 一个 provider 的模型池条目列表：[{ id, providerId, capabilities:[], verified?, source? }] */
export function providerModels(p) {
  if (!p) return [];
  const out = [];
  const push = (id, caps, extra) => {
    const name = String(id || '').trim();
    if (!name || out.some((m) => m.id === name)) return;
    out.push({ id: name, providerId: p.id, ref: modelRef(p.id, name), capabilities: [...caps], ...(extra || {}) });
  };
  // ① 显式 models 数组（带可选 capabilities 覆盖 + verified/source 透传）
  // 该字段一旦存在（含空数组）即为权威声明：用户可明确标记「此供应商没有可用模型」，
  // 不得再落入 ② 旧字段迁移或 ③ 裸账号已知池。空数组曾因 `.length` 判定被穿透，
  // 导致用户声明无模型却仍被注入 7 个厂商默认模型（见审计 B-5）。
  if (Array.isArray(p.models)) {
    for (const m of p.models) {
      const id = typeof m === 'string' ? m : m && m.id;
      // 元素级空能力数组同样是权威覆盖：用户可明确标记“此模型无能力”。
      const caps = Array.isArray(m && m.capabilities) ? m.capabilities : capabilitiesOfModel(id);
      const extra = typeof m === 'object' && m ? { verified: m.verified, source: m.source } : {};
      push(id, caps, extra);
    }
    return out;
  }
  // ② 旧模型字段迁移
  for (const [cap, field] of Object.entries(CAP_FIELD)) {
    if (p[field]) push(p[field], [cap]);
  }
  return out;
}

/** 只解析用户配置中的模型；裸 ID 与复合引用共享能力校验。 */
export function resolveModelRef(provider, capability, requested = '') {
  const pool = providerModels(provider).filter((m) => m.capabilities.includes(capability));
  const raw = String(requested || '').trim();
  const selected = raw ? resolvePoolModel(pool, raw, capability)
    : pool.find((m) => m.id === provider?.[CAP_FIELD[capability]]) || pool[0];
  return selected?.ref || null;
}

/** 共享旧分配对象、裸名称和复合引用的解析，池顺序决定同名匹配。 */
export function resolvePoolModel(pool, raw, capability) {
  let providerId = '';
  let modelId = '';
  if (raw && typeof raw === 'object') {
    providerId = String(raw.providerId || '');
    modelId = String(raw.modelId || raw.id || '');
  } else if (typeof raw === 'string') {
    const parsed = parseModelRef(raw);
    if (parsed) ({ providerId, modelId } = parsed);
    else if (!raw.includes(MODEL_REF_SEP)) modelId = raw;
  }
  return pool.find((m) => m.id === modelId && (!providerId || m.providerId === providerId)
    && m.capabilities.includes(capability)) || null;
}

/** DSH 与 CLI 共用的候选顺序：分配优先、按池顺序补齐并去重。 */
export function orderedModels(pool, capability, assignments) {
  const ordered = [];
  const seen = new Set();
  const add = (model) => {
    if (model && model.capabilities.includes(capability) && !seen.has(model.ref)) {
      seen.add(model.ref);
      ordered.push(model);
    }
  };
  for (const raw of (Array.isArray(assignments) ? assignments : (assignments ? [assignments] : []))) {
    add(resolvePoolModel(pool, raw, capability));
  }
  for (const model of pool) add(model);
  return ordered;
}

/**
 * 返回候选在当前候选链构造时的配置来源。调用方显式 model_ref 由入口直接标为
 * explicit；本函数只区分 assignment 与池序补齐，结果必须随 Attempt 写前落盘，
 * 不能在事后用可变配置重算。
 */
export function selectionReasonForModel(pool, capability, assignments, modelOrRef) {
  const selected = resolvePoolModel(pool,
    modelOrRef && typeof modelOrRef === 'object' ? modelOrRef.ref : modelOrRef,
    capability);
  if (!selected) return null;
  for (const raw of (Array.isArray(assignments) ? assignments : (assignments ? [assignments] : []))) {
    const assigned = resolvePoolModel(pool, raw, capability);
    if (assigned?.ref === selected.ref) return 'assignment';
  }
  return 'pool';
}

/** 全局模型池：合并所有 provider 的模型 */
export function modelPool(providers) {
  const pool = [];
  for (const p of providers || []) pool.push(...providerModels(p));
  return pool;
}

/** 从池里挑有某能力的模型（按池顺序） */
export function pickModel(pool, capability) {
  return (pool || []).find((m) => m.capabilities.includes(capability)) || null;
}
