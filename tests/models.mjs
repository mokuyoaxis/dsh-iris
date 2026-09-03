/**
 * dsh-iris 模型发现规则测试（阶段 6）。
 * 运行：node tests/models.mjs
 * 覆盖：
 *   ① capabilitiesOfModel：模型名 → 能力标签（wan/qwen-vl/qwen-tts/gpt/dall-e/gemini）
 *   ② providerModels：显式 models 数组、旧四字段迁移、裸 DashScope 兜底、空
 *   ③ modelPool / pickModel：全局池合并、按能力挑选、顺序
 * 纯函数，零网络、零 I/O。
 */
import * as models from '../lib/models.js';
import { CAPABILITIES } from '../lib/capability.js';

const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};

/* ---------- ① capabilitiesOfModel ---------- */
assert(models.capabilitiesOfModel('wan2.2-t2i-flash').includes(CAPABILITIES.IMAGE), 'wan2.2-t2i → image-gen');
assert(models.capabilitiesOfModel('wan2.2-t2v-flash').includes(CAPABILITIES.VIDEO), 'wan2.2-t2v → video-gen');
assert(!models.capabilitiesOfModel('wan2.2-t2v-flash').includes(CAPABILITIES.IMAGE), 'wan2.2-t2v 不含 image-gen');
assert(models.capabilitiesOfModel('qwen-vl-plus').includes(CAPABILITIES.VISION), 'qwen-vl-plus → vision');
assert(models.capabilitiesOfModel('qwen3-vl-235b-a22b-thinking').includes(CAPABILITIES.VISION), 'qwen3-vl → vision（VERIFY 实证强模型）');
assert(!models.capabilitiesOfModel('qwen3-vl-235b-a22b-thinking').includes(CAPABILITIES.TTS), 'qwen3-vl 不误标 tts');
assert(models.capabilitiesOfModel('qwen-tts-latest').includes(CAPABILITIES.TTS), 'qwen-tts → tts');
assert(models.capabilitiesOfModel('gpt-image-1').includes(CAPABILITIES.IMAGE), 'gpt-image-1 → image-gen');
assert(models.capabilitiesOfModel('dall-e-3').includes(CAPABILITIES.IMAGE), 'dall-e-3 → image-gen');
assert(models.capabilitiesOfModel('gemini-2.0-flash').includes(CAPABILITIES.VISION), 'gemini → vision');
assert(models.capabilitiesOfModel('unknown-model').length === 0, '未知模型 → 空');

/* ---------- ② providerModels ---------- */
// 显式 models 数组
const pExplicit = { id: 'p1', models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }, 'qwen-vl-plus'] };
const mExp = models.providerModels(pExplicit);
assert(mExp.length === 2, '显式 models 2 条', mExp.length);
assert(mExp[0].id === 'wan2.2-t2i-flash' && mExp[0].capabilities.includes('image-gen'), '显式模型带能力');
assert(mExp[1].id === 'qwen-vl-plus' && mExp[1].capabilities.includes('vision'), '无能力声明则按规则推断');

// 旧四字段迁移
const pOld = { id: 'p2', imageModel: 'wan2.2-t2i-flash', visionModel: 'qwen-vl-plus' };
const mOld = models.providerModels(pOld);
assert(mOld.length === 2, '旧字段迁移 2 条', mOld.length);
assert(mOld[0].id === 'wan2.2-t2i-flash' && mOld[0].capabilities.includes('image-gen'), '旧字段 image → image-gen');
assert(mOld[1].id === 'qwen-vl-plus' && mOld[1].capabilities.includes('vision'), '旧字段 vision → vision');

// 裸 DashScope 兜底
const pDash = { id: 'p3', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
const mDash = models.providerModels(pDash);
assert(mDash.length >= 3, '裸 DashScope 至少 3 个已知模型', mDash.length);
assert(mDash.some((m) => m.id === 'wan2.2-t2i-flash' && m.capabilities.includes('image-gen')), 'DashScope 含 wan t2i');
assert(mDash.some((m) => m.id === 'qwen-vl-plus' && m.capabilities.includes('vision')), 'DashScope 含 qwen-vl');
assert(mDash.some((m) => m.id === 'qwen3-vl-235b-a22b-thinking' && m.capabilities.includes('vision')), 'DashScope 池含 qwen3-vl 强视觉模型');

// 空（无字段、非 DashScope）
const pEmpty = { id: 'p4', baseUrl: 'https://other.com/v1' };
assert(models.providerModels(pEmpty).length === 0, '非 DashScope 无字段 → 空');

// 仅 mediaProtocol 不足（baseUrl 才是判定依据）
const pNoDash = { id: 'p5', baseUrl: 'https://other.com/v1', mediaProtocol: 'dashscope' };
assert(models.providerModels(pNoDash).length === 0, '仅 mediaProtocol 不足');

/* ---------- ③ modelPool / pickModel ---------- */
const pool = models.modelPool([
  { id: 'a', imageModel: 'wan2.2-t2i-flash', visionModel: 'qwen-vl-plus' },
  { id: 'b', imageModel: 'gpt-image-1' }
]);
assert(pool.length >= 3, '全局池合并', pool.length);

const img = models.pickModel(pool, CAPABILITIES.IMAGE);
assert(img && img.id === 'wan2.2-t2i-flash' && img.providerId === 'a', 'pickModel 返回第一个匹配模型', img && img.id);

const vis = models.pickModel(pool, CAPABILITIES.VISION);
assert(vis && vis.id === 'qwen-vl-plus' && vis.providerId === 'a', 'pickModel vision', vis && vis.id);

assert(models.pickModel(pool, 'nonexistent') === null, '无能力 → null');

console.log('ALL OK —— 模型发现规则 5 组断言全部通过（能力推断/显式models/旧字段迁移/裸DashScope/全局池挑选）');