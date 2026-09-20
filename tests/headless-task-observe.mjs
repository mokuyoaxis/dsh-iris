import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  activateCoreWatch,
  beginCoreAttempt,
  createCoreTask,
  inspectCoreTask,
  recordCoreAttemptResult
} from '../lib/core-tasks.js';
import { createCoreRuntime } from '../lib/core-runtime.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = fileURLToPath(new URL('./fixtures/headless-async-fetch.mjs', import.meta.url));
const writerFixture = fileURLToPath(new URL('./fixtures/core-writer-child.mjs', import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-headless-observe-'));
const dataRoot = path.join(base, 'data');
const configFile = path.join(base, 'providers.json');
const stateFile = path.join(base, 'fixture-state.json');
const children = new Set();

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const provider = (overrides = {}) => ({
  id: 'dash-main',
  enabled: true,
  apiKey: 'fixture-key-a',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope',
  models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }],
  ...overrides
});

function writeConfig(value) {
  fs.writeFileSync(configFile, JSON.stringify({ providers: [value] }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
}

function state() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { submit: 0, poll: 0, download: 0, tasks: {} };
    throw error;
  }
}

function updateState(callback) {
  const current = state();
  callback(current);
  fs.writeFileSync(stateFile, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
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

function taskFile(taskId) {
  return path.join(dataRoot, 'task-store', 'v0', 'tasks', taskId + '.json');
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('writer child READY timeout: ' + stderr));
    }, 8000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      if (!stdout.includes('READY')) {
        clearTimeout(timer);
        reject(new Error(`writer child exited ${code}: ${stderr}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function seedLegacyAcceptedTask() {
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
  runtime.start();
  try {
    return await runtime.run('execute', ({ dataRoot: root }) => {
      const task = createCoreTask(root, { capability: 'image' });
      const attempt = beginCoreAttempt(root, task.id, {
        providerId: 'dash-main', model: 'dash-main::wan2.2-t2i-flash'
      });
      recordCoreAttemptResult(root, task.id, {
        ...attempt, acceptance: 'accepted', resultKind: 'accepted', remoteTaskId: 'remote-legacy'
      });
      return inspectCoreTask(root, task.id);
    });
  } finally {
    await runtime.dispose();
  }
}

try {
  writeConfig(provider());
  const submitted = parseSuccess(cli([
    'run', 'image', '--data-root', dataRoot, '--provider-config', configFile, '--input',
    JSON.stringify({ prompt: 'fixture iris', model_ref: 'dash-main::wan2.2-t2i-flash' })
  ]), '异步图片提交');
  const taskId = submitted.taskId;
  assert(/^task_[a-f0-9]{24}$/.test(taskId)
      && submitted.task.acceptance === 'accepted'
      && submitted.task.remoteTaskId === 'remote-1'
      && submitted.task.attempts.length === 1
      && /^sha256:[a-f0-9]{64}$/.test(submitted.task.providerBinding)
      && submitted.task.attempts[0].providerBinding === submitted.task.providerBinding,
    '提交必须落盘唯一 Attempt、远端 ID 与非敏感 Provider binding', submitted.task);
  assert(state().submit === 1 && state().poll === 0 && state().download === 0
      && state().lastModel === 'wan2.2-t2i-flash' && state().submitHadAuthorization,
    'run image 只提交一次且必须使用精确模型和凭据', state());

  const originalBytes = fs.readFileSync(taskFile(taskId), 'utf8');
  writeConfig(provider({
    baseUrl: 'https://dashscope-us-east-1.aliyuncs.com/compatible-mode/v1'
  }));
  const drifted = cli(['task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', configFile]);
  assert(drifted.status === 1 && drifted.stderr.includes('IRIS_PROVIDER_TASK_BINDING_MISMATCH')
      && fs.readFileSync(taskFile(taskId), 'utf8') === originalBytes
      && state().submit === 1 && state().poll === 0,
    '端点或协议漂移必须在网络和 Task 写入前失败', { stderr: drifted.stderr, state: state() });

  writeConfig(provider({ apiKey: 'fixture-key-rotated' }));
  const pending = parseSuccess(cli([
    'task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', configFile
  ]), '第一次单步观察');
  assert(pending.task.watchState === 'suspended' && pending.task.outcome === 'none'
      && pending.task.attempts.length === 1
      && state().submit === 1 && state().poll === 1 && state().download === 0
      && state().pollHadAuthorization,
    '密钥轮换应允许观察；每次命令只 poll 一次且绝不 resubmit', { task: pending.task, state: state() });

  const ready = parseSuccess(cli([
    'task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', configFile
  ]), '第二次单步观察');
  const artifactId = ready.task.artifactIds[0];
  assert(ready.task.outcome === 'succeeded' && ready.task.deliveryState === 'ready'
      && ready.task.phase === 'terminal' && /^artifact_[a-f0-9]{24}$/.test(artifactId)
      && ready.task.attempts.length === 1
      && state().submit === 1 && state().poll === 2 && state().download === 1,
    '第二次观察必须完成 poll → download → Core Artifact，且不新建 Attempt', { task: ready.task, state: state() });
  const artifact = parseSuccess(cli([
    'artifact', 'inspect', artifactId, '--data-root', dataRoot
  ]), '跨进程读取观察产物');
  assert(artifact.artifact.metadata.taskId === taskId
      && /^[a-f0-9]{64}$/.test(artifact.artifact.digest.value)
      && artifact.artifact.size > 0,
    '观察产物必须进入可校验的 Core Artifact Store', artifact);

  const terminalBytes = fs.readFileSync(taskFile(taskId), 'utf8');
  const terminal = cli(['task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', configFile]);
  assert(terminal.status === 1 && terminal.stderr.includes('IRIS_TASK_NOT_OBSERVABLE')
      && fs.readFileSync(taskFile(taskId), 'utf8') === terminalBytes
      && state().submit === 1 && state().poll === 2 && state().download === 1,
    '终态 Task 再观察必须零网络、零写入且永不重提', terminal.stderr);

  const legacy = await seedLegacyAcceptedTask();
  const legacyBytes = fs.readFileSync(taskFile(legacy.id), 'utf8');
  const legacyObserve = cli([
    'task', 'observe', legacy.id, '--data-root', dataRoot, '--provider-config', configFile
  ]);
  assert(legacyObserve.status === 1 && legacyObserve.stderr.includes('IRIS_PROVIDER_TASK_BINDING_MISSING')
      && fs.readFileSync(taskFile(legacy.id), 'utf8') === legacyBytes
      && state().poll === 2,
    '没有提交端点证据的旧异步 Task 只能只读，不得猜测恢复', legacyObserve.stderr);

  writeConfig(provider({ models: [{ id: 'wan2.2-t2i-flash', capabilities: [] }] }));
  const modelBytes = fs.readFileSync(taskFile(legacy.id), 'utf8');
  const modelUnavailable = cli([
    'task', 'observe', legacy.id, '--data-root', dataRoot, '--provider-config', configFile
  ]);
  assert(modelUnavailable.status === 1 && modelUnavailable.stderr.includes('IRIS_PROVIDER_TASK_BINDING_MISSING')
      && fs.readFileSync(taskFile(legacy.id), 'utf8') === modelBytes && state().poll === 2,
    '旧 Task 必须优先按缺失 binding 失败且保持不变', modelUnavailable.stderr);

  writeConfig(provider());
  const resumable = parseSuccess(cli([
    'run', 'image', '--data-root', dataRoot, '--provider-config', configFile, '--input',
    JSON.stringify({ prompt: 'resume fixture', model_ref: 'dash-main::wan2.2-t2i-flash' })
  ]), '恢复场景提交');
  const firstResumePoll = parseSuccess(cli([
    'task', 'observe', resumable.taskId, '--data-root', dataRoot, '--provider-config', configFile
  ]), '恢复场景第一次观察');
  assert(firstResumePoll.task.watchState === 'suspended', '第一次观察必须留下可继续的 suspended 状态');
  const crashRuntime = createCoreRuntime({ dataRoot, mode: 'writer' });
  crashRuntime.start();
  await crashRuntime.run('execute', ({ dataRoot: root }) => activateCoreWatch(root, resumable.taskId));
  await crashRuntime.dispose();
  const active = fs.readFileSync(taskFile(resumable.taskId), 'utf8');
  assert(JSON.parse(active).watchState === 'active', '测试必须模拟 poll 前进程退出留下的 active 事实');
  const resumed = parseSuccess(cli([
    'task', 'observe', resumable.taskId, '--data-root', dataRoot, '--provider-config', configFile
  ]), '跨进程 active 恢复');
  assert(resumed.task.deliveryState === 'ready' && resumed.task.attempts.length === 1
      && state().submit === 2 && state().poll === 4 && state().download === 2,
    'active 恢复只能收口后 poll 一次，不得重复 submit', { task: resumed.task, state: state() });

  const lockTask = parseSuccess(cli([
    'run', 'image', '--data-root', dataRoot, '--provider-config', configFile, '--input',
    JSON.stringify({ prompt: 'lock fixture', model_ref: 'dash-main::wan2.2-t2i-flash' })
  ]), '写锁场景提交');
  writeConfig(provider({ models: [{ id: 'wan2.2-t2i-flash', capabilities: [] }] }));
  const unavailableBytes = fs.readFileSync(taskFile(lockTask.taskId), 'utf8');
  const unavailableState = state();
  const unavailable = cli([
    'task', 'observe', lockTask.taskId, '--data-root', dataRoot, '--provider-config', configFile
  ]);
  assert(unavailable.status === 1 && unavailable.stderr.includes('IRIS_PROVIDER_MODEL_UNAVAILABLE')
      && fs.readFileSync(taskFile(lockTask.taskId), 'utf8') === unavailableBytes
      && state().submit === unavailableState.submit && state().poll === unavailableState.poll,
    '原模型被移除或失去图片能力时必须在网络和 Task 写入前失败', unavailable.stderr);
  writeConfig(provider());
  const owner = spawn(process.execPath, [writerFixture, dataRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(owner);
  owner.once('exit', () => children.delete(owner));
  await waitForReady(owner);
  const lockBytes = fs.readFileSync(taskFile(lockTask.taskId), 'utf8');
  const beforeLockState = state();
  const busy = cli([
    'task', 'observe', lockTask.taskId, '--data-root', dataRoot, '--provider-config', configFile
  ]);
  assert(busy.status === 1 && busy.stderr.includes('IRIS_CORE_DATA_ROOT_BUSY')
      && fs.readFileSync(taskFile(lockTask.taskId), 'utf8') === lockBytes
      && state().submit === beforeLockState.submit && state().poll === beforeLockState.poll,
    '另一进程持有 writer 租约时 observe 必须 fail-fast 且零网络、零 Task 写入', busy.stderr);
  const exiting = waitForExit(owner);
  owner.stdin.write('STOP\n');
  const exited = await exiting;
  assert(exited.code === 0, 'writer fixture 必须正常释放租约', exited);

  const failedDelivery = parseSuccess(cli([
    'run', 'image', '--data-root', dataRoot, '--provider-config', configFile, '--input',
    JSON.stringify({ prompt: 'delivery fixture', model_ref: 'dash-main::wan2.2-t2i-flash' })
  ]), '交付失败场景提交');
  parseSuccess(cli([
    'task', 'observe', failedDelivery.taskId, '--data-root', dataRoot, '--provider-config', configFile
  ]), '交付失败场景第一次观察');
  updateState((current) => { current.failNextDownload = true; });
  const beforeDeliveryFailure = state();
  const deliveryFailure = parseSuccess(cli([
    'task', 'observe', failedDelivery.taskId, '--data-root', dataRoot, '--provider-config', configFile
  ]), '交付失败场景第二次观察');
  const afterDeliveryFailure = state();
  assert(deliveryFailure.task.outcome === 'succeeded' && deliveryFailure.task.deliveryState === 'failed'
      && deliveryFailure.task.artifactIds.length === 0 && deliveryFailure.task.attempts.length === 1
      && afterDeliveryFailure.submit === beforeDeliveryFailure.submit
      && afterDeliveryFailure.poll === beforeDeliveryFailure.poll + 1
      && afterDeliveryFailure.download === beforeDeliveryFailure.download + 1,
    '下载失败必须保留远端成功、零 Artifact 和唯一 Attempt，不得重新提交', {
      task: deliveryFailure.task, beforeDeliveryFailure, afterDeliveryFailure
    });

  updateState((current) => { current.failNextSubmitAfterAcceptance = true; });
  const beforeUnknown = state();
  const unknown = parseSuccess(cli([
    'run', 'image', '--data-root', dataRoot, '--provider-config', configFile, '--input',
    JSON.stringify({ prompt: 'acceptance unknown fixture', model_ref: 'dash-main::wan2.2-t2i-flash' })
  ]), '受理响应丢失场景');
  const afterUnknown = state();
  assert(unknown.task.acceptance === 'unknown' && unknown.task.outcome === 'unknown'
      && !unknown.task.remoteTaskId && unknown.task.attempts.length === 1
      && afterUnknown.submit === beforeUnknown.submit + 1,
    '提交已发出但响应丢失时必须保留受理未知且停止候选链', unknown.task);
  const unknownBytes = fs.readFileSync(taskFile(unknown.taskId), 'utf8');
  const unknownObserve = cli([
    'task', 'observe', unknown.taskId, '--data-root', dataRoot, '--provider-config', configFile
  ]);
  assert(unknownObserve.status === 1 && unknownObserve.stderr.includes('IRIS_TASK_NOT_OBSERVABLE')
      && fs.readFileSync(taskFile(unknown.taskId), 'utf8') === unknownBytes
      && state().submit === afterUnknown.submit && state().poll === afterUnknown.poll,
    '受理未知且没有远端 ID 时 observe 必须零网络、零写入、零猜测重提', unknownObserve.stderr);

  assert(!fs.existsSync(path.join(base, 'must-not-be-used')),
    'task.observe 使用显式数据根与配置时不得依赖 DSH_HOME');
  console.log('ALL OK —— task.observe 跨进程单步轮询、配置绑定、密钥轮换、active 恢复与单写者边界通过');
} finally {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(base, { recursive: true, force: true });
}
