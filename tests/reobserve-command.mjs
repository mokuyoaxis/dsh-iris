/**
 * D1 reobserve —— Command Service 层的幂等/拒绝真值表与崩溃窗口。
 * 运行：node tests/reobserve-command.mjs
 *
 * 验证 task.reobserve 与 task.observe 是同一份实现（命令名别名），
 * 所有拒绝都在 Provider 调用与 Task 写入之前发生（调用计数与文件字节冻结），
 * poll 失败留下的 suspended/unknown 事实只会被后续显式调用收敛，绝不重提。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandService, CORE_COMMANDS } from '../lib/command-service.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { activateCoreWatch } from '../lib/core-tasks.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const success = () => ({
  kind: 'succeeded',
  artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/generated.png', mediaType: 'image/png' }]
});

/** 同一 Provider 身份、可独立计数的 fixture 组合：每个真值表任务一个实例。 */
function fakeWith({ remoteTaskId, submitSteps, pollSteps }) {
  return createFakeLifecycleProvider({
    id: 'reobserve-fake',
    submitSteps: submitSteps || [{ kind: 'accepted', remoteTaskId }],
    pollSteps
  });
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-reobserve-command-'));
try {
  assert(CORE_COMMANDS.includes('task.observe') && CORE_COMMANDS.includes('task.reobserve'),
    'Command 注册表必须同时暴露 task.observe 与 task.reobserve');

  const dataRoot = path.join(base, 'data');
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
  runtime.start();
  const runner = createProviderTaskRunner(runtime);
  const commandsFor = (fake) => createCommandService(runtime, { resolveTaskAdapter: async () => fake.adapter });

  async function submit(fake) {
    const result = await runner.submit({
      capability: 'image',
      candidates: [{ adapter: fake.adapter, model: 'reobserve-fake::image-v0' }]
    });
    assert(fake.calls.submit.length === 1, '每个真值表任务只能提交一次', fake.calls);
    return result.task;
  }

  const taskFile = (taskId) => path.join(dataRoot, 'task-store', 'v0', 'tasks', taskId + '.json');

  async function expectReject(fake, taskId, code, label) {
    const frozen = () => [fake.calls.poll.length, fake.calls.download.length, fake.calls.submit.length].join(':');
    const before = frozen();
    const file = taskFile(taskId);
    const beforeBytes = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    let error;
    try { await commandsFor(fake).execute('task.reobserve', { task_id: taskId }); } catch (caught) { error = caught; }
    assert(error?.code === code, label + ' 必须拒绝为 ' + code, error?.code);
    assert(frozen() === before, label + ' 拒绝前不得发生任何 Provider 调用', { before, after: frozen() });
    if (beforeBytes !== null) {
      assert(fs.readFileSync(file, 'utf8') === beforeBytes, label + ' 拒绝不得改写 Task 事实');
    }
  }

  /* ---------- 完成闭环 + 别名同构 ---------- */
  const mainFake = fakeWith({ remoteTaskId: 'remote-main', pollSteps: [{ kind: 'pending', progress: 'fixture-running' }, success()] });
  const mainTask = await submit(mainFake);

  await expectReject(mainFake, 'task_' + '0'.repeat(24), 'IRIS_TASK_NOT_FOUND', '未知 Task');
  {
    const other = createFakeLifecycleProvider({ id: 'reobserve-other' });
    let mismatched;
    try {
      await createCommandService(runtime, { resolveTaskAdapter: async () => other.adapter })
        .execute('task.reobserve', { task_id: mainTask.id });
    } catch (error) { mismatched = error; }
    assert(mismatched?.code === 'IRIS_PROVIDER_TASK_IDENTITY_MISMATCH'
        && mainFake.calls.poll.length === 0 && other.calls.poll.length === 0 && other.calls.submit.length === 0,
      'resolver 返回身份不符的 Adapter 必须在 poll 前拒绝', mismatched?.code);
  }

  const first = await commandsFor(mainFake).execute('task.reobserve', { task_id: mainTask.id });
  assert(first.command === 'task.reobserve' && first.taskId === mainTask.id
      && first.task.watchState === 'suspended' && first.task.outcome === 'none'
      && mainFake.calls.submit.length === 1 && mainFake.calls.poll.length === 1
      && mainFake.calls.download.length === 0,
    '首次 reobserve 只能 poll 一次、绝不 submit', { task: first.task, calls: mainFake.calls });

  const second = await commandsFor(mainFake).execute('task.observe', { task_id: mainTask.id });
  assert(second.command === 'task.observe'
      && Object.keys(second).join(',') === Object.keys(first).join(',')
      && second.task.outcome === 'succeeded' && second.task.deliveryState === 'ready'
      && mainFake.calls.poll.length === 2 && mainFake.calls.download.length === 1
      && mainFake.calls.submit.length === 1,
    'task.observe 与 task.reobserve 必须同实现同形状，闭环仍只有一份提交', second);

  await expectReject(mainFake, mainTask.id, 'IRIS_TASK_NOT_OBSERVABLE', '终态 Task');

  /* ---------- 拒绝真值表：not_accepted / 受理未知无远端 ID ---------- */
  const refusedFake = fakeWith({ submitSteps: [{ kind: 'not_accepted', error: 'fixture capacity full' }] });
  const refusedTask = await submit(refusedFake);
  await expectReject(refusedFake, refusedTask.id, 'IRIS_TASK_NOT_OBSERVABLE', 'not_accepted Task');

  const lostFake = fakeWith({ submitSteps: [{ kind: 'acceptance_unknown', error: 'fixture response lost' }] });
  const lostTask = await submit(lostFake);
  assert(lostTask.acceptance === 'unknown' && !lostTask.remoteTaskId,
    '受理未知任务必须先满足没有远端 ID 的前提', lostTask);
  await expectReject(lostFake, lostTask.id, 'IRIS_TASK_NOT_OBSERVABLE', '受理未知且没有远端 ID 的 Task');

  /* ---------- 崩溃窗口：watchState 遗留 active + poll 失败，只能显式收敛 ---------- */
  const crashFake = fakeWith({
    remoteTaskId: 'remote-crash',
    pollSteps: [{ throw: new Error('fixture poll outage') }, success()]
  });
  const crashTask = await submit(crashFake);
  await runtime.run('execute', ({ dataRoot: root }) => activateCoreWatch(root, crashTask.id));
  const crashedBytes = fs.readFileSync(taskFile(crashTask.id), 'utf8');
  assert(JSON.parse(crashedBytes).watchState === 'active', '必须模拟 poll 前进程退出留下的 active 事实');

  const outage = await commandsFor(crashFake).execute('task.reobserve', { task_id: crashTask.id });
  assert(outage.task.watchState === 'suspended' && outage.task.outcome === 'unknown'
      && crashFake.calls.poll.length === 1 && crashFake.calls.submit.length === 1
      && crashFake.calls.download.length === 0,
    'poll 失败只能如实记录 suspended/unknown，绝不重提', { task: outage.task, calls: crashFake.calls });
  assert(fs.readFileSync(taskFile(crashTask.id), 'utf8') !== crashedBytes,
    'poll 失败必须把观察暂停事实落盘（revision 推进，但无 Provider 伪造结果）');

  const converged = await commandsFor(crashFake).execute('task.reobserve', { task_id: crashTask.id });
  assert(converged.task.outcome === 'succeeded' && converged.task.deliveryState === 'ready'
      && converged.task.attempts.length === 1
      && crashFake.calls.submit.length === 1 && crashFake.calls.poll.length === 2
      && crashFake.calls.download.length === 1,
    '崩溃窗口后显式 reobserve 必须一次 poll 收敛，attempt 与 submit 计数不增', {
      task: converged.task, calls: crashFake.calls
    });

  console.log('ALL OK —— D1 reobserve：别名同实现、拒绝真值表零网络零写入、崩溃窗口显式收敛');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
