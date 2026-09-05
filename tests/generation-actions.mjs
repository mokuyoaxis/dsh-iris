/**
 * 生成动作共享路径与 failover 测试：
 * - 同名模型按 provider+model 复合引用精确排序；
 * - 视频提交阶段失败自动尝试下一模型；
 * - i2v 发送 data URL，S2V attachment id 解析全历史并上传图/音；
 * - 转写使用独立 transcribe capability；
 * - Agent 视频工具调用同一 runAction('video')。
 */
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-generation-actions');
const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};

const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { runAction } = await import('../lib/actions.js');
const root = config.irisHome();
fs.mkdirSync(path.join(root, 'outputs'), { recursive: true });

const providerIds = {};
for (const p of [
  { key: 'bad', name: 'bad', apiKey: 'bad-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true },
  { key: 'good', name: 'good', apiKey: 'good-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true }
]) {
  const saved = config.upsert({ ...p, models: [
    { id: 'wan2.2-t2v-flash', capabilities: ['video-gen'] },
    { id: 'wan2.2-s2v-flash', capabilities: ['video-gen'] }
  ] });
  providerIds[p.key] = saved.id;
}
const badRef = models.modelRef(providerIds.bad, 'wan2.2-t2v-flash');
const goodRef = models.modelRef(providerIds.good, 'wan2.2-t2v-flash');
assert(config.setAssignmentOrder('video-gen', [badRef, goodRef]), '设置视频复合引用顺序');

const originalFetch = global.fetch;
const submitCalls = [];
const uploadCalls = [];
global.fetch = async (input, init = {}) => {
  const url = String(input);
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  if (url.includes('/uploads?')) {
    uploadCalls.push({ phase: 'policy', auth, url });
    return new Response(JSON.stringify({ data: {
      upload_dir: 'iris-test', upload_host: 'https://upload.invalid',
      oss_access_key_id: 'id', signature: 'sig', policy: 'policy',
      x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true'
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://upload.invalid') {
    uploadCalls.push({ phase: 'file' });
    return new Response('', { status: 200 });
  }
  if (url.includes('/video-synthesis')) {
    const body = JSON.parse(init.body || '{}');
    submitCalls.push({ auth, body, url });
    if (auth === 'Bearer bad-key') {
      return new Response(JSON.stringify({ code: 'Throttling', message: 'rate limit' }), {
        status: 429, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ output: { task_id: 'remote-' + submitCalls.length } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (url.includes('/services/audio/asr/transcription')) {
    const body = JSON.parse(init.body || '{}');
    submitCalls.push({ auth, body, url });
    return new Response(JSON.stringify({ output: { task_id: 'asr-1' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  throw new Error('unexpected fetch: ' + url);
};

try {
  const first = await runAction({ get: () => undefined }, 'video', { prompt: 'failover test' });
  tasks.stopWatchAll();
  assert(first.providerId === providerIds.good, '首 provider 429 后提交到第二 provider', first);
  assert(submitCalls.slice(0, 2).map((c) => c.auth).join(',') === 'Bearer bad-key,Bearer good-key',
    '提交按复合引用顺序 failover', submitCalls);

  // 后续明确只把 good 放首位；自动池补齐项不会被触发，因为首项提交成功。
  config.setAssignmentOrder('video-gen', [goodRef]);
  const frame = path.join(root, 'outputs', 'frame.png');
  fs.writeFileSync(frame, Buffer.from('fake-png'));
  const i2v = await runAction({}, 'video', { prompt: 'move', first_frame_path: frame, size: '640*480' });
  tasks.stopWatchAll();
  const i2vBody = submitCalls.at(-1).body;
  assert(i2v.mode === 'i2v' && String(i2vBody.input.img_url).startsWith('data:image/png;base64,'),
    'i2v 通过共享动作发送首帧 data URL', i2vBody);

  // 让 attachment 记录落到最近 50 条之外，验证全历史查找。
  const old = tasks.create({ cap: 'image', providerId: providerIds.good, model: 'm', prompt: 'old attachment' });
  tasks.update(old.id, {
    status: 'succeeded', createdAt: '2000-01-01T00:00:00.000Z',
    attachments: [{ attachmentId: 'att-old-frame', file: 'frame.png', mediaType: 'image/png' }]
  });
  for (let i = 0; i < 55; i++) {
    const t = tasks.create({ cap: 'image', providerId: providerIds.good, model: 'm', prompt: 'new-' + i });
    tasks.update(t.id, { status: 'succeeded' });
  }
  const audio = path.join(root, 'voice.wav');
  fs.writeFileSync(audio, Buffer.from('fake-wav'));
  const s2v = await runAction({}, 'video', {
    prompt: '', model: models.modelRef(providerIds.good, 'wan2.2-s2v-flash'),
    first_frame_attachment_id: 'att-old-frame', audio_path: audio
  });
  tasks.stopWatchAll();
  const s2vBody = submitCalls.at(-1).body;
  assert(s2v.providerId === providerIds.good && s2v.model === 'wan2.2-s2v-flash' && s2vBody.model === 'wan2.2-s2v-flash',
    'S2V 复合模型覆盖精确选 Provider，且远端只收到模型 id', { s2v, s2vBody });
  assert(s2v.mode === 's2v' && s2vBody.parameters.resolution === '480P' && String(s2vBody.input.image_url).startsWith('oss://') && String(s2vBody.input.audio_url).startsWith('oss://'),
    'S2V 从全历史 attachment 解析首帧并上传图/音', s2vBody);
  assert(uploadCalls.filter((c) => c.phase === 'file').length === 2, 'S2V 恰好上传首帧和音频', uploadCalls);

  const asrProvider = config.upsert({
    name: 'asr', apiKey: 'asr-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
    models: [{ id: 'qwen-audio-3.0-asr-flash-filetrans', capabilities: ['transcribe'] }]
  });
  config.setAssignmentOrder('transcribe', [models.modelRef(asrProvider.id, 'qwen-audio-3.0-asr-flash-filetrans')]);
  const asr = await runAction({}, 'transcribe', { audio_path: audio });
  tasks.stopWatchAll();
  assert(asr.providerId === asrProvider.id && asr.model === 'qwen-audio-3.0-asr-flash-filetrans', '转写只走独立 transcribe capability', asr);

  const indexSrc = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert(indexSrc.includes("runAction(ctx, 'video', args, { signal: exec.signal })"),
    'Agent 视频工具复用 GUI 的 video action');
} finally {
  tasks.stopWatchAll();
  global.fetch = originalFetch;
}

console.log('ALL OK —— 生成动作共享路径 + 视频 failover/i2v/S2V + 全历史附件 + 独立转写能力全部通过');
