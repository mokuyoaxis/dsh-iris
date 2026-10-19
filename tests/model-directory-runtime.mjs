import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';
import { FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';
import { modelUnavailable } from '../lib/model-directory.js';
import { runVisionRequest, probeVisionModel } from '../lib/vision-model-routing.js';
import { RED_TEST_IMAGE } from '../lib/vision.js';

useTempDshHome('iris-model-directory-runtime');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { inspectProviderTaskForDsh, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const old = 'qwen3-tts-flash-2025-11-27', current = 'qwen3-tts-flash';
const provider = config.upsert({ id: 'runtime-directory', auth: 'none', enabled: true,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
  models: [old, current].map(id => ({ id, capabilities: ['tts'] })) });
config.setFunctionPolicy('tts', 'auto');
const originalFetch = globalThis.fetch;
const calls = [];
let oldAvailable = false, uncertain = false;
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if ((options?.method || 'GET') === 'GET') {
    assert.equal(url.pathname, '/api/v1/models'); calls.push('directory');
    return Response.json({ output: { total: 1, models: [{ id: current, capabilities: ['TTS'] }] } });
  }
  const model = JSON.parse(options.body).model; calls.push(model);
  if (uncertain) throw new Error('connection lost after write fixture');
  if (model === old && !oldAvailable) return Response.json({ code: 'NotFound.Model', message: 'Model not exist.' }, { status: 404 });
  return Response.json({ output: { audio: { data: FAKE_WAV.toString('base64') } } });
};
try {
  const first = await runAction({}, 'tts', { text: '自动候选夹具' });
  assert.deepEqual(calls, ['directory', old, current]);
  const task = await inspectProviderTaskForDsh(first.taskId);
  assert.equal(task.outcome, 'succeeded'); assert.equal(task.attempts.length, 2);
  assert(modelUnavailable(provider, old, 'tts'));
  calls.length = 0;
  await runAction({}, 'tts', { text: '后续请求跳过已确认不存在项' });
  assert.deepEqual(calls, ['directory', current], '已确认404触发下一次目录核对，之后只提交合格模型');
  calls.length = 0;
  await runAction({}, 'tts', { text: '有效缓存不重复发现' });
  assert.deepEqual(calls, [current]);
  calls.length = 0;
  config.setAssignmentOrder('tts', [provider.id + '::' + old, provider.id + '::' + current]);
  await runAction({}, 'tts', { text: '手选名单保留' });
  assert.deepEqual(calls, [current], '手选不刷新目录，已阻断项不再消耗请求');
  assert.deepEqual(config.assignmentOrder('tts'), [provider.id + '::' + old, provider.id + '::' + current]);
  calls.length = 0;
  await assert.rejects(runAction({}, 'tts', { text: '单目标', model: provider.id + '::' + old }), /模型不存在/);
  assert.deepEqual(calls, []);
  oldAvailable = true;
  const restored = await runAction({}, 'providers_test_model', { id: provider.id, model_id: old, capability: 'tts', confirm_paid: true });
  assert.equal(restored.passed, true); assert.deepEqual(calls, [old]);
  assert.equal(modelUnavailable(provider, old, 'tts'), null);
  calls.length = 0;
  config.setFunctionPolicy('tts', 'disabled');
  await assert.rejects(runAction({}, 'tts', { text: '停用' }));
  assert.deepEqual(calls, [], '停用不发现、不生成');
  config.setFunctionPolicy('tts', 'auto');
  uncertain = true;
  await assert.rejects(runAction({}, 'tts', { text: '受理未知' }), /受理状态未知|受理结果未知/);
  assert.deepEqual(calls, [old], '有效缓存保留；新请求受理未知时停止，不能因其他候选存在而再次生成');
  const vision = config.upsert({ id: 'vision-directory', auth: 'none', enabled: true,
    baseUrl: 'https://vision.fixture.invalid/v1', mediaProtocol: 'openai-images',
    models: [{ id: 'missing-vision', capabilities: ['vision'] }, { id: 'working-vision', capabilities: ['vision'] }] });
  config.setFunctionPolicy('vision', 'auto');
  const image = { bytes: Buffer.from(RED_TEST_IMAGE.split(',')[1], 'base64'), mediaType: 'image/png' };
  let recovered = false;
  globalThis.fetch = async (_input, options) => {
    const model = JSON.parse(options.body).model; calls.push(model);
    if (model === 'missing-vision' && !recovered) return Response.json({ error: { code: 'model_not_found', message: 'private fixture detail' } }, { status: 404 });
    return new Response('data: {"choices":[{"delta":{"content":"红色"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const ask = () => runVisionRequest({}, { providers: config.pickAllFor('vision'), image, question: '颜色', onModelAvailability: config.recordAvailability });
  calls.length = 0;
  await assert.rejects(ask(), /模型能力不可用/);
  assert.deepEqual(calls, ['missing-vision'], '视觉保留现有本次操作停止规则，不扩张付费候选切换条件');
  assert(modelUnavailable(vision, 'missing-vision', 'vision'));
  calls.length = 0; await ask(); assert.deepEqual(calls, ['working-vision'], '视觉端口404同样持久隔离');
  recovered = true;
  const probe = await probeVisionModel(vision, 'missing-vision', image, { onModelAvailability: config.recordAvailability });
  assert.equal(probe.ok, true); assert.equal(modelUnavailable(vision, 'missing-vision', 'vision'), null);
  const music = config.upsert({ id: 'music-directory', auth: 'none', enabled: true,
    baseUrl: 'https://music.fixture.invalid/v1', mediaProtocol: 'openai-images',
    models: [{ id: 'missing-music', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' }] });
  config.setFunctionPolicy('music-gen', 'manual'); config.setAssignmentOrder('music-gen', [music.id + '::missing-music']);
  globalThis.fetch = async () => { calls.push('missing-music'); return Response.json({ error: { code: 'model_not_found', message: 'Model not exist.' } }, { status: 404 }); };
  calls.length = 0;
  await assert.rejects(runAction({}, 'music', { prompt: 'music fixture' }));
  assert(modelUnavailable(music, 'missing-music', 'music-gen'), 'Music按模型实际协议而非账号图片默认协议绑定');
  assert.deepEqual(calls, ['missing-music']);
  await assert.rejects(runAction({}, 'music', { prompt: 'blocked fixture' }));
  assert.deepEqual(calls, ['missing-music'], 'Music后续请求同样跳过404');
} finally { globalThis.fetch = originalFetch; stopProviderTaskWatchesForDsh(); }
console.log('PASS 实际Action/Core：自动目录、404一次切换、后续隔离、缓存、手选/停用、恢复实测与受理未知');
