/**
 * E 阶段视频迁移 —— DSH Host 端到端：Agent 工具/GUI 动作 → Core Task → 有界观察 →
 * 同源媒体 → 工作台快照。运行：node tests/dsh-video-core.mjs
 *
 * 关键断言：零 legacy 双写（tasks.json 无新视频任务、outputs/ 无新文件）、
 * 视频走独立交付 Profile（video/mp4）、Host 节拍接管与崩溃恢复、binding 漂移
 * 零 poll、s2v 仍走 legacy、工作台快照五类投影合理。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';
import { FAKE_MP4 } from './fixtures/fake-lifecycle-provider.mjs';

const { root, cleanup } = useTempDshHome('iris-dsh-video-core');
const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { apply } = await import('../lib/index.js');
const { runAction } = await import('../lib/actions.js');
const {
  dshCoreDataRoot,
  inspectProviderTaskForDsh,
  resumeProviderTaskWatchesForDsh,
  stopProviderTaskWatchesForDsh
} = await import('../lib/dsh-core-adapter.js');
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
  name: 'video fixture', enabled: true, apiKey: 'fixture-video-secret',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope',
  models: [{ id: 'wan2.2-t2v-flash', capabilities: ['video-gen'] }]
});
config.setAssignmentOrder('video-gen', [provider.id + '::wan2.2-t2v-flash']);

const originalFetch = global.fetch;
const calls = { submit: 0, poll: 0, download: 0 };
const remotes = new Map();
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith('/services/aigc/video-generation/video-synthesis')) {
    calls.submit += 1;
    const body = JSON.parse(String(init.body || '{}'));
    assert.equal(body.model, 'wan2.2-t2v-flash');
    assert(new Headers(init.headers).get('authorization'), 'submit must carry provider authorization');
    const id = 'remote-' + calls.submit;
    remotes.set(id, 0);
    return new Response(JSON.stringify({ output: { task_id: id } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  const taskMatch = url.match(/\/api\/v1\/tasks\/(remote-[0-9]+)$/);
  if (taskMatch) {
    calls.poll += 1;
    const id = taskMatch[1];
    const count = (remotes.get(id) || 0) + 1;
    remotes.set(id, count);
    if (count < 3) {
      return new Response(JSON.stringify({ output: { task_status: 'RUNNING' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      output: { task_status: 'SUCCEEDED', results: [{ url: 'https://artifact.fixture/' + id + '.mp4' }] }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (/^https:\/\/artifact\.fixture\/remote-[0-9]+\.mp4$/.test(url)) {
    calls.download += 1;
    return new Response(FAKE_MP4, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
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

async function waitForReady(taskId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await inspectProviderTaskForDsh(taskId);
    if (task.outcome === 'succeeded' && task.deliveryState === 'ready') return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Core video Task ' + taskId);
}

try {
  await apply(ctx);
  const legacyBefore = tasks.all().length;
  const outputsBefore = fs.existsSync(path.join(config.irisHome(), 'outputs'))
    ? fs.readdirSync(path.join(config.irisHome(), 'outputs')).length : 0;

  /* Agent 工具：iris_generate_video 走 Core，文本给出同源播放链接与 Artifact ID */
  const videoTool = registered.find((tool) => tool.name === 'iris_generate_video');
  const rendered = await videoTool.execute({
    prompt: 'fixture t2v iris', model: provider.id + '::wan2.2-t2v-flash'
  }, {});
  assert.equal(calls.submit, 1, 'Agent 视频工具必须只提交一次');
  assert.match(rendered, /Core task: task_[a-f0-9]{24}/);
  const taskId = rendered.match(/task_[a-f0-9]{24}/)[0];
  assert.match(rendered, /\/iris\/api\/core\/artifact\/artifact_[a-f0-9]{24}\/media/,
    '完成文本必须给出同源 mp4 播放链接');
  const finished = await inspectProviderTaskForDsh(taskId);
  assert.equal(finished.capability, 'video');
  assert.equal(finished.deliveryState, 'ready');
  assert.equal(finished.attempts.length, 1);
  assert.equal(finished.attempts[0].selectionReason, 'explicit');
  assert.match(finished.providerBinding, /^sha256:[a-f0-9]{64}$/);
  /* 零 legacy 双写 */
  assert.equal(tasks.all().length, legacyBefore, 'Core 视频不得创建 legacy Task');
  const outputsAfter = fs.existsSync(path.join(config.irisHome(), 'outputs'))
    ? fs.readdirSync(path.join(config.irisHome(), 'outputs')).length : 0;
  assert.equal(outputsAfter, outputsBefore, 'Core 视频不得双写 legacy outputs');

  /* 同源媒体路由返回 mp4 字节 */
  const artifactId = finished.artifactIds[0];
  const mediaRes = apiResponse();
  await serveApi({ method: 'GET', url: '/iris/api/core/artifact/' + artifactId + '/media' }, mediaRes);
  assert.equal(mediaRes.status, 200);
  assert.equal(mediaRes.headers['Content-Type'], 'video/mp4');
  assert.deepEqual(Buffer.from(mediaRes.body), FAKE_MP4, '同源路由必须返回 mp4 字节');

  /* 工作台快照：video 行进入五类投影，控制面门全关 */
  const snapshotRes = apiResponse();
  await serveApi({ method: 'GET', url: '/iris/api/core/snapshot?limit=20' }, snapshotRes);
  const snapshot = JSON.parse(String(snapshotRes.body));
  const row = snapshot.userTasks.find((item) => item.id === taskId);
  assert.equal(row.capability, 'video');
  assert.equal(row.userState, 'succeeded');
  assert.equal(row.mediaReady, true);
  assert.equal(row.observable + row.cancelable + row.redeliverable + row.retryable, 0,
    '完成任务的四个动作门必须全部关闭', row);

  /* GUI 动作同一入口 → Core；长轮询崩溃后启动接管 */
  const submitted = await runAction({}, 'video', {
    prompt: 'fixture restart video', model: provider.id + '::wan2.2-t2v-flash'
  });
  assert.equal(submitted.storage, 'core');
  stopProviderTaskWatchesForDsh();
  assert.equal(remotes.get(submitted.remoteTaskId), 0, '停止节拍前不得 poll');
  const resumed = await resumeProviderTaskWatchesForDsh({ intervalMs: 10, maxWatchMs: 3000 });
  assert.deepEqual(resumed, [submitted.taskId], '启动接管必须认领视频任务');
  const recovered = await waitForReady(submitted.taskId);
  assert.equal(recovered.attempts.length, 1);
  assert.equal(calls.submit, 2, '接管只 poll/download，绝不重提');
  assert.equal(tasks.all().length, legacyBefore, '接管后仍零 legacy 双写');

  /* binding 漂移：节拍在网络前失败 */
  const drifted = await runAction({}, 'video', {
    prompt: 'fixture binding drift', model: provider.id + '::wan2.2-t2v-flash'
  });
  stopProviderTaskWatchesForDsh();
  const driftFile = path.join(dshCoreDataRoot(), 'task-store/v0/tasks', drifted.taskId + '.json');
  const driftBefore = fs.readFileSync(driftFile, 'utf8');
  const pollsBeforeDrift = calls.poll;
  config.upsert({ id: provider.id, baseUrl: 'https://dashscope-us-east-1.aliyuncs.com/compatible-mode/v1' });
  const rejectedResume = await resumeProviderTaskWatchesForDsh({ intervalMs: 10, maxWatchMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(rejectedResume, []);
  assert.equal(calls.poll, pollsBeforeDrift, '端点漂移必须在 poll 前失败');
  assert.equal(fs.readFileSync(driftFile, 'utf8'), driftBefore, '端点漂移不得改写 Task 事实');
  config.upsert({ id: provider.id, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });

  /* s2v 意图仍走 legacy（本切片不迁移数字人上传流程） */
  fs.mkdirSync(path.join(config.irisHome(), 'outputs'), { recursive: true });
  const audio = path.join(config.irisHome(), 'outputs', 'voice.wav');
  fs.writeFileSync(audio, Buffer.from('fake-wav'));
  const legacyCallsBefore = calls.submit;
  const legacyRoot = tasks.all().length;
  const s2vModel = config.upsert({
    name: 's2v fixture', enabled: true, apiKey: 'fixture-s2v-secret',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    mediaProtocol: 'dashscope',
    models: [{ id: 'wan2.2-s2v-flash', capabilities: ['video-gen'] }]
  });
  global.fetch = async (input) => { throw new Error('s2v upload fixture not stubbed: ' + input); };
  let s2vError;
  try {
    await runAction({}, 'video', {
      prompt: 'x', model: models.modelRef(s2vModel.id, 'wan2.2-s2v-flash'),
      first_frame_path: audio.replace('voice.wav', 'frame.png'), audio_path: audio
    });
  } catch (error) { s2vError = error; }
  assert(s2vError, 's2v 意图必须走 legacy 链路（首帧上传失败属预期）');
  assert.equal(calls.submit, legacyCallsBefore, 's2v 不得进入 Core 提交');
  fs.writeFileSync(path.join(config.irisHome(), 'outputs', 'frame.png'), Buffer.from('fake-png'));
  void legacyRoot;

  console.log('ALL OK —— DSH 视频 → Core：长轮询接管、mp4 同源媒体、零 legacy 双写、漂移防护、s2v 保留 legacy');
} finally {
  stopProviderTaskWatchesForDsh();
  tasks.stopWatchAll();
  for (const dispose of disposers.reverse()) {
    try { dispose(); } catch {}
  }
  global.fetch = originalFetch;
  cleanup();
}
