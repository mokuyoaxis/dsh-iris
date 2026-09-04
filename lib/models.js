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
 *   ③ 裸 DashScope 账号：已知模型清单（wan 系列 / qwen-vl / qwen-tts）作为池
 */
import { CAPABILITIES } from './capability.js';

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

/** 裸 DashScope 已知模型清单（无显式模型字段时作为池） */
const DASHSCOPE_KNOWN = [
  { id: 'wan2.2-t2i-flash', caps: [CAPABILITIES.IMAGE] },
  { id: 'wan2.2-t2v-flash', caps: [CAPABILITIES.VIDEO] },
  { id: 'wan2.2-s2v-flash', caps: [CAPABILITIES.VIDEO] },
  { id: 'qwen-vl-plus', caps: [CAPABILITIES.VISION] },
  // VERIFY 2026-09-03 实证：locate grounding 零偏差（qwen-vl-plus 仅 25x25 框选）
  { id: 'qwen3-vl-235b-a22b-thinking', caps: [CAPABILITIES.VISION] },
  { id: 'qwen-tts-latest', caps: [CAPABILITIES.TTS] },
  { id: 'qwen-audio-3.0-asr-flash-filetrans', caps: [CAPABILITIES.TRANSCRIBE] }
];

/** 按模型名规则推断能力 */
export function capabilitiesOfModel(modelName) {
  const name = String(modelName || '');
  for (const [re, caps] of MODEL_CAP_RULES) {
    if (re.test(name)) return [...caps];
  }
  return [];
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
  if (Array.isArray(p.models) && p.models.length) {
    for (const m of p.models) {
      const id = typeof m === 'string' ? m : m && m.id;
      // 显式空数组也是权威覆盖：用户可明确标记“此模型无能力”。
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
  if (out.length) return out;
  // ③ 裸 DashScope 账号 → 已知模型池
  if (/dashscope/i.test(String(p.baseUrl || ''))) {
    for (const m of DASHSCOPE_KNOWN) push(m.id, m.caps);
  }
  return out;
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
