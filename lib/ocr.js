'use strict';
/**
 * Iris 长截图 OCR（阶段 3B）：视觉模型分块文字识别。
 *
 * 调研结论（RESEARCH.md §7）：qwen-vl 视觉模型中文零误差，tesseract.js 准确率差且置信度虚高。
 * 方案：复用阶段 1 VisionBackend 链，sharp 分块（1200px 高 + 120px 重叠避免切断文本行），
 * 逐块 OCR 后拼接。
 *
 * 契约：
 * - chunkHeight 默认 1200，overlap 默认 120
 * - 每块独立调用视觉模型，结果按 y 坐标顺序拼接
 * - 返回全文 + 分块明细 + 元数据
 */
import sharp from 'sharp';
import { askWithBackends } from './vision.js';
import { imageDimensions } from './pixels.js';

export class OcrError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OcrError';
  }
}

const OCR_PROMPT = '请完整读出图片中的全部文字，包括标点符号。按从上到下的顺序逐行输出。不要添加额外解释。';

/**
 * 分块 OCR：把长图按 chunkHeight 切片（重叠 overlap 避免切断文本行），逐块调用视觉模型，
 * 拼接全文。
 * @param {{input: Buffer|string, backends: Array, chunkHeight?:number, overlap?:number, signal?:AbortSignal, maxDimension?:number}}
 * @returns {Promise<{fullText:string, chunks:Array, totalChunks:number, width:number, height:number}>}
 *   chunks: [{y, height, text, error?}]
 */
export async function longOcr({ input, backends, chunkHeight = 1200, overlap = 120, signal, maxDimension = 2048 }) {
  if (!Array.isArray(backends) || backends.length === 0) {
    throw new OcrError('iris_long_ocr: 没有可用的视觉后端（至少需要一个 vision provider）');
  }
  const { width: W, height: H } = await imageDimensions(input);
  if (W <= 0 || H <= 0) throw new OcrError('iris_long_ocr: 图片尺寸无效');
  const ch = Math.max(100, Math.floor(chunkHeight));
  const ov = Math.max(0, Math.min(Math.floor(overlap), ch - 1));
  const step = ch - ov;

  // 如果宽度超过 maxDimension，先等比缩放
  let img = input;
  if (W > maxDimension) {
    const s = maxDimension / W;
    const resized = await sharp(input).resize(Math.round(W * s), Math.round(H * s)).png().toBuffer();
    img = resized;
  }
  const meta = await sharp(img).metadata();
  const iw = meta.width || W;
  const ih = meta.height || H;

  const chunks = [];
  let y = 0;
  while (y < ih) {
    const h = Math.min(ch, ih - y);
    if (h <= 0) break;
    try {
      const png = await sharp(img).extract({ left: 0, top: y, width: iw, height: h }).png().toBuffer();
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      const { answer } = await askWithBackends(backends, {
        question: OCR_PROMPT,
        imageDataUrl: dataUrl,
        signal
      });
      chunks.push({ y, height: h, text: String(answer || '').trim() });
    } catch (err) {
      chunks.push({ y, height: h, text: '', error: String((err && err.message) || err) });
    }
    y += step;
  }
  const fullText = chunks
    .filter((c) => c.text)
    .map((c, i) => `[第${i + 1}段 y=${c.y}] ${c.text}`)
    .join('\n')
    .trim();
  return { fullText, chunks, totalChunks: chunks.length, width: meta.width || W, height: meta.height || H };
}