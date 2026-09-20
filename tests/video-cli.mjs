/**
 * E 阶段视频迁移 —— Headless CLI：run video + task observe/redeliver/cancel/retry
 * 对 video 生效。运行：node tests/video-cli.mjs
 *
 * 覆盖：输入白名单与边界校验、受理→长轮询三拍→mp4 Artifact、跨进程观察同一
 * Task、ready 后 redeliver/retry 拒绝、不支持取消保持真实状态、binding 写入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = fileURLToPath(new URL('./fixtures/headless-async-fetch.mjs', import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-video-cli-'));
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
  models: [{ id: 'wan2.2-t2v-flash', capabilities: ['video-gen'] }]
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
    [{ prompt: 'x', bogus: 1 }, '未知字段'],
    [{ prompt: 'x', duration: 0 }, 'duration 下界'],
    [{ prompt: 'x', duration: 61 }, 'duration 上界'],
    [{ prompt: 'x', img_data_url: 'http://insecure/frame.png' }, 'img_data_url 必须 data:image/'],
    [{ prompt: '' }, '空 prompt']
  ]) {
    const rejected = cli(['run', 'video', '--data-root', dataRoot, '--provider-config', configFile,
      '--input', JSON.stringify(input)]);
    assert(rejected.status === 2 && state().submit === 0,
      label + ' 必须在网络前拒绝', { label, stderr: rejected.stderr });
  }

  /* 提交 + 长轮询三拍 + mp4 交付 */
  const submitted = parseSuccess(cli(['run', 'video', '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ prompt: 'cli t2v fixture', size: '1280*720', duration: 5 })]),
    '视频提交');
  const taskId = submitted.taskId;
  assert(/^task_[a-f0-9]{24}$/.test(taskId)
      && submitted.task.capability === 'video'
      && submitted.task.acceptance === 'accepted'
      && /^sha256:[a-f0-9]{64}$/.test(submitted.task.providerBinding)
      && state().submit === 1 && state().poll === 0,
    '视频提交必须落盘 Core 事实与非敏感 binding', { task: submitted.task, state: state() });

  const beat1 = parseSuccess(cli(['task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', configFile]), '第一拍');
  const beat2 = parseSuccess(cli(['task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', configFile]), '第二拍');
  assert(beat1.task.outcome === 'none' && beat2.task.outcome === 'none'
      && state().poll === 2 && state().download === 0,
    '视频长轮询前两拍保持未定论', { beat1: beat1.task, state: state() });

  const beat3 = parseSuccess(cli(['task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', configFile]), '第三拍');
  const artifactId = beat3.task.artifactIds[0];
  assert(beat3.task.outcome === 'succeeded' && beat3.task.deliveryState === 'ready'
      && state().poll === 3 && state().download === 1 && state().submit === 1,
    '第三拍收敛为 mp4 Artifact 且零重提', { task: beat3.task, state: state() });
  const artifact = parseSuccess(cli(['artifact', 'inspect', artifactId, '--data-root', dataRoot]), '读取视频 Artifact');
  assert(artifact.artifact.mediaType === 'video/mp4' && artifact.artifact.kind === 'generated-video'
      && artifact.artifact.metadata?.capability === 'video',
    '视频 Artifact 必须符合交付 Profile', artifact.artifact);

  /* 控制面对 video 生效：ready 后 redeliver/retry 拒绝；终态后再 observe 拒绝 */
  for (const [verb, code] of [
    ['observe', 'IRIS_TASK_NOT_OBSERVABLE'],
    ['redeliver', 'IRIS_TASK_NOT_REDELIVERABLE'],
    ['retry', 'IRIS_TASK_NOT_RETRYABLE']
  ]) {
    const extra = verb === 'retry' ? ['--input', JSON.stringify({ prompt: 'x' }), '--confirm-billing'] : [];
    const rejected = cli(['task', verb, taskId, '--data-root', dataRoot, '--provider-config', configFile, ...extra]);
    assert(rejected.status === 1 && rejected.stderr.includes(code)
        && state().submit === 1 && state().poll === 3 && state().download === 1,
      'ready 视频的 task ' + verb + ' 必须拒绝且零网络', { verb, stderr: rejected.stderr });
  }

  /* 取消：DashScope 不支持远端取消 → not_supported 如实回落 */
  const second = parseSuccess(cli(['run', 'video', '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ prompt: 'cli cancel fixture' })]), '第二个视频提交');
  const cancelled = parseSuccess(cli(['task', 'cancel', second.taskId, '--data-root', dataRoot, '--provider-config', configFile]), '视频取消');
  assert(cancelled.task.outcome === 'none' && cancelled.task.cancelState === 'none'
      && cancelled.task.phase !== 'terminal'
      && state().poll === 3 && state().submit === 2,
    '不支持远端取消时视频任务保持真实状态（绝不伪造已取消）', { task: cancelled.task, state: state() });

  /* 视频 retry：终态失败 → 显式确认后创建全新视频任务（候选链 video 感知） */
  const { createCoreRuntime } = await import('../lib/core-runtime.js');
  const { recordCorePollResult } = await import('../lib/core-tasks.js');
  const marker = createCoreRuntime({ dataRoot, mode: 'writer' });
  marker.start();
  await marker.run('execute', ({ dataRoot: root }) =>
    recordCorePollResult(root, second.taskId, { kind: 'failed', error: 'fixture remote failure' }));
  await marker.dispose();
  const retried = parseSuccess(cli(['task', 'retry', second.taskId,
    '--data-root', dataRoot, '--provider-config', configFile,
    '--input', JSON.stringify({ prompt: 'cli video retry' }), '--confirm-billing']), '视频 retry');
  assert(retried.command === 'task.retry' && retried.retriedFrom === second.taskId
      && retried.taskId !== second.taskId
      && retried.task.capability === 'video' && retried.task.retriedFrom === second.taskId
      && retried.task.attempts.length === 1
      && state().submit === 3,
    '视频 retry 必须创建全新视频 Task 并记录单向关系、恰好一次 submit', {
      result: retried, state: state()
    });

  assert(!fs.existsSync(path.join(base, 'must-not-be-used')),
    '视频 CLI 使用显式数据根与配置时不得依赖 DSH_HOME');
  console.log('ALL OK —— 视频 CLI：run video、长轮询三拍、mp4 Profile、控制面门、取消不伪造、retry 关系');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
