// HTTP DTOs whitelist existing Core facts; never expose records or configuration wholesale.
const STATUSES = new Set(['not_started', 'running', 'needs_attention', 'delivery_failed',
  'needs_comparison', 'awaiting_selection', 'selected']);

export function projectLocalApiFlow(facts) {
  if (facts.contractVersion !== 0 || facts.run.recipe !== 'image-edit/v0' || !STATUSES.has(facts.status)) {
    throw new TypeError('不支持的流程契约或状态');
  }
  const { run, task } = facts;
  const ref = value => value ? { artifactId: value.artifactId } : null;
  return {
    contractVersion: 0, id: run.id, recipe: run.recipe, revision: run.revision,
    createdAt: run.createdAt, updatedAt: run.updatedAt, status: facts.status,
    input: { prompt: run.input.prompt, modelRef: run.input.model_ref,
      ...(run.input.size !== undefined ? { size: run.input.size } : {}) },
    source: ref(run.source), output: ref(run.output), comparison: ref(run.comparison), selection: ref(run.selection),
    task: task ? { id: task.id, acceptance: task.acceptance, outcome: task.outcome,
      deliveryState: task.deliveryState, attemptCount: task.attempts.length } : null,
    metrics: facts.metrics ? Object.fromEntries(['ratio', 'diffPixels', 'totalPixels', 'width', 'height']
      .map(key => [key, facts.metrics[key]])) : null
  };
}

export function projectLocalApiRunSummary(run) {
  return { id: run.id, recipe: run.recipe, createdAt: run.createdAt,
    updatedAt: run.updatedAt, revision: run.revision, modelRef: run.input.model_ref,
    source: { artifactId: run.source.artifactId }, output: run.output ? { artifactId: run.output.artifactId } : null,
    selection: run.selection ? { artifactId: run.selection.artifactId } : null };
}
