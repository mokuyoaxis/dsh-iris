/**
 * E3 阶段转写迁移 —— DSH Host 端到端：Agent 工具/GUI 动作 → 上传 → Core 异步
 * 观察 → 文本 Artifact → 同源链接。运行：node tests/dsh-transcribe-core.mjs
 *
 * 关键断言：零 legacy 双写、上传是 Host 输入准备（签名 URL 不落 Core）、
 * Agent 文本直接附转写正文、快照五类投影合理、终态四门锁定。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';

const { root, cleanup } = useTempDshHome('iris-dsh-transcribe-core');
const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { apply } = await import('../lib/index.js');
const { runAction } = await import('../lib/actions.js');
const {
  inspectProviderTaskForDsh,
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
  name: 'asr fixture', enabled: true, apiKey: 'fixture-asr-secret',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope',
  models: [{ id: 'qwen-audio-3.0-asr-flash-filetrans', capabilities: ['transcribe'] }]
});
config.setAssignmentOrder('transcribe', [provider.id + '::qwen-audio-3.0-asr-flash-filetrans']);

const TRANSCRIPT = 'fixture 转写正文：鸢尾音频内容。';
const originalFetch = global.fetch;
const calls = { uploadPolicy: 0, uploadFile: 0, submit: 0, poll: 0 };
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes('/uploads?')) {
    calls.uploadPolicy += 1;
    return new Response(JSON.stringify({ data: {
      upload_dir: 'iris-test', upload_host: 'https://upload.invalid',
      oss_access_key_id: 'id', signature: 'sig', policy: 'policy',
      x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true'
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://upload.invalid') {
    calls.uploadFile += 1;
    return new Response('', { status: 200 });
  }
  if (url.endsWith('/services/audio/asr/transcription')) {
    calls.submit += 1;
    const body = JSON.parse(String(init.body || '{}'));
    assert.equal(body.model, 'qwen-audio-3.0-asr-flash-filetrans');
    assert.match(JSON.stringify(body.input), /oss:\/\/|file_url/, '转写提交必须携带上传后的音频地址');
    assert(new Headers(init.headers).get('authorization'), 'submit must carry provider authorization');
    return new Response(JSON.stringify({ output: { task_id: 'remote-asr-1' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  const pollMatch = url.match(/\/api\/v1\/tasks\/(remote-asr-[0-9]+)$/);
  if (pollMatch) {
    calls.poll += 1;
    if (calls.poll === 1) {
      return new Response(JSON.stringify({ output: { task_status: 'RUNNING' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ output: { task_status: 'SUCCEEDED', text: TRANSCRIPT } }), {
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

try {
  await apply(ctx);
  const legacyBefore = tasks.all().length;
  const audioPath = path.join(config.irisHome(), 'sample.wav');
  fs.writeFileSync(audioPath, Buffer.from('fake-wave'));

  /* Agent 工具：上传 → Core 提交 → 等待收敛 → 文本直接附正文 */
  const transcribeTool = registered.find((tool) => tool.name === 'iris_transcribe_audio');
  const rendered = await transcribeTool.execute({ audio_path: audioPath }, {});
  assert.equal(calls.uploadPolicy, 1, '上传策略恰好一次（Host 输入准备）');
  assert.equal(calls.uploadFile, 1);
  assert.equal(calls.submit, 1, '转写只提交一次');
  assert.match(rendered, /Core task: task_[a-f0-9]{24}/);
  assert.ok(rendered.includes(TRANSCRIPT), 'Agent 结果必须直接附转写正文');
  const taskId = rendered.match(/task_[a-f0-9]{24}/)[0];
  const finished = await inspectProviderTaskForDsh(taskId);
  assert.equal(finished.capability, 'transcribe');
  assert.equal(finished.deliveryState, 'ready');
  assert.equal(finished.attempts.length, 1);
  assert.equal(finished.attempts[0].selectionReason, 'assignment');
  /* 零 legacy 双写 + 签名 URL 不落 Core */
  assert.equal(tasks.all().length, legacyBefore, 'Core 转写不得创建 legacy Task');
  const recordBytes = fs.readFileSync(
    path.join((await import('../lib/dsh-core-adapter.js')).dshCoreDataRoot(), 'task-store', 'v0', 'tasks', taskId + '.json'), 'utf8');
  assert.ok(!recordBytes.includes('oss://') && !recordBytes.includes('asr-first-secret')
      && !recordBytes.includes('fixture-asr-secret'),
    'Core 转写记录不得持久化签名地址或 Key');

  /* 同源媒体路由返回纯文本正文 */
  const mediaRes = apiResponse();
  await serveApi({ method: 'GET', url: '/iris/api/core/artifact/' + finished.artifactIds[0] + '/media' }, mediaRes);
  assert.equal(mediaRes.status, 200);
  assert.equal(mediaRes.headers['Content-Type'], 'text/plain');
  assert.equal(Buffer.from(mediaRes.body).toString('utf8'), TRANSCRIPT, '同源路由必须返回转写正文');

  /* 工作台快照：transcribe 行进入五类投影，四门全关 */
  const snapshotRes = apiResponse();
  await serveApi({ method: 'GET', url: '/iris/api/core/snapshot?limit=20' }, snapshotRes);
  const row = JSON.parse(String(snapshotRes.body)).userTasks.find((item) => item.id === taskId);
  assert.equal(row.capability, 'transcribe');
  assert.equal(row.userState, 'succeeded');
  assert.equal(row.mediaReady, true);
  assert.equal(row.observable + row.cancelable + row.redeliverable + row.retryable, 0,
    '完成任务的四个动作门必须全部关闭', row);

  /* GUI 动作同一入口（audio_url 直接给，跳过上传） */
  const submitted = await runAction({}, 'transcribe', { audio_url: 'https://fixture.invalid/public.wav' });
  assert.equal(submitted.storage, 'core');
  assert.equal(calls.uploadPolicy, 1, 'audio_url 直达路径不得再上传');
  assert.equal(calls.submit, 2);
  assert.equal(tasks.all().length, legacyBefore, 'GUI 转写仍零 legacy 双写');
  stopProviderTaskWatchesForDsh();

  console.log('ALL OK —— DSH 转写 → Core：上传为输入准备、文本 Artifact、零 legacy 双写、快照投影');
} finally {
  stopProviderTaskWatchesForDsh();
  tasks.stopWatchAll();
  for (const dispose of disposers.reverse()) {
    try { dispose(); } catch {}
  }
  global.fetch = originalFetch;
  cleanup();
}
