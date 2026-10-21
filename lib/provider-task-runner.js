'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { adoptCoreArtifactFile, createCoreArtifact } from './core-artifacts.js';
import {
  activateCoreWatch,
  beginCoreAttempt,
  beginCoreDelivery,
  completeCoreDelivery,
  createCoreTask,
  claimFlowTask,
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
import { ProviderContractError, providerErrorRecord, submitWithAcceptanceBoundary } from './provider-contract.js';
import { imageEditCandidates, readImageEditArtifact } from './image-edit-input.js';
import { createDeliveryCache, newDeliveryPayloadPath, readDeliveryCache,
  readDeliveryPayload, recordDeliveryPayload } from './core-delivery-cache.js';
import { readFlowRun, flowFail } from './flow-store.js';
import { normalizeGenerationInput } from './generation-input.js';

export const PROVIDER_TASK_RUNNER_VERSION = 0;

/**
 * 按 capability 冻结的交付 Profile（E 阶段视频迁移）：媒体类型白名单、Artifact
 * kind 与默认 metadata。新增 capability 必须显式登记；未登记的 capability 直接
 * 失败，不会按图片语义猜。
 */
export const DELIVERY_PROFILES = Object.freeze({
  image: Object.freeze({ kind: 'generated-image', mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp']), defaultMediaType: 'image/png' }),
  video: Object.freeze({ kind: 'generated-video', mediaTypes: Object.freeze(['video/mp4']), defaultMediaType: 'video/mp4' }),
  // TTS 同步完成型：submit 内 completed → 同一次调用直接交付（无 remote 长轮询）。
  tts: Object.freeze({ kind: 'generated-audio', mediaTypes: Object.freeze(['audio/mpeg', 'audio/wav']), defaultMediaType: 'audio/mpeg' }),
  music: Object.freeze({ kind: 'generated-audio', mediaTypes: Object.freeze(['audio/mpeg', 'audio/wav']), defaultMediaType: 'audio/mpeg' }),
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
    if (candidate.prepareInput !== undefined && typeof candidate.prepareInput !== 'function') throw new TypeError('候选 prepareInput 必须是函数');
    return { adapter, model, providerModel: parsed.modelId, providerBinding: candidate.providerBinding, selectionReason, prepareInput: candidate.prepareInput };
  });
}

function stagingFile(dataRoot) {
  const directory = path.join(dataRoot, 'provider-staging', 'v0');
  ensurePrivateDir(directory);
  return path.join(directory, 'download-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.part');
}

async function generatedImageMediaType(bytes) {
  let format;
  try { format = (await sharp(bytes).metadata()).format; }
  catch (_) {
    throw new ProviderContractError('供应商产物不是可识别的图片', {
      stage: 'download', category: 'protocol', acceptance: 'accepted'
    });
  }
  const mediaType = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[format];
  if (!mediaType) throw new ProviderContractError('供应商图片格式仅支持 PNG、JPEG、WebP', {
    stage: 'download', category: 'protocol', acceptance: 'accepted'
  });
  return mediaType;
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
      if (task.capability !== 'image' && !profile.mediaTypes.includes(mediaType)) {
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
      const staged = stagedFiles.at(-1);
      if (task.capability === 'image') {
        staged.bytes = fs.readFileSync(target);
        staged.mediaType = await generatedImageMediaType(staged.bytes);
      }
    }
    recordCoreDownloadCompleted(dataRoot, taskId);
    for (const staged of stagedFiles) {
      const input = {
        kind: profile.kind,
        mediaType: staged.mediaType,
        metadata: { taskId, capability: task.capability },
        ...(task.sourceArtifactId ? { relations: [{ type: 'derived-from', artifactId: task.sourceArtifactId }] } : {})
      };
      const artifact = staged.bytes
        ? createCoreArtifact(dataRoot, { ...input, bytes: staged.bytes })
        : adoptCoreArtifactFile(dataRoot, { ...input, sourcePath: staged.target });
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
  const cachedFlowResult = Boolean(before.flowBinding && result.kind === 'succeeded');
  if (cachedFlowResult) createDeliveryCache(dataRoot, before, result.artifacts);
  const recorded = recordCorePollResult(dataRoot, taskId, result, { deliveryCache: cachedFlowResult });
  if (result.kind !== 'succeeded') return recorded;
  if (cachedFlowResult) return deliverCachedArtifacts(dataRoot, taskId, adapter, signal);
  return deliverArtifacts(dataRoot, taskId, adapter, result.artifacts, signal);
}

/** 同步结果按已提交缓存补交付；已下载项不再访问 Provider，稳定 Artifact ID 防重复。 */
async function deliverCachedArtifacts(dataRoot, taskId, adapter, signal) {
  beginCoreDelivery(dataRoot, taskId);
  try {
    const task = inspectCoreTask(dataRoot, taskId);
    const profile = DELIVERY_PROFILES[task.capability];
    if (!profile) throw new Error('Task 没有可用的交付 Profile');
    const cache = readDeliveryCache(dataRoot, task);
    for (let index = 0; index < cache.items.length; index++) {
      if (signal.aborted) throw new Error('本地交付已取消');
      const item = cache.items[index];
      if (!item.payload) {
        const declaredMediaType = item.source.mediaType || profile.defaultMediaType;
        if (task.capability !== 'image' && !profile.mediaTypes.includes(declaredMediaType)) {
          throw new Error('交付媒体类型不在 Profile 白名单');
        }
        checkAdapterForTask(task, adapter);
        const target = newDeliveryPayloadPath(dataRoot, cache);
        const downloaded = await invokeProviderOperation(adapter, 'download', {
          capability: task.capability, artifact: item.source, targetPath: target, signal
        }, { signal, taskId });
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size !== downloaded.bytes) {
          throw new Error('Provider 物化结果与文件证据不一致');
        }
        const mediaType = task.capability === 'image'
          ? await generatedImageMediaType(fs.readFileSync(target))
          : declaredMediaType;
        if (!profile.mediaTypes.includes(mediaType)) throw new Error('交付媒体类型不在 Profile 白名单');
        recordDeliveryPayload(dataRoot, cache, index, target, mediaType);
      }
    }
    recordCoreDownloadCompleted(dataRoot, taskId);
    const artifactIds = [];
    for (let index = 0; index < cache.items.length; index++) {
      if (signal.aborted) throw new Error('本地交付已取消');
      const item = cache.items[index];
      const sourcePath = readDeliveryPayload(dataRoot, cache, index);
      const mediaType = task.capability === 'image'
        ? await generatedImageMediaType(fs.readFileSync(sourcePath))
        : (item.payload.mediaType || profile.defaultMediaType);
      if (!profile.mediaTypes.includes(mediaType)) throw new Error('交付媒体类型不在 Profile 白名单');
      const artifact = adoptCoreArtifactFile(dataRoot, {
        artifactId: item.artifactId, sourcePath, createdAt: cache.createdAt,
        kind: profile.kind, mediaType, metadata: { taskId, capability: task.capability },
        ...(task.sourceArtifactId ? { relations: [{ type: 'derived-from', artifactId: task.sourceArtifactId }] } : {})
      });
      artifactIds.push(artifact.id);
    }
    return completeCoreDelivery(dataRoot, taskId, artifactIds);
  } catch (error) {
    return failCoreDelivery(dataRoot, taskId, error);
  }
  // 完整结果与未提交文件留在私有缓存，失败、取消和重启都不自动清掉恢复证据。
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
      if (signal.aborted) throw new ProviderTaskRunnerError('IRIS_PROVIDER_ABORTED', '提交已取消');
      const capability = String(input.capability || '').trim();
      let candidates = normalizedCandidates(capability, input.candidates);
      let providerInput = input.providerInput ?? {};
      let flow;
      if (input.flowRunId !== undefined) {
        flow = readFlowRun(dataRoot, input.flowRunId);
        const expected = normalizeGenerationInput('image', flow.input).providerInput;
        if (capability !== 'image' || !flow.edit.claimed || input.sourceArtifactId !== flow.source.artifactId
            || Object.keys(providerInput).length !== Object.keys(expected).length
            || Object.keys(expected).some(key => providerInput[key] !== expected[key])
            || candidates.length !== 1 || candidates[0].model !== flow.input.model_ref
            || candidates[0].providerBinding !== flow.providerBinding) {
          flowFail('IRIS_FLOW_INPUT_CONFLICT', '提交与流程已保存的输入或模型绑定冲突');
        }
      }
      if (input.sourceArtifactId !== undefined) {
        if (capability !== 'image') throw new TypeError('sourceArtifactId 仅用于图片编辑');
        candidates = imageEditCandidates(candidates);
        const image = await readImageEditArtifact(dataRoot, input.sourceArtifactId, signal);
        providerInput = { ...providerInput, image };
      }
      const task = flow ? claimFlowTask(dataRoot, flow.id)
        : createCoreTask(dataRoot, { capability, retriedFrom: input.retriedFrom, sourceArtifactId: input.sourceArtifactId });
      if (flow && task.attempts.length) flowFail('IRIS_FLOW_TASK_ALREADY_STARTED', '该流程 Task 已有提交意图，禁止重新 submit');
      const completedResults = new Map();
      const wrapped = candidates.map(({ adapter, model, providerModel, prepareInput }) => ({
        id: adapter.id,
        model,
        adapter,
        submit: async (providerInput, context) => {
          if (prepareInput) {
            try { providerInput = await prepareInput({ providerInput, signal }); }
            catch (error) { throw new ProviderContractError('视频输入准备失败：' + (error.safeMessage || error.message), {
              ...providerErrorRecord(error), stage: error.stage || 'prepare', category: error.category || 'local_io', acceptance: 'not_accepted'
            }); }
          }
          if (signal.aborted) throw new ProviderContractError('提交已取消', { stage: 'prepare', category: 'aborted', acceptance: 'not_accepted' });
          const result = await invokeProviderOperation(
            adapter,
            'submit',
            { capability, model: providerModel, input: providerInput, signal },
            { ...context, signal, taskId: task.id }
          );
          if (result.kind === 'completed') completedResults.set(context.attempt.id, result.artifacts);
          return result;
        }
      }));
      const submitted = await submitWithAcceptanceBoundary(wrapped, providerInput, {
        signal,
        beforeAttempt: async (attempt) => {
          const candidate = candidates[attempt.ordinal - 1];
          return beginCoreAttempt(dataRoot, task.id, {
            ...attempt,
            ...(candidate.providerBinding !== undefined ? { providerBinding: candidate.providerBinding } : {}),
            ...(candidate.selectionReason !== undefined ? { selectionReason: candidate.selectionReason } : {})
          });
        },
        afterResult: async (attempt) => {
          let cacheError;
          if (attempt.resultKind === 'completed') {
            try {
              createDeliveryCache(dataRoot, inspectCoreTask(dataRoot, task.id), completedResults.get(attempt.id));
              attempt.deliveryCache = true;
            } catch (error) { cacheError = error; }
          }
          recordCoreAttemptResult(dataRoot, task.id, attempt);
          if (cacheError) {
            failCoreDelivery(dataRoot, task.id, cacheError);
            throw cacheError;
          }
        }
      });
      if (submitted.localError) {
        return Object.freeze({ taskId: task.id, task: inspectCoreTask(dataRoot, task.id), localError: submitted.localError });
      }
      if (!submitted.result) throw new Error('Provider 提交流程没有返回结果');
      if (submitted.result.kind === 'not_accepted') {
        finalizeCoreNoAcceptance(dataRoot, task.id, submitted.result.error);
      } else if (submitted.result.kind === 'completed') {
        return Object.freeze({
          taskId: task.id,
          task: await deliverCachedArtifacts(dataRoot, task.id, submitted.candidate.adapter, signal),
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
      if (adapter || !task.deliveryCache) checkAdapterForTask(task, adapter);
      prepareCoreRedelivery(dataRoot, taskId);
      if (task.deliveryCache) return deliverCachedArtifacts(dataRoot, taskId, adapter, signal);
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
