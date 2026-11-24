import { normalizeGenerationInput } from './generation-input.js';
import { parseModelRef } from './models.js';

export const VIDEO_RECIPE = 'video-generate/v0';
export const VIDEO_I2V_RECIPE = 'video-i2v/v0';
export const VIDEO_S2V_RECIPE = 'video-s2v/v0';
export const VIDEO_RECIPES = Object.freeze({
  [VIDEO_RECIPE]: Object.freeze({ mode: 't2v', step: 'video' }),
  [VIDEO_I2V_RECIPE]: Object.freeze({ mode: 'i2v', step: 'video' }),
  [VIDEO_S2V_RECIPE]: Object.freeze({ mode: 's2v', step: 'video' })
});
export const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
export const VIDEO_TYPES = Object.freeze({ 'video/mp4': 'mp4', 'video/webm': 'webm' });

const ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const CONTROL = /[\x00-\x1f\x7f]/;

export const isVideoRecipe = recipe => Object.hasOwn(VIDEO_RECIPES, recipe);
export const videoRecipeMode = recipe => VIDEO_RECIPES[recipe]?.mode ?? null;

function fail(message) {
  throw Object.assign(new Error(message), { code: 'IRIS_VIDEO_FLOW_INPUT_INVALID' });
}

function optionalText(value, maxLength, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${label} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || CONTROL.test(trimmed)) fail(`${label} 为空、过长或包含非法字符`);
  return trimmed;
}

export function normalizeVideoFlowInput(input, recipe = VIDEO_RECIPE) {
  if (!isVideoRecipe(recipe) || !input || typeof input !== 'object' || Array.isArray(input)) {
    fail('不支持的视频流程输入');
  }
  if (recipe === VIDEO_RECIPE) {
    if (Object.keys(input).some(key => !['model_ref', 'prompt', 'size', 'duration'].includes(key))
        || !parseModelRef(input.model_ref)
        || input.duration !== undefined && (typeof input.duration !== 'number' || !Number.isFinite(input.duration))) {
      fail('文生视频仅接受明确模型、prompt 和可选 size/duration；不接受首帧或路径');
    }
    const value = normalizeGenerationInput('video', input);
    return { model_ref: value.modelRef, ...value.providerInput };
  }
  if (!parseModelRef(input.model_ref)) fail('视频流程需要明确的 provider::model');
  if (typeof input.source_artifact_id !== 'string' || !ARTIFACT.test(input.source_artifact_id)) {
    fail('图生视频与数字人流程需要当前工作区中的首帧图片 Artifact ID');
  }
  if (recipe === VIDEO_I2V_RECIPE) {
    if (Object.keys(input).some(key => !['model_ref', 'source_artifact_id', 'prompt', 'size', 'resolution', 'duration'].includes(key))) {
      fail('图生视频仅接受明确模型、首帧图片及可选 prompt/size/resolution/duration');
    }
    if (input.duration !== undefined && (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 1 || input.duration > 60)) {
      fail('视频时长必须是 1–60 的有限数字');
    }
    let prompt;
    if (input.prompt !== undefined) {
      if (typeof input.prompt !== 'string') fail('图生视频描述必须是字符串');
      prompt = input.prompt.trim();
      if (!prompt || prompt.length > 16000) fail('图生视频描述须为 1–16000 字');
    }
    const size = optionalText(input.size, 64, 'size');
    const resolution = optionalText(input.resolution, 32, 'resolution');
    return {
      model_ref: input.model_ref.trim(),
      source_artifact_id: input.source_artifact_id,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(input.duration !== undefined ? { duration: input.duration } : {})
    };
  }
  // video-s2v/v0
  if (Object.keys(input).some(key => !['model_ref', 'source_artifact_id', 'audio_artifact_id', 'resolution'].includes(key))
      || typeof input.audio_artifact_id !== 'string' || !ARTIFACT.test(input.audio_artifact_id)
      || input.audio_artifact_id === input.source_artifact_id) {
    fail('数字人视频需要当前工作区中的首帧图片与驱动音频 Artifact ID，及可选 resolution');
  }
  const resolution = optionalText(input.resolution, 32, 'resolution');
  return {
    model_ref: input.model_ref.trim(),
    source_artifact_id: input.source_artifact_id,
    audio_artifact_id: input.audio_artifact_id,
    ...(resolution !== undefined ? { resolution } : {})
  };
}
