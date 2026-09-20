/**
 * D2 redeliver —— Command Service 层的门真值表、幂等矩阵、Artifact 关系与崩溃窗口。
 * 运行：node tests/redeliver-command.mjs
 *
 * 验证 task.redeliver 只对 outcome=succeeded / deliveryState=failed 的任务开放：
 * 每次调用至多一次 re-poll（带 redelivery 语义标志）+ 一次 download、零 submit、
 * 零重新生成；成功即 ready 且投影门反转；失败回落 failed（崩溃窗口语义明确），
 * 允许再次显式 redeliver 收敛；拒绝全部发生在 Provider 调用与 Task 写入之前。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandService, CORE_COMMANDS } from '../lib/command-service.js';
import { inspectCoreArtifact, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { inspectCoreTask } from '../lib/core-tasks.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { coreTaskRedeliverable } from '../lib/core-user-projection.js';
import { semanticViolations } from '../lib/task-semantics.js';
import { createFakeLifecycleProvider, FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const success = () => ({
  kind: 'succeeded',
  artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/generated.png', mediaType: 'image/png' }]
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-redeliver-command-'));
try {
  assert(CORE_COMMANDS.includes('task.redeliver'), 'Command 注册表必须暴露 task.redeliver');

  const dataRoot = path.join(base, 'data');
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
  runtime.start();
  const runner = createProviderTaskRunner(runtime);
  const commandsFor = (fake) => createCommandService(runtime, { resolveTaskAdapter: async () => fake.adapter });
  const taskFile = (taskId) => path.join(dataRoot, 'task-store', 'v0', 'tasks', taskId + '.json');
  const callsOf = (fake) => [fake.calls.poll.length, fake.calls.download.length, fake.calls.submit.length].join(':');
  const inspect = (taskId) => runtime.run('inspect', ({ dataRoot: root }) => inspectCoreTask(root, taskId));

  async function submitAccepted(fake) {
    const result = await runner.submit({
      capability: 'image',
      candidates: [{ adapter: fake.adapter, model: 'redeliver-fake::image-v0' }]
    });
    assert(result.task.acceptance === 'accepted' && fake.calls.submit.length === 1,
      '前置：任务必须已受理且只提交一次', { task: result.task, calls: fake.calls });
    return result.task;
  }

  async function expectReject(fake, taskId, code, label) {
    const before = callsOf(fake);
    const bytes = fs.existsSync(taskFile(taskId)) ? fs.readFileSync(taskFile(taskId), 'utf8') : null;
    let error;
    try { await commandsFor(fake).execute('task.redeliver', { task_id: taskId }); } catch (caught) { error = caught; }
    assert(error?.code === code, label + ' 必须拒绝为 ' + code, error?.code);
    assert(callsOf(fake) === before, label + ' 拒绝前不得发生任何 Provider 调用', { before, after: callsOf(fake) });
    if (bytes !== null) assert(fs.readFileSync(taskFile(taskId), 'utf8') === bytes, label + ' 拒绝不得改写 Task 事实');
    return error;
  }

  /* ---------- 受理未知且无远端 ID：在网络前拒绝 ---------- */
  const lostFake = createFakeLifecycleProvider({
    id: 'redeliver-fake',
    submitSteps: [{ kind: 'acceptance_unknown', error: 'fixture response lost' }]
  });
  const lost = await runner.submit({
    capability: 'image',
    candidates: [{ adapter: lostFake.adapter, model: 'redeliver-fake::image-v0' }]
  });
  assert(lost.task.acceptance === 'unknown' && !lost.task.remoteTaskId,
    '前置：受理未知任务没有远端 ID', lost.task);
  await expectReject(lostFake, lost.task.id, 'IRIS_TASK_NOT_REDELIVERABLE', '受理未知且无远端 ID 的 Task');
  await expectReject(lostFake, 'task_' + '0'.repeat(24), 'IRIS_TASK_NOT_FOUND', '未知 Task');

  /* ---------- 运行中（非 delivery_failed）与已 ready：都拒绝 ---------- */
  const pendingFake = createFakeLifecycleProvider({
    id: 'redeliver-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-pending' }]
  });
  const pendingTask = await submitAccepted(pendingFake);
  const observedPending = await commandsFor(pendingFake).execute('task.reobserve', { task_id: pendingTask.id });
  assert(observedPending.task.outcome === 'none' && observedPending.task.deliveryState === 'none',
    '前置：任务仍运行中且没有交付事实', observedPending.task);
  await expectReject(pendingFake, pendingTask.id, 'IRIS_TASK_NOT_REDELIVERABLE', '运行中（非 delivery_failed）Task');

  const readyFake = createFakeLifecycleProvider({
    id: 'redeliver-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-ready' }],
    pollSteps: [success()]
  });
  const readyTask = await submitAccepted(readyFake);
  const observedReady = await commandsFor(readyFake).execute('task.reobserve', { task_id: readyTask.id });
  assert(observedReady.task.outcome === 'succeeded' && observedReady.task.deliveryState === 'ready',
    '前置：任务已完成交付', observedReady.task);
  const readyReject = await expectReject(readyFake, readyTask.id, 'IRIS_TASK_NOT_REDELIVERABLE', '已 ready 的 Task');
  assert(readyReject.message.includes('不会重新生成'), '拒绝文案必须明确不重新生成', readyReject.message);

  /* ---------- deliveryState=failed（download 中途失败，崩溃窗口的回落语义） ---------- */
  const mainFake = createFakeLifecycleProvider({
    id: 'redeliver-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-main' }],
    pollSteps: [success(), success(), success()],
    downloadSteps: [{ throw: new Error('fixture download outage') }, { throw: new Error('fixture download outage again') }]
  });
  const mainTask = await submitAccepted(mainFake);
  const failedFirst = await commandsFor(mainFake).execute('task.reobserve', { task_id: mainTask.id });
  assert(failedFirst.task.outcome === 'succeeded' && failedFirst.task.deliveryState === 'failed'
      && failedFirst.task.artifactIds.length === 0
      && mainFake.calls.poll.length === 1 && mainFake.calls.download.length === 1,
    '前置：observe poll 成功但 download 失败 → succeeded+failed 且零 Artifact', {
      task: failedFirst.task, calls: mainFake.calls
    });
  assert(coreTaskRedeliverable(failedFirst.task) === true && semanticViolations(failedFirst.task).length === 0,
    '回落 failed 必须符合语义轴并可重新交付', failedFirst.task);
  {
    let staged;
    try { staged = fs.readdirSync(path.join(dataRoot, 'provider-staging', 'v0')); } catch (_) { staged = []; }
    assert(!staged.some((name) => name.endsWith('.part')),
      'download 失败不得遗留 .part 半成品', staged);
  }

  /* resolver 身份不符（模拟 binding 漂移）：在网络前拒绝 */
  {
    const other = createFakeLifecycleProvider({ id: 'redeliver-other' });
    let mismatched;
    try {
      await createCommandService(runtime, { resolveTaskAdapter: async () => other.adapter })
        .execute('task.redeliver', { task_id: mainTask.id });
    } catch (error) { mismatched = error; }
    assert(mismatched?.code === 'IRIS_PROVIDER_TASK_IDENTITY_MISMATCH' && callsOf(other) === '0:0:0',
      'resolver 返回身份不符的 Adapter 必须在 poll 前拒绝', mismatched?.code);
  }

  /* ---------- 幂等矩阵：第一次 redeliver 仍失败（回落 failed），第二次收敛 ---------- */
  const again = await commandsFor(mainFake).execute('task.redeliver', { task_id: mainTask.id });
  assert(again.command === 'task.redeliver' && again.taskId === mainTask.id
      && again.task.outcome === 'succeeded' && again.task.deliveryState === 'failed'
      && again.task.artifactIds.length === 0
      && mainFake.calls.poll.length === 2 && mainFake.calls.download.length === 2
      && mainFake.calls.submit.length === 1
      && mainFake.calls.poll.every((call) => call.context?.redelivery !== true
        ? mainFake.calls.poll.indexOf(call) === 0 : true),
    '第一次 redeliver 失败只能回落 failed，调用计数至多 +1 poll/+1 download、零 submit', {
      task: again.task, calls: mainFake.calls
    });
  assert(mainFake.calls.poll[1].context?.redelivery === true,
    'redeliver 的 re-poll 必须携带 redelivery 语义标志', mainFake.calls.poll[1].context);
  assert(semanticViolations(again.task).length === 0 && coreTaskRedeliverable(again.task) === true,
    '失败后任务仍处于语义合法的 failed，允许再次显式 redeliver', again.task);

  const finalTask = await commandsFor(mainFake).execute('task.redeliver', { task_id: mainTask.id });
  assert(finalTask.task.outcome === 'succeeded' && finalTask.task.deliveryState === 'ready'
      && finalTask.task.artifactIds.length === 1
      && mainFake.calls.poll.length === 3 && mainFake.calls.download.length === 3
      && mainFake.calls.submit.length === 1,
    '第二次 redeliver 必须收敛为 ready，全程零 submit、零重新生成', {
      task: finalTask.task, calls: mainFake.calls
    });
  assert(coreTaskRedeliverable(finalTask.task) === false, '成功后投影门必须反转');

  /* 幂等收口：ready 后 redeliverable=false，再次被拒且调用计数冻结 */
  await expectReject(mainFake, mainTask.id, 'IRIS_TASK_NOT_REDELIVERABLE', 'redeliver 成功后的再次调用');

  /* ---------- Artifact 关系：新交付产物挂在同一 Task，hash 与可导出字节一致 ---------- */
  const artifactId = finalTask.task.artifactIds[0];
  const artifact = await runtime.run('inspect', ({ dataRoot: root }) => inspectCoreArtifact(root, artifactId));
  assert(artifact.kind === 'generated-image' && artifact.metadata?.taskId === mainTask.id,
    'redeliver 交付的 Artifact 必须与 Task 建立 generated-image 关系', artifact);
  const bytes = await runtime.run('inspect', ({ dataRoot: root }) => readCoreArtifactBytes(root, artifactId));
  const digest = crypto.createHash('sha256').update(bytes.bytes).digest('hex');
  assert(artifact.digest?.value === digest && bytes.bytes.equals(FAKE_PNG),
    'Artifact manifest 的 SHA-256 必须与可读字节一致', { digest: artifact.digest });
  const finalInspect = await inspect(mainTask.id);
  assert(finalInspect.attempts.length === 1 && finalInspect.attempts[0].resultKind === 'accepted',
    'redeliver 全程不得新建 Attempt 或伪造受理事实', finalInspect.attempts);

  console.log('ALL OK —— D2 redeliver：门真值表零网络、幂等矩阵、redelivery 标志、Artifact 关系与回落收敛');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
