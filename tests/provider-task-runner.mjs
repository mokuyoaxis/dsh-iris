import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import {
  activateCoreWatch,
  beginCoreAttempt,
  beginCoreDelivery,
  createCoreTask,
  inspectCoreTask,
  recordCorePollResult,
  requestCoreCancel
} from '../lib/core-tasks.js';
import { inspectCoreArtifact } from '../lib/core-artifacts.js';
import { createFakeLifecycleProvider, FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};
const roots = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-provider-runner-'));
  roots.push(root);
  return root;
};
const started = (root) => {
  const runtime = createCoreRuntime({ dataRoot: root, mode: 'writer' });
  runtime.start();
  return runtime;
};
const success = (url = 'https://fixture.invalid/result.png') => ({
  kind: 'succeeded', artifacts: [{ kind: 'remote-url', url, mediaType: 'image/png' }]
});

try {
  // 写前 Attempt -> accepted -> pending -> 正常释放/重启 -> poll -> download -> Artifact。
  const restartRoot = makeRoot();
  let writeAheadSeen = false;
  const restartFake = createFakeLifecycleProvider({
    id: 'restart-fake',
    submitSteps: [(input, context) => {
      const persisted = inspectCoreTask(restartRoot, context.taskId);
      writeAheadSeen = persisted.phase === 'submitting'
        && persisted.attempts.length === 1
        && persisted.attempts[0].acceptance === 'none';
      return { kind: 'accepted', remoteTaskId: 'remote-restart' };
    }],
    pollSteps: [{ kind: 'pending', progress: '25%' }, success()]
  });
  const runtime1 = started(restartRoot);
  const runner1 = createProviderTaskRunner(runtime1);
  const submitted = await runner1.submit({
    capability: 'image',
    candidates: [{ adapter: restartFake.adapter, model: 'restart-fake::image-v0' }],
    providerInput: { prompt: 'fixture only' }
  });
  assert(writeAheadSeen, 'Provider submit 前必须已经存在稳定 Attempt');
  assert(submitted.task.acceptance === 'accepted' && submitted.task.remoteTaskId === 'remote-restart',
    '受理事实与 remoteTaskId 必须先落盘', submitted.task);
  const pending = await runner1.observe(submitted.taskId, restartFake.adapter);
  assert(pending.watchState === 'suspended' && pending.outcome === 'none', '单次 pending 后保守挂起观察', pending);
  await runtime1.run('execute', ({ dataRoot }) => activateCoreWatch(dataRoot, submitted.taskId));
  await runtime1.dispose();

  const runtime2 = started(restartRoot);
  const runner2 = createProviderTaskRunner(runtime2);
  const recovered = await runner2.recover(submitted.taskId, restartFake.adapter);
  assert(recovered.outcome === 'succeeded' && recovered.deliveryState === 'ready'
      && recovered.artifactIds.length === 1, '重启后只恢复观察并完成交付', recovered);
  assert(restartFake.calls.submit.length === 1 && restartFake.calls.poll.length === 2
      && restartFake.calls.download.length === 1, '重启恢复不得重复 submit', restartFake.calls);
  const artifact = inspectCoreArtifact(restartRoot, recovered.artifactIds[0]);
  assert(artifact.mediaType === 'image/png' && artifact.size === FAKE_PNG.length,
    'Provider 交付必须进入同一 Core Artifact 存储', artifact);
  const persistedTask = fs.readFileSync(
    path.join(restartRoot, 'task-store', 'v0', 'tasks', submitted.taskId + '.json'), 'utf8'
  );
  assert(!persistedTask.includes('fixture.invalid') && !persistedTask.includes('result.png'),
    'Task 不得持久化供应商下载 URL');
  assert(!fs.existsSync(path.join(restartRoot, 'provider-staging', 'v0'))
      || fs.readdirSync(path.join(restartRoot, 'provider-staging', 'v0')).length === 0,
  '下载 staging 不应残留成功文件');
  await runtime2.dispose();

  // 同一 Task 的并发生命周期操作必须 fail-fast，避免双 poll/双交付。
  const concurrentRoot = makeRoot();
  let releasePoll;
  const pollGate = new Promise((resolve) => { releasePoll = resolve; });
  const concurrentFake = createFakeLifecycleProvider({
    id: 'concurrent-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-concurrent' }],
    pollSteps: [() => pollGate]
  });
  const concurrentRuntime = started(concurrentRoot);
  const concurrentRunner = createProviderTaskRunner(concurrentRuntime);
  const concurrentTask = await concurrentRunner.submit({
    capability: 'image',
    candidates: [{ adapter: concurrentFake.adapter, model: 'concurrent-fake::image-v0' }]
  });
  const firstObserve = concurrentRunner.observe(concurrentTask.taskId, concurrentFake.adapter);
  let busyError;
  try { await createProviderTaskRunner(concurrentRuntime).observe(concurrentTask.taskId, concurrentFake.adapter); }
  catch (error) { busyError = error; }
  assert(busyError?.code === 'IRIS_PROVIDER_TASK_BUSY' && concurrentFake.calls.poll.length === 1,
    '同一 Task 并发操作必须在第二次 Provider 调用前拒绝', busyError?.code);
  releasePoll({ kind: 'pending', progress: 'held-once' });
  await firstObserve;
  await concurrentRuntime.dispose();

  // submit 已发出而受理结果未落盘的恢复：只能标 unknown，零网络、零重提。
  const interruptedRoot = makeRoot();
  const interruptedRuntime1 = started(interruptedRoot);
  let interruptedId;
  await interruptedRuntime1.run('execute', ({ dataRoot }) => {
    const task = createCoreTask(dataRoot, { capability: 'image' });
    interruptedId = task.id;
    beginCoreAttempt(dataRoot, task.id, { providerId: 'interrupted-fake', model: 'interrupted-fake::image-v0' });
  });
  await interruptedRuntime1.dispose();
  const interruptedFake = createFakeLifecycleProvider({ id: 'interrupted-fake' });
  const interruptedRuntime2 = started(interruptedRoot);
  const interruptedRunner = createProviderTaskRunner(interruptedRuntime2);
  const uncertain = await interruptedRunner.recover(interruptedId, interruptedFake.adapter);
  assert(uncertain.acceptance === 'unknown' && uncertain.outcome === 'unknown'
      && interruptedFake.calls.submit.length === 0 && interruptedFake.calls.poll.length === 0,
  '响应落盘前中断必须保持受理未知且不得猜测性重提/轮询', uncertain);
  await interruptedRuntime2.dispose();

  // 取消响应和下载完成在落盘前中断：恢复只收口未知/交付失败，不执行网络。
  const recoveryRoot = makeRoot();
  const recoveryFake = createFakeLifecycleProvider({
    id: 'recovery-fake',
    submitSteps: [
      { kind: 'accepted', remoteTaskId: 'remote-cancel-interrupted' },
      { kind: 'accepted', remoteTaskId: 'remote-delivery-interrupted' }
    ]
  });
  const recoveryRuntime1 = started(recoveryRoot);
  const recoveryRunner1 = createProviderTaskRunner(recoveryRuntime1);
  const cancelInterrupted = await recoveryRunner1.submit({
    capability: 'image',
    candidates: [{ adapter: recoveryFake.adapter, model: 'recovery-fake::image-v0' }]
  });
  await recoveryRuntime1.run('execute', ({ dataRoot }) => requestCoreCancel(dataRoot, cancelInterrupted.taskId));
  const deliveryInterrupted = await recoveryRunner1.submit({
    capability: 'image',
    candidates: [{ adapter: recoveryFake.adapter, model: 'recovery-fake::image-v0' }]
  });
  await recoveryRuntime1.run('execute', ({ dataRoot }) => {
    recordCorePollResult(dataRoot, deliveryInterrupted.taskId, success());
    beginCoreDelivery(dataRoot, deliveryInterrupted.taskId);
  });
  await recoveryRuntime1.dispose();
  const recoveryRuntime2 = started(recoveryRoot);
  const recoveryRunner2 = createProviderTaskRunner(recoveryRuntime2);
  const recoveredCancel = await recoveryRunner2.recover(cancelInterrupted.taskId, recoveryFake.adapter);
  const recoveredDelivery = await recoveryRunner2.recover(deliveryInterrupted.taskId, recoveryFake.adapter);
  assert(recoveredCancel.outcome === 'unknown' && recoveredCancel.cancelState === 'unknown'
      && recoveredCancel.watchState === 'suspended', '取消响应中断必须恢复为未知', recoveredCancel);
  assert(recoveredDelivery.outcome === 'succeeded' && recoveredDelivery.deliveryState === 'failed',
    '交付中断必须保留生成成功并转为可重交付', recoveredDelivery);
  assert(recoveryFake.calls.submit.length === 2 && recoveryFake.calls.poll.length === 0
      && recoveryFake.calls.cancel.length === 0 && recoveryFake.calls.download.length === 0,
  '中断恢复本身不得发起 Provider 调用', recoveryFake.calls);
  await recoveryRuntime2.dispose();

  // 交付失败保留远端成功；显式 redeliver 只重新 poll/download。
  const deliveryRoot = makeRoot();
  const deliveryFake = createFakeLifecycleProvider({
    id: 'delivery-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-delivery' }],
    pollSteps: [success('https://fixture.invalid/first.png'), success('https://fixture.invalid/retry.png')],
    downloadSteps: [{ throw: new Error('disk full at /home/private/output.png') }, FAKE_PNG]
  });
  const deliveryRuntime = started(deliveryRoot);
  const deliveryRunner = createProviderTaskRunner(deliveryRuntime);
  const deliverySubmitted = await deliveryRunner.submit({
    capability: 'image',
    candidates: [{ adapter: deliveryFake.adapter, model: 'delivery-fake::image-v0' }]
  });
  const deliveryFailed = await deliveryRunner.observe(deliverySubmitted.taskId, deliveryFake.adapter);
  assert(deliveryFailed.outcome === 'succeeded' && deliveryFailed.deliveryState === 'failed',
    '下载失败不得覆盖远端生成成功事实', deliveryFailed);
  assert(!JSON.stringify(deliveryFailed).includes('/home/private'), '持久错误不得包含绝对私有路径');
  const redelivered = await deliveryRunner.redeliver(deliverySubmitted.taskId, deliveryFake.adapter);
  assert(redelivered.deliveryState === 'ready' && deliveryFake.calls.submit.length === 1
      && deliveryFake.calls.poll.length === 2 && deliveryFake.calls.download.length === 2,
  '重新交付只允许 poll/download，不得重新生成', { redelivered, calls: deliveryFake.calls });
  await deliveryRuntime.dispose();

  // 取消只接受 Provider 明确确认；unknown 不伪造 canceled。
  for (const [kind, expectedOutcome, expectedCancel] of [
    ['canceled', 'canceled', 'remote_confirmed'],
    ['unknown', 'unknown', 'unknown']
  ]) {
    const root = makeRoot();
    const fake = createFakeLifecycleProvider({
      id: 'cancel-' + kind,
      submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-' + kind }],
      cancelSteps: [{ kind }]
    });
    const runtime = started(root);
    const runner = createProviderTaskRunner(runtime);
    const created = await runner.submit({
      capability: 'image', candidates: [{ adapter: fake.adapter, model: fake.adapter.id + '::image-v0' }]
    });
    const canceled = await runner.cancel(created.taskId, fake.adapter);
    assert(canceled.outcome === expectedOutcome && canceled.cancelState === expectedCancel
        && fake.calls.cancel.length === 1, '取消结果必须忠实保留 Provider 证据：' + kind, canceled);
    await runtime.dispose();
  }

  // 受理未知立即停止候选链；明确未受理才允许切换一次。
  const boundaryRoot = makeRoot();
  const unknown = createFakeLifecycleProvider({
    id: 'unknown-fake', submitSteps: [{ throw: new Error('socket closed after write') }]
  });
  const forbidden = createFakeLifecycleProvider({
    id: 'forbidden-fake', submitSteps: [{ kind: 'accepted', remoteTaskId: 'duplicate' }]
  });
  const boundaryRuntime = started(boundaryRoot);
  const boundaryRunner = createProviderTaskRunner(boundaryRuntime);
  const boundary = await boundaryRunner.submit({
    capability: 'image', candidates: [
      { adapter: unknown.adapter, model: 'unknown-fake::image-v0' },
      { adapter: forbidden.adapter, model: 'forbidden-fake::image-v0' }
    ]
  });
  assert(boundary.task.acceptance === 'unknown' && unknown.calls.submit.length === 1
      && forbidden.calls.submit.length === 0, '受理未知后必须零 failover、零重复提交', boundary.task);
  await boundaryRuntime.dispose();

  const failoverRoot = makeRoot();
  const rejected = createFakeLifecycleProvider({
    id: 'rejected-fake',
    submitSteps: [{ kind: 'not_accepted', error: { category: 'quota', acceptance: 'not_accepted' } }]
  });
  const accepted = createFakeLifecycleProvider({
    id: 'accepted-fake', submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-winner' }]
  });
  const failoverRuntime = started(failoverRoot);
  const failoverRunner = createProviderTaskRunner(failoverRuntime);
  const switched = await failoverRunner.submit({
    capability: 'image', candidates: [
      { adapter: rejected.adapter, model: 'rejected-fake::image-v0' },
      { adapter: accepted.adapter, model: 'accepted-fake::image-v0' }
    ]
  });
  assert(switched.task.acceptance === 'accepted' && switched.task.attempts.length === 2
      && rejected.calls.submit.length === 1 && accepted.calls.submit.length === 1,
  '只有明确 not_accepted 才能进入下一候选', switched.task);
  await failoverRuntime.dispose();

  console.log('ALL OK —— FakeProvider submit/poll/delivery/restart/cancel 生命周期闭环通过');
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
