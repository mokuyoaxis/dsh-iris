// HTTP DTOs whitelist existing Core facts; never expose records or configuration wholesale.
import { isAudioRecipe } from './audio-flow-input.js';
import { VIDEO_RECIPE } from './video-flow-input.js';
import { isVisionRecipe } from './vision-flow-input.js';
import { PROVIDER_ERROR_CATEGORIES, PROVIDER_STAGES } from './provider-contract.js';
const STATUSES = new Set(['not_started', 'running', 'needs_attention', 'delivery_failed',
  'needs_comparison', 'needs_result', 'awaiting_selection', 'selected', 'ready']);

const ERROR_MESSAGES = Object.freeze({
  invalid_request: '请求参数或输入无效。',
  authentication: '供应商认证失败。',
  quota: '供应商额度不足。',
  rate_limit: '请求受到限流。',
  network: '请求传输失败。',
  timeout: '操作超时。',
  aborted: '操作被中断。',
  provider: '供应商返回错误。',
  protocol: '响应不符合协议。',
  local_io: '本地文件或存储操作失败。',
  unknown: '操作失败，具体原因未知。'
});

// A saved Task diagnostic, never raw provider text or a failure of this read.
function projectTaskError(error) {
  const category = PROVIDER_ERROR_CATEGORIES.includes(error.category) ? error.category : 'unknown';
  const missing = error.httpStatus === 404 && typeof error.providerCode === 'string'
    && /^(?:NotFound\.Model|model_not_found|ModelNotFound|IRIS_MODEL_UNAVAILABLE)$/i.test(error.providerCode);
  return { category, message: missing ? '所选模型在当前连接中不可用，请核对模型 ID 和接口。' : ERROR_MESSAGES[category],
    ...(PROVIDER_STAGES.includes(error.stage) ? { stage: error.stage } : {}),
    ...(Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}) };
}

export function projectLocalApiFlow(facts) {
  if (facts.contractVersion !== 0 || !['image-edit/v0', 'image-generate/v0', VIDEO_RECIPE].includes(facts.run.recipe) && !isAudioRecipe(facts.run.recipe) && !isVisionRecipe(facts.run.recipe) || !STATUSES.has(facts.status)) {
    throw new TypeError('不支持的流程契约或状态');
  }
  const { run, task } = facts;
  const ref = value => value ? { artifactId: value.artifactId } : null;
  return {
    contractVersion: 0, id: run.id, recipe: run.recipe, revision: run.revision,
    createdAt: run.createdAt, updatedAt: run.updatedAt, status: facts.status,
    input: { ...(isAudioRecipe(run.recipe) ? run.recipe === 'speech/v0' ? { text: run.input.text,
      ...(run.input.voice !== undefined ? { voice: run.input.voice } : {}) } : {} : isVisionRecipe(run.recipe)
      ? run.recipe === 'vision/v0' ? { question: run.input.question } : { chunkHeight: run.input.chunk_height, overlap: run.input.overlap,
        maxDimension: run.input.max_dimension, maxInvocations: run.input.max_invocations } : { prompt: run.input.prompt }), modelRef: run.input.model_ref,
      ...(run.input.size !== undefined ? { size: run.input.size } : {}),
      ...(run.input.duration !== undefined ? { duration: run.input.duration } : {}),
      ...(run.input.workflow_parameters !== undefined ? { workflowParameters: run.input.workflow_parameters } : {}) },
    source: ref(run.source), output: ref(run.output), comparison: ref(run.comparison), selection: ref(run.selection),
    ...(isVisionRecipe(run.recipe) ? { report: ref(run.report), ...(run.plan ? { plan: { ...run.plan } } : {}), ...(facts.ocr ? { ocr: { ...facts.ocr } } : {}) } : {}),
    task: task ? { id: task.id, acceptance: task.acceptance, outcome: task.outcome,
      deliveryState: task.deliveryState, attemptCount: task.attempts.length,
      ...(task.lastError ? { errorSummary: projectTaskError(task.lastError) } : {}),
      ...(task.networkRoutes ? { networkRoutes: task.networkRoutes.map(route => ({ route: route.route, operation: route.operation, lastAt: route.lastAt,
        ...(route.poolId ? { poolId: route.poolId } : {}), ...(route.nodeId ? { nodeId: route.nodeId } : {}) })) } : {}) } : null,
    metrics: facts.metrics ? Object.fromEntries(['ratio', 'diffPixels', 'totalPixels', 'width', 'height']
      .map(key => [key, facts.metrics[key]])) : null
  };
}

export function projectLocalApiRunSummary(run) {
  return { id: run.id, recipe: run.recipe, createdAt: run.createdAt,
    updatedAt: run.updatedAt, revision: run.revision, modelRef: run.input.model_ref,
    source: run.source ? { artifactId: run.source.artifactId } : null, output: run.output ? { artifactId: run.output.artifactId } : null,
    selection: run.selection ? { artifactId: run.selection.artifactId } : null };
}
