/**
 * dsh-iris 视频抽帧后端测试（阶段 7.1）。
 * 运行：node tests/media-probe.mjs
 * 需要系统 ffmpeg + ffprobe（可选系统条件；缺失时本测试验证错误路径后跳过真实抽帧）。
 * 覆盖：
 *   ① ffmpegAvailable / normalizeFramesOptions（默认、上限 clamp、非法参数报错）；
 *   ② scaledDimensions（按比例取偶数、不放大、上限）；
 *   ③ probeVideo（元数据：时长/尺寸/编码）；
 *   ④ extractFrames：帧数 = 请求数（时间均匀采样）、目标宽度缩放、atSec 时间戳、
 *      JPEG 魔数 / PNG 魔数、临时目录清理；
 *   ⑤ 错误路径：文件不存在 / 非视频 / 取消信号 / 参数非法。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

const probe = await import('../lib/media-probe.js');

const HAVE_FFMPEG = probe.ffmpegAvailable();
console.log('ffmpeg 可用:', HAVE_FFMPEG);

/* ---------- ① 参数校验与 clamp ---------- */
assert(probe.normalizeFramesOptions({}).maxFrames === 8, '默认 maxFrames=8');
assert(probe.normalizeFramesOptions({ maxFrames: 100 }).maxFrames === 20, 'maxFrames 上限 clamp 到 20');
assert(probe.normalizeFramesOptions({ maxFrames: 1 }).maxFrames === 1, 'maxFrames=1 通过');
assert(probe.normalizeFramesOptions({ targetWidth: 99999 }).targetWidth === 4096, 'targetWidth 上限 clamp 到 4096');
assert(probe.normalizeFramesOptions({ format: 'png' }).format === 'png', 'format png 通过');
let e;
try { probe.normalizeFramesOptions({ maxFrames: 0 }); } catch (x) { e = x; }
assert(e && /maxFrames/.test(e.message), 'maxFrames=0 报错', e && e.message);
try { probe.normalizeFramesOptions({ format: 'bmp' }); } catch (x) { e = x; }
assert(e && /jpeg 或 png/.test(e.message), 'format=bmp 报错', e && e.message);
try { probe.normalizeFramesOptions({ quality: 101 }); } catch (x) { e = x; }
assert(e && /quality/.test(e.message), 'quality=101 报错', e && e.message);

/* ---------- ② scaledDimensions ---------- */
let d = probe.scaledDimensions(320, 240, 160);
assert(d.width === 160 && d.height === 120, '按比例 320x240→160x120', d);
d = probe.scaledDimensions(320, 240, 640);
assert(d.width === 320 && d.height === 240, '不放大（源宽 < 目标宽）', d);
d = probe.scaledDimensions(640, 360, 200);
assert(d.width === 200 && d.height === 112, '高度取偶数 360*200/640=112.5→112', d);
d = probe.scaledDimensions(0, 0, 100);
assert(d.width === 1 && d.height === 2, '空输入兜底宽=1 高=2', d);

/* ---------- ③ 无 ffmpeg：错误路径（不依赖真实抽帧） ---------- */
if (!HAVE_FFMPEG) {
  const missing = path.join(os.tmpdir(), 'iris-nonexistent.mp4');
  try { probe.probeVideo(missing); } catch (x) { e = x; }
  assert(e && /ffmpeg 不可用/.test(e.message), '无 ffmpeg 时 probeVideo 报人话错误', e && e.message);
  try { await probe.extractFrames({ inputPath: missing }); } catch (x) { e = x; }
  assert(e && /ffmpeg 不可用/.test(e.message), '无 ffmpeg 时 extractFrames 报人话错误', e && e.message);
  console.log('ALL OK（跳过真实抽帧）—— 参数校验 + 无 ffmpeg 错误路径断言通过');
  process.exit(0);
}

/* ---------- 造一个真实测试视频 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-media-test-'));
const clip = path.join(tmp, 'clip.mp4');
// 6 秒 320x240 12fps 测试源（testsrc 带移动图案，帧间有差异）
const gen = spawnSync('ffmpeg', [
  '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=12',
  '-pix_fmt', 'yuv420p', '-y', clip
], { encoding: 'utf8' });
assert(gen.status === 0, '测试视频生成成功: ' + (gen.stderr || '').slice(0, 200));
const beforeTmp = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('iris-frames-')).length;

/* ---------- ④ probeVideo ---------- */
const meta = probe.probeVideo(clip);
assert(meta.durationSec > 5.5 && meta.durationSec < 7, '时长约 6s', meta.durationSec);
assert(meta.width === 320 && meta.height === 240, '尺寸 320x240', meta);
assert(typeof meta.codec === 'string' && meta.codec.length > 0, '有编码名', meta.codec);
assert(meta.sizeBytes > 0, '有字节大小', meta.sizeBytes);

/* ---------- ⑤ extractFrames 基础 ---------- */
const frames5 = await probe.extractFrames({ inputPath: clip, maxFrames: 5, targetWidth: 160, format: 'jpeg', quality: 85 });
assert(frames5.length === 5, '请求 5 帧得 5 帧（时间均匀采样）', frames5.length);
assert(frames5[0].width === 160 && frames5[0].height === 120, '缩放到 160x120', frames5[0]);
for (let i = 0; i < frames5.length; i++) {
  const f = frames5[i];
  assert(f.buffer.length > 0, '帧 ' + (i + 1) + ' 有数据');
  assert(f.buffer[0] === 0xff && f.buffer[1] === 0xd8, 'JPEG 魔数 FF D8');
  if (i > 0) assert(f.atSec > frames5[i - 1].atSec, 'atSec 递增');
}
assert(Math.abs(frames5[0].atSec - 0) < 0.001, '首帧 atSec≈0', frames5[0].atSec);
assert(Math.abs(frames5[4].atSec - 4.8) < 0.01, '末帧 atSec≈4.8（i*duration/n）', frames5[4].atSec);

/* ---------- ⑥ PNG 与缩放/上限 ---------- */
const png3 = await probe.extractFrames({ inputPath: clip, maxFrames: 3, targetWidth: 320, format: 'png' });
assert(png3.length === 3 && png3[0].buffer[0] === 0x89 && png3[0].buffer[1] === 0x50, 'PNG 魔数 89 50');
assert(png3[0].width === 320, 'targetWidth=320 不放大源宽 320', png3[0].width);
const big = await probe.extractFrames({ inputPath: clip, maxFrames: 50, targetWidth: 100000 });
assert(big.length === 20, 'maxFrames=50 clamp 到 20', big.length);
assert(big[0].width <= 4096, 'targetWidth 超限 clamp 到 4096', big[0].width);

/* ---------- ⑦ 短视频（不足 1 秒）与取消信号 ---------- */
const short = path.join(tmp, 'short.mp4');
spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=0.4:size=100x80:rate=12', '-pix_fmt', 'yuv420p', '-y', short]);
const shortFrames = await probe.extractFrames({ inputPath: short, maxFrames: 4, targetWidth: 60 });
assert(shortFrames.length === 4, '0.4s 短视频也能取整 4 帧', shortFrames.length);
assert(shortFrames[0].width === 60 && shortFrames[0].height === 48, '短视频缩放 100x80→60x48', shortFrames[0]);

const ac = new AbortController();
ac.abort();
try { await probe.extractFrames({ inputPath: clip, maxFrames: 5, signal: ac.signal }); } catch (x) { e = x; }
assert(e && /已取消/.test(e.message), '预取消信号报「已取消」', e && e.message);

/* ---------- ⑧ 错误路径 ---------- */
try { probe.probeVideo(path.join(tmp, 'missing.mp4')); } catch (x) { e = x; }
assert(e && /不存在/.test(e.message), 'probeVideo 文件不存在报错', e && e.message);
try { await probe.extractFrames({ inputPath: path.join(tmp, 'missing.mp4') }); } catch (x) { e = x; }
assert(e && /不存在/.test(e.message), 'extractFrames 文件不存在报错', e && e.message);
// 非视频文件（文本当视频）
const notVideo = path.join(tmp, 'fake.mp4');
fs.writeFileSync(notVideo, 'this is not a video at all, just plain text padding padding padding');
try { await probe.extractFrames({ inputPath: notVideo }); } catch (x) { e = x; }
assert(e && /抽帧失败|时长|ffprobe 读取失败/.test(e.message), '非视频文件报错', e && e.message);

/* ---------- ⑨ 临时目录清理 ---------- */
const afterTmp = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('iris-frames-')).length;
assert(afterTmp === beforeTmp, '抽帧临时目录已清理', { beforeTmp, afterTmp });

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ALL OK —— 视频抽帧 9 组断言全部通过（参数/clamp/缩放/probe/帧数/PNG/短视频/取消/错误路径/清理）');
