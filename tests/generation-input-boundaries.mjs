import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempDshHome } from './test-env.js';
import { FAKE_WAV, createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCommandService } from '../lib/command-service.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { listCoreTasks } from '../lib/core-tasks.js';

const { root } = useTempDshHome('iris-generation-input-boundaries');
const repo = fileURLToPath(new URL('../', import.meta.url));
const fixture = new URL('./fixtures/headless-async-fetch.mjs', import.meta.url).href;
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { dshCoreDataRoot, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const scenarios = [
  { capability: 'image', model: 'wanx2.1-t2i-turbo', input: { prompt: '  flower  ', n: '2', size: ' 1024*1024 ' } },
  { capability: 'video', model: 'wan2.6-i2v', input: { prompt: '  move  ', duration: '5', size: ' 640*480 ', img_data_url: 'data:image/png;base64,YWJj' } },
  { capability: 'tts', model: 'qwen3-tts-flash', input: { text: '  hello  ', voice: ' Cherry ' } },
  { capability: 'transcribe', model: 'qwen-audio-3.0-asr-flash-filetrans', input: { audio_url: ' https://fixture.invalid/audio.wav ' } }
];
const provider = config.upsert({
  name: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope', models: scenarios.map((item) => ({
    id: item.model, capabilities: [item.capability === 'image' ? 'image-gen' : item.capability === 'video' ? 'video-gen' : item.capability]
  }))
});
const configFile = path.join(root, 'cli-providers.json');
fs.writeFileSync(configFile, JSON.stringify({ providers: config.allProviders() }), { mode: 0o600 });
const stateFile = path.join(root, 'fixture-state.json');
const cliRoot = path.join(root, 'cli-data');
function cli(capability, input) {
  return spawnSync(process.execPath, ['--import', fixture, 'bin/dsh-iris.js', 'run', capability,
    '--data-root', cliRoot, '--provider-config', configFile, '--input', JSON.stringify(input)], {
    cwd: repo, encoding: 'utf8', shell: false,
    env: { ...process.env, IRIS_ASYNC_FIXTURE_STATE: stateFile }
  });
}
const state = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const requests = [];
const framePath = path.join(root, 'frame.png');
fs.writeFileSync(framePath, Buffer.from('abc'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  assert.equal(init.method, 'POST', '测试只允许显式提交，无后台轮询');
  const body = JSON.parse(init.body);
  requests.push(body);
  return body.input.text !== undefined
    ? Response.json({ output: { audio: { data: FAKE_WAV.toString('base64') } } })
    : Response.json({ output: { task_id: 'remote-' + requests.length } });
};

try {
  for (const scenario of scenarios) {
    const result = cli(scenario.capability, scenario.input);
    assert.equal(result.status, 0, result.stderr);
    const { img_data_url: frameData, ...dshInput } = scenario.input;
    await runAction({}, scenario.capability, { ...dshInput, ...(frameData ? { first_frame_path: framePath } : {}) });
    stopProviderTaskWatchesForDsh();
    const expected = state().lastRequest;
    assert.deepEqual(requests.at(-1), expected, scenario.capability + ' CLI/DSH 必须发送相同规范化请求');
    const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'writer' });
    runtime.start();
    try {
      const fake = createFakeLifecycleProvider({
        id: provider.id, capabilities: [scenario.capability],
        submitSteps: [{ kind: 'unknown', error: {
          stage: 'submit', category: 'network', acceptance: 'unknown', message: 'fixture'
        } }]
      });
      const old = await createProviderTaskRunner(runtime).submit({
        capability: scenario.capability,
        candidates: [{ adapter: fake.adapter, model: provider.id + '::' + scenario.model }]
      });
      const commands = createCommandService(runtime, {
        resolveTaskCandidates: async () => [{
          adapter: createConfiguredProviderAdapter(config.allProviders()[0]),
          model: provider.id + '::' + scenario.model
        }]
      });
      await commands.execute('task.retry', {
        task_id: old.taskId, provider_input: scenario.input, confirm_billing: true
      });
      assert.deepEqual(requests.at(-1), expected, scenario.capability + ' retry 与正常提交必须使用相同参数');
      const beforeCount = listCoreTasks(dshCoreDataRoot()).total;
      const beforeCalls = requests.length;
      for (const invalidInput of [
        { ...scenario.input, surprise: true },
        { ...scenario.input, model_ref: '' }
      ]) {
        await assert.rejects(commands.execute('task.retry', {
          task_id: old.taskId, provider_input: invalidInput, confirm_billing: true
        }), { code: 'IRIS_COMMAND_INPUT_INVALID' });
      }
      assert.equal(requests.length, beforeCalls, '非法 retry 必须零提交');
      assert.equal(listCoreTasks(dshCoreDataRoot()).total, beforeCount, '非法 retry 不得创建新 Task');
    } finally { await runtime.dispose(); }
  }
  for (const [capability, input, clearedField] of [
    ['image', { prompt: 'flower' }, 'size'],
    ['video', { prompt: 'move' }, 'size'],
    ['tts', { text: 'hello' }, 'voice']
  ]) {
    const result = cli(capability, input);
    assert.equal(result.status, 0, result.stderr);
    await runAction({}, capability, { ...input, [clearedField]: '' });
    stopProviderTaskWatchesForDsh();
    assert.deepEqual(requests.at(-1), state().lastRequest,
      '工作台清空可选字段后应沿用缺省值：' + clearedField);
  }
  for (const [capability, input] of [
    ['image', { prompt: '' }],
    ['video', { prompt: '' }],
    ['tts', { text: '' }],
    ['image', { prompt: 'flower', n: 0 }],
    ['image', { prompt: 'flower', n: 5 }],
    ['image', { prompt: 'x'.repeat(20001) }],
    ['video', { prompt: 'move', duration: 61 }],
    ['tts', { text: 'hello', voice: 'x'.repeat(65) }],
    ['transcribe', { audio_url: 'http://fixture.invalid/audio.wav' }]
  ]) {
    const before = JSON.stringify(state());
    const beforeCalls = requests.length;
    assert.equal(cli(capability, input).status, 2, 'CLI 非法输入应维持 usage 退出码');
    await assert.rejects(runAction({}, capability, input), { code: 'IRIS_GENERATION_INPUT_INVALID' });
    assert.equal(JSON.stringify(state()), before, 'CLI 非法输入不得调用 Provider');
    assert.equal(requests.length, beforeCalls, 'DSH 非法输入不得调用 Provider');
  }
  console.log('ALL OK —— 四类生成在 CLI/DSH/retry 的请求一致，非法参数零提交、零新 Task');
} finally {
  stopProviderTaskWatchesForDsh();
  globalThis.fetch = originalFetch;
}
