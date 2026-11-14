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
  transitionOperation, projectOperation, operationFail, MAX_ACTIVE_OPERATIONS } from './operation-store.js';
import { reservePluginOperation } from './plugin-operations.js';
import { invokeReservedPlugin } from './plugin-execution.js';
import { acceptPluginOperation, pluginInputDigest, pluginSourceArtifacts, reservePluginArtifact } from './plugin-operation-store.js';
import { readFlowRun } from './flow-store.js';
import { findFlowTask } from './core-tasks.js';

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
export function createOperationRunner({ dataRoot, application: suppliedApplication, resolveImageCandidates, resolveAudioCandidates, resolveVideoCandidates, resolveVisionCandidates, resolveTaskAdapter, onExecutionError,
  pluginRegistry, allowedOperations = [] } = {}) {
  const root = normalizeCoreOptions({ dataRoot }).dataRoot;
  const application = suppliedApplication || createApplicationRuntime({ dataRoot: root, resolveImageCandidates, resolveAudioCandidates, resolveVideoCandidates, resolveVisionCandidates, resolveTaskAdapter });
  const ports = { resolveImageCandidates, resolveAudioCandidates, resolveVideoCandidates, resolveVisionCandidates, resolveTaskAdapter };
  if (onExecutionError !== undefined && typeof onExecutionError !== 'function') throw new TypeError('执行错误报告器须为函数');
  const queue = [], active = new Map(), finalizing = new Map();
  const scheduled = Boolean(application.scheduler);
  const transaction = (action, options) => application.transaction ? application.transaction(action, options) : application.run('writer', action);
  let state = 'new', physicalRoot, directory, ownership, lease, ownerInstanceId, draining, disposal, failure, wake;

  function snapshot() {
    return Object.freeze({ state, queued: queue.length, active: active.keys().next().value || null,
      ...(scheduled ? { activeOperations: [...active.keys()] } : {}),
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
    for (const job of active.values()) job.controller.abort();
  }
  function finishIfActive(id, terminal, failureCode) {
    if (finalizing.has(id)) return finalizing.get(id);
    const completion = transaction(runtime => runtime.run('execute', ({ dataRoot }) => {
      requireOwner();
      const record = readOperation(dataRoot, id);
      if (!record || !activeState(record)) return record;
      if (record.ownerInstanceId !== ownerInstanceId) operationFail('IRIS_EXECUTION_OWNERSHIP_LOST', 'Operation 不属于本次执行实例');
      return transitionOperation(dataRoot, { id, expectedRevision: record.revision, state: terminal,
        ...(failureCode ? { failureCode } : {}) });
    }), { finalize: true }).finally(() => { finalizing.delete(id); });
    finalizing.set(id, completion);
    return completion;
  }
  async function perform(job) {
    let admitted = false;
    try {
      const saved = readOperation(physicalRoot, job.id);
      job.runId = saved?.runId;
      const execute = saved?.action === 'flow.continue' && application.runMedia ? application.runMedia : (action, options) => application.run('writer', action, options);
      await execute(runtime => { admitted = true; return runtime.run('execute', async ({ dataRoot }) => {
        requireOwner();
        let record = readOperation(dataRoot, job.id);
        if (!record || !activeState(record)) return;
        if (record.ownerInstanceId !== ownerInstanceId) operationFail('IRIS_EXECUTION_OWNERSHIP_LOST', 'Operation 执行归属不一致');
        if (job.stopReason) {
          transitionOperation(dataRoot, { id: job.id, expectedRevision: record.revision, state: job.stopReason }); return;
        }
        if (record.action === 'plugin.execute') {
          let reservation, result, executionError;
          try {
            job.authorize?.();
            reservation = reservePluginOperation(pluginRegistry, record.operationId, record.input, allowedOperations, record.dependency);
            record = transitionOperation(dataRoot, { id: job.id, expectedRevision: record.revision, state: 'running' });
            result = await invokeReservedPlugin(runtime, reservation, { imports: { operationId: record.id, sources: record.sourceArtifactIds,
              authorize: job.authorize, reserve: () => reservePluginArtifact(dataRoot, inspectExecutionRoot(dataRoot), job.id) } });
          } catch (error) { executionError = error; }
          finally { reservation?.release(); }
          const current = readOperation(dataRoot, job.id);
          const dependencyError = /IRIS_PLUGIN_(?:CLOSED|CONTRIBUTION_MISSING|DEPENDENCY_MISMATCH)/.test(executionError?.code || '');
          const denied = /(?:DENIED|HANDSHAKE_REQUIRED|AUTH_REQUIRED|REVOKED)$/.test(executionError?.code || '');
          transitionOperation(dataRoot, { id: job.id, expectedRevision: current.revision, state: job.stopReason || (executionError ? 'failed' : 'succeeded'),
            ...(executionError && !job.stopReason ? { failureCode: dependencyError ? 'dependency_unavailable' : denied ? 'permission_denied' : 'execution_failed' } : {}),
            ...(!executionError && !job.stopReason ? { value: result.value } : {}) });
          if (executionError && !job.stopReason) onExecutionError?.(executionError, job.id);
          return;
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
      }); }, { signal: job.controller.signal, ...(saved?.runId ? { key: `run:${saved.runId}` } : {}) });
    } catch (error) {
      if (job.stopReason && error.name === 'AbortError' && !application.snapshot().cleanupFailed) {
        await finishIfActive(job.id, job.stopReason);
      } else if (scheduled && !admitted && !application.snapshot().cleanupFailed
          && ['IRIS_SCHEDULER_QUEUE_TIMEOUT', 'IRIS_SCHEDULER_QUEUE_FULL'].includes(error.code)) {
        await finishIfActive(job.id, job.stopReason || 'failed', job.stopReason ? undefined : 'execution_failed');
        if (!job.stopReason) onExecutionError?.(error, job.id);
      } else throw error;
    }
  }
  function pump() {
    if (draining) { wake?.(); return; }
    if (state !== 'open') return;
    let blocked = false;
    draining = (async () => {
      while ((state === 'open' && queue.length && !blocked) || active.size) {
        while (state === 'open' && queue.length && !blocked && active.size < (scheduled ? MAX_ACTIVE_OPERATIONS : 1)) {
          const job = queue.shift(); job.rootBusy = false; active.set(job.id, job);
          job.done = perform(job).catch(error => {
            if (error.code !== 'IRIS_CORE_DATA_ROOT_BUSY') throw error;
            job.rootBusy = true;
            queue.unshift(job); blocked = true; // Explicit retry only; no lease stealing or polling timer.
          }).finally(() => { active.delete(job.id); });
        }
        if (active.size) {
          const added = new Promise(resolve => { wake = resolve; });
          await Promise.race([...active.values()].map(job => job.done).concat(added));
          wake = null;
        }
      }
    })();
    void draining.then(() => { draining = null; if (state === 'open' && queue.length && !blocked) queueMicrotask(pump); },
      error => { draining = null; failRunner(error); });
  }
  async function start() {
    if (state !== 'new') operationFail('IRIS_EXECUTION_LIFECYCLE', '执行服务只能显式启动一次');
    state = 'starting';
    try {
      physicalRoot = fs.realpathSync(root); directory = executionRunnerDirectory(physicalRoot);
      lease = createCoreRuntime({ dataRoot: directory, mode: 'writer' }); lease.start();
      ownership = inspectRunnerArea(directory); ownerInstanceId = ownership.owner.instanceId;
      state = 'open';
      await transaction(runtime => runtime.run('execute', ({ dataRoot }) => {
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
  async function submit(input, { authorize } = {}) {
    writable();
    if (input?.operationId !== undefined) {
      if (!input || Object.keys(input).sort().join(',') !== 'dependency,input,key,operationId') operationFail('IRIS_OPERATION_INPUT_INVALID', '业务执行需要原 Key、准确贡献依赖及输入');
      authorize?.();
      const marker = inspectExecutionRoot(physicalRoot), id = operationId(marker, input.key), previous = readOperation(physicalRoot, id, marker);
      const fingerprint = pluginInputDigest(input.operationId, input.input, input.dependency, previous?.sourceArtifactIds);
      if (previous) {
        if (previous.action !== 'plugin.execute' || previous.inputDigest !== fingerprint) operationFail('IRIS_OPERATION_KEY_CONFLICT', '该 Key 已绑定另一业务或输入');
        if (previous.state === 'queued' && previous.ownerInstanceId === ownerInstanceId) queueMicrotask(pump);
        return { contractVersion: 0, operation: projectOperation(previous), idempotentReplay: true };
      }
      if (!scheduled && (application.snapshot().activeWrites || application.snapshot().queuedWrites)) busy();
      const reservation = reservePluginOperation(pluginRegistry, input.operationId, input.input, allowedOperations, input.dependency);
      let record, replay = false;
      try {
        record = await transaction(runtime => runtime.run('execute', ({ dataRoot }) => {
          writable(); authorize?.();
          const current = readOperation(dataRoot, id, marker);
          if (current) {
            if (current.action !== 'plugin.execute' || current.inputDigest !== pluginInputDigest(input.operationId, input.input, input.dependency, current.sourceArtifactIds)) {
              operationFail('IRIS_OPERATION_KEY_CONFLICT', '该 Key 已绑定另一业务或输入');
            }
            replay = true; return current;
          }
          if (readAllOperations(dataRoot).filter(activeState).length >= MAX_ACTIVE_OPERATIONS - Number(scheduled)) operationFail('IRIS_OPERATION_QUEUE_FULL', '未结束的 Operation 已达上限；调度模式保留一个位置供原任务恢复');
          return acceptPluginOperation(dataRoot, marker, id, { ...input, input: reservation.input,
            sourceArtifactIds: pluginSourceArtifacts(reservation.input, reservation.artifactInputs), ownerInstanceId });
        }));
      } finally { reservation.release(); }
      if (!replay) queue.push({ id, controller: new AbortController(), stopReason: null, authorize });
      if (!replay || record.state === 'queued' && record.ownerInstanceId === ownerInstanceId) queueMicrotask(pump);
      return { contractVersion: 0, operation: projectOperation(record), idempotentReplay: replay };
    }
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
    if (!scheduled && (application.snapshot().activeWrites || application.snapshot().queuedWrites)) busy();
    const accepted = await transaction(runtime => runtime.run('execute', ({ dataRoot }) => {
      writable();
      if (scheduled && !readOperation(dataRoot, id) && readAllOperations(dataRoot).filter(activeState).length >= MAX_ACTIVE_OPERATIONS - 1
          && !findFlowTask(dataRoot, readFlowRun(dataRoot, input.runId))?.attempts.length) {
        operationFail('IRIS_OPERATION_QUEUE_FULL', '新提交队列已满；保留一个位置用于原任务查询和交付');
      }
      return acceptOperation(dataRoot, { ...input, ownerInstanceId });
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
      const job = active.get(id) || queue.find(job => job.id === id);
      if (job) { job.stopReason = 'canceled'; job.controller.abort(); }
      if (active.has(id)) await job.done;
      else {
        await finishIfActive(id, 'canceled');
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
      }
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
    for (const job of active.values()) { job.stopReason ||= 'interrupted'; job.controller.abort(); }
    disposal = (async () => {
      if (draining) await draining;
      if (failure) throw failure;
      for (const job of queue.splice(0)) await finishIfActive(job.id, 'interrupted');
      if (!suppliedApplication) await application.dispose();
      await lease?.dispose(); state = 'closed'; return snapshot();
    })();
    return disposal;
  }
  return Object.freeze({ start, submit, stop, idle, dispose, snapshot,
    scheduling(id) {
      const job = active.get(id) || queue.find(item => item.id === id);
      if (job?.rootBusy) return { phase: 'root_busy' };
      const phase = job?.runId && application.schedulingPhase(`run:${job.runId}`);
      return scheduled && phase ? { phase } : undefined;
    } });
}
