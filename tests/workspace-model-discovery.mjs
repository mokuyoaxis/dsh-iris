import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';
import * as adapters from '../lib/adapters.js';
import * as modelRules from '../lib/models.js';
import { CAPABILITIES } from '../lib/capability.js';
import {
  dashscopeApiBase,
  inferMediaProtocol,
  isDashScopeBaseUrl,
  providerMediaBaseUrl
} from '../lib/provider-protocol.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';

useTempDshHome('iris-workspace-model-discovery');

const workspaceBase = 'https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
assert.equal(isDashScopeBaseUrl(workspaceBase), true, '百炼 Workspace HTTPS 域名应被识别');
assert.equal(isDashScopeBaseUrl('https://ws-123.cn-beijing.maas.aliyuncs.com.evil.example/v1'), false,
  '伪造后缀不能通过凭据边界');
assert.equal(isDashScopeBaseUrl('https://ws-123.unknown.maas.aliyuncs.com/v1'), false,
  '未验证地域不能通过凭据边界');
assert.equal(isDashScopeBaseUrl('https://cn-hongkong.dashscope.aliyuncs.com/api/v1'), true,
  '香港官方地域端点应被识别');
assert.equal(dashscopeApiBase(workspaceBase), 'https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1');
assert.equal(inferMediaProtocol(workspaceBase), 'dashscope');
assert.equal(providerMediaBaseUrl({ baseUrl: 'https://vision.invalid/v1', mediaBaseUrl: workspaceBase }), workspaceBase);
assert.equal(providerMediaBaseUrl({ baseUrl: 'https://vision.invalid/v1', mediaBaseUrl: '' }), 'https://vision.invalid/v1');

const officialModels = Array.from({ length: 101 }, (_, i) => ({
  model: i === 0 ? 'future-image-model' : (i === 1 ? 'future-video-model' : (i === 2 ? 'brand-new-audio' : 'text-' + i)),
  capabilities: i === 0 ? ['IG'] : (i === 1 ? ['VG'] : (i === 2 ? [] : ['TG'])),
  ...(i === 2 ? { inference_metadata: { request_modality: ['Text'], response_modality: ['Audio'] } } : {})
}));
const calls = [];
const originalFetch = global.fetch;
global.fetch = async (url) => {
  const parsed = new URL(url);
  calls.push(parsed);
  const page = Number(parsed.searchParams.get('page_no'));
  const start = (page - 1) * 100;
  return new Response(JSON.stringify({
    success: true,
    output: { total: officialModels.length, page_no: page, page_size: 100, models: officialModels.slice(start, start + 100) }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
let discovered;
try {
  discovered = await adapters.listModels({ key: 'fixture', baseUrl: workspaceBase });
} finally {
  global.fetch = originalFetch;
}
assert.equal(calls.length, 2, '官方模型目录应按 output.total 拉完分页');
assert(calls.every((url) => url.pathname === '/api/v1/models'
  && url.searchParams.get('page_size') === '100'), 'Workspace 发现必须调用 /api/v1/models');
assert.deepEqual(discovered[0], { id: 'future-image-model', capabilities: ['IG'] }, '官方能力元数据应保留');
assert.deepEqual(modelRules.capabilitiesOfDiscoveredModel(discovered[0]), [CAPABILITIES.IMAGE], 'IG 映射图片能力');
assert.deepEqual(modelRules.capabilitiesOfDiscoveredModel(discovered[1]), [CAPABILITIES.VIDEO], 'VG 映射视频能力');
assert.deepEqual(modelRules.capabilitiesOfDiscoveredModel(discovered[2]), [CAPABILITIES.TTS], '输入输出模态可为未知模型补能力');
assert.deepEqual(modelRules.capabilitiesOfDiscoveredModel({ id: 'future-asr', capabilities: ['ASR'] }), [CAPABILITIES.TRANSCRIBE]);
assert.deepEqual(modelRules.capabilitiesOfDiscoveredModel({ id: 'future-tts', capabilities: ['TTS'] }), [CAPABILITIES.TTS]);
assert.deepEqual(modelRules.capabilitiesOfDiscoveredModel({ id: 'future-vu', capabilities: ['VU'] }), [CAPABILITIES.VISION]);
assert.deepEqual(modelRules.capabilitiesOfDiscoveredModel({ id: 'qwen-image-3.0' }), [CAPABILITIES.IMAGE],
  '无元数据时仍按名称规则兜底');

const transportCalls = [];
const transport = {
  async listModels(input) { transportCalls.push(['discover', input]); return []; },
  dashscopeImageMode() { return 'multimodal-sync'; },
  async generateImageMultimodal(input) { transportCalls.push(['submit', input]); return ['https://result.invalid/image.png']; },
  async submitImage() { throw new Error('不应走异步'); },
  async submitVideo() { throw new Error('unused'); },
  async submitTranscription() { throw new Error('unused'); },
  async synthesizeTts() { throw new Error('unused'); },
  async pollTask() { throw new Error('unused'); },
  async pollTranscriptionTask() { throw new Error('unused'); },
  async downloadTo() { throw new Error('unused'); }
};
const splitProvider = {
  id: 'split-endpoint',
  apiKey: 'secret-fixture',
  baseUrl: 'https://vision.invalid/v1',
  mediaBaseUrl: workspaceBase,
  mediaProtocol: 'dashscope'
};
const adapter = createConfiguredProviderAdapter(splitProvider, { transport });
await invokeProviderOperation(adapter, 'discover', {});
const result = await invokeProviderOperation(adapter, 'submit', {
  capability: 'image', model: 'qwen-image-3.0', input: { prompt: 'fixture' }
});
assert.equal(result.kind, 'completed');
assert(transportCalls.every(([, input]) => input.baseUrl === workspaceBase),
  'Provider Adapter 的发现与媒体提交必须只使用 mediaBaseUrl');

const config = await import('../lib/config.js');
const stored = config.upsert({
  name: 'split', baseUrl: 'https://vision.invalid/v1', mediaBaseUrl: workspaceBase,
  apiKey: 'fixture', enabled: true, mediaProtocol: 'auto'
});
assert.equal(stored.mediaProtocol, 'dashscope', 'auto 应按媒体端点推断协议');
config.setProviderModels(stored.id, [{ id: 'future-image-model', capabilities: [CAPABILITIES.IMAGE] }]);
config.setModelCapabilities(stored.id, 'future-image-model', [CAPABILITIES.TTS]);
config.setProviderModels(stored.id, [{ id: 'future-image-model', capabilities: [CAPABILITIES.VIDEO] }]);
const retained = modelRules.providerModels(config.providerById(stored.id))[0];
assert.deepEqual(retained.capabilities, [CAPABILITIES.TTS], '重新发现不能覆盖用户手工能力标注');
assert.equal(retained.source, 'manual');

console.log('ALL OK —— Workspace 媒体端点、官方分页能力发现与手工覆盖通过');
