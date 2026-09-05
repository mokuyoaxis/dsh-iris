import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-paid-probe');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');

const provider = config.upsert({
  name: 'fixture',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: 'fixture-secret',
  enabled: true,
  models: [
    { id: 'image-model', capabilities: ['image-gen'] },
    { id: 'video-model', capabilities: ['video-gen'] },
    { id: 'tts-model', capabilities: ['tts'] },
    { id: 'asr-model', capabilities: ['transcribe'] },
    { id: 'vision-model', capabilities: ['vision'] }
  ]
});

let fetchCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => { fetchCalls++; throw new Error('不应发出请求'); };
try {
  for (const [modelId, capability] of [['video-model', 'video-gen'], ['asr-model', 'transcribe']]) {
    const result = await runAction({}, 'providers_test_model', { id: provider.id, model_id: modelId, capability });
    assert.equal(result.skipped, true, `${capability} 空样本探针应跳过`);
  }
  for (const [modelId, capability] of [['image-model', 'image-gen'], ['tts-model', 'tts'], ['vision-model', 'vision']]) {
    await assert.rejects(
      runAction({}, 'providers_test_model', { id: provider.id, model_id: modelId, capability }),
      /明确确认/
    );
  }
  assert.equal(fetchCalls, 0, '跳过或未确认时不得访问供应商');
  assert.equal(config.allProviders()[0].models.some((model) => model.verified), false, '跳过项不写伪 verified 结果');
} finally {
  global.fetch = originalFetch;
}

console.log('ALL OK —— 付费探针需确认，视频/转写空样本跳过且零网络请求');
