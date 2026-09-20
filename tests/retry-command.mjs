/**
 * D4 retry as new task —— Command Service 层真值表、计费确认门、关系字段与计费链。
 * 运行：node tests/retry-command.mjs
 *
 * 计划规则：必须提示可能重复计费，由用户明确确认；新旧 Task 建立关系，但不复制
 * Prompt。断言落点：confirm_billing 门、retriedFrom schema、旧 Task 零变化、
 * 新 Task 独立 attempts=1、Core 记录确实不含 prompt。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandService, CORE_COMMANDS } from '../lib/command-service.js';
import { inspectCoreArtifact, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { inspectCoreTask } from '../lib/core-tasks.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { coreTaskRetryable } from '../lib/core-user-projection.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const success = () => ({
  kind: 'succeeded',
  artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/generated.png', mediaType: 'image/png' }]
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-retry-command-'));
try {
  assert(CORE_COMMANDS.includes('task.retry'), 'Command 注册表必须暴露 task.retry');

  const dataRoot = path.join(base, 'data');
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
  runtime.start();
  const runner = createProviderTaskRunner(runtime);
  const retryFake = createFakeLifecycleProvider({ id: 'retry-fake', pollSteps: [success()] });
  const commands = createCommandService(runtime, {
    resolveTaskCandidates: async () => [{ adapter: retryFake.adapter, model: 'retry-fake::image-v0' }]
  });
  const taskFile = (taskId) => path.join(dataRoot, 'task-store', 'v0', 'tasks', taskId + '.json');
  const inspect = (taskId) => runtime.run('inspect', ({ dataRoot: root }) => inspectCoreTask(root, taskId));

  async function submitTerminal(fake, label) {
    const result = await runner.submit({
      capability: 'image',
      candidates: [{ adapter: fake.adapter, model: 'retry-fake::image-v0' }]
    });
    assert(result.task.acceptance === 'accepted', label + ' 前置受理失败', result.task);
    return result.task;
  }

  /* ---------- 计费确认门：缺 confirm → 拒绝，零网络零新 Task ---------- */
  const rejectedFake = createFakeLifecycleProvider({
    id: 'retry-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-rejected' }],
    cancelSteps: [{ kind: 'canceled', message: 'fixture canceled' }]
  });
  const rejectedTask = await submitTerminal(rejectedFake, '计费门任务');
  await runner.cancel(rejectedTask.id, rejectedFake.adapter); // 终态：已确认取消
  const beforeRetry = await inspect(rejectedTask.id);
  assert(beforeRetry.phase === 'terminal' && beforeRetry.outcome === 'canceled'
      && coreTaskRetryable(beforeRetry) === true,
    '前置：已取消任务终态且可重试', beforeRetry);
  const rejectedBytes = fs.readFileSync(taskFile(rejectedTask.id), 'utf8');
  for (const [input, label] of [
    [{ task_id: rejectedTask.id, provider_input: { prompt: 'again' } }, '完全不带 confirm_billing'],
    [{ task_id: rejectedTask.id, provider_input: { prompt: 'again' }, confirm_billing: false }, 'confirm_billing:false'],
    [{ task_id: rejectedTask.id, provider_input: { prompt: 'again' }, confirm_billing: 'true' }, 'confirm_billing 字符串']
  ]) {
    let error;
    try { await commands.execute('task.retry', input); } catch (caught) { error = caught; }
    assert(error?.code === 'IRIS_COMMAND_BILLING_CONFIRM_REQUIRED',
      label + ' 必须拒绝', { label, code: error?.code });
  }
  assert(retryFake.calls.submit.length === 0
      && fs.readFileSync(taskFile(rejectedTask.id), 'utf8') === rejectedBytes,
    '计费门拒绝必须零网络、零新 Task、旧 Task 不变', retryFake.calls);

  /* ---------- 门真值表：ready 拒绝、prompt 为空拒绝、未知 Task 拒绝 ---------- */
  const readyFake = createFakeLifecycleProvider({
    id: 'retry-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-ready' }],
    pollSteps: [success()]
  });
  const readyTask = await submitTerminal(readyFake, 'ready 任务');
  await runner.observe(readyTask.id, readyFake.adapter);
  assert((await inspect(readyTask.id)).deliveryState === 'ready', '前置：任务已成功交付');
  let readyError;
  try {
    await commands.execute('task.retry', {
      task_id: readyTask.id, provider_input: { prompt: 'again' }, confirm_billing: true
    });
  } catch (error) { readyError = error; }
  assert(readyError?.code === 'IRIS_TASK_NOT_RETRYABLE' && retryFake.calls.submit.length === 0,
    'succeeded+ready 的 Task 必须拒绝 retry（成功交付不需要重试）', readyError?.code);

  let emptyPromptError;
  try {
    await commands.execute('task.retry', {
      task_id: rejectedTask.id, provider_input: { prompt: '   ' }, confirm_billing: true
    });
  } catch (error) { emptyPromptError = error; }
  assert(emptyPromptError?.code === 'IRIS_COMMAND_INPUT_INVALID' && retryFake.calls.submit.length === 0,
    'prompt 为空必须拒绝且零网络', emptyPromptError?.code);

  let missingError;
  try {
    await commands.execute('task.retry', {
      task_id: 'task_' + '0'.repeat(24), provider_input: { prompt: 'again' }, confirm_billing: true
    });
  } catch (error) { missingError = error; }
  assert(missingError?.code === 'IRIS_TASK_NOT_FOUND' && retryFake.calls.submit.length === 0,
    '未知 Task 必须拒绝且零网络', missingError?.code);

  /* ---------- 计费链 + 关系：新 Task 独立 attempts=1，旧 Task 零变化 ---------- */
  const retryInput = { task_id: rejectedTask.id, provider_input: { prompt: 'retry a canceled image' }, confirm_billing: true };
  const retried = await commands.execute('task.retry', retryInput);
  assert(retried.command === 'task.retry' && retried.retriedFrom === rejectedTask.id
      && retried.taskId !== rejectedTask.id,
    'retry 必须创建全新 Task 并记录单向关系', retried);
  assert(retryFake.calls.submit.length === 1
      && retryFake.calls.submit[0].input.input.prompt === 'retry a canceled image',
    '新 Task 恰好提交一次，prompt 由调用方重新提供', retryFake.calls);
  const newTask = retried.task;
  assert(newTask.retriedFrom === rejectedTask.id && newTask.attempts.length === 1
      && newTask.revision >= 1 && newTask.phase !== 'terminal',
    '新 Task 独立 id/attempts/binding，带 retriedFrom 关系', newTask);
  assert(fs.readFileSync(taskFile(rejectedTask.id), 'utf8') === rejectedBytes,
    '旧 Task 必须零变化（不新增 Attempt、不改写字节）');
  /* 旧记录确实不含 prompt；新记录也不含 prompt（Core 不持久化 Prompt 铁律） */
  const newBytes = fs.readFileSync(taskFile(newTask.id), 'utf8');
  assert(!newBytes.includes('retry a canceled image') && !rejectedBytes.includes('prompt'),
    '新旧 Task 记录都不得持久化 prompt', { newBytes, rejectedBytes });

  /* 幂等边界：同一 API 重放不在计划内（无幂等键）；单次调用恰好 1 个新 Task 已断言。
     但重复显式 retry（两次确认）允许创建第二个新任务——同属预期，且关系各自独立。 */
  const retriedAgain = await commands.execute('task.retry', retryInput);
  assert(retriedAgain.taskId !== retried.taskId && retriedAgain.retriedFrom === rejectedTask.id
      && retryFake.calls.submit.length === 2
      && fs.readFileSync(taskFile(rejectedTask.id), 'utf8') === rejectedBytes,
    '两次显式确认的重试各自创建独立新 Task，旧 Task 仍零变化', retryFake.calls);

  /* 新任务收敛后可交付 Artifact，metadata 挂在新 Task 上（非旧 Task） */
  const converged = await runner.observe(retried.taskId, retryFake.adapter);
  assert(converged.outcome === 'succeeded' && converged.deliveryState === 'ready'
      && converged.artifactIds.length === 1,
    '新任务可独立观察收敛', converged);
  const artifact = await runtime.run('inspect', ({ dataRoot: root }) => inspectCoreArtifact(root, converged.artifactIds[0]));
  assert(artifact.metadata?.taskId === retried.taskId && artifact.kind === 'generated-image',
    '新任务的 Artifact 必须挂在新 Task（关系不外溢到旧 Task）', artifact);
  const bytes = await runtime.run('inspect', ({ dataRoot: root }) => readCoreArtifactBytes(root, converged.artifactIds[0]));
  assert(bytes.artifact.digest.value === artifact.digest.value && bytes.bytes.length > 0,
    '新 Artifact 的 manifest hash 与字节一致', bytes.artifact.id);

  console.log('ALL OK —— D4 retry：计费确认三层门、retriedFrom 关系、prompt 零持久化、旧 Task 零变化');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
