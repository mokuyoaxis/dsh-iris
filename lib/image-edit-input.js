'use strict';
/** 聊天改图只接受当前 Core 中的静态图片；输入原字节不进入 Task 记录。 */
import sharp from 'sharp';
import { inspectCoreArtifact, readCoreArtifactBytes } from './core-artifacts.js';
import { waitForModelWork } from './model-call-runtime.js';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'IRIS_IMAGE_EDIT_INPUT_INVALID' });
}

export function imageEditCandidates(candidates) {
  if (candidates.some(candidate => candidate.selectionReason === 'explicit'
      && candidate.adapter.protocol !== 'openai-chat-images')) {
    throw invalid('指定模型的图片协议不支持聊天改图，请选择 openai-chat-images 模型');
  }
  const selected = candidates.filter(candidate => candidate.adapter.protocol === 'openai-chat-images');
  if (!selected.length) throw invalid('未配置可用的 openai-chat-images 生图模型，无法编辑原图');
  return selected;
}

export async function readImageEditArtifact(dataRoot, artifactId, signal) {
  if (typeof artifactId !== 'string' || !/^artifact_[a-f0-9]{24}$/.test(artifactId)) {
    throw invalid('source_artifact_id 必须是有效的 Core Artifact ID');
  }
  const artifact = inspectCoreArtifact(dataRoot, artifactId);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mediaType) || artifact.size > 20 * 1024 * 1024) {
    throw invalid('改图来源必须是最多 20 MiB 的静态 PNG、JPEG 或 WebP Artifact');
  }
  const { bytes } = readCoreArtifactBytes(dataRoot, artifactId);
  const metadata = await waitForModelWork(() => sharp(bytes).metadata(), signal);
  if ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[metadata.format] !== artifact.mediaType
      || metadata.pages > 1) throw invalid('改图来源的真实格式必须与 MIME 一致，且不能是动画');
  return { bytes: new Uint8Array(bytes), mediaType: artifact.mediaType };
}
