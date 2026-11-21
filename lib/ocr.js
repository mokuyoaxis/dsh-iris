'use strict';
/** M4 OCR 业务：显式图片字节、Sharp 分块和共享 Vision Ports；无 Host/路径/Store。 */
import sharp from 'sharp';
import { completeVision, VISION_BUDGET } from './vision-core.js';
import { createModelOperation } from './model-invoker.js';
import { ModelPortError, modelErrorRecord, modelPortSnapshot, normalizeModelCall } from './model-port-contract.js';
import { waitForModelWork, modelAbortError } from './model-call-runtime.js';

export const OCR_BUDGET = Object.freeze({ ...VISION_BUDGET });
export const OCR_LIMITS = Object.freeze({ maxChunks: 32, maxInvocations: 64, maxPixels: 40000000 });
export const OCR_DEDUP_MODE = 'boundary-overlap/v0';
const MIN_LINE_OVERLAP_CHARS = 4;
const MIN_INLINE_OVERLAP_CHARS = 12;
const MAX_ACTIVE_OVERLAP_LINES = 128;

function normalizeOcrLine(line) {
  return String(line || '').normalize('NFKC').replace(/\s+/g, '');
}

function splitOcrLines(text) {
  return String(text || '').split(/\r?\n/);
}

function nonEmptyLineIndices(lines) {
  const indices = [];
  for (let i = 0; i < lines.length; i++) {
    if (normalizeOcrLine(lines[i]).length > 0) indices.push(i);
  }
  return indices;
}

function linesEqual(a, aStart, b, bStart, count) {
  for (let i = 0; i < count; i++) {
    if (a[aStart + i] !== b[bStart + i]) return false;
  }
  return true;
}

function findLineOverlap(prevNorms, currNorms) {
  const maxK = Math.min(prevNorms.length, currNorms.length);
  const matches = [];
  for (let k = 1; k <= maxK; k++) {
    if (linesEqual(prevNorms, prevNorms.length - k, currNorms, 0, k)) matches.push(k);
  }
  if (!matches.length) return { status: 'none', count: 0, chars: 0 };
  if (matches.length > 1) return { status: 'ambiguous', count: 0, chars: 0 };
  const k = matches[0];
  let chars = 0;
  for (let i = 0; i < k; i++) chars += currNorms[i].length;
  if (chars < MIN_LINE_OVERLAP_CHARS) return { status: 'none', count: 0, chars: 0 };
  const repeatsBefore = prevNorms.length >= 2 * k && linesEqual(prevNorms, prevNorms.length - 2 * k, currNorms, 0, k);
  const repeatsAfter = currNorms.length >= 2 * k && linesEqual(currNorms, k, currNorms, 0, k);
  if (repeatsBefore || repeatsAfter) return { status: 'ambiguous', count: 0, chars: 0 };
  return { status: 'deduplicated', strategy: 'lines', count: k, chars };
}

function mapNormalizedChars(line) {
  const chars = [], rawStarts = [], rawEnds = [];
  let offset = 0;
  for (const cp of line) {
    const start = offset;
    offset += cp.length;
    const norm = cp.normalize('NFKC').replace(/\s+/g, '');
    for (let i = 0; i < norm.length; i++) {
      chars.push(norm[i]);
      rawStarts.push(start);
      rawEnds.push(offset);
    }
  }
  return { norm: chars.join(''), rawStarts, rawEnds };
}

function isAsciiWord(ch) {
  return Boolean(ch) && /[A-Za-z0-9]/.test(ch);
}

function findInlineOverlap(prevLastLine, currFirstLine) {
  const prev = mapNormalizedChars(prevLastLine);
  const curr = mapNormalizedChars(currFirstLine);
  const maxL = Math.min(prev.norm.length, curr.norm.length);
  if (maxL < MIN_INLINE_OVERLAP_CHARS) return { status: 'none', cutIndex: 0, chars: 0 };
  const matches = [];
  for (let len = MIN_INLINE_OVERLAP_CHARS; len <= maxL; len++) {
    // Only cut on original code-point boundaries (avoid splitting expanded NFKC sequences).
    if (len < curr.norm.length && curr.rawEnds[len - 1] === curr.rawEnds[len]) continue;
    const prevStart = prev.norm.length - len;
    if (prevStart > 0 && prev.rawStarts[prevStart] === prev.rawStarts[prevStart - 1]) continue;
    const slice = curr.norm.slice(0, len);
    if (!prev.norm.endsWith(slice)) continue;
    const prevLeftChar = prevStart > 0 ? prev.norm[prevStart - 1] : '';
    const currRightChar = len < curr.norm.length ? curr.norm[len] : '';
    if (isAsciiWord(prevLeftChar) && isAsciiWord(slice[0])) continue;
    if (isAsciiWord(slice[len - 1]) && isAsciiWord(currRightChar)) continue;
    matches.push({ len, slice, cutIndex: curr.rawEnds[len - 1] });
  }
  if (!matches.length) return { status: 'none', cutIndex: 0, chars: 0 };
  if (matches.length > 1) return { status: 'ambiguous', cutIndex: 0, chars: 0 };
  const match = matches[0];
  if (prev.norm.endsWith(match.slice + match.slice) || curr.norm.startsWith(match.slice + match.slice)) {
    return { status: 'ambiguous', cutIndex: 0, chars: 0 };
  }
  return { status: 'deduplicated', strategy: 'inline', cutIndex: match.cutIndex, chars: match.len };
}

/**
 * 保守的跨块边界重叠去重：仅在相邻成功块存在物理像素重叠时，
 * 比对前块尾与后块头的唯一、无歧义匹配；原始 chunk.text 始终保留不变。
 */
export function deduplicateOcrChunks(chunks) {
  const segments = [], seams = [];
  let prevChunk = null, coveredEndY = -1, activeNormLines = [], activeLastRawLine = '';
  for (const chunk of chunks) {
    if (chunk.status !== 'succeeded') continue;
    const rawLines = splitOcrLines(chunk.text);
    const nonEmptyIdx = nonEmptyLineIndices(rawLines);
    const currNorms = nonEmptyIdx.map(i => normalizeOcrLine(rawLines[i]));
    const overlapPx = prevChunk ? coveredEndY - chunk.y : 0;
    let keptText = chunk.text, keptNorms = currNorms;
    let keptLastRawLine = nonEmptyIdx.length ? rawLines[nonEmptyIdx.at(-1)] : '';
    if (prevChunk && overlapPx > 0 && activeNormLines.length && currNorms.length) {
      const lineMatch = findLineOverlap(activeNormLines, currNorms);
      if (lineMatch.status === 'deduplicated') {
        if (lineMatch.count >= nonEmptyIdx.length) {
          keptText = '';
          keptNorms = [];
          keptLastRawLine = '';
        } else {
          keptText = rawLines.slice(nonEmptyIdx[lineMatch.count]).join('\n').trim();
          keptNorms = currNorms.slice(lineMatch.count);
          const keptRaw = splitOcrLines(keptText);
          const keptIdx = nonEmptyLineIndices(keptRaw);
          keptLastRawLine = keptIdx.length ? keptRaw[keptIdx.at(-1)] : '';
        }
        seams.push({
          fromChunk: prevChunk.index, toChunk: chunk.index, overlapPx,
          status: 'deduplicated', strategy: 'lines',
          removedLines: lineMatch.count, removedChars: lineMatch.chars
        });
      } else if (lineMatch.status === 'ambiguous') {
        seams.push({
          fromChunk: prevChunk.index, toChunk: chunk.index, overlapPx,
          status: 'ambiguous', removedLines: 0, removedChars: 0
        });
      } else {
        const inlineMatch = findInlineOverlap(activeLastRawLine, rawLines[nonEmptyIdx[0]]);
        if (inlineMatch.status === 'deduplicated') {
          const remainder = rawLines[nonEmptyIdx[0]].slice(inlineMatch.cutIndex).trimStart();
          const rebuilt = [...(remainder ? [remainder] : []), ...rawLines.slice(nonEmptyIdx[0] + 1)];
          keptText = rebuilt.join('\n').trim();
          const keptRaw = splitOcrLines(keptText);
          const keptIdx = nonEmptyLineIndices(keptRaw);
          keptNorms = keptIdx.map(i => normalizeOcrLine(keptRaw[i]));
          keptLastRawLine = keptIdx.length ? keptRaw[keptIdx.at(-1)] : '';
          seams.push({
            fromChunk: prevChunk.index, toChunk: chunk.index, overlapPx,
            status: 'deduplicated', strategy: 'inline',
            removedLines: 0, removedChars: inlineMatch.chars
          });
        } else if (inlineMatch.status === 'ambiguous') {
          seams.push({
            fromChunk: prevChunk.index, toChunk: chunk.index, overlapPx,
            status: 'ambiguous', removedLines: 0, removedChars: 0
          });
        } else {
          seams.push({
            fromChunk: prevChunk.index, toChunk: chunk.index, overlapPx,
            status: 'none', removedLines: 0, removedChars: 0
          });
        }
      }
    }
    if (prevChunk && overlapPx > 0) {
      activeNormLines = activeNormLines.concat(keptNorms).slice(-MAX_ACTIVE_OVERLAP_LINES);
      coveredEndY = Math.max(coveredEndY, chunk.y + chunk.height);
      if (keptLastRawLine) activeLastRawLine = keptLastRawLine;
    } else {
      activeNormLines = keptNorms.slice(-MAX_ACTIVE_OVERLAP_LINES);
      coveredEndY = chunk.y + chunk.height;
      activeLastRawLine = keptLastRawLine;
    }
    prevChunk = chunk;
    if (keptText.length > 0) segments.push(`[第${chunk.index}段 y=${chunk.y}] ${keptText}`);
  }
  const appliedSeams = seams.filter(seam => seam.status === 'deduplicated').length;
  const ambiguousSeams = seams.filter(seam => seam.status === 'ambiguous').length;
  const removedLines = seams.reduce((sum, seam) => sum + seam.removedLines, 0);
  const removedChars = seams.reduce((sum, seam) => sum + seam.removedChars, 0);
  return {
    fullText: segments.join('\n'),
    deduplication: { mode: OCR_DEDUP_MODE, appliedSeams, ambiguousSeams, removedLines, removedChars, seams }
  };
}

export class OcrError extends ModelPortError {
  constructor(code = 'IRIS_MODEL_INPUT_INVALID') {
    super(code, { stage: 'prepare', invocation: 'not_invoked' });
    this.name = 'OcrError';
  }
}

const OCR_PROMPT = '请完整读出图片中的全部文字，包括标点符号。按从上到下的顺序逐行输出。不要添加额外解释。';

/** 保留既有最小块高及 overlap 钳制；NaN/无限值不进入图片准备或循环。 */
export function normalizeOcrSettings({ chunkHeight = 1200, overlap = 120, maxDimension = 2048,
  maxInvocations = OCR_LIMITS.maxInvocations } = {}) {
  if (typeof chunkHeight !== 'number' || !Number.isFinite(chunkHeight) || chunkHeight <= 0
      || typeof overlap !== 'number' || !Number.isFinite(overlap)
      || !Number.isSafeInteger(maxDimension) || maxDimension <= 0 || maxDimension > 4096
      || !Number.isSafeInteger(maxInvocations) || maxInvocations <= 0 || maxInvocations > OCR_LIMITS.maxInvocations) {
    throw new OcrError();
  }
  const ch = Math.max(100, Math.floor(chunkHeight));
  const ov = Math.max(0, Math.min(Math.floor(overlap), ch - 1));
  if (!Number.isSafeInteger(ch)) throw new OcrError();
  return Object.freeze({ chunkHeight: ch, overlap: ov, maxDimension, maxInvocations });
}

async function imageWork(action, signal) {
  try { return await waitForModelWork(action, signal); }
  catch (error) {
    if (error instanceof ModelPortError) throw error;
    throw new OcrError();
  }
}

export function ocrImagePlan(meta, settings) {
  const sourceWidth = meta.autoOrient?.width || meta.width, sourceHeight = meta.autoOrient?.height || meta.height;
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0
      || sourceWidth * sourceHeight > OCR_LIMITS.maxPixels || (meta.pages || 1) > 1) throw new OcrError();
  const width = Math.min(sourceWidth, settings.maxDimension);
  const height = sourceWidth > width ? Math.max(1, Math.round(sourceHeight * width / sourceWidth)) : sourceHeight;
  const totalChunks = Math.ceil(height / (settings.chunkHeight - settings.overlap));
  if (totalChunks > OCR_LIMITS.maxChunks) throw new OcrError();
  return { sourceWidth, sourceHeight, width, height, totalChunks };
}

/** 一轮共用 operation：准备、全部块和候选切换均消费同一 deadline/次数。 */
export async function longOcr({ image, ports, chunkHeight, overlap, maxDimension, maxInvocations,
  signal, operation, budget = OCR_BUDGET, inputs }) {
  const settings = normalizeOcrSettings({ chunkHeight, overlap, maxDimension, maxInvocations });
  const op = operation || createModelOperation({ signal, budget: { timeoutMs: budget.timeoutMs, maxInvocations: settings.maxInvocations } });
  try {
    if (op.signal.aborted) throw modelAbortError(op.signal);
    if (op.snapshot().maxInvocations > settings.maxInvocations) throw new OcrError();
    if (!Array.isArray(ports) || !ports.length) throw new OcrError('IRIS_MODEL_UNAVAILABLE');
    const input = normalizeModelCall(modelPortSnapshot(ports[0]), { prompt: OCR_PROMPT, image }, { budget }).request.image;
    const source = Buffer.from(input.bytes);
    const meta = await imageWork(() => sharp(source, { limitInputPixels: OCR_LIMITS.maxPixels }).metadata(), op.signal);
    if (({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[meta.format] !== input.mediaType) {
      throw new OcrError();
    }
    const { sourceWidth: W, sourceHeight: H, width, height, totalChunks } = ocrImagePlan(meta, settings);
    const step = settings.chunkHeight - settings.overlap;
    const img = W > width || meta.orientation > 1 ? await imageWork(() => sharp(source, { limitInputPixels: OCR_LIMITS.maxPixels })
      .autoOrient().resize(width, height).png().toBuffer(), op.signal) : source;
    const chunks = [];
    let stopCode;
    for (let index = 0; index < totalChunks; index++) {
      if (op.signal.aborted) throw modelAbortError(op.signal);
      const y = index * step, h = Math.min(settings.chunkHeight, height - y);
      const chunk = { index: index + 1, y, height: h, text: '', status: 'skipped' };
      if (stopCode) {
        chunk.code = stopCode; chunk.error = modelErrorRecord(new ModelPortError(stopCode)).message;
        chunks.push(chunk); continue;
      }
      try {
        const snapshot = op.snapshot();
        if (snapshot.invocations >= Math.min(snapshot.maxInvocations, settings.maxInvocations)) throw new ModelPortError('IRIS_MODEL_CALL_LIMIT');
        const png = await imageWork(() => sharp(img, { limitInputPixels: OCR_LIMITS.maxPixels })
          .extract({ left: 0, top: y, width, height: h }).png().toBuffer(), op.signal);
        const result = await completeVision(ports, { prompt: OCR_PROMPT,
          image: { bytes: new Uint8Array(png), mediaType: 'image/png' } }, { operation: op, budget });
        chunk.text = result.text.trim(); chunk.status = 'succeeded';
        chunk.identity = result.identity; chunk.errors = result.errors;
        if (inputs?.has(result.identity.backendId)) chunk.input = inputs.get(result.identity.backendId);
        if (result.usage) chunk.usage = result.usage;
      } catch (error) {
        const record = modelErrorRecord(error);
        if (['IRIS_MODEL_ABORTED', 'IRIS_MODEL_TIMEOUT'].includes(record.code)) throw error;
        if (op.signal.aborted) throw modelAbortError(op.signal);
        if (record.code === 'IRIS_MODEL_CALL_LIMIT') stopCode = record.code;
        else chunk.status = 'failed';
        chunk.error = record.message; chunk.code = record.code;
        chunk.errors = Object.freeze([...(error.errors || [record])]);
      }
      chunks.push(chunk);
    }
    if (op.signal.aborted) throw modelAbortError(op.signal);
    const successfulChunks = chunks.filter(chunk => chunk.status === 'succeeded').length;
    const failedChunks = chunks.filter(chunk => chunk.status === 'failed').length;
    const skippedChunks = totalChunks - successfulChunks - failedChunks;
    const { fullText, deduplication } = deduplicateOcrChunks(chunks);
    return { status: successfulChunks === totalChunks ? 'complete' : successfulChunks ? 'partial' : 'failed',
      fullText, deduplication,
      chunks, totalChunks, successfulChunks, failedChunks, skippedChunks, width, height,
      sourceWidth: W, sourceHeight: H,
      invocations: op.snapshot().invocations, ...(stopCode ? { stopCode } : {}) };
  } finally { if (!operation) op.dispose(); }
}

/** Agent/工作台共用明确的完成度，不把缺块或未处理误称为完整全文。 */
export function formatOcrResult(result) {
  const label = { complete: '完成', partial: '部分完成', failed: '失败' }[result.status];
  const counts = result.status === 'complete' ? ''
    : `（成功 ${result.successfulChunks} 块，失败 ${result.failedChunks} 块，未处理 ${result.skippedChunks} 块）`;
  const stop = result.stopCode === 'IRIS_MODEL_CALL_LIMIT' ? '；已达到本次调用上限' : '';
  const resized = result.chunks.filter(chunk => chunk.input?.resized);
  const note = (result.sourceWidth > result.width || resized.length)
    ? '\n[iris] OCR 输入已缩小，细小文字可能丢失；可提高 OCR 最大宽度或模型输入预算。'
      + (resized.length ? '\n' + resized.map(chunk => `[第${chunk.index}段] ${chunk.input.source.width}x${chunk.input.source.height} → ${chunk.input.sent.width}x${chunk.input.sent.height}px`).join('\n') : '')
    : '';
  const dedup = result.deduplication;
  const dedupNote = (dedup?.appliedSeams ? `\n[iris] 已按重叠边界合并 ${dedup.appliedSeams} 处重复（移除 ${dedup.removedLines} 行 / ${dedup.removedChars} 字符；逐块原文保留在分块结果中）。` : '')
    + (dedup?.ambiguousSeams ? `\n[iris] 有 ${dedup.ambiguousSeams} 处重叠边界存在重复歧义，已保守保留原文。` : '');
  return `[iris] 长截图 OCR ${label}：${result.width}x${result.height}px，${result.totalChunks} 块${counts}${stop}\n`
    + (result.fullText || '（没有完整识别结果）') + dedupNote + note;
}
