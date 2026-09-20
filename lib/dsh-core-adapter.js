'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { allProviders, irisHome } from './config.js';
import { createCommandService } from './command-service.js';
import { createCoreArtifact, inspectCoreArtifact, listCoreArtifacts, readCoreArtifactBytes } from './core-artifacts.js';
import { createCoreRuntime } from './core-runtime.js';
import { inspectCoreTask, listCoreTasks, recoverCoreTask } from './core-tasks.js';
import { applyCoreAttentionAction, attentionDispositionOf, readCoreAttentionPrefs } from './core-attention.js';
import { projectCoreTaskUserRow } from './core-user-projection.js';
import { requireHostPort } from './host-contract.js';
import { createProviderTaskRunner } from './provider-task-runner.js';
import { createConfiguredProviderAdapter } from './provider-adapters.js';
import { imageCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding, transcribeCandidatesFromCatalog, ttsCandidatesFromCatalog, videoCandidatesFromCatalog } from './provider-catalog.js';

let writerTail = Promise.resolve();
const providerWatchers = new Map();
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_MAX_WATCH_MS = 20 * 60 * 1000;
const POLL_ERROR_TOLERANCE = 5;

export class DshCoreAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DshCoreAdapterError';
    this.code = code;
  }
}

function abortError() {
  return Object.assign(new Error('已取消'), { name: 'AbortError' });
}

/** DSH 只在这个边界选择 profile 数据根；Core 本身仍不推断 DSH_HOME。 */
export function dshCoreDataRoot() {
  return path.join(irisHome(), 'core-v0');
}

async function withRuntime(mode, callback, signal) {
  if (signal?.aborted) throw abortError();
  const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode });
  runtime.start();
  const onAbort = () => { runtime.dispose().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try { return await callback(runtime, mode === 'writer' ? createCommandService(runtime) : null); }
  finally {
    signal?.removeEventListener('abort', onAbort);
    await runtime.dispose();
  }
}

async function withWriter(callback, signal) {
  const operation = writerTail.then(() => withRuntime('writer', callback, signal));
  writerTail = operation.catch(() => {});
  return operation;
}

function withReader(callback, signal) {
  return withRuntime('reader', callback, signal);
}

/**
 * 将 DSH 图片输入投影到共享 crop Command，再把中性 Artifact 读成宿主可保存的字节。
 * bytes 输入先成为 host-input Artifact，输出通过 derived-from 保留关系。
 */
export async function cropForDsh(input = {}) {
  return withWriter(async (runtime, commands) => {
    if (input.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    let commandInput;
    if (input.bytes !== undefined) {
      const source = await runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, {
        bytes: input.bytes,
        mediaType: input.mediaType,
        kind: 'host-input',
        metadata: {}
      }));
      commandInput = { artifact_id: source.id };
    } else {
      commandInput = { image_path: input.imagePath };
    }
    Object.assign(commandInput, {
      left: input.left,
      top: input.top,
      width: input.width,
      height: input.height
    });
    const result = await commands.execute('crop', commandInput);
    if (input.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    const materialized = await runtime.run('inspect', ({ dataRoot }) =>
      readCoreArtifactBytes(dataRoot, result.artifact.id));
    return Object.freeze({
      artifact: result.artifact,
      bytes: materialized.bytes,
      mediaType: result.artifact.mediaType,
      width: result.artifact.metadata.width,
      height: result.artifact.metadata.height
    });
  }, input.signal);
}

/** 提交一个 Core Provider Task；Provider Adapter 由 DSH 配置边界选择后显式传入。 */
export function submitProviderTaskForDsh(input = {}) {
  return withWriter((runtime) => createProviderTaskRunner(runtime).submit({
    capability: input.capability,
    candidates: input.candidates,
    providerInput: input.providerInput
  }), input.signal);
}

/** 单步观察已经受理的 Core Task；不会自动循环，也不会创建第二次 submit。 */
export function observeProviderTaskForDsh(input = {}) {
  return withWriter((runtime) => createProviderTaskRunner(runtime).observe(
    input.taskId, input.adapter, { resumeActive: input.resumeActive === true }
  ), input.signal);
}

/**
 * D1/D2 人工动作公共通路：与 Host 观察节拍共用同一个 resolver / binding 校验
 * （configuredAdapterForTask），经 Command Service 显式执行一次人工命令；合法性
 * 门在 Command 内于网络与写入之前完成。返回任务事实对应的五类用户投影行
 * （无 providerId/binding/错误原文/路径）。
 */
function manualTaskCommandForDsh(command, input = {}) {
  const taskId = String(input.taskId || '').trim();
  if (!/^task_[a-f0-9]{24}$/.test(taskId)) {
    return Promise.reject(new DshCoreAdapterError('IRIS_DSH_TASK_INVALID', 'Core Task ID 无效'));
  }
  return withWriter(async (runtime) => {
    const commands = createCommandService(runtime, { resolveTaskAdapter: configuredAdapterForTask });
    const result = await commands.execute(command, { task_id: taskId });
    return runtime.run('inspect', ({ dataRoot }) => {
      const artifacts = [];
      for (const artifactId of result.task.artifactIds) {
        try { artifacts.push(inspectCoreArtifact(dataRoot, artifactId)); }
        catch (_) { /* 缺失媒体在投影行里降级为不可用 */ }
      }
      return Object.freeze({
        taskId: result.task.id,
        row: projectCoreTaskUserRow(result.task, artifacts)
      });
    });
  }, input.signal);
}

/** D1 人工 reobserve：显式单步 poll 一次，绝不 submit。 */
export function reobserveProviderTaskForDsh(input = {}) {
  return manualTaskCommandForDsh('task.reobserve', input);
}

/**
 * D2 人工 redeliver：只对 outcome=succeeded / deliveryState=failed 的 Task
 * 重新取回远端产物（re-poll 产物清单 → download → 新 Artifact），绝不 submit、
 * 绝不重新生成。
 */
export function redeliverProviderTaskForDsh(input = {}) {
  return manualTaskCommandForDsh('task.redeliver', input);
}

/**
 * D3 人工 cancel：只有 Provider 明确确认才写 outcome=canceled；不支持或无法确认
 * 时保持真实状态（详见 core-tasks 的 recordCoreCancelResult 三分支）。
 */
export function cancelProviderTaskForDsh(input = {}) {
  return manualTaskCommandForDsh('task.cancel', input);
}

/**
 * 注意力处置（Host 偏好，零 Core 写入）：acknowledge/restore/hide/unhide。
 * 只校验任务存在；动作幂等（偏好不变时不写盘）；返回装饰后的投影行。
 */
export async function disposeCoreTaskAttention(input = {}) {
  const taskId = String(input.taskId || '').trim();
  const action = String(input.action || '').trim();
  if (!/^task_[a-f0-9]{24}$/.test(taskId)) {
    throw new DshCoreAdapterError('IRIS_DSH_TASK_INVALID', 'Core Task ID 无效');
  }
  // 任务必须存在（reader 只读）；不存在统一 404。
  const task = await inspectProviderTaskForDsh(taskId, { signal: input.signal });
  const applied = applyCoreAttentionAction(task.id, action);
  const row = await withReader((runtime) => runtime.run('inspect', ({ dataRoot }) => {
    const artifacts = [];
    for (const artifactId of task.artifactIds) {
      try { artifacts.push(inspectCoreArtifact(dataRoot, artifactId)); }
      catch (_) { /* 缺失媒体在投影行里降级为不可用 */ }
    }
    return decorateCoreUserRows(
      [projectCoreTaskUserRow(task, artifacts)],
      listAllCoreTaskRecords(dataRoot),
      readCoreAttentionPrefs()
    )[0];
  }), input.signal);
  return Object.freeze({ taskId: task.id, changed: applied.changed, row });
}

/**
 * D4 人工 retry as new task：产生新的真实计费。候选链按当前 assignments/池实况
 * 重新解析（不绑定旧 Provider/binding——旧配置可能正是失败原因），modelRef 可
 * 显式指定。prompt 必须由调用方重新提供（Core 记录不持久化 Prompt）。
 */
export function retryProviderTaskForDsh(input = {}) {
  const taskId = String(input.taskId || '').trim();
  if (!/^task_[a-f0-9]{24}$/.test(taskId)) {
    return Promise.reject(new DshCoreAdapterError('IRIS_DSH_TASK_INVALID', 'Core Task ID 无效'));
  }
  return withWriter(async (runtime) => {
    const commands = createCommandService(runtime, {
      resolveTaskCandidates: ({ capability, modelRef }) => {
        const catalog = { providers: allProviders() };
        const ref = modelRef || undefined;
        const candidates = capability === 'video'
          ? videoCandidatesFromCatalog(catalog, ref)
          : capability === 'tts'
            ? ttsCandidatesFromCatalog(catalog, ref)
            : capability === 'transcribe'
              ? transcribeCandidatesFromCatalog(catalog, ref)
              : imageCandidatesFromCatalog(catalog, ref);
        return candidates.map((route) => ({
          adapter: createConfiguredProviderAdapter(route.provider),
          model: route.modelRef,
          selectionReason: route.selectionReason,
          providerBinding: providerTaskBinding(route.provider)
        }));
      }
    });
    const result = await commands.execute('task.retry', {
      task_id: taskId,
      provider_input: input.text !== undefined
        ? { text: input.text, ...(input.voice !== undefined ? { voice: input.voice } : {}) }
        : input.audio_url !== undefined
          ? { audio_url: input.audio_url }
          : { prompt: input.prompt },
      model_ref: input.modelRef,
      confirm_billing: input.confirmBilling
    });
    return runtime.run('inspect', ({ dataRoot }) => {
      const artifacts = [];
      for (const artifactId of result.task.artifactIds) {
        try { artifacts.push(inspectCoreArtifact(dataRoot, artifactId)); }
        catch (_) { /* 缺失媒体在投影行里降级为不可用 */ }
      }
      return Object.freeze({
        taskId: result.task.id,
        retriedFrom: result.retriedFrom,
        row: projectCoreTaskUserRow(result.task, artifacts)
      });
    });
  }, input.signal);
}

/** DSH Host 观察接管的媒体能力白名单：图片、视频与转写共用 Task/Attempt 事实轴。 */
const WATCHABLE_CAPABILITIES = new Set(['image', 'video', 'transcribe']);
const WATCH_INTERVAL_BY_CAPABILITY = Object.freeze({ image: DEFAULT_POLL_INTERVAL_MS, video: 6000, transcribe: 2500 });

function observableProviderTask(task) {
  return Boolean(task && WATCHABLE_CAPABILITIES.has(task.capability)
    && task.acceptance === 'accepted' && task.remoteTaskId
    && ['none', 'unknown'].includes(task.outcome)
    && task.phase !== 'terminal');
}

function configuredAdapterForTask(task) {
  const provider = providerForTaskFromCatalog({ providers: allProviders() }, task);
  return createConfiguredProviderAdapter(provider);
}

function stopProviderWatch(taskId, expectedState) {
  const current = providerWatchers.get(taskId);
  if (expectedState && current !== expectedState) return;
  if (current?.timer) clearTimeout(current.timer);
  providerWatchers.delete(taskId);
  current?.controller.abort();
}

/**
 * DSH Host 拥有的有界 Core 观察器。每个 tick 重新读取 Task 与配置，最多执行
 * 一次 poll；任何路径都不会调用 submit。Runtime/Writer 只在单次观察期间存活。
 */
export async function watchProviderTaskForDsh(input = {}) {
  const taskId = String(input.taskId || '').trim();
  if (!/^task_[a-f0-9]{24}$/.test(taskId)) {
    throw new DshCoreAdapterError('IRIS_DSH_TASK_INVALID', 'Core Task ID 无效');
  }
  if (providerWatchers.has(taskId)) return false;
  const initial = await inspectProviderTaskForDsh(taskId, { signal: input.signal });
  if (!observableProviderTask(initial) || providerWatchers.has(taskId)) return false;
  configuredAdapterForTask(initial); // binding/模型漂移在定时器和网络前失败

  const state = {
    timer: null,
    controller: new AbortController(),
    startedAt: Date.now(),
    errors: 0,
    intervalMs: Math.max(5, Number(input.intervalMs)
      || WATCH_INTERVAL_BY_CAPABILITY[initial.capability] || DEFAULT_POLL_INTERVAL_MS),
    maxWatchMs: Math.max(50, Number(input.maxWatchMs) || DEFAULT_MAX_WATCH_MS)
  };
  providerWatchers.set(taskId, state);

  const schedule = (delay = state.intervalMs) => {
    if (providerWatchers.get(taskId) !== state) return;
    state.timer = setTimeout(() => { tick().catch(() => stopProviderWatch(taskId, state)); }, delay);
    if (state.timer.unref) state.timer.unref();
  };
  const tick = async () => {
    if (providerWatchers.get(taskId) !== state) return;
    const before = await inspectProviderTaskForDsh(taskId, { signal: state.controller.signal });
    if (providerWatchers.get(taskId) !== state) return;
    if (!observableProviderTask(before)) return stopProviderWatch(taskId, state);
    if (Date.now() - state.startedAt > state.maxWatchMs) {
      console.warn('[iris] Core Task 自动观察已达到本轮时限，保留远端受理事实：' + taskId);
      return stopProviderWatch(taskId, state);
    }
    let adapter;
    try {
      adapter = configuredAdapterForTask(before);
    } catch (error) {
      console.warn('[iris] Core Task 无法按原 Provider binding 恢复观察：' + taskId
        + ' · ' + String(error?.code || error?.message || error));
      return stopProviderWatch(taskId, state);
    }
    let after;
    try {
      after = await observeProviderTaskForDsh({
        taskId, adapter, resumeActive: true, signal: state.controller.signal
      });
    } catch (error) {
      if (error?.code === 'IRIS_CORE_DATA_ROOT_BUSY') return schedule();
      state.errors += 1;
      if (state.errors >= POLL_ERROR_TOLERANCE) {
        console.warn('[iris] Core Task 自动观察连续失败，保留事实供人工继续：' + taskId);
        return stopProviderWatch(taskId, state);
      }
      return schedule();
    }
    if (providerWatchers.get(taskId) !== state) return;
    if (!observableProviderTask(after)) return stopProviderWatch(taskId, state);
    if (after.outcome === 'unknown') state.errors += 1;
    else state.errors = 0;
    if (state.errors >= POLL_ERROR_TOLERANCE) {
      console.warn('[iris] Core Task Provider 观察连续失败，保留事实供人工继续：' + taskId);
      return stopProviderWatch(taskId, state);
    }
    schedule();
  };
  schedule(Math.min(500, state.intervalMs));
  return true;
}

/** DSH 启动时只接管仍有明确远端受理证据的 Core 图片 Task。 */
export async function resumeProviderTaskWatchesForDsh(options = {}) {
  if (!fs.existsSync(dshCoreDataRoot())) return Object.freeze([]);
  const records = await withReader((runtime) => runtime.run('inspect', ({ dataRoot }) => {
    const all = [];
    let page;
    do {
      page = listCoreTasks(dataRoot, { offset: all.length, limit: 200 });
      all.push(...page.tasks);
    } while (all.length < page.total);
    return all;
  }));
  const resumed = [];
  for (const original of records) {
    if (!WATCHABLE_CAPABILITIES.has(original.capability)) continue;
    try {
      if (observableProviderTask(original)) configuredAdapterForTask(original);
      const needsRecovery = (original.phase === 'submitting' && original.acceptance === 'none')
        || original.cancelState === 'requested'
        || (original.outcome === 'succeeded' && ['pending', 'downloading'].includes(original.deliveryState))
        || (original.acceptance === 'accepted' && original.watchState === 'active');
      const task = needsRecovery
        ? await withWriter((runtime) => runtime.run('recover', ({ dataRoot }) => recoverCoreTask(dataRoot, original.id)))
        : original;
      if (!observableProviderTask(task)) continue;
      const createdAt = Date.parse(task.createdAt);
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > (options.maxWatchMs || DEFAULT_MAX_WATCH_MS)) {
        console.warn('[iris] Core Task 超过自动接管窗口，保留事实供显式观察：' + task.id);
        continue;
      }
      if (await watchProviderTaskForDsh({
        taskId: task.id,
        intervalMs: options.intervalMs,
        maxWatchMs: options.maxWatchMs
      })) resumed.push(task.id);
    } catch (error) {
      console.warn('[iris] Core Task 启动接管失败：' + original.id
        + ' · ' + String(error?.code || error?.message || error));
    }
  }
  return Object.freeze(resumed);
}

/** 插件 Fiber 释放时停止 Host 定时器并中止在途观察；不请求远端取消或撤销既有受理/成功事实。 */
export function stopProviderTaskWatchesForDsh() {
  for (const taskId of [...providerWatchers.keys()]) stopProviderWatch(taskId);
}

/** 读取 Core Task 事实；reader 不初始化、修复或更新记录。 */
export function inspectProviderTaskForDsh(taskId, options = {}) {
  return withReader((runtime) => runtime.run('inspect', ({ dataRoot }) =>
    inspectCoreTask(dataRoot, taskId)), options.signal);
}

/**
 * 工作台只读候选快照；数据根不存在时不创建任何目录。
 * userTasks 是用户任务区消费的五类状态安全投影（lib/core-user-projection.js），
 * 单条损坏记录或媒体缺失只触发局部降级（degraded/droppedTasks），快照整体仍可加载。
 */
export function coreSnapshotForDsh(options = {}) {
  if (!fs.existsSync(dshCoreDataRoot())) {
    return Promise.resolve(Object.freeze({
      schemaVersion: 0, available: false, readOnly: true, degraded: false, droppedTasks: 0,
      tasks: Object.freeze({ total: 0, recent: Object.freeze([]) }),
      artifacts: Object.freeze({ total: 0, recent: Object.freeze([]) }),
      userTasks: Object.freeze([])
    }));
  }
  return withReader((runtime) => runtime.run('inspect', ({ dataRoot }) => {
    const tasks = listCoreTasks(dataRoot, { limit: options.limit || 12, skipInvalid: true });
    let artifacts = { total: 0, artifacts: Object.freeze([]) };
    let artifactDegraded = false;
    try { artifacts = listCoreArtifacts(dataRoot, { limit: options.limit || 12 }); }
    catch (_) { artifactDegraded = true; }
    const userTasks = decorateCoreUserRows(
      tasks.tasks.map((task) => projectCoreTaskUserRow(task, artifacts.artifacts)),
      listAllCoreTaskRecords(dataRoot),
      readCoreAttentionPrefs()
    );
    return Object.freeze({
      schemaVersion: 0, available: true, readOnly: true,
      degraded: artifactDegraded || tasks.dropped > 0,
      droppedTasks: tasks.dropped,
      tasks: Object.freeze({ total: tasks.total, recent: tasks.tasks }),
      artifacts: Object.freeze({ total: artifacts.total, recent: artifacts.artifacts }),
      userTasks: Object.freeze(userTasks)
    });
  }), options.signal);
}

/** bounded：全量扫描仅供自动静默派生；超界仍有界退出。 */
const SUCCESSOR_SCAN_LIMIT = 2000;
function listAllCoreTaskRecords(dataRoot) {
  const all = [];
  let page;
  do {
    page = listCoreTasks(dataRoot, { offset: all.length, limit: 200, skipInvalid: true });
    all.push(...page.tasks);
  } while (all.length < page.total && all.length < SUCCESSOR_SCAN_LIMIT);
  return all;
}

/** retriedFrom → 后继任务列表（自动静默只从事实派生，不缓存、不落偏好）。 */
function successorsByRetriedFrom(records) {
  const map = new Map();
  for (const record of records) {
    if (!record.retriedFrom) continue;
    if (!map.has(record.retriedFrom)) map.set(record.retriedFrom, []);
    map.get(record.retriedFrom).push(record);
  }
  return map;
}

function suppressedByRetrySuccess(taskId, successors) {
  return (successors.get(taskId) || [])
    .some((record) => record.outcome === 'succeeded' && record.deliveryState === 'ready');
}

/**
 * 投影行装饰：合并 Host 处置偏好与"重试成功自动静默"派生（每次都是事实重算）。
 * historical 只控制 DSH 分区；canceled 的 Core 五类事实投影仍保持 attention 不变。
 */
function decorateCoreUserRows(rows, records, prefs) {
  const successors = successorsByRetriedFrom(records);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return rows.map((row) => Object.freeze({
    ...row,
    disposition: attentionDispositionOf(prefs.entries[row.id]),
    suppressed: suppressedByRetrySuccess(row.id, successors),
    historical: recordsById.get(row.id)?.outcome === 'canceled'
  }));
}

/** 为 DSH 同源媒体路由读取已验证 hash 的 Core 图片；不创建宿主 URL 或 token。 */
export async function readCoreArtifactMediaForDsh(artifactId, options = {}) {
  const id = String(artifactId || '').trim();
  if (!/^artifact_[a-f0-9]{24}$/.test(id) || !fs.existsSync(dshCoreDataRoot())) {
    throw new DshCoreAdapterError('IRIS_DSH_ARTIFACT_NOT_FOUND', 'Core Artifact 不存在');
  }
  try {
    const result = await withReader((runtime) => runtime.run('inspect', ({ dataRoot }) =>
      readCoreArtifactBytes(dataRoot, id)), options.signal);
    if (!result.artifact.mediaType.startsWith('image/') && result.artifact.mediaType !== 'video/mp4'
        && !result.artifact.mediaType.startsWith('audio/') && result.artifact.mediaType !== 'text/plain') {
      throw new DshCoreAdapterError('IRIS_DSH_ARTIFACT_UNSUPPORTED', '当前 DSH 媒体预览只支持图片、mp4 视频、音频与纯文本 Artifact');
    }
    return result;
  } catch (error) {
    if (error instanceof DshCoreAdapterError) throw error;
    throw new DshCoreAdapterError('IRIS_DSH_ARTIFACT_NOT_FOUND', 'Core Artifact 不存在');
  }
}

/**
 * 将已经 ready 的 Core 图片投影为 DSH attachment blocks。重复调用只重复宿主展示，
 * 不修改 Task/Artifact，也不触发 submit、poll 或 download。
 */
export async function projectCoreTaskForDsh(host, taskId, options = {}) {
  const attachments = requireHostPort(host, 'attachments', 'Core 任务产物展示');
  const materialized = await withReader((runtime) => runtime.run('inspect', ({ dataRoot }) => {
    const task = inspectCoreTask(dataRoot, taskId);
    if (task.outcome !== 'succeeded' || task.deliveryState !== 'ready' || !task.artifactIds.length) {
      throw new DshCoreAdapterError('IRIS_DSH_TASK_NOT_READY', 'Core Task 尚无可展示的本地产物');
    }
    return {
      task,
      artifacts: task.artifactIds.map((artifactId) => readCoreArtifactBytes(dataRoot, artifactId))
    };
  }), options.signal);

  const projected = [];
  for (const item of materialized.artifacts) {
    if (options.signal?.aborted) throw abortError();
    if (!item.artifact.mediaType.startsWith('image/')) {
      throw new DshCoreAdapterError('IRIS_DSH_ARTIFACT_UNSUPPORTED', '当前 DSH 投影只支持图片 Artifact');
    }
    let attachment;
    try {
      attachment = await attachments.saveImage({
        data: new Uint8Array(item.bytes),
        mediaType: item.artifact.mediaType,
        name: 'iris-core-' + item.artifact.id + '.png'
      });
    } catch (_) {
      throw new DshCoreAdapterError('IRIS_DSH_PROJECTION_FAILED', 'Core 产物无法保存为 DSH attachment');
    }
    if (!attachment || !String(attachment.attachmentId || '').trim()) {
      throw new DshCoreAdapterError('IRIS_DSH_PROJECTION_FAILED', 'DSH attachment 返回无效');
    }
    projected.push(Object.freeze({ artifact: item.artifact, attachment }));
  }

  const blocks = [];
  for (const item of projected) {
    blocks.push(Object.freeze({
      type: 'text',
      text: '[iris] Core 任务完成：' + materialized.task.id
        + '\nartifact: ' + item.artifact.id + '\nattachment: ' + item.attachment.attachmentId
    }));
    blocks.push(Object.freeze({ type: 'image', attachment: item.attachment }));
  }
  return Object.freeze({
    task: materialized.task,
    artifacts: Object.freeze(projected),
    blocks: Object.freeze(blocks)
  });
}
