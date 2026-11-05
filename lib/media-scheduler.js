// Instance-owned admission. No durable work loop and no automatic request replay.
import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { parseModelRef } from './models.js';
import { coreRemoteTaskIdentities, CoreTaskError } from './core-tasks.js';
import { checkedSchedulingPolicy, schedulingError } from './scheduling-policy.js';
import { retryAfterDelay } from './provider-health.js';

export function createMediaScheduler(input) {
  const policy = checkedSchedulingPolicy(input), http = [], scopes = new Map(), changes = new Set(), remoteVersions = new Map();
  let timer, closed = false, active = 0, sent = 0, completed = 0, pumping = false;
  function selected(context) {
    const parsed = parseModelRef(context.modelRef || context.attempt?.model || '');
    const providerId = context.providerId || parsed?.providerId;
    const provider = policy.providers.find(value => value.providerId === providerId);
    const model = provider?.models.find(value => value.modelId === parsed?.modelId);
    return [['global', policy], ...(provider ? [[JSON.stringify([providerId]), provider]] : []),
      ...(model ? [[JSON.stringify([providerId, parsed.modelId]), model]] : [])];
  }
  function state(key) {
    if (!scopes.has(key)) scopes.set(key, { active: 0, times: [], cooldownUntil: 0 });
    return scopes.get(key);
  }
  function remove(job) { const index = http.indexOf(job); if (index >= 0) http.splice(index, 1); job.signal?.removeEventListener('abort', job.abort); }
  function pump() {
    if (pumping) return;
    pumping = true;
    try { drain(); } finally { pumping = false; }
  }
  function drain() {
    clearTimeout(timer); timer = undefined;
    let next = Infinity;
    for (const job of [...http]) {
      const now = performance.now();
      if (now >= job.deadline) {
        remove(job); job.fail(schedulingError('IRIS_SCHEDULER_QUEUE_TIMEOUT', 'HTTP 派发等候超时；本次请求未发送')); continue;
      }
      const relevant = selected(job.context).map(([key, limits]) => ({ ...limits, state: state(key) }));
      let ready = true, at = now + cooldownDelay(job.context);
      for (const entry of relevant) {
        entry.state.times = entry.state.times.filter(time => now - time < 1000);
        if (entry.httpConcurrency && entry.state.active >= entry.httpConcurrency) ready = false;
        if (entry.requestsPerSecond && entry.state.times.length >= entry.requestsPerSecond) at = Math.max(at, entry.state.times[0] + 1000);
        at = Math.max(at, entry.state.cooldownUntil);
      }
      if (!ready || at > now) {
        job.context.onSchedulingState?.(cooldownDelay(job.context) > 0 ? 'cooldown' : at > now ? 'rate_limit' : 'http_queue');
        next = Math.min(next, job.deadline, at > now ? at : Infinity); continue;
      }
      remove(job); active++; sent++;
      for (const entry of relevant) { entry.state.active++; entry.state.times.push(now); }
      let released = false;
      const release = () => {
        if (released) return; released = true; active--; completed++;
        for (const entry of relevant) entry.state.active--;
        pump();
      };
      // Timestamp and the actual dispatcher invocation share this stack, not a reservation promise.
      job.context.onSchedulingState?.('http_running');
      job.start(release);
    }
    if (http.length && Number.isFinite(next)) timer = setTimeout(pump, Math.max(1, Math.ceil(next - performance.now())));
  }
  function dispatch(context, start, fail, signal) {
    if (closed) { fail(schedulingError('IRIS_SCHEDULER_CLOSED', '调度实例已关闭')); return; }
    if (signal?.aborted) { fail(signal.reason); return; }
    if (http.length >= policy.queueLimit) { fail(schedulingError('IRIS_SCHEDULER_QUEUE_FULL', 'HTTP 等候队列已满；本次请求未发送')); return; }
    const resource = new AsyncResource('IrisHttpDispatch');
    const job = { context, signal, deadline: performance.now() + policy.queueTimeoutMs,
      start(release) { try { resource.runInAsyncScope(start, undefined, release); } finally { resource.emitDestroy(); } },
      fail(error) { try { resource.runInAsyncScope(fail, undefined, error); } finally { resource.emitDestroy(); } } };
    job.abort = () => { remove(job); job.fail(signal.reason); pump(); };
    signal?.addEventListener('abort', job.abort, { once: true });
    http.push(job); pump();
  }
  function cooldown(context, delay) {
    if (!Number.isFinite(delay) || delay < 0) return;
    // A model-specific 429 blocks future requests for that model, never unrelated providers.
    const entries = selected(context), target = entries.at(-1);
    // Unconfigured provider/model limits still need an isolated cooldown scope.
    const parsed = parseModelRef(context.modelRef || context.attempt?.model || '');
    const key = parsed ? JSON.stringify([parsed.providerId, parsed.modelId]) : context.providerId ? JSON.stringify([context.providerId]) : target[0];
    state(key).cooldownUntil = Math.max(state(key).cooldownUntil, performance.now() + delay);
    changed(); pump();
  }
  function cooldownDelay(context) {
    const parsed = parseModelRef(context.modelRef || context.attempt?.model || '');
    const ids = [JSON.stringify([context.providerId || parsed?.providerId]), ...(parsed ? [JSON.stringify([parsed.providerId, parsed.modelId])] : [])];
    return Math.max(0, ...ids.map(key => (scopes.get(key)?.cooldownUntil || 0) - performance.now()));
  }
  function changed(dataRoot) {
    if (dataRoot) {
      if (!changes.size) return;
      let version;
      try { version = JSON.stringify([...remoteCounts(dataRoot)].sort(([a], [b]) => a.localeCompare(b))); }
      catch (error) {
        if (!(error instanceof CoreTaskError)) throw error;
        // Wake the admissions that need this count, without turning a read error
        // into a failed release of an unrelated writer turn.
        for (const reject of [...changes]) reject(error);
        return;
      }
      if (remoteVersions.get(dataRoot) === version) return;
      remoteVersions.set(dataRoot, version);
    }
    for (const resolve of [...changes]) resolve();
  }
  function change(signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timeout;
      const done = (error) => { clearTimeout(timeout); changes.delete(wake); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const wake = error => done(error), abort = () => done(signal.reason);
      if (signal?.aborted) { reject(signal.reason); return; }
      changes.add(wake); signal?.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(wake, Math.max(1, timeoutMs));
    });
  }
  function remoteCounts(dataRoot) {
    const result = new Map([['global', 0]]);
    for (const task of coreRemoteTaskIdentities(dataRoot)) {
      result.set('global', result.get('global') + 1);
      const parsed = parseModelRef(task.modelRef || '');
      if (parsed) for (const key of [JSON.stringify([parsed.providerId]), JSON.stringify([parsed.providerId, parsed.modelId])]) result.set(key, (result.get(key) || 0) + 1);
    }
    return result;
  }
  async function beforeSubmit(runtime, dataRoot, context, readyAt) {
    const deadline = performance.now() + policy.queueTimeoutMs;
    for (;;) {
      if (closed) throw schedulingError('IRIS_SCHEDULER_CLOSED', '调度实例已关闭');
      runtime.signal.throwIfAborted();
      const counts = remoteCounts(dataRoot), full = selected(context).some(([key, limits]) => limits.remoteLimit && (counts.get(key) || 0) >= limits.remoteLimit);
      const delay = Math.max(cooldownDelay(context), (readyAt?.() || 0) - Date.now());
      if (!full && delay <= 0) return;
      const left = deadline - performance.now();
      if (left <= 0) throw schedulingError('IRIS_SCHEDULER_QUEUE_TIMEOUT', full
        ? '远端未结束任务名额等候超时；未发送新的提交，请查询原任务'
        : '模型冷却等候超时；未发送新的提交');
      // A bounded wait is released by another Core commit or the known cooldown/deadline.
      await runtime.networkWait(() => change(runtime.signal, Math.min(left, delay > 0 ? delay : left)), full ? 'remote_capacity' : 'cooldown');
    }
  }
  function dispatcher(target, context, signal) {
    let dispatches = 0;
    return { get dispatches() { return dispatches; }, dispatch(options, handler) {
      let abortRemote, finished = false, release;
      const queued = new AbortController();
      const combined = signal ? AbortSignal.any([signal, queued.signal]) : queued.signal;
      const end = () => { if (finished) return false; finished = true; release?.(); return true; };
      const fail = error => { if (end()) handler.onError(error); };
      // Give fetch its abort port while still queued. The real dispatcher supplies the socket abort later.
      handler.onConnect(error => { queued.abort(error); abortRemote?.(error); });
      dispatch(context, done => {
        release = done;
        const wrapped = {
          onConnect(abort) { abortRemote = abort; if (combined.aborted) abort(combined.reason); },
          onHeaders(status, headers, resume, statusText) {
            if (status === 429) {
              let retry;
              for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === 'retry-after') retry = String(headers[i + 1]);
              cooldown(context, retryAfterDelay(retry));
            }
            return handler.onHeaders(status, headers, resume, statusText);
          },
          onData: chunk => handler.onData(chunk),
          onComplete(trailers) { if (end()) handler.onComplete(trailers); },
          onError: fail,
          ...(handler.onResponseStarted ? { onResponseStarted: () => handler.onResponseStarted() } : {}),
          ...(handler.onBodySent ? { onBodySent: (...args) => handler.onBodySent(...args) } : {}),
          ...(handler.onUpgrade ? { onUpgrade(...args) { end(); return handler.onUpgrade(...args); } } : {}),
          ...(handler.onRequestUpgrade ? { onRequestUpgrade(...args) { end(); return handler.onRequestUpgrade(...args); } } : {})
        };
        try { dispatches++; target.dispatch(options, wrapped); } catch (error) { fail(error); }
      }, fail, combined);
      return true;
    } };
  }
  function snapshot(dataRoot) {
    let remote;
    if (dataRoot) {
      try { remote = { remoteOutstanding: remoteCounts(dataRoot).get('global') }; }
      catch (error) {
        if (!(error instanceof CoreTaskError)) throw error;
        remote = { remoteOutstanding: null, remoteError: error.code };
      }
    }
    return Object.freeze({ enabled: true, httpActive: active, httpQueued: http.length, requestsStarted: sent, requestsCompleted: completed,
      ...remote,
      limits: { httpConcurrency: policy.httpConcurrency, requestsPerSecond: policy.requestsPerSecond, remoteLimit: policy.remoteLimit,
        queueLimit: policy.queueLimit, queueTimeoutMs: policy.queueTimeoutMs } });
  }
  return Object.freeze({ policy, dispatch, dispatcher, beforeSubmit, changed, cooldown, snapshot,
    dispose() { closed = true; clearTimeout(timer); for (const job of [...http]) { remove(job); job.fail(schedulingError('IRIS_SCHEDULER_CLOSED', '调度实例已关闭')); } changed(); } });
}
