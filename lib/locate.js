'use strict';
/**
 * Iris 模型驱动定位（阶段 3A）：iris_locate。
 *
 * 对齐 RESEARCH 4.2a：返回**原图像素 bbox**（x1/y1/x2/y2），不是相对或归一化坐标，
 * 保证 iris_crop 可以无缝接力裁剪（vision-router 的 vision_ground 同款契约）。
 *
 * 实现：
 * - 复用阶段 1 的 VisionBackend 链（askWithBackends）做识图；
 * - 提示词强制模型只回严格 JSON bbox；
 * - 解析/校验/钳制：JSON 提取、字段数字校验、x1<x2 且 y1<y2、轻微越界 clamp、
 *   完全越界报错、found=false 明确返回。
 */
import { askWithBackends } from './vision.js';

export class LocateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocateError';
  }
}

/** 从模型回答里提取第一个平衡的 {...} JSON 对象文本；无则 null */
export function extractBboxJson(answer) {
  const text = String(answer || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 在原图上定位目标，返回原像素 bbox。
 * @param {Array} backends 有序视觉后端（buildVisionBackends 产物）
 * @param {{target:string, imageDataUrl:string, width:number, height:number, signal?:AbortSignal}}
 * @returns {Promise<{found:boolean, x1?:number, y1?:number, x2?:number, y2?:number, via?:string, model?:string}>}
 * @throws LocateError 模型未返回有效 bbox / bbox 完全越界 / 字段非法
 */
export async function locateObject(backends, { target, imageDataUrl, width, height, signal }) {
  const W = Math.floor(width);
  const H = Math.floor(height);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
    throw new LocateError('iris_locate: 图片尺寸无效');
  }
  const prompt =
    `在图片中定位「${String(target).slice(0, 200)}」。` +
    `只返回一个 JSON 对象，不要输出任何其他文字或解释。格式：` +
    `{"x1":左上角x,"y1":左上角y,"x2":右下角x,"y2":右下角y}` +
    `（原像素坐标，图片左上角为(0,0)，尺寸 ${W}x${H}，要求 x1<x2 且 y1<y2）。` +
    `请确保 bbox 完全包围目标，不得遗漏目标的任何部分。` +
    `如果图片中没有该目标，返回 {"found":false}。`;

  const { answer, via, model } = await askWithBackends(backends, { question: prompt, imageDataUrl, signal });

  const jsonText = extractBboxJson(answer);
  if (!jsonText) throw new LocateError('iris_locate: 模型未返回有效 JSON：' + String(answer).slice(0, 160));
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch (_) {
    throw new LocateError('iris_locate: bbox JSON 解析失败：' + jsonText.slice(0, 160));
  }
  if (obj && obj.found === false) return { found: false, via, model };

  const { x1, y1, x2, y2 } = obj || {};
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) {
    throw new LocateError('iris_locate: bbox 字段必须是数字：' + jsonText.slice(0, 160));
  }
  if (!(x1 < x2 && y1 < y2)) {
    throw new LocateError(`iris_locate: bbox 无效（要求 x1<x2 且 y1<y2，得到 ${x1},${y1},${x2},${y2}）`);
  }
  // 完全越界（与图片无交集）→ 报错；否则钳制到图片边界
  if (x1 >= W || x2 <= 0 || y1 >= H || y2 <= 0) {
    throw new LocateError(`iris_locate: bbox 完全超出图片边界 ${W}x${H}：${x1},${y1},${x2},${y2}`);
  }
  const clamp = (v) => Math.max(0, Math.min(v < 0 ? Math.round(v) : Math.ceil(v), W));
  const clampY = (v) => Math.max(0, Math.min(v < 0 ? Math.round(v) : Math.ceil(v), H));
  return {
    found: true,
    x1: clamp(x1),
    y1: clampY(y1),
    x2: clamp(x2),
    y2: clampY(y2),
    via,
    model
  };
}
