/**
 * E3 阶段转写迁移 —— Headless CLI：run transcribe（audio_url 直达 / audio_path
 * 上传）+ 观察长轮询 + 控制面门 + retry。运行：node tests/transcribe-cli.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = new URL('./fixtures/headless-async-fetch.mjs', import.meta.url).href;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-transcribe-cli-'));
const dataRoot = path.join(base, 'data');
const configFile = path.join(base, 'providers.json');
const stateFile = path.join(base, 'fixture-state.json');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const provider = {
  id: 'dash-main',
  enabled: true,
  apiKey: 'fixture-key-cli',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope',
  models: [{ id: 'qwen-audio-3.0-asr-flash-filetrans', capabilities: ['transcribe'] }]
};
fs.writeFileSync(configFile, JSON.stringify({ providers: [provider] }, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(configFile, 0o600);

function state() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { submit: 0, poll: 0, download: 0, tasks: {} };
    throw error;
  }
}

function cli(args) {
  return spawnSync(process.execPath, ['--import', fixture, 'bin/dsh-iris.js', ...args], {
    cwd: repo,
    env: {
      ...process.env,
      DSH_HOME: path.join(base, 'must-not-be-used'),
      IRIS_ASYNC_FIXTURE_STATE: stateFile
    },
    encoding: 'utf8',
    shell: false
  });
}

function parseSuccess(result, label) {
  assert(result.status === 0, label + ' 必须成功', { stderr: result.stderr, stdout: result.stdout });
  return JSON.parse(result.stdout);
}

try {
  /* 输入白名单与边界 */
  for (const [input, label] of [
    [{ bogus: 1 }, '未知字段'],
    [{}, '缺少音频来源'],
    [{ audio_url: 'https://a.invalid/x.wav', audio_path: '/tmp/x.wav' }, '两个来源互斥'],
    [{ audio_url: 'http://insecure/x.wav' }, 'audio_url 必须 https/oss'],
    [{ audio_path: 'relative/x.wav' }, 'audio_path 必须绝对路径'],
    [{ audio_path: '/definitely/missing.wav' }, 'audio_path 必须存在']
  ]) {
    const rejected = cli(['run', 'transcribe', '--data-root', dataRoot, '--provider-config', configFile,
      '--input', JSON.stringify(input)]);
    assert(rejected.status === 2 && state().submit === 0,
      label + ' 必须在网络前拒绝', { label, stderr: rejected.stderr });
  }

  /* audio_url 直达：零上传、受理 → 两拍收敛为文本 Artifact */
  const submitted = parseSuccess(cli(['run', 'transcribe', '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ audio_url: 'https://fixture.invalid/public.wav' })]), '转写提交（直达）');
  const taskId = submitted.taskId;
  assert(/^task_[a-f0-9]{24}$/.test(taskId)
      && submitted.task.capability === 'transcribe'
      && submitted.task.acceptance === 'accepted'
      && /^sha256:[a-f0-9]{64}$/.test(submitted.task.providerBinding)
      && state().submit === 1 && (state().uploadPolicy || 0) === 0,
    'audio_url 直达不得触发上传', { task: submitted.task, state: state() });

  const beat1 = parseSuccess(cli(['task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', configFile]), '第一拍');
  assert(beat1.task.outcome === 'none' && state().poll === 1, '第一拍保持未定论', beat1.task);
  const beat2 = parseSuccess(cli(['task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', configFile]), '第二拍');
  const artifactId = beat2.task.artifactIds[0];
  // 转写正文是 inline-base64 物化（本地落盘），不产生 download 网络调用。
  assert(beat2.task.outcome === 'succeeded' && beat2.task.deliveryState === 'ready'
      && state().poll === 2 && state().download === 0 && state().submit === 1,
    '第二拍收敛为文本 Artifact 且零重提零下载', { task: beat2.task, state: state() });
  const artifact = parseSuccess(cli(['artifact', 'inspect', artifactId, '--data-root', dataRoot]), '读取转写 Artifact');
  assert(artifact.artifact.mediaType === 'text/plain' && artifact.artifact.kind === 'transcript'
      && artifact.artifact.metadata?.capability === 'transcribe',
    '转写 Artifact 必须符合交付 Profile', artifact.artifact);

  /* Core 记录不持久化签名 URL */
  const recordBytes = fs.readFileSync(path.join(dataRoot, 'task-store', 'v0', 'tasks', taskId + '.json'), 'utf8');
  assert(!recordBytes.includes('oss://') && !recordBytes.includes('public.wav'),
    '转写记录不得持久化音频地址');

  /* 终态四门全拒且零网络 */
  for (const [verb, code] of [
    ['observe', 'IRIS_TASK_NOT_OBSERVABLE'],
    ['redeliver', 'IRIS_TASK_NOT_REDELIVERABLE'],
    ['cancel', 'IRIS_TASK_NOT_CANCELABLE']
  ]) {
    const rejected = cli(['task', verb, taskId, '--data-root', dataRoot, '--provider-config', configFile]);
    assert(rejected.status === 1 && rejected.stderr.includes(code)
        && state().submit === 1 && state().poll === 2,
      '终态转写的 task ' + verb + ' 必须拒绝且零网络', { verb, stderr: rejected.stderr });
  }

  /* audio_path 上传通道：经首选候选 Provider 的临时存储 */
  const audioFile = path.join(base, 'voice.wav');
  fs.writeFileSync(audioFile, Buffer.from('fake-wave'));
  const uploaded = parseSuccess(cli(['run', 'transcribe', '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ audio_path: audioFile })]), '转写提交（上传）');
  assert((state().uploadPolicy || 0) === 1 && (state().uploadFile || 0) === 1
      && state().submit === 2 && uploaded.task.capability === 'transcribe',
    'audio_path 必须经一次上传后再提交', { task: uploaded.task, state: state() });

  /* retry：缺 audio_url 拒绝；带 audio_url 创建新任务 */
  const noConfirm = cli(['task', 'retry', taskId, '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ audio_url: 'https://fixture.invalid/x.wav' })]);
  assert(noConfirm.status === 1 && noConfirm.stderr.includes('IRIS_COMMAND_BILLING_CONFIRM_REQUIRED'),
    '转写 retry 缺 --confirm-billing 必须拒绝', noConfirm.stderr);
  const readyRetry = cli(['task', 'retry', taskId, '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ audio_url: 'https://fixture.invalid/x.wav' }), '--confirm-billing']);
  assert(readyRetry.status === 1 && readyRetry.stderr.includes('IRIS_TASK_NOT_RETRYABLE'),
    'ready 转写必须拒绝 retry', readyRetry.stderr);

  // 终态失败的转写任务：缺 audio_url 拒绝（字段门在受理事实门之后）
  const failedRecord = JSON.parse(fs.readFileSync(
    path.join(dataRoot, 'task-store', 'v0', 'tasks', uploaded.taskId + '.json'), 'utf8'));
  failedRecord.outcome = 'failed';
  failedRecord.status = 'failed';
  failedRecord.phase = 'terminal';
  failedRecord.deliveryState = 'none';
  failedRecord.artifactIds = [];
  failedRecord.revision += 1;
  fs.writeFileSync(path.join(dataRoot, 'task-store', 'v0', 'tasks', uploaded.taskId + '.json'),
    JSON.stringify(failedRecord, null, 2) + '\n', { mode: 0o600 });
  const wrongField = cli(['task', 'retry', uploaded.taskId, '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ prompt: 'wrong field' }), '--confirm-billing']);
  assert(wrongField.status === 1 && wrongField.stderr.includes('audio_url'),
    '转写 retry 必须要求 audio_url', wrongField.stderr);
  const retried = parseSuccess(cli(['task', 'retry', uploaded.taskId,
    '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ audio_url: 'https://fixture.invalid/retry.wav' }), '--confirm-billing']), '转写 retry');
  assert(retried.command === 'task.retry' && retried.retriedFrom === uploaded.taskId
      && retried.task.capability === 'transcribe' && retried.task.retriedFrom === uploaded.taskId
      && state().submit === 3,
    '转写 retry 必须创建全新任务并恰好一次 submit', { result: retried, state: state() });

  assert(!fs.existsSync(path.join(base, 'must-not-be-used')),
    '转写 CLI 使用显式数据根与配置时不得依赖 DSH_HOME');
  const beforeUnsupported = JSON.stringify(state());
  fs.writeFileSync(configFile, JSON.stringify({ providers: [{ ...provider, mediaProtocol: 'openai-images' }] }));
  const unsupported = cli(['run', 'transcribe', '--data-root', path.join(base, 'unsupported-data'),
    '--provider-config', configFile, '--input', JSON.stringify({ audio_path: audioFile })]);
  assert(unsupported.status === 1 && unsupported.stderr.includes('IRIS_PROVIDER_INPUT_PREPARATION_UNSUPPORTED'),
    '未实现上传的协议必须返回稳定错误', unsupported.stderr);
  assert(JSON.stringify(state()) === beforeUnsupported, '不支持上传时不得调用 Provider');
  assert(!fs.existsSync(path.join(base, 'unsupported-data')), '上传拒绝发生在 Core runtime 创建前');
  console.log('ALL OK —— 转写 CLI：audio_url 直达 / audio_path 上传、长轮询、四门锁定、retry 关系');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
