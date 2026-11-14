import sharp from 'sharp';
import { parseModelRef } from './models.js';
import { inspectCoreArtifactMetadata, readCoreArtifactBytes } from './core-artifacts.js';
import { normalizeOcrSettings, ocrImagePlan, OCR_LIMITS, OcrError } from './ocr.js';
import { VISION_BUDGET } from './vision-core.js';
import { waitForModelWork } from './model-call-runtime.js';

export const VISION_RECIPES = Object.freeze(['vision/v0', 'ocr/v0']);
export const isVisionRecipe = recipe => VISION_RECIPES.includes(recipe);
export const MAX_VISION_RESULT_BYTES = 1024 * 1024;
const invalid = message => { throw Object.assign(new Error(message), { code: 'IRIS_VISION_FLOW_INPUT_INVALID' }); };

export function normalizeVisionFlowInput(recipe, input) {
  if (!isVisionRecipe(recipe) || !input || typeof input !== 'object' || Array.isArray(input)) invalid('视觉流程输入无效');
  const fields = ['model_ref', 'source_artifact_id', ...(recipe === 'vision/v0' ? ['question'] : ['chunk_height', 'overlap', 'max_dimension', 'max_invocations'])];
  if (Object.keys(input).some(key => !fields.includes(key)) || !parseModelRef(input.model_ref)
      || typeof input.source_artifact_id !== 'string' || !/^artifact_[a-f0-9]{24}$/.test(input.source_artifact_id)) {
    invalid('请提供明确视觉模型和当前工作区的图片Artifact ID');
  }
  const base = { model_ref: input.model_ref, source_artifact_id: input.source_artifact_id };
  if (recipe === 'vision/v0') {
    if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 8192) invalid('看图问题须为1–8192个字符');
    return { ...base, question: input.question.trim() };
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
  const fields = ['modelRef', 'sourceArtifactId', ...(recipe === 'vision/v0' ? ['question'] : ['chunkHeight', 'overlap', 'maxDimension', 'maxInvocations'])];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid('视觉创建字段无效');
  return normalizeVisionFlowInput(recipe, { model_ref: value.modelRef, source_artifact_id: value.sourceArtifactId,
    ...(recipe === 'vision/v0' ? { question: value.question } : Object.fromEntries([
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

export function projectOcrSummary(report) {
  return Object.fromEntries(['status', 'totalChunks', 'successfulChunks', 'failedChunks', 'skippedChunks', 'invocations', 'stopCode']
    .filter(key => report[key] !== undefined).map(key => [key, report[key]]));
}

export function visionProviderInput(recipe, input) {
  return { recipe, ...Object.fromEntries(Object.entries(normalizeVisionFlowInput(recipe, input))
    .filter(([key]) => !['model_ref', 'source_artifact_id'].includes(key))) };
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
      || report.status !== (report.successfulChunks === report.totalChunks ? 'complete' : report.successfulChunks ? 'partial' : 'failed')) corrupt();
  return report;
}
