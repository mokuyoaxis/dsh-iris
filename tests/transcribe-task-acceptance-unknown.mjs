/**
 * 转写受理未知边界（E3：Core Task 版）。
 * 运行：node tests/transcribe-task-acceptance-unknown.mjs
 *
 * 验证：音频上传是 Host 输入准备（发生在 Core Task 创建之前，签名 URL 不落盘）；
 * 提交 500（受理响应不确定）时写前 Attempt 证据已在 Core 持久化、受理未知停止
 * 候选链、零 legacy 双写、记录不持久化 API Key 或 oss:// 签名地址。
 */
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-transcribe-task-unknown');
const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};
const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { runAction } = await import('../lib/actions.js');
const { dshCoreDataRoot, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const { inspectCoreTask } = await import('../lib/core-tasks.js');
const audio = path.join(config.irisHome(), 'sample.wav');
fs.mkdirSync(config.irisHome(), { recursive: true });
fs.writeFileSync(audio, Buffer.from('fake-wave'));

const first = config.upsert({
  name: 'asr-ambiguous', apiKey: 'asr-first-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'qwen-audio-3.0-asr-flash-filetrans', capabilities: ['transcribe'] }]
});
const second = config.upsert({
  name: 'asr-must-not-run', apiKey: 'asr-second-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'qwen-audio-3.0-asr-flash-filetrans', capabilities: ['transcribe'] }]
});
config.setAssignmentOrder('transcribe', [
  models.modelRef(first.id, 'qwen-audio-3.0-asr-flash-filetrans'),
  models.modelRef(second.id, 'qwen-audio-3.0-asr-flash-filetrans')
]);

const taskStoreDir = () => path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks');
function coreRecords() {
  try {
    return fs.readdirSync(taskStoreDir()).map((name) => fs.readFileSync(path.join(taskStoreDir(), name), 'utf8'));
  } catch (_) {
    return [];
  }
}

const originalFetch = global.fetch;
let uploadPolicyCalls = 0;
let submitFirst = 0;
let submitSecond = 0;
let sawWriteAheadSubmit = false;
let mode = 'upload-fail';
global.fetch = async (input, init = {}) => {
  const url = String(input);
  const auth = init.headers && (init.headers.Authorization || init.headers.authorization);
  if (url.includes('/uploads?')) {
    uploadPolicyCalls++;
    if (mode === 'upload-fail') {
      return new Response(JSON.stringify({
        message: 'Bearer upload-leak-token /home/private/audio.wav?Signature=hidden'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: {
      upload_dir: 'iris-test', upload_host: 'https://upload.invalid',
      oss_access_key_id: 'id', signature: 'sig', policy: 'policy',
      x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true'
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://upload.invalid') return new Response('', { status: 200 });
  if (url.includes('/services/audio/asr/transcription')) {
    const records = coreRecords();
    const current = records.length ? JSON.parse(records[0]).attempts?.at(-1) : undefined;
    sawWriteAheadSubmit = current?.acceptance === 'none' && current?.stage === 'submitting';
    if (auth === 'Bearer asr-first-secret') {
      submitFirst++;
      return new Response(JSON.stringify({ code: 'InternalError', message: 'uncertain' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (auth === 'Bearer asr-second-secret') submitSecond++;
    return new Response(JSON.stringify({ output: { task_id: 'must-not-exist' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  throw new Error('unexpected fetch: ' + url);
};

try {
  const legacyBefore = tasks.all().length;
  let uploadFailure;
  try {
    await runAction({}, 'transcribe', { audio_path: audio });
  } catch (error) {
    uploadFailure = error;
  }
  const safeUploadFailure = JSON.stringify({
    message: uploadFailure?.message,
    stage: uploadFailure?.stage,
    acceptance: uploadFailure?.acceptance,
    category: uploadFailure?.category
  });
  assert(uploadFailure?.stage === 'upload' && uploadFailure?.acceptance === 'not_accepted',
    '上传失败必须作为未受理的输入准备错误直接返回', safeUploadFailure);
  assert(submitFirst === 0 && submitSecond === 0 && coreRecords().length === 0,
    '上传失败发生在 submit 与 Core Task 创建之前', { submitFirst, submitSecond, records: coreRecords().length });
  assert(tasks.all().length === legacyBefore, '上传失败不得产生 legacy 双写', tasks.all().length);
  assert(!safeUploadFailure.includes('upload-leak-token') && !safeUploadFailure.includes('/home/private')
      && !safeUploadFailure.includes('hidden') && !safeUploadFailure.includes(audio),
    '上传错误必须移除凭据、签名值与绝对路径', safeUploadFailure);

  mode = 'submit-unknown';
  let thrown;
  try {
    await runAction({}, 'transcribe', { audio_path: audio });
  } catch (error) {
    thrown = error;
  }
  stopProviderTaskWatchesForDsh();
  assert(thrown && thrown.taskId && /受理状态未知/.test(thrown.message), '转写 500 返回受理未知和 Task ID', thrown && thrown.message);
  assert(/^task_[a-f0-9]{24}$/.test(thrown.taskId), '受理未知暴露的是 Core Task ID', thrown.taskId);
  assert(uploadPolicyCalls === 2 && submitFirst === 1 && submitSecond === 0,
    '两个转写场景各准备上传一次；受理未知后禁止调用第二供应商', { uploadPolicyCalls, submitFirst, submitSecond });
  assert(sawWriteAheadSubmit, 'Core 写前 Attempt 证据必须在受理响应前落盘');
  const task = inspectCoreTask(dshCoreDataRoot(), thrown.taskId);
  assert(task.attempts.length === 1 && task.capability === 'transcribe'
      && task.acceptance === 'unknown' && task.outcome === 'unknown' && task.phase === 'terminal',
    '转写保留单 Attempt 未知事实（无远端 ID 时如实收口）', task);
  assert(tasks.all().length === legacyBefore, 'Core 转写受理未知零 legacy 双写', tasks.all().length);
  for (const record of coreRecords()) {
    assert(!record.includes('asr-first-secret') && !record.includes('asr-second-secret'),
      'Core 转写任务不持久化 API Key');
    assert(!record.includes('oss://'), 'Core 转写任务不持久化签名/临时音频地址');
  }
  const adapterContract = fs.readFileSync(new URL('../docs/PROVIDER_ADAPTER_CONTRACT.md', import.meta.url), 'utf8');
  const submissionContract = fs.readFileSync(new URL('../docs/PROVIDER_SUBMISSION_CONTRACT.md', import.meta.url), 'utf8');
  assert(adapterContract.includes('上传属于 Host/CLI 输入准备')
      && adapterContract.includes('失败会直接返回且不创建 Core Task')
      && !adapterContract.includes('是否将上传失败纳入 Core 事实仍待决策'),
  'Adapter 契约必须冻结上传准备边界，同时移除过期的待决策措辞');
  assert(submissionContract.includes('零 submit、零 Core Task')
      && !submissionContract.includes('视频和转写分别持久化'),
  '提交契约不得再虚构 Core 转写持久化 upload stage');
} finally {
  stopProviderTaskWatchesForDsh();
  tasks.stopWatchAll();
  global.fetch = originalFetch;
}

console.log('ALL OK —— 转写迁移 Core：上传失败零 Task/零 submit、写前 Attempt、500 后零重提零双写');
