import { setTimeout as delay } from 'node:timers/promises';

/** Explicit Music 502 regeneration policy; each resubmission is a new Core Task. */
export async function generateMusicTask({ runner, candidates, providerInput, options, signal }) {
  const taskIds = [];
  let result, retriedFrom;
  for (let index = 0; index <= options.retry502; index++) {
    signal?.throwIfAborted();
    result = await runner.submit({ capability: 'music', candidates, providerInput, ...(retriedFrom ? { retriedFrom } : {}) });
    taskIds.push(result.task.id);
    const task = result.task;
    if (result.localError || task.phase !== 'terminal' || task.lastError?.httpStatus !== 502
        || task.outcome === 'succeeded' || index === options.retry502) break;
    // Retry the actual model, without switching to another (potentially paid) source.
    candidates = candidates.filter(candidate => candidate.model === task.modelRef && candidate.adapter.id === task.providerId);
    if (!candidates.length) throw new Error('Music 重试无法找到原模型绑定');
    retriedFrom = task.id;
    await delay(options.retryDelayMs, undefined, { signal });
  }
  return Object.freeze({ ...result, taskIds: Object.freeze(taskIds), retries: taskIds.length - 1 });
}
