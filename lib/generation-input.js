'use strict';

import path from 'node:path';
import fs from 'node:fs';

const FIELDS = Object.freeze({
  image: ['prompt', 'size', 'n'],
  video: ['prompt', 'size', 'duration', 'img_data_url', 'first_frame_path', 'audio_path', 'resolution'],
  tts: ['text', 'voice'],
  transcribe: ['audio_url', 'audio_path']
});

export class GenerationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GenerationInputError';
    this.code = 'IRIS_GENERATION_INPUT_INVALID';
  }
}

function fail(message) { throw new GenerationInputError(message); }

function text(value, field, maxLength, required = false) {
  if (value === undefined && !required) return undefined;
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) {
    fail(`${field} 必须为 1–${maxLength} 字符`);
  }
  return normalized;
}

/**
 * CLI、DSH 与知情重试共用的纯输入边界。只校验/转换调用方重新提供的参数，
 * 不读取配置或文件，不上传，不从旧 Task 恢复 Prompt/媒体地址。
 * Host 附件解析和本地音频上传仍由入口负责。
 */
export function normalizeGenerationInput(capability, input, { allowAudioPath = false, allowVideoPaths = false } = {}) {
  const fields = Object.hasOwn(FIELDS, capability) ? FIELDS[capability] : null;
  if (!fields) fail('不支持的生成能力');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('生成输入必须是 JSON 对象');
  for (const field of Object.keys(input)) {
    if (!fields.includes(field) && field !== 'model_ref') {
      fail('生成输入不支持字段：' + field + '；允许 ' + fields.join(', ') + ', model_ref');
    }
  }
  const modelRef = String(input.model_ref || '').trim();
  const providerInput = {};
  let audioPath;
  let firstFramePath, videoMode;
  if (capability === 'video') {
    audioPath = String(input.audio_path || '').trim();
    firstFramePath = String(input.first_frame_path || '').trim();
    if ((audioPath || firstFramePath) && !allowVideoPaths) fail('本地视频输入需要支持上传的入口');
    if (firstFramePath && input.img_data_url !== undefined) fail('首帧路径与 img_data_url 不能同时提供');
    for (const file of [firstFramePath, audioPath].filter(Boolean)) {
      if (!path.isAbsolute(file)) fail('首帧和音频路径必须是绝对路径');
      try { if (!fs.statSync(file).isFile()) throw new Error(); }
      catch (_) { fail('首帧或音频文件不存在或不是普通文件'); }
    }
    if (audioPath && !firstFramePath) fail('s2v 需要 first_frame_path 和 audio_path');
    videoMode = audioPath ? 's2v' : firstFramePath || input.img_data_url ? 'i2v' : 't2v';
    if (videoMode === 's2v') {
      if (input.size !== undefined || input.duration !== undefined || input.img_data_url !== undefined) fail('s2v 不支持 size、duration 或 img_data_url');
      const resolution = input.resolution ?? '480P';
      if (!['480P', '720P'].includes(resolution)) fail('s2v resolution 只支持 480P 或 720P');
      providerInput.resolution = resolution;
    } else if (input.resolution !== undefined) fail('resolution 仅适用于 s2v');
  }
  if (capability === 'image' || capability === 'video') {
    const prompt = text(input.prompt, 'prompt', 20000, videoMode !== 's2v');
    if (prompt !== undefined) providerInput.prompt = prompt;
    const size = text(input.size, 'size', 64);
    if (size !== undefined) providerInput.size = size;
  }
  if (capability === 'image') {
    const n = input.n === undefined ? 1 : Number(input.n);
    if (!Number.isSafeInteger(n) || n < 1 || n > 4) fail('n 必须为 1–4 的整数');
    providerInput.n = n;
  }
  if (capability === 'video') {
    if (input.duration !== undefined) {
      const duration = Number(input.duration);
      if (!Number.isFinite(duration) || duration < 1 || duration > 60) fail('duration 必须为 1–60 的数字');
      providerInput.duration = duration;
    }
    if (input.img_data_url !== undefined) {
      const imgDataUrl = String(input.img_data_url).trim();
      if (!imgDataUrl.startsWith('data:image/')) fail('img_data_url 必须是 data:image/ 开头的 data URL');
      providerInput.imgDataUrl = imgDataUrl;
    }
  }
  if (capability === 'tts') {
    providerInput.text = text(input.text, 'text', 20000, true);
    const voice = text(input.voice, 'voice', 64);
    if (voice !== undefined) providerInput.voice = voice;
  }
  if (capability === 'transcribe') {
    const audioUrl = String(input.audio_url || '').trim();
    audioPath = String(input.audio_path || '').trim();
    if (Boolean(audioUrl) === Boolean(audioPath)) {
      fail('转写必须且只能提供 audio_url（公网/oss://）或 audio_path（本地绝对路径）之一');
    }
    if (audioUrl) {
      if (audioUrl.length > 20000) fail('audio_url 最多为 20000 字符');
      if (!/^(https:\/\/|oss:\/\/)/.test(audioUrl)) fail('audio_url 必须是 https:// 或 oss:// 地址');
      providerInput.audioUrl = audioUrl;
    } else {
      if (!allowAudioPath) fail('retry 必须重新提供 audio_url；本地音频上传由调用入口负责');
      if (!path.isAbsolute(audioPath)) fail('audio_path 必须是绝对路径');
    }
  }
  return Object.freeze({
    modelRef,
    providerInput: Object.freeze(providerInput),
    ...(audioPath ? { audioPath } : {}),
    ...(capability === 'video' ? { firstFramePath, videoMode } : {})
  });
}
