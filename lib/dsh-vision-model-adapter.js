'use strict';
import { ModelPortError } from './model-port-contract.js';
import { createDshBoundModelPort } from './dsh-text-model-adapter.js';
import { waitForModelWork } from './model-call-runtime.js';

/** rc.2 只接受附件引用。保存后读回核对字节，禁止默默用旧引用/归一化后的另一张图。 */
export function createDshVisionModelPort(textModel, attachments, binding, { metadata } = {}) {
  if (!attachments || typeof attachments.saveImage !== 'function' || typeof attachments.readImage !== 'function') {
    throw new ModelPortError('IRIS_MODEL_UNAVAILABLE', { stage: 'prepare' });
  }
  if (!metadata || metadata.provider !== binding?.provider || metadata.id !== binding?.model
      || !Array.isArray(metadata.inputModalities) || !metadata.inputModalities.includes('image')) {
    throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE', { stage: 'prepare' });
  }
  return createDshBoundModelPort(textModel, binding, { metadata, kind: 'vision',
    async prepareImage(image, signal) {
      const data = new Uint8Array(image.bytes);
      // saveImage 在 rc.2 无取消参数；等待有界，迟到保存可留下 Host 附件，但绝不启动生成。
      const ref = await waitForModelWork(() => attachments.saveImage({ data, mediaType: image.mediaType, name: 'iris-vision' }), signal);
      if (!ref || typeof ref.attachmentId !== 'string' || !ref.attachmentId || ref.mediaType !== image.mediaType) {
        throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE', { stage: 'prepare' });
      }
      const stored = await waitForModelWork(() => attachments.readImage(ref, signal), signal);
      if (stored?.mediaType !== undefined && stored.mediaType !== image.mediaType
          || !(stored?.data instanceof Uint8Array) || stored.data.byteLength !== image.bytes.byteLength
          || !Buffer.from(stored.data).equals(Buffer.from(image.bytes))) {
        throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE', { stage: 'prepare' });
      }
      return ref;
    }
  }).port;
}

/** 只在显式调用时读取默认选择/精确元数据；不把默认文本模型猜成视觉模型。 */
export async function prepareDshVisionModelPort(textModel, attachments, { signal } = {}) {
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
    return createDshVisionModelPort(textModel, attachments, binding, { metadata });
  }, signal); }
  catch (error) {
    if (error instanceof ModelPortError) throw error;
    throw new ModelPortError('IRIS_MODEL_REQUEST_FAILED', { stage: 'prepare', invocation: 'not_invoked' });
  }
}
