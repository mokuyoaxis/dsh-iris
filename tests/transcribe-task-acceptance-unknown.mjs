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

const originalFetch = global.fetch;
let uploadPolicyCalls = 0;
let submitFirst = 0;
let submitSecond = 0;
let sawUploadStage = false;
let sawSubmitStage = false;
function diskAttempt() {
  const disk = JSON.parse(fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8'));
  return disk.tasks.at(-1)?.attempts?.at(-1);
}
global.fetch = async (input, init = {}) => {
  const url = String(input);
  const auth = init.headers && init.headers.Authorization;
  if (url.includes('/uploads?')) {
    uploadPolicyCalls++;
    sawUploadStage = diskAttempt()?.stage === 'upload';
    return new Response(JSON.stringify({ data: {
      upload_dir: 'iris-test', upload_host: 'https://upload.invalid',
      oss_access_key_id: 'id', signature: 'sig', policy: 'policy',
      x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true'
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://upload.invalid') return new Response('', { status: 200 });
  if (url.includes('/services/audio/asr/transcription')) {
    sawSubmitStage = diskAttempt()?.stage === 'submit';
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
  let thrown;
  try {
    await runAction({}, 'transcribe', { audio_path: audio });
  } catch (error) {
    thrown = error;
  }
  assert(thrown && thrown.taskId && /受理状态未知/.test(thrown.message), '转写 500 返回受理未知和 Task ID', thrown && thrown.message);
  assert(uploadPolicyCalls === 1 && submitFirst === 1 && submitSecond === 0, '转写提交不确定后不上传或提交第二候选', { uploadPolicyCalls, submitFirst, submitSecond });
  assert(sawUploadStage && sawSubmitStage, '上传和提交前均已持久化对应 stage');
  const task = tasks.get(thrown.taskId);
  assert(task.attempts.length === 1 && task.acceptance === 'unknown' && task.outcome === 'unknown', '转写保留单 Attempt 未知事实', task);
  const registry = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8');
  assert(!registry.includes('asr-first-secret') && !registry.includes('asr-second-secret'), '转写任务不持久化 API Key');
} finally {
  tasks.stopWatchAll();
  global.fetch = originalFetch;
}

console.log('ALL OK —— 转写上传/提交 stage 预写，提交 500 后零重复调用');
