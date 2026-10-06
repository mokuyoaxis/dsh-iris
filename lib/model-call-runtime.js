'use strict';
/** 协议适配器的有界等待；调用方仍须把 signal 传给实际 I/O。 */
import { ModelPortError, modelErrorRecord } from './model-port-contract.js';

export function modelAbortError(signal, stage = 'prepare', invocation = 'not_invoked') {
  return new ModelPortError(modelErrorRecord(signal?.reason).code === 'IRIS_MODEL_TIMEOUT'
    ? 'IRIS_MODEL_TIMEOUT' : 'IRIS_MODEL_ABORTED', { stage, invocation });
}

export async function waitForModelWork(work, signal, stage = 'prepare', invocation = 'not_invoked') {
  if (signal?.aborted) throw modelAbortError(signal, stage, invocation);
  let listener;
  const canceled = new Promise((_, reject) => {
    listener = () => reject(modelAbortError(signal, stage, invocation));
    signal?.addEventListener('abort', listener, { once: true });
  });
  // 延迟调用以便预先取消时零 I/O；race 同时消费晚到的 rejection。
  const pending = Promise.resolve().then(() => {
    if (signal?.aborted) throw modelAbortError(signal, stage, invocation);
    return work();
  });
  try {
    const result = await Promise.race([pending, canceled]);
    if (signal?.aborted) throw modelAbortError(signal, stage, invocation);
    return result;
  } finally { signal?.removeEventListener('abort', listener); }
}

export function modelCallScope(parent, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const deadline = performance.now() + timeoutMs;
  let timer;
  const schedule = () => {
    if (controller.signal.aborted) return;
    const left = deadline - performance.now();
    if (left <= 0) controller.abort(new ModelPortError('IRIS_MODEL_TIMEOUT'));
    else timer = setTimeout(schedule, Math.min(2147483647, Math.ceil(left)));
  };
  schedule();
  return { signal: controller.signal, abort: reason => controller.abort(reason),
    dispose() { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); } };
}
