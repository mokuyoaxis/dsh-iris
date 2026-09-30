import assert from 'node:assert/strict';
import { createCommandService } from '../lib/command-service.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-retry-provider-input');
const runtime = createCoreRuntime({ dataRoot: root, mode: 'writer' });
runtime.start();
const adapter = createConfiguredProviderAdapter({
  id: 'retry-provider', apiKey: 'fixture-key', mediaProtocol: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
});
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  assert.equal(init.method, 'POST');
  requests.push(JSON.parse(init.body));
  return Response.json({ output: { task_id: 'remote-retry-' + requests.length } });
};

try {
  for (const scenario of [
    {
      capability: 'transcribe', model: 'qwen-audio-3.0-asr-flash-filetrans',
      input: { audio_url: 'https://fixture.invalid/retry.wav' },
      expected: { file_urls: ['https://fixture.invalid/retry.wav'] }
    },
    {
      capability: 'video', model: 'wan2.6-i2v',
      input: { prompt: 'move', img_data_url: 'data:image/png;base64,YWJj', duration: '5' },
      expected: { prompt: 'move', img_url: 'data:image/png;base64,YWJj' }
    }
  ]) {
    const fake = createFakeLifecycleProvider({
      id: adapter.id, capabilities: [scenario.capability],
      submitSteps: [{ kind: 'unknown', error: {
        stage: 'submit', category: 'network', acceptance: 'unknown', message: 'fixture'
      } }]
    });
    const before = await createProviderTaskRunner(runtime).submit({
      capability: scenario.capability,
      candidates: [{ adapter: fake.adapter, model: adapter.id + '::' + scenario.model }]
    });
    const count = requests.length;
    const retried = await createCommandService(runtime, {
      resolveTaskCandidates: async () => [{ adapter, model: adapter.id + '::' + scenario.model }]
    }).execute('task.retry', {
      task_id: before.taskId, provider_input: scenario.input, confirm_billing: true
    });
    assert.equal(requests.length, count + 1, '每次知情重试只能提交一次');
    assert.deepEqual(requests.at(-1).input, scenario.expected,
      scenario.capability + ' retry 必须保留调用方重新提供的媒体输入');
    assert.equal(retried.task.retriedFrom, before.taskId);
    if (scenario.capability === 'video') assert.equal(requests.at(-1).parameters.duration, 5);
  }
  console.log('ALL OK —— 真实协议适配器的转写/图生视频重试请求保留媒体输入，零外部请求');
} finally {
  globalThis.fetch = originalFetch;
  await runtime.dispose();
}
