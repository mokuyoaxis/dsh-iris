/**
 * E 阶段视频 Profile conformance —— FakeProvider 视频全生命周期。
 * 运行：node tests/video-core-conformance.mjs
 *
 * 冻结并锁定：视频输入（prompt/imgDataUrl/size/duration）、受理边界、长轮询多拍、
 * 交付 Profile（video/mp4 + generated-video + 白名单外媒体类型协议失败）、
 * 交付失败→redeliver 收敛、取消 not_supported 不伪造、受理未知不重提、
 * 崩溃窗口恢复、图片 conformance 零回归。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandService } from '../lib/command-service.js';
import { inspectCoreArtifact, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { activateCoreWatch, inspectCoreTask } from '../lib/core-tasks.js';
import { defineProviderAdapter } from '../lib/provider-adapter.js';
import { DELIVERY_PROFILES, createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { projectCoreTaskUserRow } from '../lib/core-user-projection.js';
import { semanticViolations } from '../lib/task-semantics.js';
import { createFakeLifecycleProvider, FAKE_MP4 } from './fixtures/fake-lifecycle-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const videoSuccess = (url = 'https://fixture.invalid/video.mp4') => ({
  kind: 'succeeded',
  artifacts: [{ kind: 'remote-url', url }] // 远端清单不带 mediaType → Profile 默认 video/mp4
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-video-conformance-'));
try {
  /* 交付 Profile 冻结锁定 */
  assert(DELIVERY_PROFILES.video.kind === 'generated-video'
      && JSON.stringify(DELIVERY_PROFILES.video.mediaTypes) === JSON.stringify(['video/mp4'])
      && DELIVERY_PROFILES.video.defaultMediaType === 'video/mp4'
      && DELIVERY_PROFILES.image.kind === 'generated-image'
      && JSON.stringify(DELIVERY_PROFILES.image.mediaTypes) === JSON.stringify(['image/png']),
    '交付 Profile 必须冻结视频/图片的 kind 与媒体白名单', DELIVERY_PROFILES);

  const dataRoot = path.join(base, 'data');
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
  runtime.start();
  const runner = createProviderTaskRunner(runtime);
  const commandsFor = (fake) => createCommandService(runtime, { resolveTaskAdapter: async () => fake.adapter });

  /* ---------- 长轮询多拍 → 收敛 → video/mp4 Artifact ---------- */
  const mainFake = createFakeLifecycleProvider({
    id: 'video-fake',
    capabilities: ['image', 'video'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-video-main' }],
    pollSteps: [{ kind: 'pending', progress: 'rendering 10%' }, { kind: 'pending', progress: 'rendering 60%' }, videoSuccess()]
  });
  const submitted = await runner.submit({
    capability: 'video',
    candidates: [{ adapter: mainFake.adapter, model: 'video-fake::t2v-v0' }],
    providerInput: { prompt: 'fixture t2v', size: '1280*720', duration: 5 }
  });
  assert(submitted.task.capability === 'video' && submitted.task.acceptance === 'accepted'
      && mainFake.calls.submit.length === 1
      && mainFake.calls.submit[0].input.input.prompt === 'fixture t2v'
      && mainFake.calls.submit[0].input.input.duration === 5,
    '视频提交必须走受理边界并透传冻结输入字段', { task: submitted.task, calls: mainFake.calls });

  const beat1 = await commandsFor(mainFake).execute('task.observe', { task_id: submitted.taskId });
  const beat2 = await commandsFor(mainFake).execute('task.observe', { task_id: submitted.taskId });
  assert(beat1.task.watchState === 'suspended' && beat1.task.outcome === 'none'
      && beat2.task.outcome === 'none' && mainFake.calls.poll.length === 2,
    '长轮询前两拍保持未定论且每拍至多一次 poll', { beat1: beat1.task, beat2: beat2.task });
  assert(semanticViolations(beat1.task).length === 0 && semanticViolations(beat2.task).length === 0,
    '视频长轮询全链语义不变式必须通过');

  const beat3 = await commandsFor(mainFake).execute('task.observe', { task_id: submitted.taskId });
  assert(beat3.task.outcome === 'succeeded' && beat3.task.deliveryState === 'ready'
      && beat3.task.artifactIds.length === 1
      && mainFake.calls.poll.length === 3 && mainFake.calls.download.length === 1
      && mainFake.calls.submit.length === 1,
    '第三拍必须收敛为 video Artifact，零重提', { task: beat3.task, calls: mainFake.calls });
  const artifact = await runtime.run('inspect', ({ dataRoot: root }) =>
    inspectCoreArtifact(root, beat3.task.artifactIds[0]));
  assert(artifact.kind === 'generated-video' && artifact.mediaType === 'video/mp4'
      && artifact.metadata?.taskId === submitted.taskId
      && artifact.metadata?.capability === 'video',
    '视频 Artifact 必须是 generated-video / video/mp4 并挂回 Task', artifact);
  const bytes = await runtime.run('inspect', ({ dataRoot: root }) =>
    readCoreArtifactBytes(root, artifact.id));
  assert(bytes.bytes.equals(FAKE_MP4)
      && artifact.digest.value === crypto.createHash('sha256').update(FAKE_MP4).digest('hex'),
    '视频字节与 manifest hash 必须一致', artifact.digest);

  /* 五类投影对 video capability 的行 DTO 合理 */
  const row = projectCoreTaskUserRow(beat3.task, [artifact]);
  assert(row.capability === 'video' && row.userState === 'succeeded' && row.mediaReady === true
      && row.observable === false && row.cancelable === false && row.redeliverable === false
      && row.retryable === false,
    '视频任务的五类投影与四个动作门必须与图片同构合理', row);

  /* ---------- 交付 Profile 白名单：错媒体类型协议失败，可 redeliver ---------- */
  const typedFake = createFakeLifecycleProvider({
    id: 'video-fake',
    capabilities: ['image', 'video'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-video-typed' }],
    pollSteps: [
      { kind: 'succeeded', artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/wrong.png', mediaType: 'image/png' }] },
      videoSuccess('https://fixture.invalid/right.mp4')
    ]
  });
  const typedTask = await runner.submit({
    capability: 'video',
    candidates: [{ adapter: typedFake.adapter, model: 'video-fake::t2v-v0' }]
  });
  const typedFailed = await commandsFor(typedFake).execute('task.observe', { task_id: typedTask.task.id });
  assert(typedFailed.task.outcome === 'succeeded' && typedFailed.task.deliveryState === 'failed'
      && typedFailed.task.artifactIds.length === 0,
    '白名单外媒体类型必须交付失败且保留远端成功', typedFailed.task);
  const typedFixed = await commandsFor(typedFake).execute('task.redeliver', { task_id: typedTask.task.id });
  assert(typedFixed.task.deliveryState === 'ready'
      && typedFake.calls.submit.length === 1
      && typedFake.calls.poll[1].context?.redelivery === true,
    'redeliver 重新取回视频产物且带 redelivery 标志、零重提', {
      task: typedFixed.task, calls: typedFake.calls
    });

  /* ---------- 交付失败（网络）→ redeliver 收敛；崩溃窗口恢复 ---------- */
  const flakyFake = createFakeLifecycleProvider({
    id: 'video-fake',
    capabilities: ['image', 'video'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-video-flaky' }],
    pollSteps: [videoSuccess(), videoSuccess()],
    downloadSteps: [{ throw: new Error('fixture network cut') }]
  });
  const flakyTask = await runner.submit({
    capability: 'video',
    candidates: [{ adapter: flakyFake.adapter, model: 'video-fake::t2v-v0' }]
  });
  const flakyFailed = await commandsFor(flakyFake).execute('task.observe', { task_id: flakyTask.task.id });
  assert(flakyFailed.task.deliveryState === 'failed' && flakyFailed.task.artifactIds.length === 0,
    '视频下载失败必须回落 failed 且零 Artifact', flakyFailed.task);
  const flakyRedelivered = await commandsFor(flakyFake).execute('task.redeliver', { task_id: flakyTask.task.id });
  assert(flakyRedelivered.task.deliveryState === 'ready' && flakyFake.calls.submit.length === 1,
    '显式 redeliver 收敛视频交付', flakyRedelivered.task);

  /* 崩溃窗口：遗留 active 观察事实后，显式 observe 收口后只 poll 一次 */
  const crashFake = createFakeLifecycleProvider({
    id: 'video-fake',
    capabilities: ['image', 'video'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-video-crash' }],
    pollSteps: [videoSuccess()]
  });
  const crashTask = await runner.submit({
    capability: 'video',
    candidates: [{ adapter: crashFake.adapter, model: 'video-fake::t2v-v0' }]
  });
  await runtime.run('execute', ({ dataRoot: root }) => activateCoreWatch(root, crashTask.task.id));
  const crashedResumed = await commandsFor(crashFake).execute('task.reobserve', { task_id: crashTask.task.id });
  assert(crashedResumed.task.outcome === 'succeeded' && crashedResumed.task.deliveryState === 'ready'
      && crashFake.calls.poll.length === 1 && crashFake.calls.submit.length === 1,
    'active 崩溃恢复只能收口后 poll 一次', { task: crashedResumed.task, calls: crashFake.calls });

  /* ---------- 取消 not_supported：outcome 绝不伪造 canceled ---------- */
  const noCancelAdapter = defineProviderAdapter({
    id: 'video-fake',
    protocol: 'fixture',
    capabilities: ['image', 'video'],
    operations: {
      submit: async () => { throw new Error('此 adapter 不得被用于提交'); },
      poll: async () => ({ kind: 'pending', progress: 'fixture-running' }),
      mapError: (error, context) => ({ raw: String(error), ...context })
    },
    unsupported: {
      discover: 'fixture 无需发现',
      cancel: 'fixture 视频协议没有远端取消实现',
      download: '此 adapter 只用于观察已有任务'
    }
  });
  const runningFake = createFakeLifecycleProvider({
    id: 'video-fake',
    capabilities: ['image', 'video'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-video-running' }],
    pollSteps: [videoSuccess()]
  });
  const runningTask = await runner.submit({
    capability: 'video',
    candidates: [{ adapter: runningFake.adapter, model: 'video-fake::t2v-v0' }]
  });
  const cancelled = await createCommandService(runtime, { resolveTaskAdapter: async () => noCancelAdapter })
    .execute('task.cancel', { task_id: runningTask.task.id });
  assert(cancelled.task.outcome === 'none' && cancelled.task.cancelState === 'none'
      && cancelled.task.phase !== 'terminal',
    '视频不支持取消时必须保持真实状态、绝不伪造 canceled', cancelled.task);
  const convergedAfterCancel = await commandsFor(runningFake).execute('task.reobserve', { task_id: runningTask.task.id });
  assert(convergedAfterCancel.task.outcome === 'succeeded',
    '不支持取消的视频任务仍可显式收敛', convergedAfterCancel.task);

  /* ---------- 受理未知：零重提 ---------- */
  const unknownFake = createFakeLifecycleProvider({
    id: 'video-fake',
    capabilities: ['image', 'video'],
    submitSteps: [{ kind: 'acceptance_unknown', error: 'fixture response lost' }]
  });
  const unknown = await runner.submit({
    capability: 'video',
    candidates: [{ adapter: unknownFake.adapter, model: 'video-fake::t2v-v0' }]
  });
  assert(unknown.task.acceptance === 'unknown' && unknown.task.phase === 'terminal'
      && unknownFake.calls.submit.length === 1 && unknownFake.calls.poll.length === 0,
    '视频受理未知必须停止候选链且零观察调用', unknown.task);

  console.log('ALL OK —— 视频 Profile conformance：长轮询、mp4 交付、白名单、redeliver、取消不伪造、崩溃恢复、受理未知');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
