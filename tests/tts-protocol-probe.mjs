/** TTS 协议与实测回归：只用内存响应，不访问真实供应商。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { supportsModelCapability } from '../lib/provider-protocol.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';
import { ttsCandidatesFromCatalog } from '../lib/provider-catalog.js';

useTempDshHome('iris-tts-protocol-probe');
const config = await import('../lib/config.js');
const { runAction } = await import('./fixtures/dsh-runtime-fixture.mjs');
const unsupported = [
  'qwen3-tts-flash-realtime', 'qwen3-tts-flash-realtime-2025-11-27',
  'qwen3-tts-instruct-flash-realtime-2026-01-22', 'qwen3-tts-vc-realtime-2025-11-27',
  'qwen3.8-omni-flash-realtime', 'qwen-audio-3.1-realtime-plus',
  'qwen-audio-3.1-tts-flash', 'cosyvoice-v3-plus', 'sambert-zhichu-v1', 'MiniMax/speech-2.8-hd'
];
const customVoices = ['qwen3-tts-vc-2026-01-22', 'qwen3-tts-vd-2026-01-26'];
const ordinary = ['qwen3-tts-flash', 'qwen3-tts-flash-2025-11-27', 'qwen3-tts-instruct-flash', 'qwen-tts-latest'];
const provider = config.upsert({ name: 'tts protocol fixture', enabled: true,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
  apiKey: 'fixture-secret', models: [...ordinary, ...unsupported, ...customVoices].map(id => ({ id, capabilities: ['tts'] })) });
config.setFunctionPolicy('tts', 'auto');
config.setModelVerified(provider.id, unsupported[0], 'tts', { ok: true, note: 'historical fixture evidence' });
const ref = id => provider.id + '::' + id;
const catalog = () => ({ providers: config.allProviders(), assignments: config.assignments() });
const saved = () => fs.readFileSync(path.join(config.irisHome(), 'providers.json'));
const adapter = createConfiguredProviderAdapter(config.providerById(provider.id));
const calls = [];
const originalFetch = globalThis.fetch;
let reply = 'success';
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  calls.push({ url: String(url), body });
  assert.equal(String(url), 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer fixture-secret');
  if (reply === 'missing') return Response.json({ code: 'NotFound.Model', message: 'Model not exist.' }, { status: 404 });
  if (reply === 'auth') return Response.json({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, { status: 401 });
  if (reply === 'voice') return Response.json({ code: 'InvalidParameter', message: 'Unsupported voice.' }, { status: 400 });
  return Response.json({ output: { audio: { url: 'https://fixture.invalid/tts.wav' } } });
};
try {
  const before = saved();
  const preview = await runAction({}, 'assignments_get');
  const expected = [...ordinary, ...customVoices].map(ref);
  assert.deepEqual(preview.order.tts, expected, '自动池只排除已知协议缺口，不删除配置');
  assert.deepEqual(ttsCandidatesFromCatalog(catalog()).map(item => item.modelRef), expected);
  assert.deepEqual(saved(), before, '只读预览不改写个人模型配置或证据');
  for (const id of unsupported) {
    assert.equal(supportsModelCapability(provider, id, 'tts'), false);
    const option = preview.poolByCapability.tts.find(item => item.id === id);
    assert.equal(option.protocolSupported, false);
    assert.equal(option.unavailable, true);
    assert.match(option.reason, /尚未接入/);
    const probe = await runAction({}, 'providers_test_model', { id: provider.id, model_id: id, capability: 'tts', confirm_paid: true });
    assert.equal(probe.skipped, true);
    assert.match(probe.text, /已跳过.*尚未接入/);
    const submitted = await invokeProviderOperation(adapter, 'submit', { capability: 'tts', model: id, input: { text: '你好' } });
    assert.equal(submitted.kind, 'not_accepted', '手选或直接提交也必须在发送前拒绝');
    assert.equal(submitted.error.stage, 'validate');
    assert.equal(submitted.error.acceptance, 'not_accepted');
    assert.equal(submitted.error.category, 'invalid_request');
  }
  for (const id of customVoices) {
    const probe = await runAction({}, 'providers_test_model', { id: provider.id, model_id: id, capability: 'tts', confirm_paid: true });
    assert.equal(probe.skipped, true, '空音色探针不能用 Cherry 代替自建音色');
    assert.match(probe.text, /填写.*音色 ID/);
    const missingVoice = await invokeProviderOperation(adapter, 'submit', { capability: 'tts', model: id, input: { text: '你好' } });
    assert.equal(missingVoice.kind, 'not_accepted');
    assert.equal(missingVoice.error.stage, 'validate');
  }
  assert.equal(calls.length, 0, '协议不匹配和缺少自建音色都不得访问供应商');
  assert.deepEqual(saved(), before, '本地跳过不能写成供应商实测失败或抹掉历史成功');
  assert.equal(supportsModelCapability(provider, 'my-explicit-http-tts', 'tts'), true, '未知自定义模型不按名称封禁');
  for (const id of ordinary) {
    const count = calls.length;
    const result = await runAction({}, 'providers_test_model', { id: provider.id, model_id: id, capability: 'tts', confirm_paid: true });
    assert.equal(result.passed, true);
    assert.equal(calls.length, count + 1, '逐模型检测只调用指定模型一次');
    assert.deepEqual(calls.at(-1).body, { model: id, input: { text: '你好', voice: 'Cherry' } });
  }
  const custom = await invokeProviderOperation(adapter, 'submit', {
    capability: 'tts', model: customVoices[0], input: { text: '自定义音色', voice: 'registered-fixture-voice' }
  });
  assert.equal(custom.kind, 'completed');
  assert.equal(calls.at(-1).body.input.voice, 'registered-fixture-voice');
  reply = 'missing';
  const start = calls.length;
  const failed = await runAction({}, 'providers_test_model', {
    id: provider.id, model_id: ordinary[1], capability: 'tts', confirm_paid: true
  });
  assert.equal(failed.passed, false);
  assert.equal(calls.length, start + 1, '404 不得在实测中自动换模型或地域重试');
  assert.match(failed.text, /当前语音接口找不到模型 qwen3-tts-flash-2025-11-27/);
  assert.match(failed.text, /dashscope\.aliyuncs\.com.*所属地域及调用协议.*Model not exist\./);
  const observation = config.providerById(provider.id).health.observations.find(item => item.modelId === ordinary[1] && item.capability === 'tts');
  assert.equal(observation.lastTransient.httpStatus, 404);
  assert.equal(observation.lastTransient.category, 'invalid_request');
  assert.equal(config.modelHealth(provider.id, ordinary[1], 'tts').modelUnavailable, true,
    '明确模型不存在影响当前可选性');
  assert(observation.lastSuccess, '当前不可选仍保留原成功证据');
  assert(!failed.text.includes('fixture-secret'));
  for (const kind of ['auth', 'voice']) {
    reply = kind;
    const result = await invokeProviderOperation(adapter, 'submit', { capability: 'tts', model: ordinary[0], input: { text: '你好' } });
    assert.equal(result.kind, 'not_accepted');
    assert.equal(result.error.httpStatus, kind === 'auth' ? 401 : 400);
    assert.equal(result.error.category, kind === 'auth' ? 'authentication' : 'invalid_request');
    assert(!result.error.safeMessage.includes('找不到模型'), '认证和音色错误不能伪装成模型不存在');
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log('PASS TTS 协议门、零请求跳过、历史证据保留、模型/音色透传、404 指引和单目标无重试');
