'use strict';
/**
 * Iris 确定性像素工具后端（阶段 2）：iris_crop + iris_pixel_diff。
 *
 * 基于 sharp（Apache-2.0，本机 aarch64 proot Debian 已验证）。
 * 契约（进入测试）：
 * - crop：区域 (left,top,width,height) 必须为正且不越界；输出 PNG + 实际尺寸。
 * - diff：尺寸不一致时以「较小者」为基准强制归一化（fit=fill），上限
 *   MAX_DIFF_DIMENSION 防爆内存；alpha 通道不参与差异计算；颜色空间统一 sRGB。
 * - 差异判定用 RGB 通道差之和阈值（容忍压缩噪声），diff ratio = 差异像素占比。
 */
import sharp from 'sharp';

/** diff 归一化后的最大边长（防超大图整读内存） */
const MAX_DIFF_DIMENSION = 1024;
/** RGB 通道差之和超过该值才计为差异像素（容忍 JPEG 压缩噪声） */
const DIFF_THRESHOLD = 30;

export class PixelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PixelError';
  }
}

/**
 * 裁剪图片区域，输出 PNG + 实际尺寸。
 * @param {{input: Buffer|string, left:number, top:number, width:number, height:number}}
 * @returns {Promise<{buffer:Buffer, width:number, height:number, mime:string}>}
 */
export async function cropImage({ input, left, top, width, height }) {
  const meta = await sharp(input).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  const l = Math.floor(left);
  const t = Math.floor(top);
  const w = Math.floor(width);
  const h = Math.floor(height);
  for (const [name, v] of [['left', l], ['top', t], ['width', w], ['height', h]]) {
    if (!Number.isFinite(v)) throw new PixelError(`iris_crop: ${name} 必须是数字`);
  }
  if (w <= 0 || h <= 0) throw new PixelError(`iris_crop: width/height 必须为正（得到 ${w}x${h}）`);
  if (l < 0 || t < 0 || l + w > W || t + h > H) {
    throw new PixelError(`iris_crop: 区域 (${l},${t},${w},${h}) 超出图片边界 ${W}x${H}`);
  }
  const { data, info } = await sharp(input)
    .extract({ left: l, top: t, width: w, height: h })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, mime: 'image/png' };
}

/**
 * 像素级 diff：输出 diff ratio、最差区域、热力图 PNG。
 * @param {{inputA: Buffer|string, inputB: Buffer|string, grid?:number, topRegions?:number}}
 * @returns {Promise<{ratio:number, diffPixels:number, totalPixels:number, width:number, height:number,
 *   worstRegions:Array<{row:number,col:number,score:number}>, heatmap:Buffer, mime:string}>}
 */
export async function pixelDiff({ inputA, inputB, grid = 8, topRegions = 3 }) {
  const [metaA, metaB] = await Promise.all([sharp(inputA).metadata(), sharp(inputB).metadata()]);
  if (!metaA.width || !metaA.height || !metaB.width || !metaB.height) {
    throw new PixelError('iris_pixel_diff: 图片尺寸读取失败');
  }
  // 尺寸策略：以较小者为基准归一化；超上限等比缩到 MAX_DIFF_DIMENSION 内
  let targetW = Math.min(metaA.width, metaB.width);
  let targetH = Math.min(metaA.height, metaB.height);
  const cap = Math.max(targetW, targetH);
  if (cap > MAX_DIFF_DIMENSION) {
    const s = MAX_DIFF_DIMENSION / cap;
    targetW = Math.max(1, Math.round(targetW * s));
    targetH = Math.max(1, Math.round(targetH * s));
  }

  // 读取两图 RGB raw（去 alpha，统一到目标尺寸，强制拉伸对齐）
  const [rawA, rawB] = await Promise.all([
    sharp(inputA).resize(targetW, targetH, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(inputB).resize(targetW, targetH, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  ]);
  if (rawA.length !== targetW * targetH * 3 || rawB.length !== targetW * targetH * 3) {
    throw new PixelError('iris_pixel_diff: 像素读取失败（尺寸不匹配）');
  }

  const N = targetW * targetH;
  const mag = new Float32Array(N); // 每像素归一化差异幅值 0..1
  let diffPixels = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 3;
    const d =
      Math.abs(rawA[o] - rawB[o]) +
      Math.abs(rawA[o + 1] - rawB[o + 1]) +
      Math.abs(rawA[o + 2] - rawB[o + 2]);
    mag[i] = d / 765;
    if (d > DIFF_THRESHOLD) diffPixels++;
  }
  const ratio = N ? diffPixels / N : 0;

  // 8x8（默认）网格：统计每格平均差异，取最差 topRegions
  const g = Math.max(1, Math.floor(grid));
  const gw = Math.ceil(targetW / g);
  const gh = Math.ceil(targetH / g);
  const cells = [];
  for (let r = 0; r < g; r++) {
    for (let c = 0; c < g; c++) {
      let sum = 0;
      let cnt = 0;
      const y0 = r * gh;
      const y1 = Math.min((r + 1) * gh, targetH);
      const x0 = c * gw;
      const x1 = Math.min((c + 1) * gw, targetW);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += mag[y * targetW + x];
          cnt++;
        }
      }
      cells.push({ row: r, col: c, score: cnt ? sum / cnt : 0 });
    }
  }
  cells.sort((a, b) => b.score - a.score);
  const worstRegions = cells.slice(0, Math.max(1, Math.floor(topRegions)));

  // 热力图：灰度 PNG，亮度 = 差异幅值（放大低差异可见性）
  const heat = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) {
    const v = Math.min(255, Math.round(mag[i] * 255 * 2));
    heat[i * 3] = v;
    heat[i * 3 + 1] = v;
    heat[i * 3 + 2] = v;
  }
  const heatmap = await sharp(heat, { raw: { width: targetW, height: targetH, channels: 3 } }).png().toBuffer();

  return { ratio, diffPixels, totalPixels: N, width: targetW, height: targetH, worstRegions, heatmap, mime: 'image/png' };
}
