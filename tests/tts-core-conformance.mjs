/**
 * E2 阶段 TTS Profile conformance —— 同步完成型语音全生命周期。
 * 运行：node tests/tts-core-conformance.mjs
 *
 * 冻结并锁定：输入 {text, voice}、同步 completed 同一次调用内交付
 * generated-audio Artifact（inline-base64 与 remote-url 两种产物形态）、
 * 字节 hash 一致、四门对终态全部拒绝、白名单外媒体类型协议失败、
 * 受理失败/未知语义、终态失败可 retry 为新任务。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandService } from '../lib/command-service.js';
import { inspectCoreArtifact, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { DELIVERY_PROFILES, createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { projectCoreTaskUserRow } from '../lib/core-user-projection.js';
import { semanticViolations } from '../lib/task-semantics.js';
import { createFakeLifecycleProvider, FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-tts-conformance-'));
try {
  /* 交付 Profile 冻结锁定 */
  assert(DELIVERY_PROFILES.tts.kind === 'generated-audio'
      && JSON.stringify(DELIVERY_PROFILES.tts.mediaTypes) === JSON.stringify(['audio/mpeg', 'audio/wav'])
      && DELIVERY_PROFILES.tts.defaultMediaType === 'audio/mpeg',
    'TTS 交付 Profile 必须冻结 generated-audio 与音频白名单', DELIVERY_PROFILES.tts);

  const dataRoot = path.join(base, 'data');
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
  runtime.start();
  const runner = createProviderTaskRunner(runtime);
  const commandsFor = (fake) => createCommandService(runtime, { resolveTaskAdapter: async () => fake.adapter });

  /* ---------- 同步完成：一次 submit 内完成交付（inline-base64 形态） ---------- */
  const inlineFake = createFakeLifecycleProvider({ id: 'tts-fake', capabilities: ['image', 'video', 'tts'] });
  const submitted = await runner.submit({
    capability: 'tts',
    candidates: [{ adapter: inlineFake.adapter, model: 'tts-fake::qwen-tts-v0' }],
    providerInput: { text: '你好，鸢尾', voice: 'Cherry' }
  });
  assert(submitted.task.capability === 'tts'
      && submitted.task.outcome === 'succeeded' && submitted.task.deliveryState === 'ready'
      && submitted.task.phase === 'terminal' && submitted.task.artifactIds.length === 1
      && inlineFake.calls.submit.length === 1 && inlineFake.calls.poll.length === 0,
    'TTS 同步完成必须一次 submit 内交付，绝不 poll', { task: submitted.task, calls: inlineFake.calls });
  assert(inlineFake.calls.submit[0].input.input.text === '你好，鸢尾'
      && inlineFake.calls.submit[0].input.input.voice === 'Cherry',
    '冻结输入字段 text/voice 必须透传', inlineFake.calls.submit[0].input.input);
  assert(semanticViolations(submitted.task).length === 0, 'TTS 终态必须符合语义轴', submitted.task);

  const artifact = await runtime.run('inspect', ({ dataRoot: root }) =>
    inspectCoreArtifact(root, submitted.task.artifactIds[0]));
  const bytes = await runtime.run('inspect', ({ dataRoot: root }) =>
    readCoreArtifactBytes(root, artifact.id));
  assert(artifact.kind === 'generated-audio' && artifact.mediaType === 'audio/mpeg'
      && artifact.metadata?.capability === 'tts' && artifact.metadata?.taskId === submitted.taskId
      && bytes.bytes.equals(FAKE_WAV)
      && artifact.digest.value === crypto.createHash('sha256').update(FAKE_WAV).digest('hex'),
    'inline-base64 音频必须物化为 generated-audio 且 hash 一致', artifact);

  /* 五类投影与四门：终态 ready 全关 */
  const row = projectCoreTaskUserRow(submitted.task, [artifact]);
  assert(row.capability === 'tts' && row.userState === 'succeeded' && row.mediaReady === true
      && !row.observable && !row.cancelable && !row.redeliverable && !row.retryable,
    '同步完成的 TTS 任务四个动作门必须全部关闭', row);

  /* ---------- 四门对终态全部拒绝且零 Provider 调用 ---------- */
  const frozen = () => [inlineFake.calls.poll.length, inlineFake.calls.download.length, inlineFake.calls.submit.length, inlineFake.calls.cancel.length].join(':');
  for (const [command, code] of [
    ['task.reobserve', 'IRIS_TASK_NOT_OBSERVABLE'],
    ['task.redeliver', 'IRIS_TASK_NOT_REDELIVERABLE'],
    ['task.cancel', 'IRIS_TASK_NOT_CANCELABLE']
  ]) {
    const before = frozen();
    let error;
    try { await commandsFor(inlineFake).execute(command, { task_id: submitted.taskId }); } catch (caught) { error = caught; }
    assert(error?.code === code && frozen() === before,
      '终态 TTS 的 ' + command + ' 必须拒绝且零调用', { command, code: error?.code });
  }

  /* ---------- remote-url 形态：download 物化 ---------- */
  const remoteFake = createFakeLifecycleProvider({
    id: 'tts-fake',
    capabilities: ['tts'],
    submitSteps: [{
      kind: 'completed',
      value: { kind: 'audio' },
      artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/voice.mp3', mediaType: 'audio/mpeg' }]
    }]
  });
  const remoteSubmitted = await runner.submit({
    capability: 'tts',
    candidates: [{ adapter: remoteFake.adapter, model: 'tts-fake::qwen-tts-v0' }],
    providerInput: { text: 'remote url voice', voice: 'Cherry' }
  });
  assert(remoteSubmitted.task.deliveryState === 'ready' && remoteFake.calls.download.length === 1,
    'remote-url 音频必须经 download 物化', remoteSubmitted.task);
  const remoteBytes = await runtime.run('inspect', ({ dataRoot: root }) =>
    readCoreArtifactBytes(root, remoteSubmitted.task.artifactIds[0]));
  assert(remoteBytes.bytes.equals(FAKE_WAV), 'remote-url 下载字节必须一致');

  /* ---------- 白名单外媒体类型：协议失败 → 终态失败可 retry ---------- */
  const badMediaFake = createFakeLifecycleProvider({
    id: 'tts-fake',
    capabilities: ['tts'],
    submitSteps: [{
      kind: 'completed',
      value: { kind: 'audio' },
      artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/voice.mp4', mediaType: 'video/mp4' }]
    }]
  });
  const badMedia = await runner.submit({
    capability: 'tts',
    candidates: [{ adapter: badMediaFake.adapter, model: 'tts-fake::qwen-tts-v0' }],
    providerInput: { text: 'wrong media', voice: 'Cherry' }
  });
  assert(badMedia.task.outcome === 'succeeded' && badMedia.task.deliveryState === 'failed'
      && badMedia.task.artifactIds.length === 0,
    '白名单外媒体类型必须交付失败且零 Artifact', badMedia.task);
  assert(badMedia.task.remoteTaskId === undefined || !badMedia.task.remoteTaskId,
    '同步 TTS 没有远端任务 ID', badMedia.task);
  let redeliverError;
  try { await commandsFor(badMediaFake).execute('task.redeliver', { task_id: badMedia.taskId }); } catch (caught) { redeliverError = caught; }
  assert(redeliverError?.code === 'IRIS_TASK_NOT_REDELIVERABLE',
    '同步 TTS 无远端 ID，redeliver 必须拒绝（恢复走 retry）', redeliverError?.code);
  const retryFake = createFakeLifecycleProvider({ id: 'tts-fake', capabilities: ['tts'] });
  const retried = await createCommandService(runtime, {
    resolveTaskCandidates: async () => [{ adapter: retryFake.adapter, model: 'tts-fake::qwen-tts-v0' }]
  }).execute('task.retry', {
    task_id: badMedia.taskId,
    provider_input: { text: 'wrong media', voice: 'Cherry' },
    confirm_billing: true
  });
  assert(retried.task.retriedFrom === badMedia.taskId && retried.task.deliveryState === 'ready'
      && retried.task.artifactIds.length === 1 && retryFake.calls.submit.length === 1,
    '终态失败的 TTS 可显式 retry 为新任务并收敛', retried.task);

  /* ---------- 受理失败/未知语义 ---------- */
  const refuseFake = createFakeLifecycleProvider({
    id: 'tts-fake',
    capabilities: ['tts'],
    submitSteps: [{ kind: 'not_accepted', error: 'fixture capacity full' }]
  });
  const refused = await runner.submit({
    capability: 'tts',
    candidates: [{ adapter: refuseFake.adapter, model: 'tts-fake::qwen-tts-v0' }]
  });
  assert(refused.task.acceptance === 'not_accepted' && refused.task.phase === 'terminal'
      && refuseFake.calls.submit.length === 1 && refuseFake.calls.poll.length === 0,
    '明确未受理必须收口终态且零观察调用', refused.task);
  const unknownFake = createFakeLifecycleProvider({
    id: 'tts-fake',
    capabilities: ['tts'],
    submitSteps: [{ kind: 'acceptance_unknown', error: 'fixture response lost' }]
  });
  const unknown = await runner.submit({
    capability: 'tts',
    candidates: [{ adapter: unknownFake.adapter, model: 'tts-fake::qwen-tts-v0' }]
  });
  assert(unknown.task.acceptance === 'unknown' && unknown.task.outcome === 'unknown'
      && unknownFake.calls.submit.length === 1 && unknownFake.calls.poll.length === 0,
    '受理未知必须保留证据且零重提', unknown.task);

  console.log('ALL OK —— TTS Profile conformance：同步交付、两种产物形态、四门锁定、白名单、retry 收敛');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
