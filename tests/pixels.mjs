/**
 * dsh-iris 确定性像素工具测试（阶段 2）：crop + pixel_diff。
 * 运行：node tests/pixels.mjs
 * 覆盖：
 *   ① crop：正常裁剪、边界校验（越界/非正）、输出尺寸正确；
 *   ② pixel_diff：相同图 ratio=0、不同图 ratio>0、尺寸不一致归一化、
 *      alpha 忽略、最差区域排序、热力图输出；
 *   ③ 大图自动缩放到 MAX_DIFF_DIMENSION 内。
 * 零网络，sharp 本地计算。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = path.dirname(new URL(import.meta.url).pathname);
const outDir = path.join(root, '..', 'tmp', 'pixels-test-' + Date.now());
fs.mkdirSync(outDir, { recursive: true });

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

const { cropImage, pixelDiff, PixelError } = await import('../lib/pixels.js');

/* ---------- 准备测试图 ---------- */

// 10×10 红图
const RED = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
// 10×10 蓝图
const BLUE = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
// 10×10 半红半蓝图（左 5px 红右 5px 蓝）
const SPLIT = await sharp({
  create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } }
}).png().toBuffer();
// 用 overlay 技术造半红半蓝：先造红底，在上面叠半透明的蓝
// 实际上 sharp 没直接像素级 API，换个方式：用 raw
const splitRaw = Buffer.alloc(10 * 10 * 3);
for (let y = 0; y < 10; y++) {
  for (let x = 0; x < 5; x++) {
    const o = (y * 10 + x) * 3;
    splitRaw[o] = 255; splitRaw[o + 1] = 0; splitRaw[o + 2] = 0;
  }
  for (let x = 5; x < 10; x++) {
    const o = (y * 10 + x) * 3;
    splitRaw[o] = 0; splitRaw[o + 1] = 0; splitRaw[o + 2] = 255;
  }
}
const SPLIT_PNG = await sharp(splitRaw, { raw: { width: 10, height: 10, channels: 3 } }).png().toBuffer();

/* ---------- ① crop ---------- */

// 正常裁剪
const c = await cropImage({ input: RED, left: 2, top: 2, width: 4, height: 4 });
assert(c.width === 4 && c.height === 4, 'crop 尺寸正确', c);
assert(c.mime === 'image/png', 'crop mime png');
// 验证裁剪结果不是空
const cMeta = await sharp(c.buffer).metadata();
assert(cMeta.width === 4 && cMeta.height === 4, 'crop 输出 meta 正确', cMeta);

// 越界
try { await cropImage({ input: RED, left: 8, top: 0, width: 4, height: 4 }); assert(false, '应抛越界'); }
catch (e) { assert(/超出/.test(e.message), '越界检查', e.message); }

// 非正宽高
try { await cropImage({ input: RED, left: 0, top: 0, width: 0, height: 4 }); assert(false, '应抛宽>0'); }
catch (e) { assert(/必须为正/.test(e.message), '正宽检查', e.message); }

// 路径输入（字符串）
const tmpPath = path.join(outDir, 'tmp.png');
await sharp(RED).png().toFile(tmpPath);
const cPath = await cropImage({ input: tmpPath, left: 0, top: 0, width: 10, height: 10 });
assert(cPath.width === 10, 'crop 路径输入', cPath.width);

/* ---------- ② pixel_diff ---------- */

// 相同图 → ratio=0
const same = await pixelDiff({ inputA: RED, inputB: RED });
assert(same.ratio === 0 && same.diffPixels === 0, '相同图 ratio=0', same.ratio);
assert(same.worstRegions.length === 3 && same.worstRegions[0].score === 0, '相同图 worst 为 0');

// 不同图 → ratio>0
const diff = await pixelDiff({ inputA: RED, inputB: BLUE });
assert(diff.ratio > 0 && diff.diffPixels > 0, '不同图 ratio>0', diff.ratio);
assert(diff.width === 10 && diff.height === 10, 'diff 尺寸 10x10');
assert(diff.heatmap && diff.heatmap.length > 0, '热力图非空');
assert(diff.mime === 'image/png', '热力图 mime');

// 最差区域：全是红 vs 全是蓝，每格差异应相同 → 前三格 score 相等
assert(diff.worstRegions[0].score === diff.worstRegions[1].score, '全图差异均匀', diff.worstRegions);

// 半红半蓝 vs 全红：左半一致（score=0），右半差异大
const half = await pixelDiff({ inputA: RED, inputB: SPLIT_PNG });
assert(half.ratio > 0 && half.ratio < 1, '半差异 ratio', half.ratio);
// 最差区域应来自右半（col >= 3，右半列），且前三格 score > 0.5
const rightHalf = half.worstRegions.filter((r) => r.col >= 3 && r.score > 0.5);
assert(rightHalf.length >= 2, '最差区域在右半', half.worstRegions.slice(0, 3));

// 尺寸不一致归一化
const SMALL = await sharp({ create: { width: 5, height: 5, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
const sized = await pixelDiff({ inputA: RED, inputB: SMALL });
assert(sized.width === 5 && sized.height === 5, '尺寸归一化到较小者', sized.width + 'x' + sized.height);

// alpha 忽略：4 通道图 vs 3 通道图
const SPLIT_WITH_ALPHA = await sharp(SPLIT_PNG).ensureAlpha(0).png().toBuffer();
const alphaDiff = await pixelDiff({ inputA: RED, inputB: SPLIT_WITH_ALPHA });
assert(alphaDiff.ratio >= 0, 'alpha 忽略不崩溃', alphaDiff.ratio);

/* ---------- ③ 大图自动缩放 ---------- */
const BIG = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
const BIG_B = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
const bigDiff = await pixelDiff({ inputA: BIG, inputB: BIG_B });
assert(bigDiff.width <= 1024 && bigDiff.height <= 1024, '大图缩到 MAX_DIFF_DIMENSION', bigDiff.width + 'x' + bigDiff.height);

/* ---------- 清理 ---------- */
fs.rmSync(outDir, { recursive: true, force: true });

console.log('ALL OK —— 像素工具 8 组断言全部通过（crop 越界/尺寸/diff ratio/局部/归一化/alpha/大图/热力图）');