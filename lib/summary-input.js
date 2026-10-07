'use strict';
/** CLI/Host 共用的摘要来源：已有帧只读，不导出媒体或重新抽帧。 */
import { CommandError } from './command-service.js';
import { readCoreArtifactBytes } from './core-artifacts.js';
import { waitForModelWork } from './model-call-runtime.js';

function invalid(message) { throw new CommandError('IRIS_COMMAND_INPUT_INVALID', message); }

export function normalizeSummarySource(input) {
  const hasFrames = input.frame_artifact_ids !== undefined;
  const hasVideo = Boolean(input.video_path);
  if (hasFrames === hasVideo) invalid('摘要必须且只能提供 video_path 或 frame_artifact_ids 之一');
  if (hasFrames) {
    const ids = input.frame_artifact_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 20
        || !ids.every(id => typeof id === 'string' && /^artifact_[a-f0-9]{24}$/.test(id))
        || new Set(ids).size !== ids.length) invalid('frame_artifact_ids 必须是 1–20 个不重复的 Core Artifact ID');
    if (input.max_frames !== undefined || input.target_width !== undefined) invalid('已有帧不使用 max_frames 或 target_width；请直接选择帧 ID');
    if (input.transcribe === true) invalid('自动音轨转写需要 video_path；已有帧可提供 transcribe_text');
  }
  if (input.transcribe_text !== undefined && typeof input.transcribe_text !== 'string') invalid('transcribe_text 必须是字符串');
  if (input.transcribe === true && input.transcribe_text?.trim()) invalid('transcribe 与 transcribe_text 不能同时使用');
  return hasFrames ? 'core-artifacts' : 'video';
}

export async function readSummaryFrames(runtime, frameArtifactIds, signal) {
  return waitForModelWork(() => runtime.run('inspect', ({ dataRoot }) => {
    const frames = frameArtifactIds.map(id => {
      const { artifact, bytes } = readCoreArtifactBytes(dataRoot, id);
      const { frameIndex, atSec, width, height } = artifact.metadata;
      if (artifact.kind !== 'video-frame' || !['image/png', 'image/jpeg'].includes(artifact.mediaType)
          || !Number.isFinite(atSec) || atSec < 0 || !Number.isSafeInteger(frameIndex) || frameIndex < 1
          || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
        invalid('摘要需要含有效帧序号、时间戳和尺寸的 video-frame Artifact');
      }
      return { artifactId: artifact.id, frameIndex, atSec, width, height, buffer: bytes };
    }).sort((a, b) => a.atSec - b.atSec || a.frameIndex - b.frameIndex);
    return { frames, meta: { source: 'core-artifacts', startSec: frames[0].atSec, endSec: frames.at(-1).atSec } };
  }), signal);
}

export function summaryFrameRecords(frames) {
  return frames.map(({ artifactId, frameIndex, atSec, width, height }) => ({
    ...(artifactId ? { artifactId, frameIndex } : {}), atSec, width, height
  }));
}

export function summaryTimelineLabel(meta) {
  return meta.source === 'core-artifacts'
    ? `${meta.startSec.toFixed(1)}–${meta.endSec.toFixed(1)}s 已选帧`
    : `${meta.durationSec.toFixed(1)}s`;
}
