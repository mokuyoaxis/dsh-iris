'use strict';
/** 改图只接受当前 Core 中的静态图片；输入原字节不进入 Task 记录。 */
import sharp from 'sharp';
import { inspectCoreArtifact, readCoreArtifactBytes } from './core-artifacts.js';
import { waitForModelWork } from './model-call-runtime.js';
import { supportsImageEdit } from './provider-protocol.js';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'IRIS_IMAGE_EDIT_INPUT_INVALID' });
}

export function imageEditCandidates(candidates) {
  const supported = candidate => supportsImageEdit(candidate.adapter.protocol, candidate.providerModel);
  if (candidates.some(candidate => candidate.selectionReason === 'explicit'
      && !supported(candidate))) {
    throw invalid('指定模型的图片协议不支持此类改图，请选择聊天生图模型或 DashScope Qwen 原生改图模型');
  }
  const selected = candidates.filter(supported);
  if (!selected.length) throw invalid('当前生图名单没有可用的聊天生图或 DashScope Qwen 改图模型');
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
