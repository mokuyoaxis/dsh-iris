import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from './application-runtime.js';
import { normalizeCoreOptions } from './core-contract.js';
import { createCoreRuntime } from './core-runtime.js';
import { createImageFlowService } from './image-flow.js';
import { inspectRunnerArea } from './execution-ownership.js';
import { requestDirectory } from './local-request-root.js';
import { inspectCoreWriterLease } from './core-runtime.js';
import { recoverCoreWriterLease } from './core-lease-recovery.js';
import { acceptOperation, inspectExecutionRoot, operationId, readOperation, readAllOperations,
  transitionOperation, projectOperation, operationFail } from './operation-store.js';

const activeState = record => ['queued', 'running'].includes(record.state);
const busy = () => operationFail('IRIS_CORE_DATA_ROOT_BUSY', '当前写者正在执行，请用原 Key 稍后明确重试');

export function executionRunnerDirectory(root) {
  return requestDirectory(root, inspectExecutionRoot(root), 'runner');
}
export function inspectExecutionLease(root) {
  return inspectCoreWriterLease(executionRunnerDirectory(root));
}
export function recoverExecutionLease(root, options) {
  return recoverCoreWriterLease(executionRunnerDirectory(root), options);
}

/** One execution owner, one finite continue per accepted Operation. Construction performs no I/O. */
export function createOperationRunner({ dataRoot, application: suppliedApplication, resolveImageCandidates, resolveTaskAdapter, onExecutionError } = {}) {
  const root = normalizeCoreOptions({ dataRoot }).dataRoot;
  const application = suppliedApplication || createApplicationRuntime({ dataRoot: root, resolveImageCandidates, resolveTaskAdapter });
  const ports = { resolveImageCandidates, resolveTaskAdapter };
  if (onExecutionError !== undefined && typeof onExecutionError !== 'function') throw new TypeError('执行错误报告器须为函数');
  const queue = [];
  let state = 'new', physicalRoot, directory, ownership, lease, ownerInstanceId, active, draining, disposal, failure;

  function snapshot() {
    return Object.freeze({ state, queued: queue.length, active: active?.id || null,
      executionEnabled: state === 'open', failed: Boolean(failure) });
  }
  function requireOwner() {
    if (state !== 'open' && state !== 'closing') operationFail('IRIS_EXECUTION_UNAVAILABLE', '执行服务未就绪或已停止');
    if (inspectRunnerArea(directory)?.fingerprint !== ownership.fingerprint) {
      operationFail('IRIS_EXECUTION_OWNERSHIP_LOST', '执行所有权已改变，停止执行并保留现场');
    }
  }
  function writable() {
    requireOwner();
    if (state !== 'open') operationFail('IRIS_EXECUTION_UNAVAILABLE', '执行服务正在关闭');
  }
  function failRunner(error) {
    failure ||= error; state = 'failed';
    active?.controller.abort();
  }
  async function finishIfActive(id, terminal) {
    return application.run('writer', runtime => runtime.run('execute', ({ dataRoot }) => {
      requireOwner();
      const record = readOperation(dataRoot, id);
      if (!record || !activeState(record)) return record;
      if (record.ownerInstanceId !== ownerInstanceId) operationFail('IRIS_EXECUTION_OWNERSHIP_LOST', 'Operation 不属于本次执行实例');
      return transitionOperation(dataRoot, { id, expectedRevision: record.revision, state: terminal });
    }));
  }
  async function perform(job) {
    try {
      await application.run('writer', runtime => runtime.run('execute', async ({ dataRoot }) => {
        requireOwner();
        let record = readOperation(dataRoot, job.id);
        if (!record || !activeState(record)) return;
        if (record.ownerInstanceId !== ownerInstanceId) operationFail('IRIS_EXECUTION_OWNERSHIP_LOST', 'Operation 执行归属不一致');
        if (job.stopReason) {
          transitionOperation(dataRoot, { id: job.id, expectedRevision: record.revision, state: job.stopReason }); return;
        }
        try { record = transitionOperation(dataRoot, { id: job.id, expectedRevision: record.revision, state: 'running' }); }
        catch (error) {
          if (error.code !== 'IRIS_OPERATION_RUN_CHANGED') throw error;
          transitionOperation(dataRoot, { id: job.id, expectedRevision: record.revision, state: 'failed', failureCode: 'run_changed' }); return;
        }
        let executionError;
        try { await createImageFlowService(runtime, ports).execute('flow.continue', { run_id: record.runId }); }
        catch (error) { executionError = error; }
        // The operation-scoped writer is still held, including after its signal aborts.
        // Persist only local execution facts; Provider Task outcome remains authoritative.
        transitionOperation(dataRoot, { id: job.id, expectedRevision: record.revision,
          state: job.stopReason || (executionError ? 'failed' : 'succeeded'),
          ...(executionError && !job.stopReason ? { failureCode: 'execution_failed' } : {}) });
        if (executionError && !job.stopReason) onExecutionError?.(executionError, job.id);
      }), { signal: job.controller.signal });
    } catch (error) {
      if (job.stopReason && error.name === 'AbortError' && !application.snapshot().cleanupFailed) {
        await finishIfActive(job.id, job.stopReason);
      } else throw error;
    }
  }
  function pump() {
    if (draining || state !== 'open') return;
    draining = (async () => {
      while (state === 'open' && queue.length) {
        active = queue.shift();
        active.done = perform(active);
        try { await active.done; }
        catch (error) {
          if (error.code !== 'IRIS_CORE_DATA_ROOT_BUSY') throw error;
          queue.unshift(active); active = null; break; // No timer or lease stealing; explicit retry wakes this queue.
        }
        active = null;
      }
    })();
    void draining.then(() => { draining = null; }, error => { draining = null; failRunner(error); });
  }
  async function start() {
    if (state !== 'new') operationFail('IRIS_EXECUTION_LIFECYCLE', '执行服务只能显式启动一次');
    state = 'starting';
    try {
      physicalRoot = fs.realpathSync(root); directory = executionRunnerDirectory(physicalRoot);
      lease = createCoreRuntime({ dataRoot: directory, mode: 'writer' }); lease.start();
      ownership = inspectRunnerArea(directory); ownerInstanceId = ownership.owner.instanceId;
      state = 'open';
      await application.run('writer', runtime => runtime.run('execute', ({ dataRoot }) => {
        requireOwner();
        for (const record of readAllOperations(dataRoot).filter(activeState)) {
          transitionOperation(dataRoot, { id: record.id, expectedRevision: record.revision, state: 'interrupted' });
        }
      }));
      return snapshot();
    } catch (error) {
      state = 'failed'; failure = error;
      if (lease) await lease.dispose();
      throw error;
    }
  }
  async function submit(input) {
    writable();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3
        || !['key', 'runId', 'expectedRunRevision'].every(key => Object.hasOwn(input, key))) {
      operationFail('IRIS_OPERATION_INPUT_INVALID', '需要明确 Key、Run 和预期 revision');
    }
    const marker = inspectExecutionRoot(physicalRoot), id = operationId(marker, input.key);
    const previous = readOperation(physicalRoot, id, marker);
    if (previous) {
      if (previous.runId !== input.runId || previous.expectedRunRevision !== input.expectedRunRevision) {
        operationFail('IRIS_OPERATION_KEY_CONFLICT', '该 Key 已绑定其他操作输入');
      }
      if (previous.state === 'queued' && previous.ownerInstanceId === ownerInstanceId) queueMicrotask(pump);
      return { contractVersion: 0, operation: projectOperation(previous), idempotentReplay: true };
    }
    if (application.snapshot().activeWrites || application.snapshot().queuedWrites) busy();
    const accepted = await application.run('writer', runtime => runtime.run('execute', ({ dataRoot }) => {
      writable(); return acceptOperation(dataRoot, { ...input, ownerInstanceId });
    }));
    if (!accepted.idempotentReplay) {
      queue.push({ id: accepted.operation.id, controller: new AbortController(), stopReason: null });
      queueMicrotask(pump);
    }
    return { contractVersion: 0, operation: projectOperation(accepted.operation), idempotentReplay: accepted.idempotentReplay };
  }
  async function stop(id) {
    writable();
    const record = readOperation(physicalRoot, id);
    if (!record) operationFail('IRIS_OPERATION_NOT_FOUND', 'Operation 不存在');
    if (activeState(record)) {
      if (record.ownerInstanceId !== ownerInstanceId) operationFail('IRIS_EXECUTION_OWNERSHIP_LOST', '不能停止另一执行实例的操作');
      const job = active?.id === id ? active : queue.find(job => job.id === id);
      if (job) { job.stopReason = 'canceled'; job.controller.abort(); }
      if (active?.id === id) await job.done;
      else await finishIfActive(id, 'canceled');
    }
    const saved = readOperation(physicalRoot, id);
    if (activeState(saved)) operationFail('IRIS_EXECUTION_STOP_UNSAVED', '停止尚未持久保存，请查询原 Operation');
    return { contractVersion: 0, operation: projectOperation(saved),
      localStopped: saved.state === 'canceled', remoteCancellation: 'not_requested' };
  }
  async function idle() { if (draining) await draining; if (failure) throw failure; return snapshot(); }
  function dispose() {
    if (disposal) return disposal;
    if (state === 'new') { state = 'closed'; return disposal = suppliedApplication ? Promise.resolve(snapshot()) : application.dispose().then(snapshot); }
    if (state === 'closed') return Promise.resolve(snapshot());
    if (state !== 'failed') state = 'closing';
    if (active) { active.stopReason ||= 'interrupted'; active.controller.abort(); }
    disposal = (async () => {
      if (draining) await draining;
      if (failure) throw failure;
      for (const job of queue.splice(0)) await finishIfActive(job.id, 'interrupted');
      if (!suppliedApplication) await application.dispose();
      await lease?.dispose(); state = 'closed'; return snapshot();
    })();
    return disposal;
  }
  return Object.freeze({ start, submit, stop, idle, dispose, snapshot });
}
