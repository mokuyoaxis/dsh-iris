/**
 * B-7 回归测试：video 动作的 s2v 判定必须一致，且不得静默丢弃 audio_path。
 *
 * 背景（审计 B-7）：路由判定（actions.js `s2v = audio_path || model含s2v`）与
 * 模式判定（videoRoute `isS2V = model含s2v`）条件不一致。当 audio_path 有值但
 * 选中模型非 s2v 时，进入 legacy else 分支，audio_path 被静默丢弃，用户得到
 * 非预期的 t2v 视频（可能产生非预期计费）。
 *
 * 断言：
 *   ① audio_path + 非 s2v 模型 → 明确拒绝，零 Provider 调用；
 *   ② 无 audio_path + t2v 模型 → 仍走 Core 链路（现状不变）；
 *   ③ audio_path 校验失败（不存在）→ 在受理边界前拒绝，零 Provider 调用。
 * 零外部网络。
 */
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-video-s2v-routing');
const assert = (cond, msg, extra) => {
  if (!cond) { console.error('FAIL:', msg, extra === undefined ? '' : JSON.stringify(extra)); process.exit(1); }
};

const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { runAction } = await import('../lib/actions.js');
const { dshCoreDataRoot, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');

const provider = config.upsert({
  name: 'video-provider', apiKey: 'video-fixture-secret',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [
    { id: 'wan2.2-t2v-flash', capabilities: ['video-gen'] },
    { id: 'wan2.2-s2v-flash', capabilities: ['video-gen'] }
  ]
});
config.setAssignmentOrder('video-gen', [
  models.modelRef(provider.id, 'wan2.2-t2v-flash'),
  models.modelRef(provider.id, 'wan2.2-s2v-flash')
]);

const coreRecords = () => {
  try {
    const dir = path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks');
    return fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
  } catch (_) { return []; }
};

// 统计网络调用：任何 Provider 请求都算（本测试不应产生任何调用）
let fetchCalls = 0;
const originalFetch = global.fetch;
global.fetch = async (input) => { fetchCalls++; throw new Error('不应发出请求: ' + String(input)); };

try {
  const missingAudio = path.join(config.irisHome(), 'does-not-exist.wav');

  // ① audio_path 存在但模型非 s2v → 必须明确拒绝
  //    （用不存在的音频，先验证「存在性校验」；再用真实文件验证「模型矛盾」）
  fs.mkdirSync(config.irisHome(), { recursive: true });
  const audio = path.join(config.irisHome(), 'voice.wav');
  fs.writeFileSync(audio, Buffer.from('fake-wave'));

  const before = coreRecords().length;
  let rejected = null;
  try {
    await runAction({}, 'video', {
      prompt: 'should not silently drop audio',
      model: models.modelRef(provider.id, 'wan2.2-t2v-flash'),
      audio_path: audio
    });
  } catch (error) {
    rejected = error;
  }
  assert(rejected, 'B-7：audio_path + 非 s2v 模型必须明确拒绝，而非静默生成 t2v');
  assert(/s2v|数字人|audio_path/i.test(String(rejected.message)),
    '拒绝信息应说明 audio_path 与 s2v 模型的匹配要求', rejected.message);
  assert(fetchCalls === 0, 'B-7：矛盾输入必须零 Provider 调用', { fetchCalls });
  assert(coreRecords().length === before, 'B-7：矛盾输入不得创建 Core Task', { before, after: coreRecords().length });

  // ③ audio_path 不存在 → 受理边界前拒绝
  fetchCalls = 0;
  const before2 = coreRecords().length;
  let missingRejected = null;
  try {
    await runAction({}, 'video', {
      prompt: 'x', model: models.modelRef(provider.id, 'wan2.2-s2v-flash'), audio_path: missingAudio
    });
  } catch (error) { missingRejected = error; }
  assert(missingRejected, '不存在的 audio_path 必须拒绝');
  assert(fetchCalls === 0, '不存在的 audio_path 必须零 Provider 调用', { fetchCalls });
  assert(coreRecords().length === before2, '不存在的 audio_path 不得创建 Core Task');

  const frame = path.join(config.irisHome(), 'frame.png');
  fs.writeFileSync(frame, Buffer.from('fake-image'));
  const calls = [];
  let submittedInput;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/uploads?')) {
      calls.push('policy');
      return Response.json({ data: {
        upload_dir: 'fixture', upload_host: 'https://upload.invalid',
        oss_access_key_id: 'id', signature: 'sig', policy: 'policy',
        x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true'
      } });
    }
    if (url === 'https://upload.invalid') {
      calls.push('upload');
      return new Response('', { status: 200 });
    }
    if (url.includes('/video-synthesis')) {
      calls.push('submit');
      submittedInput = JSON.parse(init.body).input;
      return Response.json({ code: 'BadRequest', message: 'fixture rejection' }, { status: 400 });
    }
    throw new Error('unexpected fixture request');
  };
  let uploadRejected;
  try {
    await runAction({}, 'video', {
      model: models.modelRef(provider.id, 'wan2.2-s2v-flash'),
      audio_path: audio, first_frame_path: frame
    });
  } catch (error) { uploadRejected = error; }
  assert(uploadRejected?.taskId, '提交拒绝保留 legacy Task 身份');
  assert(calls.join(',') === 'policy,upload,policy,upload,submit', '首帧与音频各上传一次后提交', calls);
  assert(submittedInput.image_url.startsWith('oss://') && submittedInput.audio_url.startsWith('oss://'),
    '准备结果传给协议提交', submittedInput);
  assert(tasks.get(uploadRejected.taskId).acceptance === 'not_accepted', '上传成功不表示生成已受理');

  calls.length = 0;
  global.fetch = async () => {
    calls.push('policy');
    return Response.json({ message: 'denied' }, { status: 403 });
  };
  let failedUpload;
  try {
    await runAction({}, 'video', {
      model: models.modelRef(provider.id, 'wan2.2-s2v-flash'),
      audio_path: audio, first_frame_path: frame
    });
  } catch (error) { failedUpload = error; }
  const failedAttempt = tasks.get(failedUpload?.taskId)?.attempts.at(-1);
  assert(calls.join(',') === 'policy', '上传失败不得继续上传或提交');
  assert(failedAttempt?.error.stage === 'upload' && failedAttempt.error.acceptance === 'not_accepted'
    && failedAttempt.error.category === 'authentication', '上传失败保留规范化错误', failedAttempt);

  console.log('ALL OK —— B-7 s2v 判定一致化：audio_path 矛盾输入明确拒绝、零 Provider 调用、零 Task 创建');
} finally {
  global.fetch = originalFetch;
  tasks.stopWatchAll();
  await stopProviderTaskWatchesForDsh();
}
