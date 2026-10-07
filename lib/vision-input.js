'use strict';
/** 单图来源由入口选择；Core 图片以原字节/MIME 只读进入视觉业务。 */
import { CommandError } from './command-service.js';
import { inspectCoreArtifact, readCoreArtifactBytes } from './core-artifacts.js';
import { MODEL_IMAGE_MEDIA_TYPES } from './model-port-contract.js';
import { VISION_BUDGET } from './vision-core.js';
import { waitForModelWork } from './model-call-runtime.js';

export function normalizeVisionImageSource(input, { allowAttachment = false } = {}) {
  const fields = ['image_path', 'artifact_id', ...(allowAttachment ? ['attachment_id'] : [])];
  const selected = fields.filter(field => input[field] !== undefined);
  if (selected.length !== 1) throw new CommandError('IRIS_COMMAND_INPUT_INVALID',
    '必须且只能提供 ' + fields.join('、') + ' 之一');
  if (selected[0] === 'artifact_id'
      && (typeof input.artifact_id !== 'string' || !/^artifact_[a-f0-9]{24}$/.test(input.artifact_id))) {
    throw new CommandError('IRIS_COMMAND_INPUT_INVALID', 'artifact_id 必须是有效的 Core Artifact ID');
  }
  return selected[0];
}

export function readVisionArtifact(runtime, artifactId, signal) {
  return waitForModelWork(() => runtime.run('inspect', ({ dataRoot }) => {
    // 先检查大小/MIME，再物化字节；沿用图片输入的 20 MiB 上限。
    const artifact = inspectCoreArtifact(dataRoot, artifactId);
    if (!MODEL_IMAGE_MEDIA_TYPES.includes(artifact.mediaType) || artifact.size > VISION_BUDGET.maxImageBytes) {
      throw new CommandError('IRIS_COMMAND_INPUT_INVALID', '视觉 Artifact 必须是最多 20 MiB 的 PNG、JPEG、WebP 或 GIF 图片');
    }
    const { bytes } = readCoreArtifactBytes(dataRoot, artifactId);
    return { bytes: new Uint8Array(bytes), mediaType: artifact.mediaType };
  }), signal);
}
