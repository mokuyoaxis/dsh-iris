/**
 * dsh-iris 长截图 OCR 测试（阶段 3B）。
 * 运行：node tests/ocr.mjs
 * 覆盖：
 *   ① 小图（< chunkHeight）→ 1 块；
 *   ② 长图 → 多块，y 坐标按 step=chunkHeight-overlap 递增，重叠正确；
 *   ③ fullText 按顺序拼接（[第N段 y=..] 标记）；
 *   ④ 块内视觉调用失败 → 该块 error 标记，不整体崩溃；
 *   ⑤ 无后端 → OcrError；
 *   ⑥ 宽图超 maxDimension → 等比缩放后仍能分块。
 * 全部用 mock 后端（返回固定文本），零网络、零费用。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-ocr-home');

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

const { longOcr, OcrError } = await import('../lib/ocr.js');

/* ---------- mock 后端：按调用次数返回递增文本 ---------- */
function mockBackend(answers) {
  let n = 0;
  return {
    id: 'mock',
    kind: 'mock',
    model: 'mock-model',
    async analyze() {
      const a = answers[Math.min(n, answers.length - 1)];
      n++;
      if (a && a.error) throw new Error(a.error);
      return a && a.text;
    }
  };
}

/* ---------- 造测试图 ---------- */
async function makeImage(width, height, chunkCount) {
  // 每块不同底色，便于区分（视觉模型并不真看，mock 返回固定文本）
  return sharp({ create: { width, height, channels: 3, background: { r: 10 * chunkCount % 255, g: 0, b: 0 } } }).png().toBuffer();
}

/* ---------- ① 小图 → 1 块 ---------- */
const small = await makeImage(100, 500, 1);
const r1 = await longOcr({ input: small, backends: [mockBackend([{ text: 'A' }])], chunkHeight: 1200, overlap: 120 });
assert(r1.totalChunks === 1, '小图 1 块', r1.totalChunks);
assert(r1.fullText === '[第1段 y=0] A', '单块全文', r1.fullText);

/* ---------- ② 长图 → 多块 + 重叠 ---------- */
// 2500px 高，chunkHeight=1000, overlap=200 → step=800 → y: 0, 800, 1600, 2400 = 4 块
const tall = await makeImage(200, 2500, 4);
const r2 = await longOcr({
  input: tall,
  backends: [mockBackend([{ text: 'line1' }, { text: 'line2' }, { text: 'line3' }, { text: 'line4' }])],
  chunkHeight: 1000,
  overlap: 200
});
assert(r2.totalChunks === 4, '长图 4 块', r2.totalChunks);
assert(r2.chunks.map((c) => c.y).join(',') === '0,800,1600,2400', 'y 按 step=800 递增', JSON.stringify(r2.chunks.map((c) => c.y)));
assert(r2.fullText.includes('[第1段 y=0] line1') && r2.fullText.includes('[第4段 y=2400] line4'), '全文按序拼接', r2.fullText);
assert(r2.height === 2500, '元数据高度', r2.height);

/* ---------- ③ 重叠防切断文本行（断言 overlap 参与 step） ---------- */
const noOverlap = await longOcr({ input: tall, backends: [mockBackend([{ text: 'x' }])], chunkHeight: 1000, overlap: 0 });
assert(noOverlap.chunks.map((c) => c.y).join(',') === '0,1000,2000', 'overlap=0 → step=1000', JSON.stringify(noOverlap.chunks.map((c) => c.y)));

/* ---------- ④ 单块失败 → error 标记不整体崩 ---------- */
const r4 = await longOcr({
  input: tall,
  backends: [mockBackend([{ text: 'ok1' }, { error: '模拟失败' }, { text: 'ok2' }])],
  chunkHeight: 1000,
  overlap: 200
});
assert(r4.totalChunks === 4, '失败块仍计入', r4.totalChunks);
assert(r4.chunks[1].error && r4.chunks[1].text === '', '第2块 error 标记', JSON.stringify(r4.chunks[1]));
assert(r4.fullText.includes('ok1') && r4.fullText.includes('ok2') && !r4.fullText.includes('模拟失败'), '失败块被跳过', r4.fullText);

/* ---------- ⑤ 无后端 → OcrError ---------- */
let err5 = null;
try { await longOcr({ input: small, backends: [] }); } catch (e) { err5 = e; }
assert(err5 instanceof OcrError && /没有可用的视觉后端/.test(err5.message), '无后端报错', err5 && err5.message);

/* ---------- ⑥ 宽图超 maxDimension → 等比缩放 ---------- */
const wide = await makeImage(3000, 1000, 6);
const r6 = await longOcr({ input: wide, backends: [mockBackend([{ text: 'wide' }])], chunkHeight: 500, overlap: 0, maxDimension: 2048 });
assert(r6.totalChunks >= 1, '宽图缩放后仍分块', r6.totalChunks);
assert(r6.width === 2048, '宽度被缩到 maxDimension', r6.width);

console.log('ALL OK —— 长截图 OCR 6 组断言全部通过（单块/多块重叠/y 步进/失败隔离/无后端/宽图缩放）');
