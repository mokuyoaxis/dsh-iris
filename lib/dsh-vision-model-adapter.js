'use strict';
import { ModelPortError } from './model-port-contract.js';
import { createDshBoundModelPort } from './dsh-text-model-adapter.js';
import { waitForModelWork } from './model-call-runtime.js';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareVisionImage } from './vision-image-input.js';

/** rc.2 只接受附件引用；业务钩子使用核验后真正发给宿主的图片。 */
export function createDshVisionModelPort(textModel, attachments, binding, { metadata, allowImageNormalization = false,
  imageInput, orientImages = false, prepareImageRequest } = {}) {
  if (!attachments || typeof attachments.saveImage !== 'function' || typeof attachments.readImage !== 'function') {
    throw new ModelPortError('IRIS_MODEL_UNAVAILABLE', { stage: 'prepare' });
  }
  if (!metadata || metadata.provider !== binding?.provider || metadata.id !== binding?.model
      || !Array.isArray(metadata.inputModalities) || !metadata.inputModalities.includes('image')) {
    throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE', { stage: 'prepare' });
  }
  return createDshBoundModelPort(textModel, binding, { metadata, kind: 'vision', prepareImageRequest,
    async prepareImage(image, signal) {
      if (imageInput) image = await prepareVisionImage(image, imageInput, { signal, orient: orientImages });
      const data = new Uint8Array(image.bytes);
      // saveImage 在 rc.2 无取消参数；等待有界，迟到保存可留下 Host 附件，但绝不启动生成。
      const ref = await waitForModelWork(() => attachments.saveImage({ data, mediaType: image.mediaType, name: 'iris-vision' }), signal);
      if (!ref || typeof ref.attachmentId !== 'string' || !ref.attachmentId) {
        throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE', { stage: 'prepare' });
      }
      const stored = await waitForModelWork(() => attachments.readImage(ref, signal), signal);
      if (!(stored?.data instanceof Uint8Array) || stored.mediaType !== undefined && stored.mediaType !== ref.mediaType) {
        throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE', { stage: 'prepare' });
      }
      const unchanged = ref.mediaType === image.mediaType && Buffer.from(stored.data).equals(Buffer.from(image.bytes));
      if (!unchanged) {
        // 正规宿主附件用内容哈希绑定读回字节；任意旧引用/损坏数据不能冒充压缩副本。
        if (!allowImageNormalization || ref.attachmentId !== 'sha256:' + createHash('sha256').update(stored.data).digest('hex')
            || ref.bytes !== stored.data.byteLength) throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE', { stage: 'prepare' });
        const [source, normalized] = await waitForModelWork(() => Promise.all([
          sharp(Buffer.from(image.bytes)).metadata(), sharp(Buffer.from(stored.data)).metadata()
        ]), signal);
        const original = ref.originalDimensions || ref;
        const width = source.autoOrient?.width || source.width, height = source.autoOrient?.height || source.height;
        if (original.width !== width || original.height !== height || ref.width !== normalized.width || ref.height !== normalized.height
            || ref.width > width || ref.height > height
            || ref.mediaType !== { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[normalized.format]) {
          throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE', { stage: 'prepare' });
        }
      }
      return { attachment: ref, image: { bytes: new Uint8Array(stored.data), mediaType: ref.mediaType } };
    }
  }).port;
}

/** 只在显式调用时读取默认选择/精确元数据；不把默认文本模型猜成视觉模型。 */
export async function prepareDshVisionModelPort(textModel, attachments, { signal, ...options } = {}) {
  try { return await waitForModelWork(async () => {
    if (typeof textModel?.currentSelection !== 'function' || typeof textModel?.resolveModelInfo !== 'function') {
      throw new ModelPortError('IRIS_MODEL_UNAVAILABLE', { stage: 'prepare' });
    }
    if (typeof attachments?.saveImage !== 'function' || typeof attachments?.readImage !== 'function') {
      throw new ModelPortError('IRIS_MODEL_UNAVAILABLE', { stage: 'prepare' });
    }
    const selection = textModel.currentSelection();
    if (typeof selection?.provider !== 'string' || !selection.provider.trim()
        || typeof selection?.model !== 'string' || !selection.model.trim()) {
      throw new ModelPortError('IRIS_MODEL_UNAVAILABLE', { stage: 'prepare' });
    }
    const binding = { provider: selection.provider, model: selection.model };
    const metadata = await waitForModelWork(() => textModel.resolveModelInfo(binding.provider, binding.model, signal), signal);
    return createDshVisionModelPort(textModel, attachments, binding, { metadata, ...options });
  }, signal); }
  catch (error) {
    if (error instanceof ModelPortError) throw error;
    throw new ModelPortError('IRIS_MODEL_REQUEST_FAILED', { stage: 'prepare', invocation: 'not_invoked' });
  }
}
