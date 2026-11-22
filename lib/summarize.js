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
  const labelH = 22; // 时间戳标签高度
  const gap = 4;
  const bg = { r: 16, g: 16, b: 20 };
  // 每格宽度：先扣除列间距再分配格宽，保证总宽不超过 maxSheetWidth；格高设上限并按比例自适应，兼容横竖混排与极端长图
  const maxFrameW = Math.max(...frames.map(f => Number.isFinite(f?.width) && f.width > 0 ? f.width : 0)) || 640;
  const maxCellW = Math.max(1, Math.floor((maxSheetWidth - (colsN - 1) * gap) / colsN));
  const cellW = Math.max(Math.min(80, maxCellW), Math.min(maxFrameW, maxCellW));
  const maxThumbH = Math.max(Math.round(cellW * 1.5), 360);

  // 先逐帧按比例缩放到 (cellW × maxThumbH) 内并居中补齐宽度 + 底部时间戳标签
  const cells = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const { data: fitted, info: fittedInfo } = await waitForModelWork(() => sharp(f.buffer)
      .resize({ width: cellW, height: maxThumbH, fit: 'inside' })
      .png()
      .toBuffer({ resolveWithObject: true }), signal);
    const thumbW = fittedInfo.width;
    const thumbH = fittedInfo.height;
    const padLeft = Math.floor((cellW - thumbW) / 2);
    const padRight = cellW - thumbW - padLeft;
    const stamp = Number.isFinite(f.atSec) ? `${f.atSec.toFixed(1)}s` : `#${i + 1}`;
    // 时间戳标签（SVG 覆盖在缩略图下方）
    const label = Buffer.from(
      `<svg width="${cellW}" height="${labelH}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="rgba(0,0,0,0.62)"/>` +
      `<text x="4" y="${labelH - 7}" font-family="monospace" font-size="12" fill="#ffffff">` +
      `${stamp}</text></svg>`
    );
    const cell = await waitForModelWork(() => sharp(fitted)
      .extend({ left: padLeft, right: padRight, bottom: labelH, background: bg })
      .composite([{ input: label, top: thumbH, left: 0 }])
      .png()
      .toBuffer(), signal);
    cells.push({ buffer: cell, width: cellW, height: thumbH + labelH });
  }

  // 每行取该行最高格子的高度，确保横图与竖图混排时永不越界，且等尺寸帧布局保持原样
  const rowHeights = Array.from({ length: rowsN }, (_, r) => {
    const start = r * colsN;
    return Math.max(...cells.slice(start, start + colsN).map(c => c.height));
  });
  const rowTops = [];
  let cursorY = 0;
  for (let r = 0; r < rowsN; r++) {
    rowTops.push(cursorY);
    cursorY += rowHeights[r] + (r + 1 < rowsN ? gap : 0);
  }
  const sheetW = colsN * cellW + (colsN - 1) * gap;
  const sheetH = cursorY;
  const composite = cells.map((c, i) => {
    const row = Math.floor(i / colsN);
    return {
      input: c.buffer,
      left: (i % colsN) * (cellW + gap),
      top: rowTops[row] + Math.floor((rowHeights[row] - c.height) / 2)
    };
  });
  const buffer = await waitForModelWork(() => sharp({
    create: { width: sheetW, height: sheetH, channels: 3, background: bg }
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
    let sheet;
    try {
      sheet = await buildContactSheet({ frames, cols: 3, signal: op.signal });
    } catch (error) {
      if (error instanceof ModelPortError) throw error;
      throw new ModelPortError('IRIS_MODEL_INPUT_INVALID', { stage: 'prepare', invocation: 'not_invoked' });
    }
    const result = await completeVision(ports, { prompt: buildSummaryPrompt({ question, transcript }),
      image: { bytes: new Uint8Array(sheet.buffer), mediaType: 'image/png' } }, { operation: op, budget });
    return { ...result, sheet };
  } finally { if (!operation) op.dispose(); }
}
