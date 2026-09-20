/**
 * E2 阶段 TTS 迁移 —— DSH Host 端到端：Agent 工具/GUI 动作 → Core 同步交付 →
 * 同源音频 → 工作台快照。运行：node tests/dsh-tts-core.mjs
 *
 * 关键断言：零 legacy 双写、同步一次调用完成交付、Agent 文本含同源音频链接、
 * 快照五类投影四门全关、终态任务四个人工 API 全部 409。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';
import { FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';

const { root, cleanup } = useTempDshHome('iris-dsh-tts-core');
const config = await import('../lib/config.js');
const tasks = await import('../lib/tasks.js');
const { apply } = await import('../lib/index.js');
const { runAction } = await import('../lib/actions.js');
const { inspectProviderTaskForDsh, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const { serveApi } = await import('../lib/api.js');

const registered = [];
const disposers = [];
const services = {
  tools: { register(definition) { registered.push(definition); return () => {}; } },
  skills: { register() { return () => {}; } },
  webServer: { register() { return () => {}; } },
  attachments: {
    async saveImage() { return { attachmentId: 'unused', mediaType: 'image/png' }; },
    async readImage() { throw new Error('not needed'); }
  }
};
const ctx = {
  tools: services.tools, skills: services.skills,
  get(name) { return services[name]; },
  inject(names, callback) { if (names.every((name) => services[name])) callback(this); },
  effect(callback) {
    const dispose = callback();
    if (typeof dispose === 'function') disposers.push(dispose);
    return () => {};
  }
};

const provider = config.upsert({
  name: 'tts fixture', enabled: true, apiKey: 'fixture-tts-secret',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope',
  models: [{ id: 'qwen-tts-latest', capabilities: ['tts'] }]
});
config.setAssignmentOrder('tts', [provider.id + '::qwen-tts-latest']);

const originalFetch = global.fetch;
const calls = { tts: 0 };
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith('/services/aigc/multimodal-generation/generation')) {
    calls.tts += 1;
    const body = JSON.parse(String(init.body || '{}'));
    assert.equal(body.model, 'qwen-tts-latest');
    assert.equal(body.input.voice, 'Cherry');
    assert(new Headers(init.headers).get('authorization'), 'tts submit must carry provider authorization');
    return new Response(JSON.stringify({ output: { audio: { data: FAKE_WAV.toString('base64') } } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  throw new Error('Unexpected fixture request: ' + url);
};

function apiResponse() {
  return {
    headersSent: false, destroyed: false, writableEnded: false, status: 0, headers: {}, body: undefined,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body; this.writableEnded = true; }
  };
}

async function postCoreAction(action, taskId) {
  const res = apiResponse();
  serveApi({ method: 'POST', url: '/iris/api/core/task/' + taskId + '/' + action, on() { return this; } }, res);
  for (let i = 0; i < 200 && !res.writableEnded; i++) await new Promise((resolve) => setImmediate(resolve));
  return res;
}

try {
  await apply(ctx);
  const legacyBefore = tasks.all().length;

  /* Agent 工具：同步合成即完成，文本含同源音频链接 */
  const speakTool = registered.find((tool) => tool.name === 'iris_speak_text');
  const rendered = await speakTool.execute({
    text: 'fixture tts iris', voice: 'Cherry', model: provider.id + '::qwen-tts-latest'
  }, {});
  assert.equal(calls.tts, 1, 'Agent TTS 必须只合成一次');
  assert.match(rendered, /Core task: task_[a-f0-9]{24}/);
  assert.match(rendered, /\[♪ 音频播放\]\(\/iris\/api\/core\/artifact\/artifact_[a-f0-9]{24}\/media\)/,
    '完成文本必须给出同源音频链接');
  const taskId = rendered.match(/task_[a-f0-9]{24}/)[0];
  const finished = await inspectProviderTaskForDsh(taskId);
  assert.equal(finished.capability, 'tts');
  assert.equal(finished.outcome, 'succeeded');
  assert.equal(finished.deliveryState, 'ready');
  assert.equal(finished.phase, 'terminal');
  assert.equal(finished.attempts.length, 1);
  assert.equal(finished.attempts[0].selectionReason, 'explicit');
  assert.match(finished.providerBinding, /^sha256:[a-f0-9]{64}$/);
  assert.equal(tasks.all().length, legacyBefore, 'Core TTS 零 legacy 双写');
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'outputs')), false, 'Core TTS 不得创建 legacy outputs');

  /* 同源媒体路由返回音频字节 */
  const artifactId = finished.artifactIds[0];
  const mediaRes = apiResponse();
  await serveApi({ method: 'GET', url: '/iris/api/core/artifact/' + artifactId + '/media' }, mediaRes);
  assert.equal(mediaRes.status, 200);
  assert.equal(mediaRes.headers['Content-Type'], 'audio/mpeg');
  assert.deepEqual(Buffer.from(mediaRes.body), FAKE_WAV, '同源路由必须返回音频字节');

  /* 工作台快照：tts 行进入五类投影，四门全关 */
  const snapshotRes = apiResponse();
  await serveApi({ method: 'GET', url: '/iris/api/core/snapshot?limit=20' }, snapshotRes);
  const snapshot = JSON.parse(String(snapshotRes.body));
  const row = snapshot.userTasks.find((item) => item.id === taskId);
  assert.equal(row.capability, 'tts');
  assert.equal(row.userState, 'succeeded');
  assert.equal(row.mediaReady, true);
  assert.equal(row.observable + row.cancelable + row.redeliverable + row.retryable, 0,
    '同步完成任务的四个动作门必须全部关闭', row);

  /* 终态 TTS 的四个人工 API 全部 409 且零调用 */
  for (const action of ['reobserve', 'redeliver', 'cancel']) {
    const res = await postCoreAction(action, taskId);
    assert.equal(res.status, 409, action + ' 对终态 TTS 必须 409');
  }
  assert.equal(calls.tts, 1, '人工动作拒绝不得产生 Provider 调用');

  /* GUI 动作同一入口 */
  const submitted = await runAction({}, 'tts', { text: 'gui tts', voice: 'Cherry' });
  assert.equal(submitted.storage, 'core');
  assert.equal(calls.tts, 2);
  assert.equal(tasks.all().length, legacyBefore, 'GUI TTS 仍零 legacy 双写');

  console.log('ALL OK —— DSH TTS → Core：同步交付、同源音频、零 legacy 双写、终态四门锁定');
} finally {
  stopProviderTaskWatchesForDsh();
  tasks.stopWatchAll();
  for (const dispose of disposers.reverse()) {
    try { dispose(); } catch {}
  }
  global.fetch = originalFetch;
  cleanup();
}
