import { parseModelRef } from './models.js';

export const MUSIC_RECIPE = 'music/v0';
export const MUSIC_TYPES = Object.freeze({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav' });
export const MAX_MUSIC_BYTES = 20 * 1024 * 1024;
export const isMusicRecipe = recipe => recipe === MUSIC_RECIPE;

const RUN = /^run_[a-f0-9]{24}$/;

function fail(message) {
  throw Object.assign(new Error(message), { code: 'IRIS_MUSIC_FLOW_INPUT_INVALID' });
}

export function musicProviderInput(input) {
  const normalized = normalizeMusicFlowInput(input);
  return {
    prompt: normalized.prompt,
    ...(normalized.timeout_ms !== undefined ? { timeoutMs: normalized.timeout_ms } : {})
  };
}

export function normalizeMusicFlowInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['model_ref', 'prompt', 'timeout_ms', 'retried_from_run_id'].includes(key))
      || typeof input.model_ref !== 'string' || !parseModelRef(input.model_ref.trim())
      || typeof input.prompt !== 'string') {
    fail('音乐流程需要明确的 provider::model、音乐描述及可选 timeout_ms/retried_from_run_id');
  }
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 16000) fail('音乐描述须为 1–16000 字');
  if (input.timeout_ms !== undefined && (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 3600000)) {
    fail('timeout_ms 必须是 1–3600000 的整数毫秒');
  }
  if (input.retried_from_run_id !== undefined && (typeof input.retried_from_run_id !== 'string' || !RUN.test(input.retried_from_run_id))) {
    fail('retried_from_run_id 必须是有效的原 Run ID');
  }
  return {
    model_ref: input.model_ref.trim(),
    prompt,
    ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
    ...(input.retried_from_run_id !== undefined ? { retried_from_run_id: input.retried_from_run_id } : {})
  };
}
