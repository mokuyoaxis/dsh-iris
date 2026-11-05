import { normalizeGenerationInput } from './generation-input.js';
import { parseModelRef } from './models.js';

export const VIDEO_RECIPE = 'video-generate/v0';
export const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
export const VIDEO_TYPES = Object.freeze({ 'video/mp4': 'mp4', 'video/webm': 'webm' });
export function normalizeVideoFlowInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['model_ref', 'prompt', 'size', 'duration'].includes(key))
      || !parseModelRef(input.model_ref) || /s2v/i.test(parseModelRef(input.model_ref).modelId)
      || input.duration !== undefined && (typeof input.duration !== 'number' || !Number.isFinite(input.duration))) {
    throw Object.assign(new Error('文生视频仅接受明确模型、prompt 和可选 size/duration；不接受首帧、S2V 或路径'), { code: 'IRIS_VIDEO_FLOW_INPUT_INVALID' });
  }
  const value = normalizeGenerationInput('video', input);
  return { model_ref: value.modelRef, ...value.providerInput };
}
