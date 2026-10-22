/** 功能池只接纳明确能力；DSH/CLI 共用规则，全部网络由本地夹具替代。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { providerModels, modelPool, orderedModels, modelRef, capabilitiesOfDiscoveredModel } from '../lib/models.js';
import { imageCandidatesFromCatalog } from '../lib/provider-catalog.js';
import { executeConfigCommand } from '../lib/provider-config-service.js';

const { root } = useTempDshHome('iris-explicit-capabilities');
const config = await import('../lib/config.js');
const { runAction } = await import('./fixtures/dsh-runtime-fixture.mjs');
const bare = config.upsert({ name: 'bare', apiKey: 'fixture', enabled: true,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope' });
assert.equal(bare.models, undefined, '保存裸账号不物化默认模型');
assert.deepEqual(config.capabilitiesOf(bare), []);
assert.deepEqual(config.pickAllFor('image-gen'), []);
const store = path.join(config.irisHome(), 'providers.json');
const storedBefore = fs.readFileSync(store);
config.resetCache();
assert.equal(config.providerById(bare.id).models, undefined, '加载裸账号不物化默认模型');
assert.deepEqual(fs.readFileSync(store), storedBefore, '能力读取不改写配置');

const legacy = { id: 'legacy', imageModel: 'shared', visionModel: 'shared' };
assert.deepEqual(providerModels(legacy)[0].capabilities, ['image-gen', 'vision']);
assert.deepEqual(providerModels({ ...legacy, models: [] }), [], '空模型池权威');
assert.deepEqual(providerModels({ ...legacy, models: [{ id: 'shared', capabilities: [] }] })[0].capabilities, [], '明确空标签权威');
assert.deepEqual(providerModels({ ...legacy, models: ['shared'] })[0].capabilities, ['image-gen', 'vision'], '旧字段仍是明确功能绑定');
for (const name of ['qwen-vl-plus', 'wan2.2-t2i-flash', 'gemini-music', 'gemini-video']) {
  assert.deepEqual(providerModels({ id: 'names', models: [name] })[0].capabilities, []);
  assert.deepEqual(capabilitiesOfDiscoveredModel({ id: name }), []);
  assert.deepEqual(capabilitiesOfDiscoveredModel({ id: name, capabilities: [] }), []);
  assert.deepEqual(capabilitiesOfDiscoveredModel({ id: name, capabilities: ['MUSIC'] }), ['music-gen']);
}

const managed = config.upsert({ name: 'managed', enabled: true, auth: 'none',
  baseUrl: 'https://fixture.example/v1', mediaProtocol: 'openai-images',
  models: [{ id: 'manual', capabilities: ['image-gen'], source: 'manual',
    verified: { 'image-gen': { ok: true, at: '2026-10-09T00:00:00Z' } } },
    { id: 'configured-empty', capabilities: [] }, { id: 'configured-vision', capabilities: ['vision'] },
    { id: ' padded-vision ', capabilities: ['vision'] }, 'trusted'] });
const originalFetch = global.fetch;
const calls = [];
const directory = [
  { id: 'qwen-vl-plus' }, { id: 'gemini-music' }, { id: 'gemini-video' },
  { id: 'trusted', capabilities: ['IG', 'VU'] }, { id: 'manual', capabilities: ['VU'] },
  { id: 'configured-empty', capabilities: ['IG'] }, { id: 'configured-vision', capabilities: ['IG'] },
  { id: 'padded-vision', capabilities: ['IG'] },
  { id: 'explicit-empty', capabilities: [], inference_metadata: { response_modality: ['image'] } },
  { id: 'future-music', capabilities: ['MUSIC'], inference_metadata: { request_modality: ['text'], response_modality: ['audio'] } }
];
global.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method || 'GET' });
  assert(String(url).endsWith('/models'), '发现不能提交生成或实测');
  return new Response(JSON.stringify({ data: directory }), { headers: { 'Content-Type': 'application/json' } });
};
try {
  await runAction({}, 'providers_add_model', { id: managed.id, model_id: 'wan2.2-t2i-flash' });
  await runAction({}, 'providers_add_model', { id: managed.id, model_id: 'explicit-empty', capabilities: [] });
  await runAction({}, 'providers_add_model', { id: managed.id, model_id: 'manual-unlabelled' });
  assert.equal(calls.length, 0);
  const found = await runAction({}, 'providers_discover', { id: managed.id });
  assert.equal(found.media, 6, '元数据声明计数，名称不算能力');
  for (const name of ['qwen-vl-plus', 'gemini-music', 'gemini-video', 'wan2.2-t2i-flash']) {
    assert.deepEqual(providerModels(config.providerById(managed.id)).find(model => model.id === name).capabilities, []);
  }
  const manual = config.providerById(managed.id).models.find(model => model.id === 'manual');
  assert.deepEqual(manual.capabilities, ['image-gen']);
  assert.equal(manual.verified['image-gen'].ok, true, '发现保留手工能力与实测证据');
  assert.deepEqual(providerModels(config.providerById(managed.id)).find(model => model.id === 'trusted').capabilities, ['image-gen', 'vision']);
  assert.deepEqual(providerModels(config.providerById(managed.id)).find(model => model.id === 'configured-empty').capabilities, [], '无 source 标记的明确空标签也优先');
  assert.deepEqual(providerModels(config.providerById(managed.id)).find(model => model.id === 'configured-vision').capabilities, ['vision'], '无 source 标记的明确标签优先');
  assert.deepEqual(providerModels(config.providerById(managed.id)).find(model => model.id === 'padded-vision').capabilities, ['vision'], '模型 ID 去空格后仍识别已有明确标签');
  assert.deepEqual(providerModels(config.providerById(managed.id)).find(model => model.id === 'explicit-empty').capabilities, []);
  assert.deepEqual(providerModels(config.providerById(managed.id)).find(model => model.id === 'future-music').capabilities, ['music-gen'], '明确 Music 元数据独立映射，不泛化成 TTS');
  await assert.rejects(runAction({}, 'image', { prompt: 'fixture', model: 'gemini-music' }), /模型|供应商/);
  assert.equal(calls.length, 1, '未标注模型在提交前拒绝，零额外 HTTP');
  directory.push({ id: 'manual-unlabelled', capabilities: ['TTS'] });
  await runAction({}, 'providers_discover', { id: managed.id });
  assert.deepEqual(providerModels(config.providerById(managed.id)).find(model => model.id === 'manual-unlabelled').capabilities, ['tts'], '未标注手动名称经历一次缺席后仍能接受可信元数据');

  const file = path.join(root, 'cli-providers.json');
  fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'cli', enabled: true, auth: 'none',
    baseUrl: 'https://fixture.example/v1', mediaProtocol: 'openai-images',
    models: [{ id: 'configured-empty', capabilities: [] }, { id: 'configured-vision', capabilities: ['vision'] }] }], assignments: {} }), { mode: 0o600 });
  await executeConfigCommand(file, 'models.add', { model_ref: 'cli::wan2.2-t2i-flash' });
  await executeConfigCommand(file, 'models.add', { model_ref: 'cli::manual-unlabelled' });
  const previewBefore = fs.readFileSync(file);
  const preview = await executeConfigCommand(file, 'models.discover', { provider_id: 'cli' });
  assert.deepEqual(fs.readFileSync(file), previewBefore, '发现预览不落盘');
  assert.deepEqual(preview.models.find(model => model.id === 'gemini-music').capabilities, []);
  await executeConfigCommand(file, 'models.discover', { provider_id: 'cli', apply: true });
  const catalog = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(providerModels(catalog.providers[0]).find(model => model.id === 'configured-empty').capabilities, []);
  assert.deepEqual(providerModels(catalog.providers[0]).find(model => model.id === 'configured-vision').capabilities, ['vision']);
  for (const name of ['wan2.2-t2i-flash', 'qwen-vl-plus', 'gemini-music', 'gemini-video']) {
    assert.deepEqual(providerModels(catalog.providers[0]).find(model => model.id === name).capabilities, []);
  }
  assert.throws(() => imageCandidatesFromCatalog(catalog, 'gemini-music'), error => error.code === 'IRIS_PROVIDER_MODEL_UNAVAILABLE');
  assert.deepEqual(providerModels(catalog.providers[0]).find(model => model.id === 'manual-unlabelled').capabilities, ['tts'], 'CLI 未标注手动名称接受可信元数据');
  assert.equal(calls.length, 4, 'DSH 两次发现、CLI 预览与应用各一次，仅四次夹具 GET');

  const pool = modelPool([{ id: 'a', models: [{ id: 'shared', capabilities: ['image-gen', 'vision'] },
    { id: 'speech', capabilities: ['tts'] }, 'gemini-music'] },
    { id: 'b', models: [{ id: 'image', capabilities: ['image-gen'] }] }]);
  const order = [modelRef('b', 'image'), modelRef('a', 'shared')];
  for (let run = 0; run < 2; run++) {
    assert.deepEqual(orderedModels(pool, 'image-gen', order).map(model => model.ref), order, '功能池保留固定分配顺序，不新增轮转');
    assert.deepEqual(orderedModels(pool, 'vision').map(model => model.ref), [], '能力标签不自动授权功能调用');
    assert.deepEqual(orderedModels(pool, 'tts').map(model => model.ref), [], '空分配不自动补齐');
  }
} finally { global.fetch = originalFetch; }
console.log('PASS 明确功能能力：裸账号零赋能、旧绑定兼容、DSH/CLI 未标注目录、可信元数据、手工优先、固定功能池与零生成');
