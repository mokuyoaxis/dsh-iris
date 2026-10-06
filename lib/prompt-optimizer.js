'use strict';
/** DSH 优化入口：v1 配置与模型选择/投影；共享业务不读取宿主和存储。 */
import { loadPromptOptimizerConfig } from './prompt-optimizer-config.js';
import { hasHostPort, requireHostPort } from './host-contract.js';
import { normalizePromptInput, assemblePrompt, preparePromptOptimization, runPromptOptimization } from './prompt-optimizer-core.js';
import { prepareDshTextModelPort } from './dsh-text-model-adapter.js';
import { createModelOperation } from './model-invoker.js';
import { ModelPortError, modelPortSnapshot, modelErrorRecord } from './model-port-contract.js';

export { MAX_PROMPT_INPUT_BYTES, MAX_PROMPT_OUTPUT_CHARS } from './prompt-optimizer-core.js';

function modelSelection(value, field) {
  if (!value || typeof value !== 'object') return null;
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!provider || !model || provider.length > 256 || model.length > 256) {
    if (field) throw new Error(`${field} 必须同时包含有效的 provider 与 model`);
    return null;
  }
  const out = { provider, model };
  if (typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim()) {
    out.reasoningEffort = value.reasoningEffort.trim().slice(0, 128);
  }
  return out;
}

export function resolvePromptOptimizerRoute(host, config, requestedRoute) {
  if (config.route.mode === 'fixed') {
    return { ...modelSelection(config.route, 'route'), source: 'iris-fixed' };
  }
  const current = modelSelection(requestedRoute);
  if (current) return { ...current, source: 'current-session' };
  const textModel = hasHostPort(host, 'textModel') ? host.ports.textModel : undefined;
  const fallback = textModel && typeof textModel.currentSelection === 'function'
    ? modelSelection(textModel.currentSelection())
    : null;
  if (fallback) return { ...fallback, source: 'host-default' };
  throw new Error('Iris 找不到可用文本模型：请先在 DSH 会话中选择模型，或在 JSON 配置中设置 fixed 路由');
}

function reasoningPolicy(port, offId, route, configured) {
  const descriptor = modelPortSnapshot(port);
  if (configured === 'provider-default') return { policy: configured, effective: 'provider-default' };
  if (configured === 'off-if-supported') return { policy: configured, effective: offId || 'provider-default',
    ...(offId ? { request: { mode: 'off' } } : {}) };
  const effort = configured === 'inherit' ? route.reasoningEffort : configured;
  if (!effort) return { policy: configured, effective: 'provider-default' };
  if (!descriptor.reasoning?.effortIds?.includes(effort)) throw new ModelPortError('IRIS_MODEL_UNSUPPORTED', { stage: 'prepare', invocation: 'not_invoked' });
  return { policy: configured === 'inherit' ? 'inherit' : 'fixed', effective: effort, request: { mode: 'effort', effortId: effort } };
}

/** 执行一次显式优化或只组装；无 Task/Artifact 写入，无自动重试/发送。 */
export async function optimizePrompt(host, input, { signal } = {}) {
  if (signal?.aborted) throw new ModelPortError('IRIS_MODEL_ABORTED');
  const normalized = normalizePromptInput(input);
  if (normalized.mode === 'assemble') return { ...assemblePrompt(input, { signal }), configSource: 'not-loaded', route: null };
  const loaded = loadPromptOptimizerConfig();
  const config = loaded.config;
  const plan = preparePromptOptimization(input, config);
  const operation = createModelOperation({ ...(signal ? { signal } : {}), budget: { timeoutMs: config.generation.timeoutMs, maxInvocations: 1 } });
  let reasoning;
  try {
    const route = resolvePromptOptimizerRoute(host, config, input?.route);
    const llm = requireHostPort(host, 'textModel', '提示词优化');
    const { port, offId } = await prepareDshTextModelPort(llm, { ...route, sessionId: input?.sessionId }, { signal: operation.signal });
    reasoning = reasoningPolicy(port, offId, route, config.generation.reasoningEffort);
    const result = await runPromptOptimization(port, plan, { signal: operation.signal, operation, reasoning: reasoning.request });
    return { ...result, configSource: loaded.source, route: { source: route.source, provider: route.provider, model: route.model,
      reasoningPolicy: reasoning.policy, reasoningEffort: reasoning.effective } };
  } catch (error) {
    if (modelErrorRecord(error).code === 'IRIS_MODEL_OUTPUT_LIMIT') {
      const display = new Error('优化结果超过输出上限或模型在 ' + config.generation.maxOutputTokens + ' token 生成预算内未完成（思考策略：' + (reasoning?.effective || 'provider-default') + '）。Iris 未携带会话历史；请检查输出长度，或调整模型与生成预算');
      display.code = 'IRIS_MODEL_OUTPUT_LIMIT';
      throw display;
    }
    throw error;
  } finally { operation.dispose(); }
}
