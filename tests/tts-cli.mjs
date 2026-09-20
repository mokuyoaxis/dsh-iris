/**
 * E2 阶段 TTS 迁移 —— Headless CLI：run tts 同步交付 + 控制面门 + retry 关系。
 * 运行：node tests/tts-cli.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = new URL('./fixtures/headless-async-fetch.mjs', import.meta.url).href;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-tts-cli-'));
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
  models: [{ id: 'qwen-tts-latest', capabilities: ['tts'] }]
};
fs.writeFileSync(configFile, JSON.stringify({ providers: [provider] }, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(configFile, 0o600);

function state() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { tts: 0 };
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
    [{ text: '你好', bogus: 1 }, '未知字段'],
    [{ text: '' }, '空 text'],
    [{ text: '你好', voice: 'x'.repeat(65) }, 'voice 过长']
  ]) {
    const rejected = cli(['run', 'tts', '--data-root', dataRoot, '--provider-config', configFile,
      '--input', JSON.stringify(input)]);
    assert(rejected.status === 2 && (state().tts || 0) === 0,
      label + ' 必须在网络前拒绝', { label, stderr: rejected.stderr });
  }

  /* 同步合成：一次命令内 completed → generated-audio Artifact */
  const submitted = parseSuccess(cli(['run', 'tts', '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ text: '你好，鸢尾', voice: 'Cherry' })]), '语音合成');
  const taskId = submitted.taskId;
  assert(/^task_[a-f0-9]{24}$/.test(taskId)
      && submitted.task.capability === 'tts'
      && submitted.task.outcome === 'succeeded' && submitted.task.deliveryState === 'ready'
      && submitted.task.phase === 'terminal'
      && submitted.task.artifactIds.length === 1
      && /^sha256:[a-f0-9]{64}$/.test(submitted.task.providerBinding)
      && (state().tts || 0) === 1,
    'TTS 同步合成必须一次命令内交付并落盘非敏感 binding', { task: submitted.task, state: state() });
  const artifact = parseSuccess(cli(['artifact', 'inspect', submitted.task.artifactIds[0], '--data-root', dataRoot]), '读取音频 Artifact');
  assert(artifact.artifact.mediaType === 'audio/mpeg' && artifact.artifact.kind === 'generated-audio'
      && artifact.artifact.metadata?.capability === 'tts',
    '音频 Artifact 必须符合交付 Profile', artifact.artifact);

  /* 终态后控制面四门全拒且零网络 */
  for (const [verb, code, extra] of [
    ['observe', 'IRIS_TASK_NOT_OBSERVABLE', []],
    ['redeliver', 'IRIS_TASK_NOT_REDELIVERABLE', []],
    ['cancel', 'IRIS_TASK_NOT_CANCELABLE', []]
  ]) {
    const rejected = cli(['task', verb, taskId, '--data-root', dataRoot, '--provider-config', configFile, ...extra]);
    assert(rejected.status === 1 && rejected.stderr.includes(code) && (state().tts || 0) === 1,
      '终态 TTS 的 task ' + verb + ' 必须拒绝且零网络', { verb, stderr: rejected.stderr });
  }

  /* retry：ready 拒绝；终态失败（注入）可重试为新任务 */
  const readyRetry = cli(['task', 'retry', taskId, '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ text: '重试文本' }), '--confirm-billing']);
  assert(readyRetry.status === 1 && readyRetry.stderr.includes('IRIS_TASK_NOT_RETRYABLE'),
    'ready TTS 必须拒绝 retry', readyRetry.stderr);

  const second = parseSuccess(cli(['run', 'tts', '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ text: '将被标记失败的合成' })]), '第二个 TTS 提交');
  // 同步 TTS 无远端 ID，无法走 poll 失败注入；fixture 直接落盘终态失败事实。
  const secondFile = path.join(dataRoot, 'task-store', 'v0', 'tasks', second.taskId + '.json');
  const failedFact = JSON.parse(fs.readFileSync(secondFile, 'utf8'));
  failedFact.outcome = 'failed';
  failedFact.status = 'failed';
  failedFact.phase = 'terminal';
  failedFact.deliveryState = 'none';
  failedFact.artifactIds = [];
  failedFact.revision += 1;
  fs.writeFileSync(secondFile, JSON.stringify(failedFact, null, 2) + '\n', { mode: 0o600 });
  const retried = parseSuccess(cli(['task', 'retry', second.taskId,
    '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ text: '重试文本' }), '--confirm-billing']), 'TTS retry');
  assert(retried.command === 'task.retry' && retried.retriedFrom === second.taskId
      && retried.task.capability === 'tts' && retried.task.retriedFrom === second.taskId
      && retried.task.deliveryState === 'ready'
      && (state().tts || 0) === 3,
    'TTS retry 必须创建全新语音任务并同步收敛、恰好一次合成', { result: retried, state: state() });

  assert(!fs.existsSync(path.join(base, 'must-not-be-used')),
    'TTS CLI 使用显式数据根与配置时不得依赖 DSH_HOME');
  console.log('ALL OK —— TTS CLI：run tts 同步交付、四门锁定、retry 关系');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
