'use strict';
/**
 * Iris 模型驱动定位（阶段 3A）：iris_locate。
 *
 * 返回**原图像素 bbox**（x1/y1/x2/y2），不是相对或归一化坐标，
 * 保证 iris_crop 可以无缝接力裁剪（vision-router 的 vision_ground 同款契约）。
 *
 * 实现：
 * - 消费共享 Vision Ports；
 * - 提示词强制模型只回严格 JSON bbox；
 * - 解析/校验/钳制：JSON 提取、字段数字校验、x1<x2 且 y1<y2、轻微越界 clamp、
 *   完全越界报错、found=false 明确返回。
 */
import { completeVision } from './vision-core.js';
import { ModelPortError } from './model-port-contract.js';
import { createVisionInputObserver } from './vision-image-input.js';

export class LocateError extends ModelPortError {
  constructor(message) {
    super('IRIS_MODEL_PROTOCOL_INVALID', { stage: 'normalize', invocation: 'responded' });
    this.message = message;
    this.name = 'LocateError';
  }
}

export function normalizeLocateTarget(target) {
  const value = String(target || '').trim();
  if (!value) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
  return value.slice(0, 200);
}

function locatePrompt(target, width, height, normalized = false) {
  const coordinates = normalized
    ? `坐标必须使用 0–1000 归一化坐标：x=像素x/${width}*1000，y=像素y/${height}*1000；左上角(0,0)，右下角(1000,1000)，不得直接输出像素坐标`
    : '本次输入图片的像素坐标，图片左上角为(0,0)';
  return `在图片中定位「${target}」。只返回一个 JSON 对象，不要输出任何其他文字或解释。格式：`
    + `{"x1":左上角x,"y1":左上角y,"x2":右下角x,"y2":右下角y}`
    + `（图片尺寸 ${width}x${height}；${coordinates}；要求 x1<x2 且 y1<y2）。`
    + `请确保 bbox 完全包围目标，不得遗漏目标的任何部分。如果图片中没有该目标，返回 {"found":false}。`;
}

/** 输入已显式转正；将四角逆变换回原始像素，向外取整以供原图裁剪。 */
export function mapLocateBbox(bbox, input) {
  if (bbox.found === false) return bbox;
  const { width: W, height: H } = input.source;
  const orientation = input.orientation;
  const swapped = orientation >= 5 && orientation <= 8;
  const sx = (swapped ? H : W) / (input.coordinateSpace === 'normalized-1000' ? 1000 : input.sent.width);
  const sy = (swapped ? W : H) / (input.coordinateSpace === 'normalized-1000' ? 1000 : input.sent.height);
  const inverse = (x, y) => {
    switch (orientation) {
      case 2: return [W - x, y];
      case 3: return [W - x, H - y];
      case 4: return [x, H - y];
      case 5: return [y, x];
      case 6: return [y, H - x];
      case 7: return [W - y, H - x];
      case 8: return [W - y, x];
      default: return [x, y];
    }
  };
  const corners = [[bbox.x1, bbox.y1], [bbox.x1, bbox.y2], [bbox.x2, bbox.y1], [bbox.x2, bbox.y2]]
    .map(([x, y]) => inverse(x * sx, y * sy));
  const xs = corners.map(([x]) => x), ys = corners.map(([, y]) => y);
  // 消除比例换算在整数边缘的浮点误差，再对真实小数向外取整。
  const edge = (value, round) => Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : round(value);
  return { found: true, x1: Math.max(0, edge(Math.min(...xs), Math.floor)), y1: Math.max(0, edge(Math.min(...ys), Math.floor)),
    x2: Math.min(W, edge(Math.max(...xs), Math.ceil)), y2: Math.min(H, edge(Math.max(...ys), Math.ceil)) };
}

/** 工厂钩子局限于本次业务，协议适配器不解析 bbox；候选各用自己的真实输入。 */
export function createLocateImageRequest(target, inputs) {
  target = normalizeLocateTarget(target);
  const observe = createVisionInputObserver(inputs);
  return async args => {
    const input = await observe(args);
    input.coordinateSpace = 'normalized-1000';
    return { prompt: locatePrompt(target, input.sent.width, input.sent.height, true),
      mapText: text => JSON.stringify(mapLocateBbox(parseLocateBbox(text, 1000, 1000, { round: false }), input)) };
  };
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
 * @param {Array} ports 有序 Vision Ports
 * @param {{target:string, image:object, width:number, height:number}}
 * @returns {Promise<object>} 完整模型结果及 bbox
 * @throws LocateError 模型未返回有效 bbox / bbox 完全越界 / 字段非法
 */
export async function locateObject(ports, { target, image, width, height }, options = {}) {
  target = normalizeLocateTarget(target);
  const W = Math.floor(width);
  const H = Math.floor(height);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
    throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
  }
  const prompt = locatePrompt(target, W, H);

  const result = await completeVision(ports, { prompt, image }, options);
  return { ...result, bbox: parseLocateBbox(result.text, W, H) };
}

/** 保持原像素解析与钳制规则；格式失败不再发起模型调用。 */
export function parseLocateBbox(answer, W, H, { round = true } = {}) {
  const jsonText = extractBboxJson(answer);
  if (!jsonText) throw new LocateError('iris_locate: 模型未返回有效 JSON');
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch (_) {
    throw new LocateError('iris_locate: bbox JSON 解析失败');
  }
  if (obj && obj.found === false) return { found: false };

  const { x1, y1, x2, y2 } = obj || {};
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) {
    throw new LocateError('iris_locate: bbox 字段必须是数字');
  }
  if (!(x1 < x2 && y1 < y2)) {
    throw new LocateError('iris_locate: bbox 无效（要求 x1<x2 且 y1<y2）');
  }
  // 完全越界（与图片无交集）→ 报错；否则钳制到图片边界
  if (x1 >= W || x2 <= 0 || y1 >= H || y2 <= 0) {
    throw new LocateError('iris_locate: bbox 完全超出图片边界');
  }
  const pixel = v => round ? (v < 0 ? Math.round(v) : Math.ceil(v)) : v;
  const clamp = (v) => Math.max(0, Math.min(pixel(v), W));
  const clampY = (v) => Math.max(0, Math.min(pixel(v), H));
  return {
    found: true,
    x1: clamp(x1),
    y1: clampY(y1),
    x2: clamp(x2),
    y2: clampY(y2)
  };
}
