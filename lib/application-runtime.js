'use strict';

import { normalizeCoreOptions } from './core-contract.js';
import { createCoreRuntime, inspectCoreWriterLease } from './core-runtime.js';
import { createCommandService } from './command-service.js';
import { normalizeGenerationInput } from './generation-input.js';
import { createProviderTaskRunner } from './provider-task-runner.js';
import { createImageFlowService } from './image-flow.js';
import { createLocalCreationService } from './local-creation.js';
import { createLocalOperationService } from './local-operations.js';
import { reservePluginOperation } from './plugin-operations.js';
import { invokeReservedPlugin } from './plugin-execution.js';

// Internal first-slice execution surface, not a public API or an HTTP allowlist.
const COMMAND_MODES = Object.freeze({
  'artifact.import': 'writer', 'artifact.export': 'writer', 'media.diff': 'writer',
  'task.observe': 'writer', 'task.reobserve': 'writer', 'task.redeliver': 'writer', 'task.cancel': 'writer',
  'artifact.inspect': 'reader', 'artifact.list': 'reader', 'task.inspect': 'reader', 'task.list': 'reader',
  'flow.init': 'writer', 'flow.create': 'writer', 'flow.continue': 'writer', 'flow.select': 'writer', 'flow.export': 'writer',
  'flow.inspect': 'reader', 'flow.list': 'reader',
  'creation.init': 'writer', 'creation.image': 'writer', 'creation.flow': 'writer', 'creation.generate': 'writer',
  'creation.audio': 'writer', 'creation.speech': 'writer', 'creation.transcribe': 'writer',
  'creation.root': 'reader', 'creation.lookup': 'reader',
  'execution.init': 'writer', 'operation.accept': 'writer', 'operation.transition': 'writer',
  'operation.inspect': 'reader', 'operation.lookup': 'reader', 'operation.list': 'reader'
});

export class ApplicationRuntimeError extends Error {
  constructor(code, message) { super(message); this.name = 'ApplicationRuntimeError'; this.code = code; }
}

function aborted() {
  return Object.assign(new ApplicationRuntimeError('IRIS_APP_ABORTED', 'Iris 操作已取消'), { name: 'AbortError' });
}

function closed() {
  return new ApplicationRuntimeError('IRIS_APP_CLOSED', 'Iris 应用运行时正在关闭或已关闭');
}

/** Instance-owned FIFO and operation-scoped Core leases. No I/O until an explicit operation. */
export function createApplicationRuntime({ dataRoot, resolveImageCandidates, resolveAudioCandidates, resolveTaskAdapter } = {}) {
  const root = normalizeCoreOptions({ dataRoot }).dataRoot;
  if (resolveImageCandidates !== undefined && typeof resolveImageCandidates !== 'function') {
    throw new TypeError('resolveImageCandidates 必须是显式候选解析函数');
  }
  if (resolveTaskAdapter !== undefined && typeof resolveTaskAdapter !== 'function') {
    throw new TypeError('resolveTaskAdapter 必须是显式 Task Provider 解析函数');
  }
  if (resolveAudioCandidates !== undefined && typeof resolveAudioCandidates !== 'function') throw new TypeError('音频候选解析须为函数');
  let state = 'open';
  const queue = [];
  const active = new Set();
  let writer = null;
  let disposePromise;
  let cleanupFailure;

  function snapshot() {
    return Object.freeze({ state, queuedWrites: queue.length, activeWrites: Number(Boolean(writer)),
      activeReaders: active.size - Number(Boolean(writer)), cleanupFailed: Boolean(cleanupFailure) });
  }

  function detach(job) { job.signal?.removeEventListener('abort', job.onAbort); }

  function rejectQueued(job, error) {
    detach(job);
    job.reject(error);
  }

  function stop(job) {
    job.aborted = true;
    if (job.runtime && !job.disposal) {
      job.disposal = job.runtime.dispose();
      // The operation awaits this same promise below and reports any cleanup error.
      job.disposal.catch(() => {});
    }
  }

  function stopAll() {
    for (const job of queue.splice(0)) rejectQueued(job, closed());
    for (const job of active) stop(job);
  }

  async function perform(job) {
    if (job.aborted) throw aborted();
    const runtime = createCoreRuntime({ dataRoot: root, mode: job.mode });
    job.runtime = runtime;
    let result, operationError, failed = false;
    try {
      runtime.start();
      result = await job.action(runtime);
    } catch (error) {
      failed = true; operationError = error;
      if (job.mode === 'reader' && error?.code === 'IRIS_ARTIFACT_INDEX_INVALID' && error.missingFile === true) {
        const lease = inspectCoreWriterLease(root);
        if (lease.status === 'present' && lease.ownerStatus === 'alive') {
          operationError = new ApplicationRuntimeError('IRIS_CORE_DATA_ROOT_BUSY', '作品读取遇到活动写入，请在写入结束后显式重试');
          Object.defineProperty(operationError, 'cause', { value: error });
        }
      }
    }
    try { await (job.disposal || runtime.dispose()); }
    catch (error) {
      cleanupFailure ||= error;
      state = 'closing';
      stopAll();
      if (failed) {
        throw Object.assign(new AggregateError([operationError, error], 'Iris 操作失败且运行时未能安全释放'), { code: error.code });
      }
      throw error;
    }
    if (failed) throw operationError;
    return result;
  }

  function start(job) {
    active.add(job);
    job.done = Promise.resolve().then(async () => {
      let result, error, failed = false;
      try { result = await perform(job); }
      catch (caught) { failed = true; error = caught; }
      detach(job);
      active.delete(job);
      if (writer === job) writer = null;
      if (failed) job.reject(error); else job.resolve(result);
      dispatch();
    });
  }

  function dispatch() {
    if (state !== 'open' || writer || !queue.length) return;
    writer = queue.shift();
    start(writer);
  }

  function schedule(mode, action, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal 必须是 AbortSignal');
    if (state !== 'open') return Promise.reject(closed());
    if (signal?.aborted) return Promise.reject(aborted());
    let job;
    const result = new Promise((resolve, reject) => { job = { mode, action, signal, resolve, reject, aborted: false }; });
    job.onAbort = () => {
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); rejectQueued(job, aborted()); }
      else stop(job);
    };
    signal?.addEventListener('abort', job.onAbort, { once: true });
    if (mode === 'writer') { queue.push(job); dispatch(); }
    else start(job);
    return result;
  }

  /** Trusted in-process Host composition; never an external command/HTTP dispatch surface. */
  function run(mode, action, options) {
    if (!['reader', 'writer'].includes(mode)) throw new TypeError('Host 操作需要明确 reader/writer 模式');
    if (typeof action !== 'function') throw new TypeError('Host 操作必须是函数');
    return schedule(mode, action, options);
  }

  async function execute(name, input, options) {
    if (!Object.hasOwn(COMMAND_MODES, name)) {
      throw new ApplicationRuntimeError('IRIS_APP_COMMAND_UNSUPPORTED', '应用运行时尚未装配该 Command');
    }
    const ownedInput = structuredClone(input);
    return schedule(COMMAND_MODES[name], runtime => {
      const ports = resolveTaskAdapter ? { resolveTaskAdapter: async task => {
        const adapter = await resolveTaskAdapter(task, { signal: runtime.signal });
        if (runtime.signal.aborted) throw aborted();
        return adapter;
      } } : {};
      if (name === 'execution.init' || name.startsWith('operation.')) return createLocalOperationService(runtime).execute(name, ownedInput);
      if (name.startsWith('creation.')) return createLocalCreationService(runtime, { resolveImageCandidates, resolveAudioCandidates,
        onPrepared: options?.onPrepared }).execute(name, ownedInput);
      if (name.startsWith('flow.')) return createImageFlowService(runtime, { ...ports, resolveImageCandidates, resolveAudioCandidates }).execute(name, ownedInput);
      return createCommandService(runtime, ports).execute(name, ownedInput);
    }, options);
  }

  async function generateImage(input, options) {
    const normalized = normalizeGenerationInput('image', input);
    if (!resolveImageCandidates) {
      throw new ApplicationRuntimeError('IRIS_APP_IMAGE_RESOLVER_MISSING', '图片生成需要显式提供候选解析函数');
    }
    return schedule('writer', async runtime => {
      const candidates = await resolveImageCandidates({ modelRef: normalized.modelRef, signal: runtime.signal });
      if (runtime.signal.aborted) throw aborted();
      return createProviderTaskRunner(runtime).submit({ capability: 'image', candidates,
        providerInput: normalized.providerInput, sourceArtifactId: normalized.sourceArtifactId });
    }, options);
  }

  /** Explicit trusted assembly only. No HTTP/MCP route or persistent Operation action is added. */
  async function executePluginOperation(registry, id, input, { allowedOperations = [], dependency, signal } = {}) {
    const reserved = reservePluginOperation(registry, id, input, allowedOperations, dependency);
    try {
      return await schedule(reserved.mode, runtime => runtime.run(reserved.mode === 'reader' ? 'inspect' : 'execute',
        () => invokeReservedPlugin(runtime, reserved)), { signal });
    } finally { reserved.release(); }
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    state = 'closing';
    stopAll();
    disposePromise = Promise.all([...active].map(job => job.done)).then(() => {
      if (cleanupFailure) throw cleanupFailure;
      state = 'closed';
      return snapshot();
    });
    return disposePromise;
  }

  return Object.freeze({ execute, generateImage, executePluginOperation, run, dispose, snapshot });
}
