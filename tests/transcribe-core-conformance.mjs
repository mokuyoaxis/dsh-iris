/**
 * E3 阶段转写 Profile conformance —— 上传型异步转写全生命周期。
 * 运行：node tests/transcribe-core-conformance.mjs
 *
 * 冻结并锁定：输入 {audioUrl}（签名 URL 不落 Core）、受理 + remoteTaskId、
 * 长轮询多拍、正文物化为 text/plain transcript Artifact（inline-base64）、
 * 字节 hash 一致、取消 not_supported 不伪造、受理未知零重提、崩溃窗口恢复、
 * retry 用 audio_url 重新提交。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandService } from '../lib/command-service.js';
import { inspectCoreArtifact, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { activateCoreWatch } from '../lib/core-tasks.js';
import { defineProviderAdapter } from '../lib/provider-adapter.js';
import { DELIVERY_PROFILES, createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { projectCoreTaskUserRow } from '../lib/core-user-projection.js';
import { semanticViolations } from '../lib/task-semantics.js';
import { createFakeLifecycleProvider, FAKE_TRANSCRIPT } from './fixtures/fake-lifecycle-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const transcriptSuccess = () => ({
  kind: 'succeeded',
  value: { kind: 'text', text: FAKE_TRANSCRIPT.toString('utf8') },
  artifacts: [{ kind: 'inline-base64', data: FAKE_TRANSCRIPT.toString('base64'), mediaType: 'text/plain' }]
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-transcribe-conformance-'));
try {
  /* 交付 Profile 冻结锁定 */
  assert(DELIVERY_PROFILES.transcribe.kind === 'transcript'
      && JSON.stringify(DELIVERY_PROFILES.transcribe.mediaTypes) === JSON.stringify(['text/plain'])
      && DELIVERY_PROFILES.transcribe.defaultMediaType === 'text/plain',
    '转写交付 Profile 必须冻结 transcript 与 text/plain 白名单', DELIVERY_PROFILES.transcribe);

  const dataRoot = path.join(base, 'data');
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
  runtime.start();
  const runner = createProviderTaskRunner(runtime);
  const commandsFor = (fake) => createCommandService(runtime, { resolveTaskAdapter: async () => fake.adapter });

  /* ---------- 受理 + 长轮询 → 文本物化 ---------- */
  const mainFake = createFakeLifecycleProvider({
    id: 'transcribe-fake',
    capabilities: ['transcribe'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-asr-main' }],
    pollSteps: [{ kind: 'pending', progress: 'recognizing' }, transcriptSuccess()]
  });
  const submitted = await runner.submit({
    capability: 'transcribe',
    candidates: [{ adapter: mainFake.adapter, model: 'transcribe-fake::asr-v0' }],
    providerInput: { audioUrl: 'oss://fixture-bucket/private/signed-audio-url?Expires=9999' }
  });
  assert(submitted.task.capability === 'transcribe' && submitted.task.acceptance === 'accepted'
      && submitted.task.remoteTaskId === 'remote-asr-main'
      && mainFake.calls.submit.length === 1
      && mainFake.calls.submit[0].input.input.audioUrl.includes('oss://'),
    '转写提交必须走受理边界并透传 audioUrl', { task: submitted.task, calls: mainFake.calls });

  const beat1 = await commandsFor(mainFake).execute('task.observe', { task_id: submitted.taskId });
  assert(beat1.task.outcome === 'none' && mainFake.calls.poll.length === 1,
    '转写长轮询第一拍保持未定论', beat1.task);
  const beat2 = await commandsFor(mainFake).execute('task.observe', { task_id: submitted.taskId });
  assert(beat2.task.outcome === 'succeeded' && beat2.task.deliveryState === 'ready'
      && beat2.task.artifactIds.length === 1
      && mainFake.calls.poll.length === 2 && mainFake.calls.download.length === 1
      && mainFake.calls.submit.length === 1,
    '第二拍必须收敛为文本 Artifact，零重提', { task: beat2.task, calls: mainFake.calls });

  const artifact = await runtime.run('inspect', ({ dataRoot: root }) =>
    inspectCoreArtifact(root, beat2.task.artifactIds[0]));
  const bytes = await runtime.run('inspect', ({ dataRoot: root }) =>
    readCoreArtifactBytes(root, artifact.id));
  assert(artifact.kind === 'transcript' && artifact.mediaType === 'text/plain'
      && artifact.metadata?.capability === 'transcribe'
      && bytes.bytes.equals(FAKE_TRANSCRIPT)
      && artifact.digest.value === crypto.createHash('sha256').update(FAKE_TRANSCRIPT).digest('hex'),
    '转写正文必须物化为 transcript Artifact 且 hash 一致', artifact);

  /* Core 记录不持久化签名 URL（铁律） */
  const recordBytes = fs.readFileSync(
    path.join(dataRoot, 'task-store', 'v0', 'tasks', submitted.taskId + '.json'), 'utf8');
  assert(!recordBytes.includes('oss://') && !recordBytes.includes('signed-audio-url'),
    'Core 转写记录不得持久化签名/临时音频地址');

  /* 五类投影对 transcribe 行合理（完成态四门全关） */
  const row = projectCoreTaskUserRow(beat2.task, [artifact]);
  assert(row.capability === 'transcribe' && row.userState === 'succeeded' && row.mediaReady === true
      && !row.observable && !row.cancelable && !row.redeliverable && !row.retryable,
    '转写任务的五类投影与四个动作门必须合理', row);

  /* ---------- 白名单外媒体类型：协议失败 → redeliver ---------- */
  const typedFake = createFakeLifecycleProvider({
    id: 'transcribe-fake',
    capabilities: ['transcribe'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-asr-typed' }],
    pollSteps: [
      { kind: 'succeeded', artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/wrong.json', mediaType: 'application/json' }] },
      transcriptSuccess()
    ]
  });
  const typedTask = await runner.submit({
    capability: 'transcribe',
    candidates: [{ adapter: typedFake.adapter, model: 'transcribe-fake::asr-v0' }],
    providerInput: { audioUrl: 'https://fixture.invalid/audio.wav' }
  });
  const typedFailed = await commandsFor(typedFake).execute('task.observe', { task_id: typedTask.task.id });
  assert(typedFailed.task.outcome === 'succeeded' && typedFailed.task.deliveryState === 'failed'
      && typedFailed.task.artifactIds.length === 0,
    '白名单外媒体类型必须交付失败且零 Artifact', typedFailed.task);
  const typedFixed = await commandsFor(typedFake).execute('task.redeliver', { task_id: typedTask.task.id });
  assert(typedFixed.task.deliveryState === 'ready'
      && typedFake.calls.submit.length === 1
      && typedFake.calls.poll[1].context?.redelivery === true,
    'redeliver 重新取回转写正文且带 redelivery 标志、零重提', typedFixed.task);

  /* ---------- 崩溃窗口恢复 ---------- */
  const crashFake = createFakeLifecycleProvider({
    id: 'transcribe-fake',
    capabilities: ['transcribe'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-asr-crash' }],
    pollSteps: [transcriptSuccess()]
  });
  const crashTask = await runner.submit({
    capability: 'transcribe',
    candidates: [{ adapter: crashFake.adapter, model: 'transcribe-fake::asr-v0' }],
    providerInput: { audioUrl: 'https://fixture.invalid/audio.wav' }
  });
  await runtime.run('execute', ({ dataRoot: root }) => activateCoreWatch(root, crashTask.task.id));
  const crashedResumed = await commandsFor(crashFake).execute('task.reobserve', { task_id: crashTask.task.id });
  assert(crashedResumed.task.deliveryState === 'ready'
      && crashFake.calls.poll.length === 1 && crashFake.calls.submit.length === 1,
    'active 崩溃恢复只能收口后 poll 一次', { task: crashedResumed.task, calls: crashFake.calls });

  /* ---------- 取消 not_supported：不伪造已取消 ---------- */
  const noCancelAdapter = defineProviderAdapter({
    id: 'transcribe-fake',
    protocol: 'fixture',
    capabilities: ['transcribe'],
    operations: {
      submit: async () => { throw new Error('此 adapter 不得被用于提交'); },
      poll: async () => ({ kind: 'pending', progress: 'fixture-running' }),
      mapError: (error, context) => ({ raw: String(error), ...context })
    },
    unsupported: {
      discover: 'fixture 无需发现',
      cancel: 'fixture 转写协议没有远端取消实现',
      download: '此 adapter 只用于观察已有任务'
    }
  });
  const runningFake = createFakeLifecycleProvider({
    id: 'transcribe-fake',
    capabilities: ['transcribe'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-asr-running' }],
    pollSteps: [transcriptSuccess()]
  });
  const runningTask = await runner.submit({
    capability: 'transcribe',
    candidates: [{ adapter: runningFake.adapter, model: 'transcribe-fake::asr-v0' }],
    providerInput: { audioUrl: 'https://fixture.invalid/audio.wav' }
  });
  const cancelled = await createCommandService(runtime, { resolveTaskAdapter: async () => noCancelAdapter })
    .execute('task.cancel', { task_id: runningTask.task.id });
  assert(cancelled.task.outcome === 'none' && cancelled.task.cancelState === 'none'
      && cancelled.task.phase !== 'terminal',
    '转写不支持取消时必须保持真实状态、绝不伪造已取消', cancelled.task);
  const convergedAfterCancel = await commandsFor(runningFake).execute('task.reobserve', { task_id: runningTask.task.id });
  assert(convergedAfterCancel.task.outcome === 'succeeded',
    '不支持取消的转写任务仍可显式收敛', convergedAfterCancel.task);

  /* ---------- 受理未知零重提 ---------- */
  const unknownFake = createFakeLifecycleProvider({
    id: 'transcribe-fake',
    capabilities: ['transcribe'],
    submitSteps: [{ kind: 'acceptance_unknown', error: 'fixture response lost' }]
  });
  const unknown = await runner.submit({
    capability: 'transcribe',
    candidates: [{ adapter: unknownFake.adapter, model: 'transcribe-fake::asr-v0' }],
    providerInput: { audioUrl: 'https://fixture.invalid/audio.wav' }
  });
  assert(unknown.task.acceptance === 'unknown' && unknown.task.phase === 'terminal'
      && unknownFake.calls.submit.length === 1 && unknownFake.calls.poll.length === 0,
    '转写受理未知必须停止候选链且零观察调用', unknown.task);

  /* ---------- retry 用 audio_url 重新提交 ---------- */
  let missingAudio;
  try {
    await commandsFor(unknownFake).execute('task.retry', {
      task_id: unknown.task.id,
      provider_input: { prompt: 'wrong field' },
      confirm_billing: true
    });
  } catch (error) { missingAudio = error; }
  assert(missingAudio?.code === 'IRIS_COMMAND_INPUT_INVALID' && /audio_url/.test(missingAudio.message),
    '转写 retry 必须要求重新提供 audio_url', missingAudio?.code);
  const retryFake = createFakeLifecycleProvider({
    id: 'transcribe-fake',
    capabilities: ['transcribe'],
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-asr-retry' }],
    pollSteps: [transcriptSuccess()]
  });
  const retried = await createCommandService(runtime, {
    resolveTaskCandidates: async () => [{ adapter: retryFake.adapter, model: 'transcribe-fake::asr-v0' }]
  }).execute('task.retry', {
    task_id: unknown.task.id,
    provider_input: { audio_url: 'https://fixture.invalid/retry-audio.wav' },
    confirm_billing: true
  });
  assert(retried.task.retriedFrom === unknown.task.id && retried.task.capability === 'transcribe'
      && retryFake.calls.submit.length === 1,
    '转写 retry 必须创建全新任务并记录单向关系', retried.task);

  console.log('ALL OK —— 转写 Profile conformance：上传型异步、文本物化、白名单、redeliver、取消不伪造、retry');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
