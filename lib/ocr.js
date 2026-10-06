'use strict';
/** M4 OCR 业务：显式图片字节、Sharp 分块和共享 Vision Ports；无 Host/路径/Store。 */
import sharp from 'sharp';
import { completeVision, VISION_BUDGET } from './vision-core.js';
import { createModelOperation } from './model-invoker.js';
import { ModelPortError, modelErrorRecord, modelPortSnapshot, normalizeModelCall } from './model-port-contract.js';
import { waitForModelWork, modelAbortError } from './model-call-runtime.js';

export const OCR_BUDGET = Object.freeze({ ...VISION_BUDGET });
export const OCR_LIMITS = Object.freeze({ maxChunks: 32, maxInvocations: 64, maxPixels: 40000000 });

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

/** 一轮共用 operation：准备、全部块和候选切换均消费同一 deadline/次数。 */
export async function longOcr({ image, ports, chunkHeight, overlap, maxDimension, maxInvocations,
  signal, operation, budget = OCR_BUDGET }) {
  const settings = normalizeOcrSettings({ chunkHeight, overlap, maxDimension, maxInvocations });
  const op = operation || createModelOperation({ signal, budget: { timeoutMs: budget.timeoutMs, maxInvocations: settings.maxInvocations } });
  try {
    if (op.signal.aborted) throw modelAbortError(op.signal);
    if (op.snapshot().maxInvocations > settings.maxInvocations) throw new OcrError();
    if (!Array.isArray(ports) || !ports.length) throw new OcrError('IRIS_MODEL_UNAVAILABLE');
    const input = normalizeModelCall(modelPortSnapshot(ports[0]), { prompt: OCR_PROMPT, image }, { budget }).request.image;
    const source = Buffer.from(input.bytes);
    const meta = await imageWork(() => sharp(source, { limitInputPixels: OCR_LIMITS.maxPixels }).metadata(), op.signal);
    const W = meta.width, H = meta.height;
    if (!Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W <= 0 || H <= 0
        || W * H > OCR_LIMITS.maxPixels || (meta.pages || 1) > 1
        || ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[meta.format] !== input.mediaType) {
      throw new OcrError();
    }
    const width = Math.min(W, settings.maxDimension);
    const height = W > width ? Math.max(1, Math.round(H * width / W)) : H;
    const step = settings.chunkHeight - settings.overlap;
    const totalChunks = Math.ceil(height / step);
    if (totalChunks > OCR_LIMITS.maxChunks) throw new OcrError();
    const img = W > width ? await imageWork(() => sharp(source, { limitInputPixels: OCR_LIMITS.maxPixels })
      .resize(width, height).png().toBuffer(), op.signal) : source;
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
    return { status: successfulChunks === totalChunks ? 'complete' : successfulChunks ? 'partial' : 'failed',
      fullText: chunks.filter(chunk => chunk.status === 'succeeded').map(chunk => `[第${chunk.index}段 y=${chunk.y}] ${chunk.text}`).join('\n'),
      chunks, totalChunks, successfulChunks, failedChunks, skippedChunks, width, height,
      invocations: op.snapshot().invocations, ...(stopCode ? { stopCode } : {}) };
  } finally { if (!operation) op.dispose(); }
}

/** Agent/工作台共用明确的完成度，不把缺块或未处理误称为完整全文。 */
export function formatOcrResult(result) {
  const label = { complete: '完成', partial: '部分完成', failed: '失败' }[result.status];
  const counts = result.status === 'complete' ? ''
    : `（成功 ${result.successfulChunks} 块，失败 ${result.failedChunks} 块，未处理 ${result.skippedChunks} 块）`;
  const stop = result.stopCode === 'IRIS_MODEL_CALL_LIMIT' ? '；已达到本次调用上限' : '';
  return `[iris] 长截图 OCR ${label}：${result.width}x${result.height}px，${result.totalChunks} 块${counts}${stop}\n`
    + (result.fullText || '（没有完整识别结果）');
}
