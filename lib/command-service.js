'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCoreArtifact,
  exportCoreArtifact,
  inspectCoreArtifact,
  listCoreArtifacts,
  readCoreArtifactBytes,
  rebuildCoreArtifactIndex
} from './core-artifacts.js';
import { inspectCoreTask, listCoreTasks } from './core-tasks.js';
import { cropImage, pixelDiff, imageDimensions, PixelError } from './pixels.js';
import { extractFrames, normalizeFramesOptions, probeVideo } from './media-probe.js';
import { hasProviderOperation } from './provider-adapter.js';
import { createProviderTaskRunner } from './provider-task-runner.js';
import { GenerationInputError, normalizeGenerationInput } from './generation-input.js';
import { videoTaskCandidates } from './video-input.js';
import { waitForCoreTask } from './task-wait.js';
import { planCoreDeletion, planCoreCleanup, quarantineCoreFiles, inspectCoreTransactions, restoreCoreTransaction } from './core-maintenance.js';

export const COMMAND_CONTRACT_VERSION = 0;
export const CORE_COMMANDS = Object.freeze([
  'crop', 'media.diff', 'media.frames', 'media.html', 'task.inspect', 'task.list', 'task.wait', 'task.observe', 'task.reobserve', 'task.redeliver', 'task.cancel', 'task.retry',
  'task.inspect-many', 'artifact.inspect', 'artifact.inspect-many', 'artifact.list', 'artifact.export', 'artifact.export-many', 'artifact.rebuild',
  'core.delete', 'core.cleanup', 'core.transactions', 'core.restore'
]);

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

function commandError(code, message) {
  return new CommandError(code, message);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactInput(input, allowed) {
  if (!plain(input)) throw commandError('IRIS_COMMAND_INPUT_INVALID', 'Command 输入必须是 JSON 对象');
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw commandError('IRIS_COMMAND_INPUT_INVALID', `Command 不支持输入字段：${key}`);
  }
}

function localFile(value, field, label) {
  const supplied = String(value || '').trim();
  if (!supplied || !path.isAbsolute(supplied)) {
    throw commandError('IRIS_COMMAND_INPUT_INVALID', field + ' 必须是宿主可读的绝对路径');
  }
  try {
    const resolved = fs.realpathSync.native(supplied);
    if (!fs.statSync(resolved).isFile()) throw new Error('not file');
    return resolved;
  } catch (_) {
    throw commandError('IRIS_COMMAND_INPUT_INVALID', label + '不存在或不是普通文件');
  }
}

function localImage(input) {
  return localFile(input.image_path, 'image_path', '图片');
}

function coordinates(input) {
  const values = {};
  for (const name of ['left', 'top', 'width', 'height']) {
    if (typeof input[name] !== 'number' || !Number.isFinite(input[name])) {
      throw commandError('IRIS_COMMAND_INPUT_INVALID', `${name} 必须是有限数字`);
    }
    values[name] = input[name];
  }
  return values;
}

function abortError() {
  const error = new Error('Core Command 已取消');
  error.name = 'AbortError';
  return error;
}

function idList(input, field) {
  const ids = input[field];
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(id => typeof id === 'string') || new Set(ids).size !== ids.length) {
    throw commandError('IRIS_COMMAND_INPUT_INVALID', field + ' 必须是 1–200 个不重复 ID 的数组');
  }
  return ids;
}

function queryInput(input, fields) {
  exactInput(input, ['offset', 'limit', ...fields]);
  for (const [key, value] of Object.entries(input)) {
    if (['offset', 'limit'].includes(key)) {
      if (!Number.isSafeInteger(value) || value < (key === 'offset' ? 0 : 1) || (key === 'limit' && value > 200)) throw commandError('IRIS_COMMAND_INPUT_INVALID', 'offset 必须非负，limit 必须是 1–200 的整数');
    } else if (typeof value !== 'string' || !value.trim()) throw commandError('IRIS_COMMAND_INPUT_INVALID', '过滤字段必须是非空字符串');
  }
}

export function createCommandService(runtime, ports = {}) {
  if (!runtime || typeof runtime.run !== 'function') throw new TypeError('Command Service 需要 Core Runtime');

  async function execute(name, input) {
    if (!CORE_COMMANDS.includes(name)) throw commandError('IRIS_COMMAND_UNKNOWN', `未知 Command：${String(name)}`);
    if (name === 'core.delete' || name === 'core.cleanup') {
      exactInput(input, name === 'core.delete' ? ['task_ids', 'artifact_ids', 'confirm_delete'] : ['paths', 'older_than_ms', 'confirm_delete']);
      if (input.confirm_delete !== undefined && typeof input.confirm_delete !== 'boolean') throw commandError('IRIS_COMMAND_INPUT_INVALID', 'confirm_delete 必须是布尔值');
      return runtime.run(input.confirm_delete === true ? 'execute' : 'inspect', ({ dataRoot, signal }) => {
        if (signal.aborted) throw abortError();
        let plan = name === 'core.delete' ? planCoreDeletion(dataRoot, input) : planCoreCleanup(dataRoot, input);
        if (name === 'core.cleanup' && input.confirm_delete === true) {
          const paths = input.paths;
          if (!Array.isArray(paths) || !paths.length || paths.length > 200 || !paths.every(file => typeof file === 'string') || new Set(paths).size !== paths.length) throw commandError('IRIS_COMMAND_INPUT_INVALID', '执行清理必须明确指定 1–200 个预览中的 paths');
          const entries = paths.map(file => plan.candidates.find(entry => entry.path === file));
          if (entries.some(entry => !entry)) throw commandError('IRIS_CORE_CLEANUP_CHANGED', '指定路径不在当前可清理预览中');
          plan = { operation: 'cleanup', allowed: true, entries };
        }
        const result = input.confirm_delete === true ? quarantineCoreFiles(dataRoot, plan) : { preview: true, ...plan };
        return { contractVersion: COMMAND_CONTRACT_VERSION, command: name, ...result };
      });
    }
    if (name === 'core.transactions') {
      exactInput(input, []);
      return runtime.run('inspect', ({ dataRoot }) => ({ contractVersion: COMMAND_CONTRACT_VERSION, command: name, transactions: inspectCoreTransactions(dataRoot) }));
    }
    if (name === 'core.restore') {
      exactInput(input, ['transaction_id']);
      return runtime.run('execute', ({ dataRoot }) => ({ contractVersion: COMMAND_CONTRACT_VERSION, command: name, ...restoreCoreTransaction(dataRoot, input.transaction_id) }));
    }
    if (name === 'media.html') {
      exactInput(input, ['html', 'width', 'height', 'full_page']);
      if (typeof input.html !== 'string' || !input.html.trim() || Buffer.byteLength(input.html) > 1024 * 1024) {
        throw commandError('IRIS_COMMAND_INPUT_INVALID', 'html 必须是非空字符串，最多 1 MiB');
      }
      const width = input.width ?? 1280, height = input.height ?? 720;
      if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096)
          || (input.full_page !== undefined && typeof input.full_page !== 'boolean')) {
        throw commandError('IRIS_COMMAND_INPUT_INVALID', 'width/height 必须是 1–4096 的整数，full_page 必须是布尔值');
      }
      if (typeof ports.browser?.renderHtml !== 'function') throw commandError('IRIS_COMMAND_BROWSER_REQUIRED', 'HTML 截图需要 Browser Port');
      return runtime.run('execute', async ({ dataRoot, signal }) => {
        const rendered = await ports.browser.renderHtml({ html: input.html, width, height, fullPage: input.full_page !== false, signal });
        if (signal.aborted) throw abortError();
        const bytes = Buffer.from(rendered.bytes);
        if (rendered.mediaType !== 'image/png' || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
          throw commandError('IRIS_COMMAND_PROCESSING_FAILED', '浏览器没有返回 PNG 截图');
        }
        const dimensions = await imageDimensions(bytes);
        if (signal.aborted) throw abortError();
        const artifact = createCoreArtifact(dataRoot, { bytes, mediaType: 'image/png', kind: 'html-screenshot', metadata: dimensions });
        return Object.freeze({ contractVersion: COMMAND_CONTRACT_VERSION, command: name, artifact });
      });
    }
    if (name === 'crop') {
      exactInput(input, ['image_path', 'artifact_id', 'left', 'top', 'width', 'height']);
      const hasPath = Boolean(String(input.image_path || '').trim());
      const hasArtifact = Boolean(String(input.artifact_id || '').trim());
      if (hasPath === hasArtifact) {
        throw commandError('IRIS_COMMAND_INPUT_INVALID', 'crop 必须且只能提供 image_path 或 artifact_id 之一');
      }
      const localPath = hasPath ? localImage(input) : null;
      const region = coordinates(input);
      return runtime.run('execute', async ({ dataRoot, signal }) => {
        if (signal.aborted) throw abortError();
        const source = hasArtifact ? readCoreArtifactBytes(dataRoot, input.artifact_id) : null;
        const image = source ? source.bytes : localPath;
        let cropped;
        try { cropped = await cropImage({ input: image, ...region }); }
        catch (error) {
          if (error instanceof PixelError) throw commandError('IRIS_COMMAND_INPUT_INVALID', error.message);
          throw commandError('IRIS_COMMAND_PROCESSING_FAILED', '图片无法裁剪；请确认格式受支持且文件可读取');
        }
        if (signal.aborted) throw abortError();
        const artifact = createCoreArtifact(dataRoot, {
          bytes: cropped.buffer,
          mediaType: cropped.mime,
          kind: 'crop',
          metadata: { width: cropped.width, height: cropped.height },
          relations: source ? [{ type: 'derived-from', artifactId: source.artifact.id }] : []
        });
        return Object.freeze({
          contractVersion: COMMAND_CONTRACT_VERSION,
          command: 'crop',
          artifact
        });
      });
    }
    if (name === 'media.diff') {
      exactInput(input, [
        'image_a_path', 'image_a_artifact_id', 'image_b_path', 'image_b_artifact_id',
        'grid', 'top_regions'
      ]);
      const aPathSupplied = Boolean(String(input.image_a_path || '').trim());
      const aArtifactSupplied = Boolean(String(input.image_a_artifact_id || '').trim());
      const bPathSupplied = Boolean(String(input.image_b_path || '').trim());
      const bArtifactSupplied = Boolean(String(input.image_b_artifact_id || '').trim());
      if (aPathSupplied === aArtifactSupplied || bPathSupplied === bArtifactSupplied) {
        throw commandError('IRIS_COMMAND_INPUT_INVALID',
          'media.diff 的 A/B 两侧都必须且只能提供本地路径或 Artifact ID 之一');
      }
      const imageAPath = aPathSupplied
        ? localFile(input.image_a_path, 'image_a_path', '图片 A') : null;
      const imageBPath = bPathSupplied
        ? localFile(input.image_b_path, 'image_b_path', '图片 B') : null;
      const grid = input.grid === undefined ? 8 : Number(input.grid);
      const topRegions = input.top_regions === undefined ? 3 : Number(input.top_regions);
      if (!Number.isSafeInteger(grid) || grid < 1 || grid > 64
          || !Number.isSafeInteger(topRegions) || topRegions < 1 || topRegions > 100) {
        throw commandError('IRIS_COMMAND_INPUT_INVALID',
          'grid 必须是 1–64 的整数，top_regions 必须是 1–100 的整数');
      }
      return runtime.run('execute', async ({ dataRoot, signal }) => {
        if (signal.aborted) throw abortError();
        const sourceA = aArtifactSupplied
          ? readCoreArtifactBytes(dataRoot, input.image_a_artifact_id) : null;
        const sourceB = bArtifactSupplied
          ? readCoreArtifactBytes(dataRoot, input.image_b_artifact_id) : null;
        for (const source of [sourceA, sourceB]) {
          if (source && !source.artifact.mediaType.startsWith('image/')) {
            throw commandError('IRIS_COMMAND_INPUT_INVALID', 'media.diff 的 Artifact 输入必须是图片');
          }
        }
        let diff;
        try {
          diff = await pixelDiff({
            inputA: sourceA ? sourceA.bytes : imageAPath,
            inputB: sourceB ? sourceB.bytes : imageBPath,
            grid,
            topRegions
          });
        } catch (error) {
          if (signal.aborted) throw abortError();
          if (error instanceof PixelError) {
            throw commandError('IRIS_COMMAND_INPUT_INVALID', error.message);
          }
          throw commandError('IRIS_COMMAND_PROCESSING_FAILED',
            '图片差异分析失败；请确认格式受支持且文件可读取');
        }
        if (signal.aborted) throw abortError();
        const sourceIds = [...new Set([sourceA?.artifact.id, sourceB?.artifact.id].filter(Boolean))];
        const metrics = Object.freeze({
          ratio: diff.ratio,
          diffPixels: diff.diffPixels,
          totalPixels: diff.totalPixels,
          width: diff.width,
          height: diff.height,
          worstRegions: Object.freeze(diff.worstRegions.map((region) => Object.freeze({ ...region })))
        });
        const artifact = createCoreArtifact(dataRoot, {
          bytes: diff.heatmap,
          mediaType: diff.mime,
          kind: 'pixel-diff',
          metadata: { ...metrics, worstRegions: diff.worstRegions },
          relations: sourceIds.map((artifactId) => ({ type: 'derived-from', artifactId }))
        });
        return Object.freeze({
          contractVersion: COMMAND_CONTRACT_VERSION,
          command: name,
          metrics,
          artifact
        });
      });
    }
    if (name === 'media.frames') {
      exactInput(input, ['video_path', 'artifact_id', 'max_frames', 'target_width', 'quality', 'format']);
      const hasPath = Boolean(String(input.video_path || '').trim());
      const hasArtifact = Boolean(String(input.artifact_id || '').trim());
      if (hasPath === hasArtifact) {
        throw commandError('IRIS_COMMAND_INPUT_INVALID',
          'media.frames 必须且只能提供 video_path 或 artifact_id 之一');
      }
      const videoPath = hasPath ? localFile(input.video_path, 'video_path', '视频') : null;
      let frameOptions;
      try {
        frameOptions = normalizeFramesOptions({
          ...(input.max_frames !== undefined ? { maxFrames: input.max_frames } : {}),
          ...(input.target_width !== undefined ? { targetWidth: input.target_width } : {}),
          ...(input.quality !== undefined ? { quality: input.quality } : {}),
          ...(input.format !== undefined ? { format: input.format } : {})
        });
      } catch (error) {
        throw commandError('IRIS_COMMAND_INPUT_INVALID', error.message);
      }
      return runtime.run('execute', async ({ dataRoot, signal }) => {
        if (signal.aborted) throw abortError();
        const source = hasArtifact ? readCoreArtifactBytes(dataRoot, input.artifact_id) : null;
        if (source && !source.artifact.mediaType.startsWith('video/')) {
          throw commandError('IRIS_COMMAND_INPUT_INVALID', 'media.frames 的 Artifact 输入必须是视频');
        }
        let temporaryDirectory;
        let readablePath = videoPath;
        if (source) {
          try {
            temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-command-frames-'));
            readablePath = path.join(temporaryDirectory, 'source.mp4');
            fs.writeFileSync(readablePath, source.bytes, { mode: 0o600 });
          } catch (_) {
            if (temporaryDirectory) {
              try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch (_) { /* 临时副本 */ }
            }
            throw commandError('IRIS_COMMAND_PROCESSING_FAILED', '视频临时副本无法安全写入');
          }
        }
        let media;
        let frames;
        try {
          media = probeVideo(readablePath);
          frames = await extractFrames({ inputPath: readablePath, ...frameOptions, signal });
        } catch (error) {
          if (signal.aborted) throw abortError();
          throw commandError('IRIS_COMMAND_PROCESSING_FAILED',
            '视频抽帧失败；请确认 ffmpeg 可用且文件格式受支持');
        } finally {
          if (temporaryDirectory) {
            try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch (_) { /* 临时副本 */ }
          }
        }
        if (signal.aborted) throw abortError();
        const relations = source ? [{ type: 'frame-of', artifactId: source.artifact.id }] : [];
        const mediaType = frameOptions.format === 'png' ? 'image/png' : 'image/jpeg';
        const artifacts = frames.map((frame, index) => createCoreArtifact(dataRoot, {
          bytes: frame.buffer,
          mediaType,
          kind: 'video-frame',
          metadata: {
            frameIndex: index + 1,
            atSec: frame.atSec,
            width: frame.width,
            height: frame.height
          },
          relations
        }));
        return Object.freeze({
          contractVersion: COMMAND_CONTRACT_VERSION,
          command: name,
          media: Object.freeze({ ...media }),
          artifacts: Object.freeze(artifacts)
        });
      });
    }
    if (name === 'task.wait') {
      exactInput(input, ['task_id', 'timeout_ms', 'poll_interval_ms']);
      const result = await waitForCoreTask(runtime, input.task_id, { timeoutMs: input.timeout_ms, pollIntervalMs: input.poll_interval_ms,
        ...(typeof ports.resolveTaskAdapter === 'function' ? { observe: () => execute('task.observe', { task_id: input.task_id }) } : {}) });
      return Object.freeze({ contractVersion: COMMAND_CONTRACT_VERSION, command: name, ...result });
    }
    // task.reobserve 是人工触发观察的对外命令名（DSH API/工作台），与 task.observe
    // 共用同一份门与单步 poll 实现；语义不区分，绝不 submit。
    if (name === 'task.observe' || name === 'task.reobserve') {
      exactInput(input, ['task_id']);
      return runtime.run('execute', async ({ dataRoot }) => {
        const before = inspectCoreTask(dataRoot, input.task_id);
        if (before.acceptance !== 'accepted' || !before.remoteTaskId || !['none', 'unknown'].includes(before.outcome)) throw commandError('IRIS_TASK_NOT_OBSERVABLE', 'Task 没有可观察的远端受理事实，或已终止；不会重新提交');
        if (typeof ports.resolveTaskAdapter !== 'function') throw commandError('IRIS_COMMAND_PROVIDER_REQUIRED', 'task.observe 需要宿主显式提供 Task Provider resolver');
        const adapter = await ports.resolveTaskAdapter(before);
        if (!adapter || adapter.id !== before.providerId || !adapter.capabilities?.includes(before.capability)) throw commandError('IRIS_PROVIDER_TASK_IDENTITY_MISMATCH', 'Task Provider resolver 返回了不匹配的 Adapter');
        if (!hasProviderOperation(adapter, 'poll')) throw commandError('IRIS_PROVIDER_TASK_OBSERVE_UNSUPPORTED', 'Task 原 Provider 不支持 poll；不会重新提交');
        const task = await createProviderTaskRunner(runtime).observe(input.task_id, adapter, { resumeActive: true });
        return Object.freeze({ contractVersion: COMMAND_CONTRACT_VERSION, command: name, taskId: task.id, task });
      });
    }
    // task.redeliver：只对 outcome=succeeded / deliveryState=failed 的任务重新取回
    // 已生成的远端产物（re-poll 拿产物清单，绝不 submit，也不会重新生成）。
    if (name === 'task.redeliver') {
      exactInput(input, ['task_id']);
      return runtime.run('execute', async ({ dataRoot }) => {
        const before = inspectCoreTask(dataRoot, input.task_id);
        if (before.outcome !== 'succeeded' || before.deliveryState !== 'failed' || !before.remoteTaskId) throw commandError('IRIS_TASK_NOT_REDELIVERABLE', 'Task 不处于可重新交付状态；不会重新生成');
        if (typeof ports.resolveTaskAdapter !== 'function') throw commandError('IRIS_COMMAND_PROVIDER_REQUIRED', 'task.redeliver 需要宿主显式提供 Task Provider resolver');
        const adapter = await ports.resolveTaskAdapter(before);
        if (!adapter || adapter.id !== before.providerId || !adapter.capabilities?.includes(before.capability)) throw commandError('IRIS_PROVIDER_TASK_IDENTITY_MISMATCH', 'Task Provider resolver 返回了不匹配的 Adapter');
        if (!hasProviderOperation(adapter, 'poll')) throw commandError('IRIS_PROVIDER_TASK_OBSERVE_UNSUPPORTED', 'Task 原 Provider 不支持 poll；不会重新生成');
        const task = await createProviderTaskRunner(runtime).redeliver(input.task_id, adapter);
        return Object.freeze({ contractVersion: COMMAND_CONTRACT_VERSION, command: name, taskId: task.id, task });
      });
    }
    // task.cancel：只对已受理、有远端 ID、结果未定论且非终态的任务开放。
    // 只有 Provider 明确确认才写 outcome=canceled；不支持或无法确认时保持真实状态。
    if (name === 'task.cancel') {
      exactInput(input, ['task_id']);
      return runtime.run('execute', async ({ dataRoot }) => {
        const before = inspectCoreTask(dataRoot, input.task_id);
        if (before.acceptance !== 'accepted' || !before.remoteTaskId
            || !['none', 'unknown'].includes(before.outcome) || before.phase === 'terminal') {
          throw commandError('IRIS_TASK_NOT_CANCELABLE', 'Task 缺少可取消的远端受理事实，或已终止');
        }
        if (before.cancelState !== 'none') {
          throw commandError('IRIS_TASK_CANCEL_ALREADY_REQUESTED', '该 Task 已请求过取消；请显式重新观察以确认远端真实状态');
        }
        if (typeof ports.resolveTaskAdapter !== 'function') throw commandError('IRIS_COMMAND_PROVIDER_REQUIRED', 'task.cancel 需要宿主显式提供 Task Provider resolver');
        const adapter = await ports.resolveTaskAdapter(before);
        if (!adapter || adapter.id !== before.providerId || !adapter.capabilities?.includes(before.capability)) throw commandError('IRIS_PROVIDER_TASK_IDENTITY_MISMATCH', 'Task Provider resolver 返回了不匹配的 Adapter');
        const task = await createProviderTaskRunner(runtime).cancel(input.task_id, adapter);
        return Object.freeze({ contractVersion: COMMAND_CONTRACT_VERSION, command: name, taskId: task.id, task });
      });
    }
    // task.retry：D4 重试为新任务。产生新的真实计费，必须显式 confirm_billing；
    // 只对终态且未成功交付的 Task 开放；新 Task 有全新 id/attempts/binding 并记录
    // 单向 retriedFrom 关系，旧 Task 不动；Core 不持久化 Prompt，prompt 必须由
    // 调用方重新提供（绝不从旧记录"恢复"）。
    if (name === 'task.retry') {
      exactInput(input, ['task_id', 'provider_input', 'model_ref', 'confirm_billing']);
      if (input.confirm_billing !== true) {
        throw commandError('IRIS_COMMAND_BILLING_CONFIRM_REQUIRED', '重试会创建新任务并可能产生重复生成费用；必须显式确认计费');
      }
      return runtime.run('execute', async ({ dataRoot }) => {
        const before = inspectCoreTask(dataRoot, input.task_id);
        if (before.phase !== 'terminal' || (before.outcome === 'succeeded' && before.deliveryState === 'ready')) {
          throw commandError('IRIS_TASK_NOT_RETRYABLE', '只有终态且未成功交付的 Task 可以重试为新任务');
        }
        let normalized;
        try { normalized = normalizeGenerationInput(before.capability, input.provider_input, { allowVideoPaths: before.capability === 'video' }); }
        catch (error) {
          if (error instanceof GenerationInputError) throw commandError('IRIS_COMMAND_INPUT_INVALID', error.message);
          throw error;
        }
        const providerInput = normalized.providerInput;
        if (before.sourceArtifactId && !normalized.sourceArtifactId) {
          throw commandError('IRIS_COMMAND_INPUT_INVALID', '改图重试必须重新提供 source_artifact_id 和修改指令');
        }
        if (Object.hasOwn(input.provider_input, 'model_ref')) {
          throw commandError('IRIS_COMMAND_INPUT_INVALID', 'retry 的模型覆盖请使用外层 model_ref');
        }
        const modelRef = String(input.model_ref || '').trim();
        if (input.model_ref !== undefined && !modelRef) throw commandError('IRIS_COMMAND_INPUT_INVALID', 'model_ref 必须是 providerId::modelId 复合引用');
        if (typeof ports.resolveTaskCandidates !== 'function') throw commandError('IRIS_COMMAND_PROVIDER_REQUIRED', 'task.retry 需要宿主显式提供候选链 resolver');
        let candidates = await ports.resolveTaskCandidates({ capability: before.capability, modelRef });
        if (before.capability === 'video') candidates = videoTaskCandidates(candidates, normalized);
        const result = await createProviderTaskRunner(runtime).submit({
          capability: before.capability,
          candidates,
          providerInput,
          sourceArtifactId: normalized.sourceArtifactId,
          retriedFrom: before.id
        });
        return Object.freeze({
          contractVersion: COMMAND_CONTRACT_VERSION,
          command: name,
          taskId: result.taskId,
          retriedFrom: before.id,
          task: result.task,
          ...(result.localError ? { localError: result.localError } : {})
        });
      });
    }
    if (name === 'task.inspect') {
      exactInput(input, ['task_id']);
      return runtime.run('inspect', ({ dataRoot }) => Object.freeze({
        contractVersion: COMMAND_CONTRACT_VERSION,
        command: name,
        task: inspectCoreTask(dataRoot, input.task_id)
      }));
    }
    if (name === 'task.list') {
      queryInput(input, ['status', 'capability', 'provider_id', 'model_ref', 'outcome', 'delivery_state']);
      return runtime.run('inspect', ({ dataRoot }) => Object.freeze({
        contractVersion: COMMAND_CONTRACT_VERSION,
        command: name,
        ...listCoreTasks(dataRoot, input)
      }));
    }
    if (name === 'artifact.inspect') {
      exactInput(input, ['artifact_id']);
      return runtime.run('inspect', ({ dataRoot }) => Object.freeze({
        contractVersion: COMMAND_CONTRACT_VERSION,
        command: name,
        artifact: inspectCoreArtifact(dataRoot, input.artifact_id)
      }));
    }
    if (name === 'artifact.list') {
      queryInput(input, ['kind', 'media_type', 'task_id']);
      return runtime.run('inspect', ({ dataRoot }) => Object.freeze({
        contractVersion: COMMAND_CONTRACT_VERSION,
        command: name,
        ...listCoreArtifacts(dataRoot, input)
      }));
    }
    if (name === 'artifact.rebuild') {
      exactInput(input, []);
      return runtime.run('recover', ({ dataRoot }) => Object.freeze({
        contractVersion: COMMAND_CONTRACT_VERSION,
        command: name,
        ...rebuildCoreArtifactIndex(dataRoot)
      }));
    }
    if (name === 'task.inspect-many' || name === 'artifact.inspect-many') {
      const task = name.startsWith('task.'), field = task ? 'task_ids' : 'artifact_ids';
      exactInput(input, [field]);
      const ids = idList(input, field);
      return runtime.run('inspect', ({ dataRoot }) => ({ contractVersion: COMMAND_CONTRACT_VERSION, command: name,
        results: ids.map(id => {
          try { return { id, [task ? 'task' : 'artifact']: task ? inspectCoreTask(dataRoot, id) : inspectCoreArtifact(dataRoot, id) }; }
          catch (error) { return { id, error: { code: error.code || 'IRIS_COMMAND_FAILED' } }; }
        }) }));
    }
    if (name === 'artifact.export-many') {
      exactInput(input, ['artifact_ids', 'output_directory']);
      const ids = idList(input, 'artifact_ids');
      const directory = input.output_directory;
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        throw commandError('IRIS_COMMAND_INPUT_INVALID', 'output_directory 必须是已存在的绝对目录');
      }
      return runtime.run('execute', ({ dataRoot, signal }) => {
        const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/flac': '.flac', 'text/plain': '.txt', 'application/json': '.json' };
        const outputs = ids.map(id => {
          const artifact = inspectCoreArtifact(dataRoot, id);
          const file = path.join(directory, id + (extensions[artifact.mediaType] || '.bin'));
          if (fs.existsSync(file)) throw commandError('IRIS_ARTIFACT_EXPORT_EXISTS', '批量导出目标已存在；未导出任何文件');
          return { id, file };
        });
        const results = outputs.map(({ id, file }) => {
          if (signal.aborted) return { id, exported: false, error: { code: 'IRIS_COMMAND_ABORTED' } };
          try { return { id, ...exportCoreArtifact(dataRoot, id, file) }; }
          catch (error) { return { id, exported: false, error: { code: error.code || 'IRIS_ARTIFACT_EXPORT_FAILED' } }; }
        });
        return { contractVersion: COMMAND_CONTRACT_VERSION, command: name, results };
      });
    }
    exactInput(input, ['artifact_id', 'output_path']);
    return runtime.run('execute', ({ dataRoot }) => Object.freeze({
      contractVersion: COMMAND_CONTRACT_VERSION,
      command: name,
      ...exportCoreArtifact(dataRoot, input.artifact_id, input.output_path)
    }));
  }

  return Object.freeze({ contractVersion: COMMAND_CONTRACT_VERSION, commands: CORE_COMMANDS, execute });
}
