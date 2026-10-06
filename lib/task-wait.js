import { setTimeout as delay } from 'node:timers/promises';
import { inspectCoreTask } from './core-tasks.js';

export function coreTaskWaitFinished(task) {
  return task.phase === 'terminal' || task.acceptance !== 'accepted'
    || !['none', 'unknown'].includes(task.outcome);
}

/** 有界观察原 Task，超时中止 poll/下载并保留事实；没有任何 submit/retry 路径。 */
export async function waitForCoreTask(runtime, taskId, { observe, timeoutMs = 120000, pollIntervalMs = 2500 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1200000
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 60000) {
    throw Object.assign(new Error('timeout_ms 必须是 1–1200000，poll_interval_ms 必须是 50–60000 的整数'), { code: 'IRIS_COMMAND_INPUT_INVALID' });
  }
  const dataRoot = await runtime.run('inspect', context => context.dataRoot);
  let task = inspectCoreTask(dataRoot, taskId);
  const completed = timedOut => ({ taskId, task, timedOut, ready: task.outcome === 'succeeded' && task.deliveryState === 'ready' });
  if (coreTaskWaitFinished(task)) return completed(false);
  if (typeof observe !== 'function') throw Object.assign(new Error('等待远端任务需要 Provider resolver'), { code: 'IRIS_COMMAND_PROVIDER_REQUIRED' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; runtime.dispose().catch(() => {}); }, timeoutMs);
  try {
    while (!coreTaskWaitFinished(task)) {
      runtime.signal.throwIfAborted();
      try { task = (await observe()).task; }
      catch (error) {
        if (runtime.signal.aborted) throw error;
        if (error.code && !['IRIS_PROVIDER_POLL_FAILED', 'IRIS_PROVIDER_DOWNLOAD_FAILED'].includes(error.code)) throw error;
        task = inspectCoreTask(dataRoot, taskId);
      }
      if (!coreTaskWaitFinished(task)) await delay(pollIntervalMs, undefined, { signal: runtime.signal });
    }
    return completed(false);
  } catch (error) {
    if (!timedOut) throw error;
    await runtime.dispose();
    task = inspectCoreTask(dataRoot, taskId);
    return completed(true);
  } finally { clearTimeout(timer); }
}
