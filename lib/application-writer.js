import { AsyncResource } from 'node:async_hooks';
import { createCoreRuntime } from './core-runtime.js';
import { schedulingError } from './scheduling-policy.js';
import { performance } from 'node:perf_hooks';

const aborted = () => Object.assign(schedulingError('IRIS_APP_ABORTED', 'Iris 操作已取消'), { name: 'AbortError' });
const closed = () => schedulingError('IRIS_APP_CLOSED', 'Iris 应用运行时正在关闭或已关闭');

/** Internal cooperative writer. Only known media code may loan its write turn. */
export function createApplicationWriter({ dataRoot, policy, scheduler, onFailure }) {
  const pending = [], active = new Set(), taskGate = {};
  let rootRuntime, owner, closing = false, failure, retiring, disposal;
  const snapshot = () => ({ queuedWrites: pending.filter(entry => entry.kind === 'start').length,
    activeWrites: Number(Boolean(rootRuntime)), writeTurn: Number(Boolean(owner)),
    managedWrites: active.size, waitingWrites: [...active].filter(job => job.parked).length, cleanupFailed: Boolean(failure) });

  function remove(entry) {
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
    clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort);
  }
  function enqueue(entry) {
    return new Promise((resolve, reject) => {
      entry.resolve = resolve; entry.reject = reject;
      pending.push(entry); pump();
    });
  }
  async function retire() {
    const runtime = rootRuntime;
    try { await runtime.dispose(); }
    catch (error) {
      failure = error; closing = true; onFailure?.(error);
      for (const entry of [...pending]) { remove(entry); entry.reject(error); }
      throw error;
    } finally { rootRuntime = null; retiring = null; pump(); }
  }
  function pump() {
    if (owner || retiring) return;
    // A waiting exclusive callback cannot block the resumes that let earlier media jobs finish.
    let index = pending.findIndex(entry => entry.kind !== 'start' || entry.transaction);
    if (index < 0) index = 0;
    let entry = pending[index];
    if (!entry) {
      if (rootRuntime && !active.size) {
        retiring = Promise.resolve().then(retire); void retiring.catch(() => {});
      }
      return;
    }
    if (entry.kind === 'start' && performance.now() >= entry.deadline) {
      remove(entry); entry.reject(schedulingError('IRIS_SCHEDULER_QUEUE_TIMEOUT', '本地写入等候超时；未开始本次操作')); pump(); return;
    }
    if (entry.kind === 'start' && (!entry.managed && active.size || [...active].some(job => !job.managed))) return;
    remove(entry);
    if (entry.kind === 'start') {
      try {
        if (!rootRuntime) { rootRuntime = createCoreRuntime({ dataRoot, mode: 'writer' }); rootRuntime.start(); }
      } catch (error) {
        entry.reject(error);
        // start may have retained a failed lease; dispose must report that failure.
        retiring = Promise.resolve().then(retire); void retiring.catch(() => {}); return;
      }
      const job = entry.job;
      active.add(job); owner = job;
      entry.resolve();
    } else { owner = entry.job; entry.resolve(); }
  }
  function release(job) {
    if (owner !== job) throw new Error('Iris writer turn ownership mismatch');
    owner = null;
    let error;
    try { scheduler?.changed(dataRoot); } catch (caught) { error = caught; }
    pump(); return error;
  }
  async function networkWait(job, action, reason = 'network') {
    if (!job.managed || job.parked) throw new Error('Iris write turn can only be loaned once by managed media');
    job.parked = reason; const releaseError = release(job);
    let result, error;
    try { if (releaseError) throw releaseError; result = await action(); } catch (caught) { error = caught; }
    // Even an aborted operation reacquires its turn before recording acceptance/terminal facts.
    await enqueue({ kind: 'resume', job }); job.parked = null; job.phase = null;
    if (error) throw error;
    return result;
  }
  async function checkpoint(job, action) {
    if (job.finished) throw closed();
    const parked = job.parked;
    if (parked) await enqueue({ kind: 'checkpoint', job });
    if (owner !== job) throw new Error('Core checkpoint requires the current write turn');
    try {
      const value = action();
      if (value && typeof value.then === 'function') throw new TypeError('Core checkpoint 必须同步完成');
      return value;
    } finally { if (parked) { const error = release(job); if (error) throw error; } }
  }
  async function execute(action, { signal, managed = false, transaction = false, finalize = false, key } = {}) {
    if (closing) throw closed();
    signal?.throwIfAborted();
    if (!finalize && active.size + pending.filter(entry => entry.kind === 'start').length >= policy.queueLimit) {
      throw schedulingError('IRIS_SCHEDULER_QUEUE_FULL', '本地写入队列已满；请查询原操作后再明确重试');
    }
    const resource = new AsyncResource('IrisApplicationWriter'), controller = new AbortController();
    const job = { managed, parked: null, key, controller, cleanup: [], inFlight: new Set(), finished: false };
    // Only the runner uses finalize for short terminal writes of already accepted Operations.
    // They must drain under the writer even when new work has reached its admission budget.
    const entry = { kind: 'start', job, signal, managed, transaction, deadline: finalize ? Infinity : performance.now() + policy.queueTimeoutMs };
    // Same durable Run/creation key must not overlap even if its candidate resolver waits.
    if (key && ([...active].some(other => other.key === key) || pending.some(other => other.job.key === key))) {
      resource.emitDestroy(); throw schedulingError('IRIS_APP_OPERATION_BUSY', '原 Run 或创建 Key 正在执行；请查询原操作');
    }
    entry.abort = () => {
      controller.abort();
      if (!active.has(job)) { remove(entry); entry.reject(aborted()); pump(); }
    };
    signal?.addEventListener('abort', entry.abort, { once: true });
    const start = enqueue(entry);
    // Queued starts are bounded; resumes/terminal persistence never expire behind this timer.
    if (pending.includes(entry) && !finalize) entry.timer = setTimeout(() => {
      remove(entry); entry.reject(schedulingError('IRIS_SCHEDULER_QUEUE_TIMEOUT', '本地写入等候超时；未开始本次操作')); pump();
    }, Math.max(1, entry.deadline - performance.now()));
    let result, operationError;
    try {
      await start;
      // The queue entry's abort listener was removed at admission; active jobs keep their own signal.
      signal?.addEventListener('abort', entry.abort, { once: true });
      if (signal?.aborted) controller.abort();
      controller.signal.throwIfAborted();
      const runtime = Object.freeze({
        get signal() { return controller.signal; }, taskGate,
        run(operation, callback) {
          if (job.finished) throw closed();
          if (owner !== job) throw new Error('Core operation requires the current write turn');
          const promise = rootRuntime.run(operation, context => callback(Object.freeze({ ...context, signal: controller.signal })));
          job.inFlight.add(promise);
          void promise.then(() => job.inFlight.delete(promise), () => job.inFlight.delete(promise));
          return promise;
        },
        snapshot: () => rootRuntime.snapshot(),
        onDispose(callback) {
          if (job.finished) throw closed();
          if (typeof callback !== 'function') throw new TypeError('Core cleanup 必须是函数');
          job.cleanup.push(callback); return () => { const i = job.cleanup.indexOf(callback); if (i < 0) return false; job.cleanup.splice(i, 1); return true; };
        },
        networkWait: (callback, reason) => networkWait(job, callback, reason),
        checkpoint: callback => checkpoint(job, callback),
        reportScheduling(phase) { if (job.parked) job.phase = phase; },
        scheduler,
        schedulingState: () => job.parked || 'writing'
      });
      result = await resource.runInAsyncScope(action, undefined, runtime);
    } catch (error) { operationError = error; }
    finally {
      signal?.removeEventListener('abort', entry.abort);
      if (active.has(job)) {
        while (job.inFlight.size) await Promise.allSettled([...job.inFlight]);
        job.finished = true; controller.abort();
        try { for (const callback of job.cleanup.reverse()) await callback(); }
        catch (error) {
          failure = error; closing = true;
          // A failed per-job cleanup keeps the same retained-lease semantics as CoreRuntime.
          rootRuntime.onDispose(() => { throw error; });
          onFailure?.(error); operationError ||= error;
        }
        active.delete(job);
        if (owner === job) { const error = release(job); operationError ||= error; } else pump();
        if (retiring) {
          try { await retiring; }
          catch (error) { operationError = operationError ? Object.assign(new AggregateError([operationError, error], '操作和写者释放均失败'), { code: error.code }) : error; }
        }
      }
      resource.emitDestroy();
    }
    if (operationError) throw operationError;
    return result;
  }
  function dispose() {
    if (disposal) return disposal;
    closing = true;
    for (const entry of [...pending]) if (entry.kind === 'start') { remove(entry); entry.reject(closed()); }
    for (const job of active) job.controller.abort();
    disposal = (async () => {
      // The application awaits admitted jobs before invoking this final drain.
      if (active.size) throw new Error('Iris writer disposed before jobs drained');
      pump(); if (retiring) await retiring;
      if (failure) throw failure;
    })();
    return disposal;
  }
  return Object.freeze({ execute, snapshot, dispose, phase(key) { const job = [...active].find(job => job.key === key); return job?.phase || job?.parked || null; }, abort() {
    closing = true;
    for (const entry of [...pending]) if (entry.kind === 'start') { remove(entry); entry.reject(closed()); }
    for (const job of active) job.controller.abort();
  } });
}
