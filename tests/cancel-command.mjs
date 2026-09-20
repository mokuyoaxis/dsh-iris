/**
 * D3 cancel —— Command Service 层真值表、三分支语义、幂等与竞态防护。
 * 运行：node tests/cancel-command.mjs
 *
 * 计划规则：只有 Provider 明确确认才写 canceled；unsupported 或 unknown 保持真实
 * 状态。断言落点：recordCoreCancelResult 三分支 + 终态竞态守卫（远端事实优先）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandService, CORE_COMMANDS } from '../lib/command-service.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { inspectCoreTask, recordCoreCancelResult, recordCorePollResult, requestCoreCancel } from '../lib/core-tasks.js';
import { defineProviderAdapter } from '../lib/provider-adapter.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { coreTaskCancelable } from '../lib/core-user-projection.js';
import { semanticViolations } from '../lib/task-semantics.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const success = () => ({
  kind: 'succeeded',
  artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/generated.png', mediaType: 'image/png' }]
});

/** 与 FakeProvider 同身份但显式没有 cancel 操作（模拟真实 DashScope/openai-images）。 */
function adapterWithoutCancel() {
  return defineProviderAdapter({
    id: 'cancel-fake',
    protocol: 'fixture',
    capabilities: ['image'],
    operations: {
      submit: async () => {
        throw new Error('此 adapter 不得被用于提交');
      },
      poll: async () => ({ kind: 'pending', progress: 'fixture-running' }),
      mapError: (error, context) => ({ raw: String(error), ...context })
    },
    unsupported: {
      discover: 'fixture 无需发现',
      cancel: 'fixture 协议没有远端取消实现',
      download: '此 adapter 只用于观察已有任务'
    }
  });
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-cancel-command-'));
try {
  assert(CORE_COMMANDS.includes('task.cancel'), 'Command 注册表必须暴露 task.cancel');

  const dataRoot = path.join(base, 'data');
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
  runtime.start();
  const runner = createProviderTaskRunner(runtime);
  const commandsFor = (fake) => createCommandService(runtime, { resolveTaskAdapter: async () => fake.adapter });
  const taskFile = (taskId) => path.join(dataRoot, 'task-store', 'v0', 'tasks', taskId + '.json');
  const callsOf = (fake) => [fake.calls.poll.length, fake.calls.cancel.length, fake.calls.submit.length].join(':');

  async function submitAccepted(fake) {
    const result = await runner.submit({
      capability: 'image',
      candidates: [{ adapter: fake.adapter, model: 'cancel-fake::image-v0' }]
    });
    assert(result.task.acceptance === 'accepted' && fake.calls.submit.length === 1,
      '前置：任务必须已受理且只提交一次', { task: result.task, calls: fake.calls });
    return result.task;
  }

  async function expectReject(fake, taskId, code, label) {
    const before = callsOf(fake);
    const bytes = fs.existsSync(taskFile(taskId)) ? fs.readFileSync(taskFile(taskId), 'utf8') : null;
    let error;
    try { await commandsFor(fake).execute('task.cancel', { task_id: taskId }); } catch (caught) { error = caught; }
    assert(error?.code === code, label + ' 必须拒绝为 ' + code, error?.code);
    assert(callsOf(fake) === before, label + ' 拒绝前不得发生任何 Provider 调用', { before, after: callsOf(fake) });
    if (bytes !== null) assert(fs.readFileSync(taskFile(taskId), 'utf8') === bytes, label + ' 拒绝不得改写 Task 事实');
    return error;
  }

  /* ---------- 门真值表：无远端 ID / not_accepted / 终态 → 拒绝且零调用 ---------- */
  const lostFake = createFakeLifecycleProvider({
    id: 'cancel-fake',
    submitSteps: [{ kind: 'acceptance_unknown', error: 'fixture response lost' }]
  });
  const lost = await runner.submit({
    capability: 'image',
    candidates: [{ adapter: lostFake.adapter, model: 'cancel-fake::image-v0' }]
  });
  assert(lost.task.acceptance === 'unknown' && !lost.task.remoteTaskId,
    '前置：受理未知任务没有远端 ID', lost.task);
  await expectReject(lostFake, lost.task.id, 'IRIS_TASK_NOT_CANCELABLE', '受理未知且无远端 ID 的 Task');
  await expectReject(lostFake, 'task_' + '0'.repeat(24), 'IRIS_TASK_NOT_FOUND', '未知 Task');

  const refusedFake = createFakeLifecycleProvider({
    id: 'cancel-fake',
    submitSteps: [{ kind: 'not_accepted', error: 'fixture capacity full' }]
  });
  const refused = await runner.submit({
    capability: 'image',
    candidates: [{ adapter: refusedFake.adapter, model: 'cancel-fake::image-v0' }]
  });
  await expectReject(refusedFake, refused.task.id, 'IRIS_TASK_NOT_CANCELABLE', 'not_accepted Task');

  const doneFake = createFakeLifecycleProvider({
    id: 'cancel-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-done' }],
    pollSteps: [success()]
  });
  const doneTask = await submitAccepted(doneFake);
  const doneObserved = await commandsFor(doneFake).execute('task.reobserve', { task_id: doneTask.id });
  assert(doneObserved.task.phase === 'terminal' && doneObserved.task.outcome === 'succeeded',
    '前置：任务已完成交付', doneObserved.task);
  await expectReject(doneFake, doneTask.id, 'IRIS_TASK_NOT_CANCELABLE', '终态 Task');

  /* ---------- Provider 明确确认：outcome=canceled + remote_confirmed ---------- */
  const confirmFake = createFakeLifecycleProvider({
    id: 'cancel-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-confirm' }],
    cancelSteps: [{ kind: 'canceled', message: 'fixture canceled' }]
  });
  const confirmTask = await submitAccepted(confirmFake);
  assert(coreTaskCancelable(confirmTask) === true, '投影必须标记该任务可取消');
  const confirmed = await commandsFor(confirmFake).execute('task.cancel', { task_id: confirmTask.id });
  assert(confirmed.command === 'task.cancel' && confirmed.taskId === confirmTask.id
      && confirmed.task.outcome === 'canceled' && confirmed.task.cancelState === 'remote_confirmed'
      && confirmed.task.phase === 'terminal'
      && confirmFake.calls.cancel.length === 1 && confirmFake.calls.submit.length === 1
      && confirmFake.calls.poll.length === 0,
    'Provider 明确确认才写 canceled，且 cancel 只调用一次', { task: confirmed.task, calls: confirmFake.calls });
  assert(semanticViolations(confirmed.task).length === 0, '取消确认必须符合语义轴', confirmed.task);
  /* 幂等：确认后再次取消被拒（终态门），零远端调用 */
  await expectReject(confirmFake, confirmTask.id, 'IRIS_TASK_NOT_CANCELABLE', '已确认取消的 Task 再次取消');

  /* ---------- not_supported：绝不伪造 canceled，回到可继续观察的真实状态 ---------- */
  const plainFake = createFakeLifecycleProvider({
    id: 'cancel-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-unsupported' }],
    pollSteps: [success()]
  });
  const unsupportedTask = await submitAccepted(plainFake);
  const unsupportedCommands = createCommandService(runtime, { resolveTaskAdapter: async () => adapterWithoutCancel() });
  const unsupported = await unsupportedCommands.execute('task.cancel', { task_id: unsupportedTask.id });
  assert(unsupported.task.outcome === 'none' && unsupported.task.cancelState === 'none'
      && unsupported.task.phase !== 'terminal' && unsupported.task.watchState === 'suspended'
      && plainFake.calls.cancel.length === 0 && plainFake.calls.poll.length === 0,
    'Provider 不支持远端取消时必须如实回落（outcome 绝不伪造 canceled）', unsupported.task);
  assert(semanticViolations(unsupported.task).length === 0 && coreTaskCancelable(unsupported.task) === true,
    '不支持取消的任务保持真实可观察状态（cancelable 门可再次出现）', unsupported.task);
  /* 再次 cancel 仍是确定性 not_supported：零远端调用、状态不漂移 */
  const unsupportedAgain = await unsupportedCommands.execute('task.cancel', { task_id: unsupportedTask.id });
  assert(unsupportedAgain.task.outcome === 'none' && plainFake.calls.cancel.length === 0,
    '重复 cancel（不支持）必须是零网络的安全重放', unsupportedAgain.task);
  /* 该任务仍可被显式 reobserve 收敛（取消请求不曾触碰远端） */
  const converged = await commandsFor(plainFake).execute('task.reobserve', { task_id: unsupportedTask.id });
  assert(converged.task.outcome === 'succeeded' && converged.task.deliveryState === 'ready',
    '不支持取消的任务仍可由显式 reobserve 收敛到成功', converged.task);

  /* ---------- unknown（超时/网络失败）：保持真实，显式 reobserve 收敛 ---------- */
  const timeoutFake = createFakeLifecycleProvider({
    id: 'cancel-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-timeout' }],
    cancelSteps: [{ kind: 'unknown', message: 'fixture cancel timeout' }],
    pollSteps: [success()]
  });
  const timeoutTask = await submitAccepted(timeoutFake);
  const unknown = await commandsFor(timeoutFake).execute('task.cancel', { task_id: timeoutTask.id });
  assert(unknown.task.outcome === 'unknown' && unknown.task.cancelState === 'unknown'
      && unknown.task.phase !== 'terminal' && unknown.task.watchState === 'suspended'
      && unknown.task.lastError?.safeMessage
      && timeoutFake.calls.cancel.length === 1,
    '取消超时必须记 cancelState=unknown、outcome 保持真实非终态', unknown.task);
  assert(semanticViolations(unknown.task).length === 0, 'unknown 分支必须符合语义轴', unknown.task);
  await expectReject(timeoutFake, timeoutTask.id, 'IRIS_TASK_CANCEL_ALREADY_REQUESTED', '取消未确认时的再次取消');
  const timeoutConverged = await commandsFor(timeoutFake).execute('task.reobserve', { task_id: timeoutTask.id });
  assert(timeoutConverged.task.outcome === 'succeeded' && timeoutConverged.task.deliveryState === 'ready'
      && timeoutFake.calls.submit.length === 1 && timeoutFake.calls.poll.length === 1,
    '取消未确认的任务可由显式 reobserve 收敛，绝不重提', { task: timeoutConverged.task, calls: timeoutFake.calls });

  /* ---------- 竞态防护：poll 先沉淀 succeeded，cancel 结果不得覆盖 ---------- */
  const raceFake = createFakeLifecycleProvider({
    id: 'cancel-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-race' }]
  });
  const raceTask = await submitAccepted(raceFake);
  await runtime.run('execute', ({ dataRoot: root }) => {
    requestCoreCancel(root, raceTask.id);
    recordCorePollResult(root, raceTask.id, success());
    return recordCoreCancelResult(root, raceTask.id, { kind: 'canceled' });
  });
  const racedTask = await runtime.run('inspect', ({ dataRoot: root }) => inspectCoreTask(root, raceTask.id));
  assert(racedTask.outcome === 'succeeded' && racedTask.cancelState === 'none',
    '远端已成功的事实在竞态下不得被 cancel 覆盖', racedTask);

  console.log('ALL OK —— D3 cancel：门真值表零调用、三分支如实语义、幂等与竞态防护、显式收敛');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
