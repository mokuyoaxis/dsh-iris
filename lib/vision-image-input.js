'use strict';
/** 视觉发送副本；原始文件和 Core Artifact 始终只读。 */
import sharp from 'sharp';
import { ModelPortError } from './model-port-contract.js';
import { waitForModelWork } from './model-call-runtime.js';

// 客户端默认发送预算，不表示任何供应商承诺的输入上限。
export const DEFAULT_VISION_INPUT = Object.freeze({ maxBytes: 8 * 1024 * 1024 });

export function normalizeVisionInputLimits(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['maxBytes', 'maxDimension'].includes(key))
      || !Object.values(value).every(number => Number.isSafeInteger(number) && number > 0)) {
    throw Object.assign(new Error('visionInput 只接受正整数 maxBytes、maxDimension，null 恢复继承'), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  }
  return { ...value };
}

export function visionInputLimits(provider, modelId) {
  const model = provider.models?.find(value => typeof value === 'object' && value?.id === modelId);
  return { ...DEFAULT_VISION_INPUT, ...normalizeVisionInputLimits(provider.visionInput),
    ...normalizeVisionInputLimits(model?.visionInput) };
}

async function processImage(processor, signal, output) {
  const cancel = () => processor.destroy();
  signal?.addEventListener('abort', cancel, { once: true });
  try { return await waitForModelWork(() => output(processor), signal); }
  finally { signal?.removeEventListener('abort', cancel); }
}

export async function prepareVisionImage(image, limits, { signal, orient = false } = {}) {
  const { maxBytes, maxDimension } = { ...DEFAULT_VISION_INPUT, ...normalizeVisionInputLimits(limits) };
  if (signal?.aborted) return waitForModelWork(() => image, signal);
  if (image.bytes.byteLength <= maxBytes && !maxDimension && !orient) return image;
  const tooLarge = () => new ModelPortError('IRIS_MODEL_IMAGE_TOO_LARGE', {
    stage: 'prepare', imageBytes: image.bytes.byteLength, imageMaxBytes: maxBytes
  });
  const format = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[image.mediaType];
  let metadata;
  try { metadata = await processImage(sharp(Buffer.from(image.bytes)), signal, processor => processor.metadata()); }
  catch (error) {
    if (error instanceof ModelPortError) throw error;
    throw new ModelPortError('IRIS_MODEL_INPUT_INVALID', { stage: 'prepare' });
  }
  const sourceDimension = Math.max(metadata.width, metadata.height);
  if (image.bytes.byteLength <= maxBytes && (!maxDimension || sourceDimension <= maxDimension)
      && (!orient || !metadata.orientation || metadata.orientation === 1)) return image;
  // 合预算的 GIF/动画仍原字节透传，需要缩放时不静默压成一帧。
  if (!format || metadata.pages > 1) throw tooLarge();
  let dimension = Math.min(sourceDimension, maxDimension || sourceDimension);
  let size = image.bytes.byteLength;
  // 每次从原字节缩放，不反复压缩上一次副本；只进行本地处理，不重发模型请求。
  for (let attempt = 0; attempt < 6; attempt++) {
    if (size > maxBytes) dimension = Math.max(1, Math.min(dimension,
      Math.floor((attempt === 0 ? sourceDimension : dimension) * Math.min(0.8, Math.sqrt(maxBytes / size) * 0.9))));
    const processor = sharp(Buffer.from(image.bytes)).autoOrient().resize({ width: dimension, height: dimension,
      fit: 'inside', withoutEnlargement: true }).toFormat(format);
    const bytes = await processImage(processor, signal, value => value.toBuffer());
    if (bytes.byteLength <= maxBytes) return { bytes: new Uint8Array(bytes), mediaType: image.mediaType };
    size = bytes.byteLength;
    if (dimension === 1) break;
  }
  throw tooLarge();
}

/** 每次调用的实际图片事实；仅包含尺寸/大小，不包含字节、路径或凭据。 */
export function createVisionInputObserver(inputs) {
  return async ({ request, image, signal, identity }) => {
    const [source, sent] = await waitForModelWork(() => Promise.all([
      sharp(Buffer.from(request.image.bytes)).metadata(), sharp(Buffer.from(image.bytes)).metadata()
    ]), signal);
    const record = {
      source: { width: source.width, height: source.height, bytes: request.image.bytes.byteLength, mediaType: request.image.mediaType },
      sent: { width: sent.width, height: sent.height, bytes: image.bytes.byteLength, mediaType: image.mediaType },
      orientation: source.orientation || 1,
      resized: (source.autoOrient?.width || source.width) !== sent.width || (source.autoOrient?.height || source.height) !== sent.height
    };
    inputs.set(identity.backendId, record);
    return record;
  };
}
