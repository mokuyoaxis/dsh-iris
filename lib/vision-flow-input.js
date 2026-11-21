import crypto from 'node:crypto';
import sharp from 'sharp';
import { parseModelRef } from './models.js';
import { inspectCoreArtifactMetadata, readCoreArtifactBytes } from './core-artifacts.js';
import { normalizeOcrSettings, ocrImagePlan, OCR_LIMITS, OCR_DEDUP_MODE, OcrError } from './ocr.js';
import { normalizeLocateTarget } from './locate.js';
import { VISION_BUDGET } from './vision-core.js';
import { waitForModelWork } from './model-call-runtime.js';

export const VISION_RECIPES = Object.freeze(['vision/v0', 'ocr/v0', 'locate/v0', 'summarize/v0']);
export const isVisionRecipe = recipe => VISION_RECIPES.includes(recipe);
export const MAX_VISION_RESULT_BYTES = 1024 * 1024;
export const MAX_SUMMARY_FRAMES = 20;
const ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const invalid = message => { throw Object.assign(new Error(message), { code: 'IRIS_VISION_FLOW_INPUT_INVALID' }); };

export function normalizeVisionFlowInput(recipe, input) {
  if (!isVisionRecipe(recipe) || !input || typeof input !== 'object' || Array.isArray(input)) invalid('视觉流程输入无效');
  if (recipe === 'summarize/v0') {
    const fields = ['model_ref', 'frame_artifact_ids', 'question', 'transcript'];
    if (Object.keys(input).some(key => !fields.includes(key)) || !parseModelRef(input.model_ref)
        || !Array.isArray(input.frame_artifact_ids) || !input.frame_artifact_ids.length || input.frame_artifact_ids.length > MAX_SUMMARY_FRAMES
        || !input.frame_artifact_ids.every(id => typeof id === 'string' && ARTIFACT.test(id))
        || new Set(input.frame_artifact_ids).size !== input.frame_artifact_ids.length) {
      invalid('多模态摘要需要明确视觉模型和 1–20 个不重复的图片/视频帧 Artifact ID');
    }
    const normalized = { model_ref: input.model_ref, frame_artifact_ids: [...input.frame_artifact_ids] };
    if (input.question !== undefined) {
      if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 8192) invalid('摘要问题须为 1–8192 个字符');
      normalized.question = input.question.trim();
    }
    if (input.transcript !== undefined) {
      if (typeof input.transcript !== 'string' || !input.transcript.trim() || input.transcript.length > 6000) invalid('附加转写文本须为 1–6000 个字符');
      normalized.transcript = input.transcript.trim();
    }
    return normalized;
  }
  const fields = ['model_ref', 'source_artifact_id', ...(recipe === 'vision/v0' ? ['question'] : recipe === 'locate/v0' ? ['target'] : ['chunk_height', 'overlap', 'max_dimension', 'max_invocations'])];
  if (Object.keys(input).some(key => !fields.includes(key)) || !parseModelRef(input.model_ref)
      || typeof input.source_artifact_id !== 'string' || !ARTIFACT.test(input.source_artifact_id)) {
    invalid('请提供明确视觉模型和当前工作区的图片Artifact ID');
  }
  const base = { model_ref: input.model_ref, source_artifact_id: input.source_artifact_id };
  if (recipe === 'vision/v0') {
    if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 8192) invalid('看图问题须为1–8192个字符');
    return { ...base, question: input.question.trim() };
  }
  if (recipe === 'locate/v0') {
    if (typeof input.target !== 'string' || !input.target.trim() || input.target.trim().length > 200) invalid('定位目标须为 1–200 个字符');
    return { ...base, target: normalizeLocateTarget(input.target) };
  }
  let settings;
  try { settings = normalizeOcrSettings({ chunkHeight: input.chunk_height, overlap: input.overlap,
    maxDimension: input.max_dimension, maxInvocations: input.max_invocations ?? OCR_LIMITS.maxChunks }); }
  catch (error) { if (!(error instanceof OcrError)) throw error; invalid('OCR设置无效'); }
  if (settings.maxInvocations > OCR_LIMITS.maxChunks) invalid('此OCR流程最多调用32次模型');
  return { ...base, chunk_height: settings.chunkHeight, overlap: settings.overlap,
    max_dimension: settings.maxDimension, max_invocations: settings.maxInvocations };
}

export function visionCreationInput(recipe, value) {
  if (recipe === 'summarize/v0') {
    const fields = ['modelRef', 'frameArtifactIds', 'question', 'transcript'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid('摘要创建字段无效');
    return normalizeVisionFlowInput(recipe, {
      model_ref: value.modelRef, frame_artifact_ids: value.frameArtifactIds,
      ...(value.question !== undefined ? { question: value.question } : {}),
      ...(value.transcript !== undefined ? { transcript: value.transcript } : {})
    });
  }
  const fields = ['modelRef', 'sourceArtifactId', ...(recipe === 'vision/v0' ? ['question'] : recipe === 'locate/v0' ? ['target'] : ['chunkHeight', 'overlap', 'maxDimension', 'maxInvocations'])];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid('视觉创建字段无效');
  return normalizeVisionFlowInput(recipe, { model_ref: value.modelRef, source_artifact_id: value.sourceArtifactId,
    ...(recipe === 'vision/v0' ? { question: value.question } : recipe === 'locate/v0' ? { target: value.target } : Object.fromEntries([
      ['chunk_height', value.chunkHeight], ['overlap', value.overlap], ['max_dimension', value.maxDimension], ['max_invocations', value.maxInvocations]
    ].filter(([, field]) => field !== undefined))) });
}

export async function readVisionFlowImage(root, artifactId, signal, input) {
  const artifact = inspectCoreArtifactMetadata(root, artifactId);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mediaType) || artifact.size > VISION_BUDGET.maxImageBytes) {
    invalid('视觉来源须为最多20 MiB的静态PNG/JPEG/WebP作品');
  }
  const { bytes } = readCoreArtifactBytes(root, artifactId);
  let metadata;
  try { metadata = await waitForModelWork(() => sharp(bytes, { limitInputPixels: OCR_LIMITS.maxPixels }).metadata(), signal); }
  catch (error) { signal?.throwIfAborted(); if (error.name === 'AbortError') throw error; invalid('视觉来源无法解码或超过4000万像素'); }
  if (({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' })[metadata.format] !== artifact.mediaType || (metadata.pages || 1) > 1
      || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width <= 0 || metadata.height <= 0
      || metadata.width * metadata.height > OCR_LIMITS.maxPixels) {
    invalid('视觉来源须为MIME一致的单帧图片，且不超过4000万像素');
  }
  let plan;
  try { plan = input?.chunk_height === undefined ? undefined : ocrImagePlan(metadata, normalizeOcrSettings({
    chunkHeight: input.chunk_height, overlap: input.overlap, maxDimension: input.max_dimension, maxInvocations: input.max_invocations })); }
  catch (error) { if (!(error instanceof OcrError)) throw error; invalid('OCR图片尺寸或分块计划超过上限'); }
  return { bytes: new Uint8Array(bytes), mediaType: artifact.mediaType, ...(plan ? { plan } : {}) };
}

export async function readVisionSummaryFrames(root, frameArtifactIds, signal) {
  if (!Array.isArray(frameArtifactIds) || !frameArtifactIds.length || frameArtifactIds.length > MAX_SUMMARY_FRAMES) {
    invalid('多模态摘要需要 1–20 个图片/视频帧 Artifact ID');
  }
  const sources = [], rawFrames = [];
  let allVideoFrames = true;
  for (let index = 0; index < frameArtifactIds.length; index++) {
    const id = frameArtifactIds[index];
    const artifact = inspectCoreArtifactMetadata(root, id);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mediaType) || artifact.size > VISION_BUDGET.maxImageBytes) {
      invalid('摘要来源须为最多 20 MiB 的静态 PNG/JPEG/WebP 图片或视频帧作品');
    }
    const { bytes } = readCoreArtifactBytes(root, id);
    let metadata;
    try { metadata = await waitForModelWork(() => sharp(bytes, { limitInputPixels: OCR_LIMITS.maxPixels }).metadata(), signal); }
    catch (error) { signal?.throwIfAborted(); if (error.name === 'AbortError') throw error; invalid('摘要来源图片无法解码或超过 4000 万像素'); }
    if (({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' })[metadata.format] !== artifact.mediaType || (metadata.pages || 1) > 1
        || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width <= 0 || metadata.height <= 0
        || metadata.width * metadata.height > OCR_LIMITS.maxPixels) {
      invalid('摘要来源须为 MIME 一致的单帧静态图片，且不超过 4000 万像素');
    }
    const isVideoFrame = artifact.kind === 'video-frame'
      && Number.isFinite(artifact.metadata?.atSec) && artifact.metadata.atSec >= 0
      && Number.isSafeInteger(artifact.metadata?.frameIndex) && artifact.metadata.frameIndex >= 1;
    if (!isVideoFrame) allVideoFrames = false;
    sources.push({ artifactId: artifact.id, sha256: sha256(bytes) });
    rawFrames.push({
      artifactId: artifact.id,
      frameIndex: isVideoFrame ? artifact.metadata.frameIndex : index + 1,
      atSec: isVideoFrame ? artifact.metadata.atSec : index,
      width: metadata.width,
      height: metadata.height,
      buffer: bytes
    });
  }
  const frames = allVideoFrames ? [...rawFrames].sort((a, b) => a.atSec - b.atSec || a.frameIndex - b.frameIndex) : rawFrames;
  return { frames, sources };
}

export function projectLocateSummary(result) {
  return {
    target: result.target,
    width: result.width,
    height: result.height,
    found: result.found,
    ...(result.bbox ? { bbox: { ...result.bbox } } : {})
  };
}

export function parseLocateResult(bytes) {
  const corrupt = () => { throw Object.assign(new Error('视觉定位结果结构不一致'), { code: 'IRIS_FLOW_RESULT_UNSUPPORTED' }); };
  if (bytes.length > MAX_VISION_RESULT_BYTES) corrupt();
  let result;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { corrupt(); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.contractVersion !== 0
      || typeof result.target !== 'string' || !result.target.trim() || result.target.length > 200
      || !Number.isSafeInteger(result.width) || result.width < 1
      || !Number.isSafeInteger(result.height) || result.height < 1
      || typeof result.found !== 'boolean') corrupt();
  if (result.found) {
    const b = result.bbox;
    if (!b || typeof b !== 'object' || Array.isArray(b)
        || ['x1', 'y1', 'x2', 'y2', 'left', 'top', 'width', 'height'].some(k => !Number.isSafeInteger(b[k]))
        || b.x1 < 0 || b.y1 < 0 || b.x2 > result.width || b.y2 > result.height
        || !(b.x1 < b.x2 && b.y1 < b.y2)
        || b.left !== b.x1 || b.top !== b.y1 || b.width !== b.x2 - b.x1 || b.height !== b.y2 - b.y1) corrupt();
  } else if (result.bbox !== undefined) corrupt();
  return result;
}

export function projectOcrSummary(report) {
  const summary = Object.fromEntries(['status', 'totalChunks', 'successfulChunks', 'failedChunks', 'skippedChunks', 'invocations', 'stopCode']
    .filter(key => report[key] !== undefined).map(key => [key, report[key]]));
  if (report.deduplication) {
    summary.deduplication = {
      mode: report.deduplication.mode,
      appliedSeams: report.deduplication.appliedSeams,
      ambiguousSeams: report.deduplication.ambiguousSeams,
      removedLines: report.deduplication.removedLines,
      removedChars: report.deduplication.removedChars
    };
  }
  return summary;
}

export function visionProviderInput(recipe, input) {
  return { recipe, ...Object.fromEntries(Object.entries(normalizeVisionFlowInput(recipe, input))
    .filter(([key]) => !['model_ref', 'source_artifact_id'].includes(key))) };
}

function validOcrDeduplication(value, totalChunks) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.mode !== OCR_DEDUP_MODE
      || ['appliedSeams', 'ambiguousSeams', 'removedLines', 'removedChars'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)
      || !Array.isArray(value.seams) || value.seams.length >= totalChunks) return false;
  let applied = 0, ambiguous = 0, lines = 0, chars = 0;
  for (const seam of value.seams) {
    if (!seam || typeof seam !== 'object' || Array.isArray(seam)
        || !Number.isSafeInteger(seam.fromChunk) || seam.fromChunk < 1 || seam.fromChunk > totalChunks
        || !Number.isSafeInteger(seam.toChunk) || seam.toChunk <= seam.fromChunk || seam.toChunk > totalChunks
        || !Number.isSafeInteger(seam.overlapPx) || seam.overlapPx <= 0
        || !['deduplicated', 'none', 'ambiguous'].includes(seam.status)
        || (seam.status === 'deduplicated' ? !['lines', 'inline'].includes(seam.strategy) : seam.strategy !== undefined)
        || !Number.isSafeInteger(seam.removedLines) || seam.removedLines < 0
        || !Number.isSafeInteger(seam.removedChars) || seam.removedChars < 0) return false;
    if (seam.status === 'deduplicated') applied++;
    if (seam.status === 'ambiguous') ambiguous++;
    lines += seam.removedLines; chars += seam.removedChars;
  }
  return applied === value.appliedSeams && ambiguous === value.ambiguousSeams
    && lines === value.removedLines && chars === value.removedChars;
}

export function parseOcrReport(bytes, { plan, maxInvocations = OCR_LIMITS.maxChunks } = {}) {
  const corrupt = () => { throw Object.assign(new Error('OCR报告结构不一致'), { code: 'IRIS_FLOW_RESULT_UNSUPPORTED' }); };
  if (bytes.length > MAX_VISION_RESULT_BYTES) corrupt();
  let report;
  try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { corrupt(); }
  if (!report || report.contractVersion !== 0 || !['complete', 'partial', 'failed'].includes(report.status)
      || !Number.isSafeInteger(report.totalChunks) || report.totalChunks < 1 || report.totalChunks > OCR_LIMITS.maxChunks
      || !Array.isArray(report.chunks) || report.chunks.length !== report.totalChunks
      || ['successfulChunks', 'failedChunks', 'skippedChunks', 'invocations'].some(key => !Number.isSafeInteger(report[key]) || report[key] < 0)
      || report.successfulChunks + report.failedChunks + report.skippedChunks !== report.totalChunks
      || report.invocations > maxInvocations || report.invocations < report.successfulChunks
      || plan && Object.keys(plan).some(key => report[key] !== plan[key])
      || ['sourceWidth', 'sourceHeight', 'width', 'height'].some(key => !Number.isSafeInteger(report[key]) || report[key] <= 0)
      || report.chunks.some((chunk, index) => !chunk || chunk.index !== index + 1 || typeof chunk.text !== 'string'
        || !Number.isSafeInteger(chunk.y) || chunk.y < 0 || !Number.isSafeInteger(chunk.height) || chunk.height <= 0 || chunk.y + chunk.height > report.height
        || !['succeeded', 'failed', 'skipped'].includes(chunk.status))
      || ['succeeded', 'failed', 'skipped'].some((status, index) => report.chunks.filter(chunk => chunk.status === status).length
        !== report[['successfulChunks', 'failedChunks', 'skippedChunks'][index]])
      || report.status !== (report.successfulChunks === report.totalChunks ? 'complete' : report.successfulChunks ? 'partial' : 'failed')
      || report.deduplication !== undefined && !validOcrDeduplication(report.deduplication, report.totalChunks)) corrupt();
  return report;
}
