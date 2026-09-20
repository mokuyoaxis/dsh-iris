'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCoreArtifact } from './core-artifacts.js';
import {
  activateCoreWatch,
  beginCoreAttempt,
  beginCoreDelivery,
  completeCoreDelivery,
  createCoreTask,
  failCoreDelivery,
  finalizeCoreNoAcceptance,
  inspectCoreTask,
  prepareCoreRedelivery,
  recordCoreAttemptResult,
  recordCoreCancelResult,
  recordCoreDownloadCompleted,
  recordCorePollResult,
  recordCoreWatchError,
  recoverCoreTask,
  requestCoreCancel
} from './core-tasks.js';
import { ensurePrivateDir } from './private-storage.js';
import { parseModelRef } from './models.js';
import {
  hasProviderOperation,
  invokeProviderOperation
} from './provider-adapter.js';
import { providerErrorRecord, submitWithAcceptanceBoundary } from './provider-contract.js';

export const PROVIDER_TASK_RUNNER_VERSION = 0;

/**
 * 按 capability 冻结的交付 Profile（E 阶段视频迁移）：媒体类型白名单、Artifact
 * kind 与默认 metadata。新增 capability 必须显式登记；未登记的 capability 直接
 * 失败，不会按图片语义猜。
 */
export const DELIVERY_PROFILES = Object.freeze({
  image: Object.freeze({ kind: 'generated-image', mediaTypes: Object.freeze(['image/png']), defaultMediaType: 'image/png' }),
  video: Object.freeze({ kind: 'generated-video', mediaTypes: Object.freeze(['video/mp4']), defaultMediaType: 'video/mp4' }),
  // TTS 同步完成型：submit 内 completed → 同一次调用直接交付（无 remote 长轮询）。
  tts: Object.freeze({ kind: 'generated-audio', mediaTypes: Object.freeze(['audio/mpeg', 'audio/wav']), defaultMediaType: 'audio/mpeg' }),
  // 转写上传型异步：受理 + remoteTaskId → 长轮询 → 文本物化为 UTF-8 Artifact。
  transcribe: Object.freeze({ kind: 'transcript', mediaTypes: Object.freeze(['text/plain']), defaultMediaType: 'text/plain' })
});
const runtimeTaskGates = new WeakMap();

export class ProviderTaskRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderTaskRunnerError';
    this.code = code;
  }
}

function checkRuntime(runtime) {
  if (!runtime || typeof runtime.run !== 'function') {
    throw new TypeError('Provider Task Runner 需要已创建的 Core Runtime');
  }
}

function checkAdapterForTask(task, adapter) {
  if (!adapter || adapter.id !== task.providerId) {
    throw new ProviderTaskRunnerError('IRIS_PROVIDER_TASK_IDENTITY_MISMATCH', 'Provider Adapter 与 Task 已持久化身份不一致');
  }
  return adapter;
}

function normalizedCandidates(capability, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) throw new TypeError('至少需要一个 Provider 候选');
  return candidates.map((candidate, index) => {
    const adapter = candidate?.adapter;
    const model = String(candidate?.model || '').trim();
    const parsed = parseModelRef(model);
    const selectionReason = candidate?.selectionReason;
    if (!adapter || !adapter.capabilities?.includes(capability) || !parsed
        || parsed.providerId !== adapter.id || !parsed.modelId
        || (candidate.providerBinding !== undefined && !/^sha256:[a-f0-9]{64}$/.test(candidate.providerBinding))
        || (selectionReason !== undefined && !['explicit', 'assignment', 'pool'].includes(selectionReason))) {
      throw new TypeError('Provider 候选 ' + (index + 1) + ' 不支持 Task capability 或模型复合身份无效');
    }
    return { adapter, model, providerModel: parsed.modelId, providerBinding: candidate.providerBinding, selectionReason };
  });
}

function stagingFile(dataRoot) {
  const directory = path.join(dataRoot, 'provider-staging', 'v0');
  ensurePrivateDir(directory);
  return path.join(directory, 'download-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.part');
}

async function deliverArtifacts(dataRoot, taskId, adapter, remoteArtifacts, signal) {
  beginCoreDelivery(dataRoot, taskId);
  const artifactIds = [];
  const stagedFiles = [];
  try {
    if (!Array.isArray(remoteArtifacts) || remoteArtifacts.length === 0) {
      throw Object.assign(new Error('Provider Task Runner 没有收到可物化产物'), {
        stage: 'download', category: 'protocol', acceptance: 'accepted'
      });
    }
    const task = inspectCoreTask(dataRoot, taskId);
    const profile = DELIVERY_PROFILES[task.capability];
    if (!profile) {
      throw Object.assign(new Error('Provider Task Runner 没有该 capability 的交付 Profile：' + task.capability), {
        stage: 'download', category: 'protocol', acceptance: 'accepted'
      });
    }
    for (const remote of remoteArtifacts) {
      const mediaType = String(remote.mediaType || profile.defaultMediaType);
      if (!profile.mediaTypes.includes(mediaType)) {
        throw Object.assign(new Error('Provider Task Runner 交付媒体类型不在 Profile 白名单：' + mediaType), {
          stage: 'download', category: 'protocol', acceptance: 'accepted'
        });
      }
      const target = stagingFile(dataRoot);
      stagedFiles.push({ target, mediaType });
      const downloaded = await invokeProviderOperation(adapter, 'download', {
        capability: task.capability,
        artifact: remote,
        targetPath: target,
        signal
      }, { signal, taskId });
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== downloaded.bytes) {
        throw Object.assign(new Error('Provider 物化结果与文件证据不一致'), {
          stage: 'download', category: 'local_io', acceptance: 'accepted'
        });
      }
    }
    recordCoreDownloadCompleted(dataRoot, taskId);
    for (const staged of stagedFiles) {
      const artifact = createCoreArtifact(dataRoot, {
        kind: profile.kind,
        mediaType: staged.mediaType,
        bytes: fs.readFileSync(staged.target),
        metadata: { taskId, capability: task.capability }
      });
      artifactIds.push(artifact.id);
    }
    return completeCoreDelivery(dataRoot, taskId, artifactIds);
  } catch (error) {
    return failCoreDelivery(dataRoot, taskId, error);
  } finally {
    for (const staged of stagedFiles) {
      try { fs.rmSync(staged.target, { force: true }); } catch (_) { /* 后续显式清理可处理残留 */ }
    }
  }
}

async function observeWithinRoot(dataRoot, taskId, adapter, signal) {
  const before = inspectCoreTask(dataRoot, taskId);
  checkAdapterForTask(before, adapter);
  activateCoreWatch(dataRoot, taskId);
  let result;
  try {
    result = await invokeProviderOperation(adapter, 'poll', {
      capability: before.capability,
      remoteTaskId: before.remoteTaskId,
      signal
    }, { signal, taskId });
  } catch (error) {
    return recordCoreWatchError(dataRoot, taskId, error);
  }
  const recorded = recordCorePollResult(dataRoot, taskId, result);
  if (result.kind !== 'succeeded') return recorded;
  return deliverArtifacts(dataRoot, taskId, adapter, result.artifacts, signal);
}

/**
 * FakeProvider 与未来真实 Host 共用的生命周期调度候选。它不拥有 timer，也不会
 * 自动循环轮询；每次 observe 只消费一个 poll 结果，使重启和故障边界可重复验证。
 */
export function createProviderTaskRunner(runtime) {
  checkRuntime(runtime);
  let activeTasks = runtimeTaskGates.get(runtime);
  if (!activeTasks) {
    activeTasks = new Set();
    runtimeTaskGates.set(runtime, activeTasks);
  }

  async function runExclusive(taskId, operation, callback) {
    const key = String(taskId || '');
    if (activeTasks.has(key)) {
      throw new ProviderTaskRunnerError(
        'IRIS_PROVIDER_TASK_BUSY',
        '该 Task 已有生命周期操作正在执行'
      );
    }
    activeTasks.add(key);
    try {
      return await runtime.run(operation, callback);
    } finally {
      activeTasks.delete(key);
    }
  }

  async function submit(input = {}) {
    return runtime.run('execute', async ({ dataRoot, signal }) => {
      const capability = String(input.capability || '').trim();
      const candidates = normalizedCandidates(capability, input.candidates);
      const task = createCoreTask(dataRoot, { capability, retriedFrom: input.retriedFrom });
      const wrapped = candidates.map(({ adapter, model, providerModel }) => ({
        id: adapter.id,
        model,
        adapter,
        submit: (providerInput, context) => invokeProviderOperation(
          adapter,
          'submit',
          { capability, model: providerModel, input: providerInput, signal },
          { ...context, signal, taskId: task.id }
        )
      }));
      const submitted = await submitWithAcceptanceBoundary(wrapped, input.providerInput ?? {}, {
        beforeAttempt: async (attempt) => {
          const candidate = candidates[attempt.ordinal - 1];
          return beginCoreAttempt(dataRoot, task.id, {
            ...attempt,
            ...(candidate.providerBinding !== undefined ? { providerBinding: candidate.providerBinding } : {}),
            ...(candidate.selectionReason !== undefined ? { selectionReason: candidate.selectionReason } : {})
          });
        },
        afterResult: async (attempt) => recordCoreAttemptResult(dataRoot, task.id, attempt)
      });
      if (submitted.localError) {
        return Object.freeze({ taskId: task.id, task: inspectCoreTask(dataRoot, task.id), localError: submitted.localError });
      }
      if (!submitted.result) throw new Error('Provider 提交流程没有返回结果');
      if (submitted.result.kind === 'not_accepted') {
        finalizeCoreNoAcceptance(dataRoot, task.id, submitted.result.error);
      } else if (submitted.result.kind === 'completed') {
        const artifacts = submitted.result.artifacts;
        return Object.freeze({
          taskId: task.id,
          task: await deliverArtifacts(dataRoot, task.id, submitted.candidate.adapter, artifacts, signal),
          attempts: submitted.attempts
        });
      }
      return Object.freeze({
        taskId: task.id,
        task: inspectCoreTask(dataRoot, task.id),
        attempts: submitted.attempts
      });
    });
  }

  function inspect(taskId) {
    return runtime.run('inspect', ({ dataRoot }) => inspectCoreTask(dataRoot, taskId));
  }

  function observe(taskId, adapter, { resumeActive = false } = {}) {
    return runExclusive(taskId, 'execute', ({ dataRoot, signal }) => {
      if (resumeActive) {
        const current = inspectCoreTask(dataRoot, taskId);
        checkAdapterForTask(current, adapter);
        if (current.watchState === 'active') recoverCoreTask(dataRoot, taskId);
      }
      return observeWithinRoot(dataRoot, taskId, adapter, signal);
    });
  }

  function redeliver(taskId, adapter) {
    return runExclusive(taskId, 'execute', async ({ dataRoot, signal }) => {
      const task = inspectCoreTask(dataRoot, taskId);
      checkAdapterForTask(task, adapter);
      prepareCoreRedelivery(dataRoot, taskId);
      let result;
      try {
        result = await invokeProviderOperation(adapter, 'poll', {
          capability: task.capability,
          remoteTaskId: task.remoteTaskId,
          signal
        }, { signal, taskId, redelivery: true });
      } catch (error) {
        return failCoreDelivery(dataRoot, taskId, error);
      }
      if (result.kind !== 'succeeded') {
        return failCoreDelivery(dataRoot, taskId, providerErrorRecord(
          result.error || '重新查询没有得到可交付产物',
          { stage: 'download', category: 'protocol', acceptance: 'accepted' }
        ));
      }
      return deliverArtifacts(dataRoot, taskId, adapter, result.artifacts, signal);
    });
  }

  function cancel(taskId, adapter) {
    return runExclusive(taskId, 'execute', async ({ dataRoot, signal }) => {
      const task = inspectCoreTask(dataRoot, taskId);
      checkAdapterForTask(task, adapter);
      requestCoreCancel(dataRoot, taskId);
      if (!hasProviderOperation(adapter, 'cancel')) {
        return recordCoreCancelResult(dataRoot, taskId, { kind: 'not_supported' });
      }
      const result = await invokeProviderOperation(adapter, 'cancel', {
        capability: task.capability,
        remoteTaskId: task.remoteTaskId,
        signal
      }, { signal, taskId });
      return recordCoreCancelResult(dataRoot, taskId, result);
    });
  }

  function recover(taskId, adapter) {
    return runExclusive(taskId, 'recover', async ({ dataRoot, signal }) => {
      const recovered = recoverCoreTask(dataRoot, taskId);
      if (recovered.acceptance === 'accepted' && recovered.remoteTaskId
          && recovered.outcome === 'none'
          && ['accepted', 'running'].includes(recovered.phase)) {
        checkAdapterForTask(recovered, adapter);
        return observeWithinRoot(dataRoot, taskId, adapter, signal);
      }
      return recovered;
    });
  }

  return Object.freeze({
    version: PROVIDER_TASK_RUNNER_VERSION,
    submit,
    inspect,
    observe,
    redeliver,
    cancel,
    recover
  });
}
