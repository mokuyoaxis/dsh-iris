'use strict';
/** 有限操作内调用控制。只有 deadline timer；无后台任务、网络、配置或存储。 */
import {
  ModelPortError, modelErrorRecord, normalizeModelError, modelPortSnapshot,
  normalizeModelCallOptions, normalizeModelCall, normalizeModelCompletion, normalizeModelOperationOptions
} from './model-port-contract.js';

const TIMER_MAX_MS = 2147483647;
const now = () => performance.now();

function scope({ parents = [], timeoutMs, startedAt = now() }) {
  const controller = new AbortController();
  const deadline = startedAt + timeoutMs;
  const listeners = [];
  let timer;
  let failureCode;
  let disposed = false;
  const abort = (code) => {
    if (controller.signal.aborted) return;
    failureCode = code;
    clearTimeout(timer);
    controller.abort(new ModelPortError(code, { stage: 'invoke', invocation: 'unknown' }));
  };
  const schedule = () => {
    if (disposed || controller.signal.aborted) return;
    const remaining = deadline - now();
    if (remaining <= 0) abort('IRIS_MODEL_TIMEOUT');
    else timer = setTimeout(schedule, Math.min(TIMER_MAX_MS, Math.ceil(remaining)));
  };
  const seen = new Set();
  for (const parent of parents) {
    if (!parent.signal || seen.has(parent.signal)) continue;
    seen.add(parent.signal);
    const listener = () => abort(parent.code());
    if (parent.signal.aborted) listener();
    else {
      parent.signal.addEventListener('abort', listener, { once: true });
      listeners.push([parent.signal, listener]);
    }
  }
  schedule();
  return {
    signal: controller.signal,
    get failureCode() { return failureCode; },
    remaining() { return Math.max(0, deadline - now()); },
    check(context = {}) {
      if (!controller.signal.aborted && now() >= deadline) abort('IRIS_MODEL_TIMEOUT');
      if (controller.signal.aborted) throw new ModelPortError(failureCode, context);
    },
    abort,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    }
  };
}

/** abort 必须已传播到底层；race 只用于不合作的端口有界退出并处理晚到拒绝。 */
async function waitForCompletion(work, signal) {
  let listener;
  const interrupted = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener('abort', listener); }
}

function candidatePolicy(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
  const out = { skipUnavailable: false, allowRejected: false, allowEmptyResult: false };
  for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(out, key) || !Object.hasOwn(field, 'value') || typeof field.value !== 'boolean') {
      throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
    }
    out[key] = field.value;
  }
  if (Object.getOwnPropertySymbols(value).length) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
  return out;
}

function mayContinue(error, policy) {
  const { code, invocation } = modelErrorRecord(error);
  if (invocation === 'not_invoked' && policy.skipUnavailable) {
    return ['IRIS_MODEL_UNAVAILABLE', 'IRIS_MODEL_INCOMPATIBLE', 'IRIS_MODEL_UNSUPPORTED'].includes(code);
  }
  if (invocation === 'rejected' && policy.allowRejected) {
    return ['IRIS_MODEL_AUTH_FAILED', 'IRIS_MODEL_RATE_LIMITED'].includes(code);
  }
  return policy.allowEmptyResult && invocation === 'responded' && code === 'IRIS_MODEL_EMPTY_RESULT';
}

function operation(options, startedAt) {
  const total = scope({ timeoutMs: options.budget.timeoutMs, startedAt,
    parents: options.signal ? [{ signal: options.signal, code: () => 'IRIS_MODEL_ABORTED' }] : [] });
  let disposed = false;
  let invocations = 0;
  let pending = 0;

  const check = () => {
    if (disposed) throw new ModelPortError('IRIS_MODEL_ABORTED');
    total.check();
  };

  const invoke = async (port, request, callOptions) => {
    const callStartedAt = now();
    check();
    const descriptor = modelPortSnapshot(port);
    const complete = port.complete;
    if (typeof complete !== 'function') throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE');
    const local = normalizeModelCallOptions(descriptor, callOptions);
    const backendId = descriptor.identity.backendId;
    const child = scope({ timeoutMs: local.budget.timeoutMs, startedAt: callStartedAt, parents: [
      { signal: total.signal, code: () => total.failureCode },
      ...(local.signal ? [{ signal: local.signal, code: () => 'IRIS_MODEL_ABORTED' }] : [])
    ] });
    let entered = false;
    let called = false;
    let refunded = false;
    try {
      child.check({ backendId });
      const input = normalizeModelCall(descriptor, request, local);
      child.check({ backendId });
      if (descriptor.availability !== 'available') {
        throw new ModelPortError(descriptor.availability === 'incompatible' ? 'IRIS_MODEL_INCOMPATIBLE' : 'IRIS_MODEL_UNAVAILABLE', { backendId });
      }
      check();
      if (invocations >= options.budget.maxInvocations) throw new ModelPortError('IRIS_MODEL_CALL_LIMIT', { backendId });
      // 在调入 complete 之前占用次数，避免并发请求一起穿过最后一个额度。
      invocations++;
      pending++;
      entered = true;
      const controlledOptions = Object.freeze({ signal: child.signal,
        budget: Object.freeze({ ...input.options.budget, timeoutMs: Math.max(1, Math.ceil(Math.min(child.remaining(), total.remaining()))) }) });
      const work = Promise.resolve().then(() => {
        child.check({ stage: 'invoke', invocation: 'not_invoked', backendId });
        called = true;
        return complete.call(port, input.request, controlledOptions);
      });
      const result = await waitForCompletion(work, child.signal);
      child.check({ stage: 'normalize', invocation: 'responded', backendId });
      const normalized = normalizeModelCompletion(descriptor, result, local.budget);
      child.check({ stage: 'normalize', invocation: 'responded', backendId });
      return normalized;
    } catch (error) {
      const record = modelErrorRecord(error);
      // 只有可信契约错误明确说明尚未调用时，才返还预留次数。
      if (entered && (!called || record.invocation === 'not_invoked' && ['validate', 'prepare', 'invoke'].includes(record.stage))) {
        invocations--;
        refunded = true;
      }
      if (child.signal.aborted) {
        if (['IRIS_MODEL_ABORTED', 'IRIS_MODEL_TIMEOUT'].includes(child.failureCode)) total.abort(child.failureCode);
        throw new ModelPortError(child.failureCode, { stage: entered && !refunded ? 'invoke' : 'validate',
          invocation: !entered || refunded ? 'not_invoked' : record.invocation === 'responded' ? 'responded' : 'unknown', backendId });
      }
      // 输出/协议失败也通知底层停止，结果从不自动转为下一次调用。
      child.abort(record.code);
      if (['IRIS_MODEL_ABORTED', 'IRIS_MODEL_TIMEOUT'].includes(record.code)) total.abort(record.code);
      throw normalizeModelError(error, { backendId });
    } finally {
      if (entered) pending--;
      child.dispose();
    }
  };

  return Object.freeze({
    signal: total.signal,
    invoke,
    async runCandidates(ports, request, callOptions, policy = {}) {
      check();
      const rules = candidatePolicy(policy);
      if (!Array.isArray(ports) || !ports.length || [...ports].some(port => !port)) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
      let lastError;
      for (const port of [...ports]) {
        check();
        try { return await invoke(port, request, callOptions); }
        catch (error) {
          if (total.signal.aborted || disposed) throw error;
          check();
          if (!mayContinue(error, rules)) throw error;
          lastError = error;
        }
      }
      throw lastError;
    },
    snapshot() {
      return Object.freeze({ invocations, pending, maxInvocations: options.budget.maxInvocations,
        state: disposed ? 'disposed' : total.failureCode === 'IRIS_MODEL_TIMEOUT' ? 'timed_out' : total.signal.aborted ? 'aborted' : 'active' });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      total.abort('IRIS_MODEL_ABORTED');
      total.dispose();
    }
  });
}

/** 一个 OCR/候选等复合业务共用此 scope；调用方在 finally 中 dispose。 */
export function createModelOperation(options) {
  const startedAt = now();
  return operation(normalizeModelOperationOptions(options), startedAt);
}

/** 默认只允许一次调用，自动释放操作 scope；不运行候选策略。 */
export async function invokeModel(port, request, options) {
  const startedAt = now();
  const descriptor = modelPortSnapshot(port);
  const local = normalizeModelCallOptions(descriptor, options);
  const op = operation(normalizeModelOperationOptions({ budget: { timeoutMs: local.budget.timeoutMs, maxInvocations: 1 },
    ...(local.signal ? { signal: local.signal } : {}) }), startedAt);
  try { return await op.invoke(port, request, local); }
  finally { op.dispose(); }
}
