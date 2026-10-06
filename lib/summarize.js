'use strict';
/**
 * Iris 多模态上下文摘要（阶段 7.3）—— 把视频压成「一张联系表 + 一段转写文本」喂给视觉模型。
 *
 * 为什么是 contact sheet：
 * - Vision Port 一次 complete 只送一张图（字节与 MIME），
 *   逐帧送 N 次要 N 次模型调用、费用与延迟都不可接受；
 * - 把 N 帧缩略图按时间序拼成网格 + 每帧盖时间戳标签，一次视觉调用即可看全片（上下文压缩）。
 *
 * 契约：
 * - buildContactSheet({frames, ...opts}) → PNG buffer + 网格尺寸（纯 sharp，可离线测试）
 * - summarizeMedia({ports, frames, question?, transcript?, signal})
 *   → 一张拼图通过共享 Vision Ports，转写只消费显式输入
 */
import sharp from 'sharp';
import { completeVision, VISION_BUDGET } from './vision-core.js';
import { createModelOperation } from './model-invoker.js';
import { waitForModelWork } from './model-call-runtime.js';
import { ModelPortError } from './model-port-contract.js';

export class SummarizeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SummarizeError';
  }
}

const DEFAULT_QUESTION = '请根据这些视频关键帧（按时间顺序从左到右、从上到下排列）总结视频的画面内容、场景与主题。';

/**
 * 把 N 帧拼成带时间戳标签的联系表（PNG buffer）。
 * @param {{frames:Array<{buffer:Buffer, atSec:number, width:number, height:number}>, cols?:number, maxSheetWidth?:number}}
 * @returns {Promise<{buffer:Buffer, width:number, height:number, rows:number, cols:number}>}
 */
export async function buildContactSheet({ frames, cols = 3, maxSheetWidth = 1024, signal }) {
  return waitForModelWork(() => makeContactSheet({ frames, cols, maxSheetWidth, signal }), signal);
}

async function makeContactSheet({ frames, cols, maxSheetWidth, signal }) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new SummarizeError('iris_media_summarize: 没有可拼的帧');
  }
  const n = frames.length;
  const colsN = Math.max(1, Math.min(Math.floor(cols), n, 4));
  const rowsN = Math.ceil(n / colsN);
  // 每格宽度：以源帧宽为基准，但整表不超过 maxSheetWidth（防超上下文）
  const cellW = Math.max(80, Math.min(frames[0].width || 640, Math.floor(maxSheetWidth / colsN)));
  const labelH = 22; // 时间戳标签高度
  const gap = 4;

  // 先逐帧缩略图 + 时间戳标签合成单个 cell
  const cells = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const w = Math.max(1, cellW);
    const scale = w / Math.max(1, f.width || w);
    const h = Math.max(1, Math.round((f.height || 0) * scale));
    const thumb = await waitForModelWork(() => sharp(f.buffer)
      .resize(w, h, { fit: 'fill' })
      .png()
      .toBuffer(), signal);
    // 时间戳标签（SVG 覆盖在缩略图下方）
    const label = Buffer.from(
      `<svg width="${w}" height="${labelH}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="rgba(0,0,0,0.62)"/>` +
      `<text x="4" y="${labelH - 7}" font-family="monospace" font-size="12" fill="#ffffff">` +
      `${f.atSec.toFixed(1)}s</text></svg>`
    );
    const cell = await waitForModelWork(() => sharp(thumb)
      .extend({ bottom: labelH, background: { r: 16, g: 16, b: 20 } })
      .composite([{ input: label, top: h, left: 0 }])
      .png()
      .toBuffer(), signal);
    cells.push({ buffer: cell, width: w, height: h + labelH });
  }

  const cellH = cells[0].height;
  const sheetW = colsN * cellW + (colsN - 1) * gap;
  const sheetH = rowsN * cellH + (rowsN - 1) * gap;
  const composite = cells.map((c, i) => ({
    input: c.buffer,
    left: (i % colsN) * (cellW + gap),
    top: Math.floor(i / colsN) * (cellH + gap)
  }));
  const buffer = await waitForModelWork(() => sharp({
    create: { width: sheetW, height: sheetH, channels: 3, background: { r: 16, g: 16, b: 20 } }
  })
    .composite(composite)
    .png()
    .toBuffer(), signal);
  return { buffer, width: sheetW, height: sheetH, rows: rowsN, cols: colsN };
}

/** 组装摘要提示词：画面指令 + （可选）转写文本 */
export function buildSummaryPrompt({ question, transcript }) {
  const q = String(question || '').trim() || DEFAULT_QUESTION;
  let prompt = q;
  if (transcript && String(transcript).trim()) {
    const t = String(transcript).trim();
    prompt +=
      `\n\n视频音轨的语音转写文本如下（可能不完整或含识别噪声）：\n` +
      `"""\n${t.slice(0, 6000)}\n"""\n` +
      `请结合转写内容补充说明视频的对话、旁白或口头信息（如有）。`;
  }
  return prompt;
}

/**
 * 多模态摘要：contact sheet 图 + 可选转写文本 → 视觉后端链 → 摘要文本。
 * @param {{ports:Array, frames:Array, question?:string, transcript?:string, signal?:AbortSignal}}
 * @returns {Promise<object>} 完整模型结果和同一张拼图
 */
export async function summarizeMedia({ ports = [], frames, question, transcript, signal, operation, budget = VISION_BUDGET }) {
  if (!ports.length) throw new ModelPortError('IRIS_MODEL_UNAVAILABLE');
  const op = operation || createModelOperation({ signal, budget: { timeoutMs: budget.timeoutMs, maxInvocations: ports.length } });
  try {
    const sheet = await buildContactSheet({ frames, cols: 3, signal: op.signal });
    const result = await completeVision(ports, { prompt: buildSummaryPrompt({ question, transcript }),
      image: { bytes: new Uint8Array(sheet.buffer), mediaType: 'image/png' } }, { operation: op, budget });
    return { ...result, sheet };
  } finally { if (!operation) op.dispose(); }
}
