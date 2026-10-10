/**
 * dsh-iris 模型发现规则测试（阶段 6）。
 * 运行：node tests/models.mjs
 * 覆盖：
 *   ① capabilitiesOfModel：非权威名称建议，不参与功能池选型
 *   ② providerModels：明确标签、旧功能绑定、裸账号无默认模型、空池
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

/* ---------- ①b 真实命名族（P2 扩规则，来自 GET /models 实测样本）---------- */
assert(models.capabilitiesOfModel('wan2.7-image').includes(CAPABILITIES.IMAGE), 'wan2.7-image → image');
assert(models.capabilitiesOfModel('wan2.7-image-pro').includes(CAPABILITIES.IMAGE), 'wan2.7-image-pro → image');
assert(models.capabilitiesOfModel('wan2.2-t2i-flash').includes(CAPABILITIES.IMAGE), 'wan2.2-t2i → image（旧命名仍覆盖）');
assert(models.capabilitiesOfModel('wan2.5-i2v-preview').includes(CAPABILITIES.VIDEO), 'wan2.5-i2v → video');
assert(models.capabilitiesOfModel('wan2.2-t2v-flash').includes(CAPABILITIES.VIDEO), 'wan2.2-t2v → video');
assert(!models.capabilitiesOfModel('wan2.7-image').includes(CAPABILITIES.VIDEO), 'wan2.7-image 不误标 video');
assert(models.capabilitiesOfModel('qwen-image-3.0-pro').includes(CAPABILITIES.IMAGE), 'qwen-image → image');
assert(!models.capabilitiesOfModel('qwen-image-edit-max').includes(CAPABILITIES.IMAGE), '纯 qwen-image-edit 不误标文生图');
assert(models.capabilitiesOfModel('z-image-turbo').includes(CAPABILITIES.IMAGE), 'z-image → image');
assert(models.capabilitiesOfModel('qwen3-tts-flash').includes(CAPABILITIES.TTS), 'qwen3-tts → tts');
assert(models.capabilitiesOfModel('qwen-tts-latest').includes(CAPABILITIES.TTS), 'qwen-tts → tts（旧命名）');
assert(models.capabilitiesOfModel('cosyvoice-v2').includes(CAPABILITIES.TTS), 'cosyvoice → tts');
assert(models.capabilitiesOfModel('qwen-vl-max').includes(CAPABILITIES.VISION), 'qwen-vl-max → vision');
assert(models.capabilitiesOfModel('qwen3-vl-235b-a22b-thinking').includes(CAPABILITIES.VISION), 'qwen3-vl → vision');
assert(models.capabilitiesOfModel('paraformer-v2').includes(CAPABILITIES.TRANSCRIBE), 'paraformer → transcribe');
assert(!models.capabilitiesOfModel('qwen-audio-turbo').includes(CAPABILITIES.TRANSCRIBE), 'qwen-audio-turbo 是理解模型，不误标文件转写');
assert(models.capabilitiesOfModel('qwen-audio-3.0-asr-flash-filetrans').includes(CAPABILITIES.TRANSCRIBE), 'Qwen-Audio Filetrans → transcribe');

/* ---------- ② providerModels ---------- */
// 显式 models 数组
const pExplicit = { id: 'p1', models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }, 'qwen-vl-plus'] };
const mExp = models.providerModels(pExplicit);
assert(mExp.length === 2, '显式 models 2 条', mExp.length);
assert(mExp[0].id === 'wan2.2-t2i-flash' && mExp[0].capabilities.includes('image-gen'), '显式模型带能力');
assert(mExp[1].id === 'qwen-vl-plus' && mExp[1].capabilities.length === 0, '无能力声明则保留未标注模型');
const explicitEmpty = models.providerModels({ id: 'p-empty', models: [{ id: 'qwen-vl-plus', capabilities: [] }] });
assert(explicitEmpty[0].capabilities.length === 0, '显式空能力数组覆盖名字推断');
assert(models.parseModelRef(models.modelRef('p::x', 'model/a')).providerId === 'p::x', '复合引用可逆编码 provider');

// 旧四字段迁移
const pOld = { id: 'p2', imageModel: 'wan2.2-t2i-flash', visionModel: 'qwen-vl-plus' };
const mOld = models.providerModels(pOld);
assert(mOld.length === 2, '旧字段迁移 2 条', mOld.length);
assert(mOld[0].id === 'wan2.2-t2i-flash' && mOld[0].capabilities.includes('image-gen'), '旧字段 image → image-gen');
assert(mOld[1].id === 'qwen-vl-plus' && mOld[1].capabilities.includes('vision'), '旧字段 vision → vision');

// B-5 回归：显式 models: [] 是权威声明，不得被裸账号迁移穿透
// （用户明确表示「此供应商没有可用模型」时，不得注入任何厂商默认池）
const pExplicitEmptyDash = {
  id: 'p-empty-dash',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  models: []
};
const mExplicitEmptyDash = models.providerModels(pExplicitEmptyDash);
assert(mExplicitEmptyDash.length === 0,
  '显式 models: [] 必须尊重用户声明，不得注入已知模型池', mExplicitEmptyDash.map((m) => m.id));
assert(models.modelPool([pExplicitEmptyDash]).length === 0,
  'models: [] 的供应商不得出现在全局模型池');

// 裸账号不注入厂商模型或能力。
const pNoModelsDash = { id: 'p-no-models-dash', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
assert(models.providerModels(pNoModelsDash).length === 0, '运行时不猜模型');
assert(!Object.hasOwn(pNoModelsDash, 'models'), '读取不物化模型池');

// 协议与域名都不构成明确模型声明
const pDash = { id: 'p3', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
const mDash = models.providerModels(pDash);
assert(mDash.length === 0, '裸 DashScope 没有隐含默认模型', mDash.length);
const shared = models.providerModels({ id: 'shared', imageModel: 'custom', visionModel: 'custom' });
assert(shared.length === 1 && shared[0].capabilities.join(',') === 'image-gen,vision', '同一旧模型可属于多个功能池');
assert(models.providerModels({ ...pOld, capabilities: [] }).length === 0, '账号明确空能力阻止旧绑定');

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

console.log('ALL OK —— 模型规则断言通过（名称建议/明确功能标签/旧绑定/裸账号无兜底/功能池挑选）');
