'use strict';
/**
 * Iris 媒体分析探测（阶段 7.1）—— 视频抽帧。
 *
 * ffmpeg 是可选系统可执行文件：启动时用 `which` 探测，缺失则 `ffmpegAvailable()` 返回
 * false，抽帧工具在执行时报清晰的人话错误（其余功能不受影响）。静态版 ffmpeg
 * （johnvansickle）同样可用。本模块为纯后端：零 npm 依赖，可离线单测。
 *
 * 契约（对齐 RESEARCH §9.2）：
 * - 最多帧数上限 20（覆盖 5 分钟短视频，不超 LLM 上下文窗口）；
 * - 最大宽度 4096（含），缩放到 targetWidth，高度按比例取偶数；
 * - 帧数 = 请求数（时间均匀采样），短视频也能取到整 N 帧；
 * - 返回帧的时间戳 = i * duration / n（i 从 0 起，均匀分布）。
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_FRAMES = 20;
export const MAX_WIDTH = 4096;
export const MIN_WIDTH = 16;

/** 探测 ffmpeg / ffprobe 是否可用 */
export function ffmpegAvailable() {
  try {
    const ff = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
    const fp = spawnSync('which', ['ffprobe'], { encoding: 'utf8' });
    return ff.status === 0 && fp.status === 0;
  } catch (_) {
    return false;
  }
}

/** 用 ffprobe 读取视频元数据 */
export function probeVideo(inputPath) {
  if (!ffmpegAvailable()) throw new Error('iris: ffmpeg 不可用，无法分析视频（可选安装 ffmpeg/ffprobe 后启用）');
  if (!fs.existsSync(inputPath)) throw new Error('iris: 视频文件不存在: ' + inputPath);
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=width,height,codec_name',
    '-of', 'json',
    inputPath
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('iris: ffprobe 读取失败: ' + (r.stderr || '').slice(0, 300));
  let data;
  try { data = JSON.parse(r.stdout); } catch (_) { throw new Error('iris: ffprobe 输出解析失败'); }
  const fmt = data.format || {};
  const videoStream = (data.streams || []).find((s) => s.codec_type === 'video' || s.width);
  return {
    durationSec: Number(fmt.duration) || 0,
    sizeBytes: Number(fmt.size) || 0,
    width: videoStream ? Number(videoStream.width) || 0 : 0,
    height: videoStream ? Number(videoStream.height) || 0 : 0,
    codec: videoStream ? videoStream.codec_name || '' : ''
  };
}

/** 校验并收敛抽帧参数，返回规范化配置 */
export function normalizeFramesOptions({ maxFrames = 8, targetWidth = 640, quality = 85, format = 'jpeg' } = {}) {
  if (format !== 'jpeg' && format !== 'png') throw new Error('iris: format 只支持 jpeg 或 png');
  const n = Math.round(Number(maxFrames));
  if (!Number.isFinite(n) || n < 1) throw new Error('iris: maxFrames 必须是 ≥1 的整数');
  const clampedN = Math.min(n, MAX_FRAMES);
  const w = Math.round(Number(targetWidth));
  if (!Number.isFinite(w) || w < MIN_WIDTH) throw new Error(`iris: targetWidth 必须是 ≥${MIN_WIDTH} 的整数`);
  const clampedW = Math.min(w, MAX_WIDTH);
  const q = Math.round(Number(quality));
  if (!Number.isFinite(q) || q < 1 || q > 100) throw new Error('iris: quality 必须是 1–100 的整数');
  return { maxFrames: clampedN, targetWidth: clampedW, quality: q, format };
}

/** 目标缩放后尺寸：宽 = min(targetWidth, 源宽)，高按比例取偶数 */
export function scaledDimensions(srcWidth, srcHeight, targetWidth) {
  const outW = Math.min(targetWidth, Math.max(1, srcWidth));
  const outH = Math.max(2, Math.round((srcHeight * outW) / Math.max(1, srcWidth)) & ~1);
  return { width: outW, height: outH };
}

/** 异步跑 ffmpeg（不阻塞宿主事件循环），支持取消信号 */
function runFfmpeg(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('iris: 抽帧失败: ' + stderr.slice(0, 300)));
    });
    if (signal) {
      if (signal.aborted) { child.kill('SIGKILL'); reject(new Error('已取消')); return; }
      signal.addEventListener('abort', () => { child.kill('SIGKILL'); reject(new Error('已取消')); }, { once: true });
    }
  });
}

/**
 * 从视频抽取 N 张帧（时间均匀采样），输出 JPEG/PNG buffer 数组。
 * @param {{inputPath:string, maxFrames?:number, targetWidth?:number, quality?:number, format?:'jpeg'|'png', signal?:AbortSignal}}
 * @returns {Promise<Array<{buffer:Buffer, atSec:number, width:number, height:number}>>}
 */
export async function extractFrames({ inputPath, maxFrames = 8, targetWidth = 640, quality = 85, format = 'jpeg', signal } = {}) {
  const opts = normalizeFramesOptions({ maxFrames, targetWidth, quality, format });
  if (!ffmpegAvailable()) throw new Error('iris: ffmpeg 不可用，无法抽帧（可选安装 ffmpeg/ffprobe 后启用）');
  if (!inputPath || typeof inputPath !== 'string') throw new Error('iris: inputPath 必须是视频文件的绝对路径');
  if (!fs.existsSync(inputPath)) throw new Error('iris: 视频文件不存在: ' + inputPath);
  const meta = probeVideo(inputPath);
  const duration = meta.durationSec;
  if (!(duration > 0)) throw new Error('iris: 无法读取视频时长（文件可能不是有效视频）');
  const n = opts.maxFrames;
  const { width: outW, height: outH } = scaledDimensions(meta.width, meta.height, opts.targetWidth);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-frames-'));
  const ext = opts.format === 'png' ? '.png' : '.jpg';
  try {
    // fps 滤镜均匀抽帧：fps = n/duration（分数形式对短视频也精确产出 N 帧）
    const fps = `${n}/${duration}`;
    const outFile = path.join(outDir, 'f%d' + ext);
    const args = ['-v', 'error', '-i', inputPath, '-vf', `fps=${fps},scale='min(${opts.targetWidth},iw)':-2`];
    if (opts.format === 'png') args.push(outFile);
    else args.push('-q:v', String(opts.quality), outFile);
    await runFfmpeg(args, { signal });
    const frames = [];
    const names = fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg') || f.endsWith('.png')).sort();
    for (const name of names) {
      const idx = Number(name.replace(/^f/, '').replace(/\.(jpg|png)$/, ''));
      if (!Number.isFinite(idx) || idx < 1 || idx > n) continue; // 只取前 N 帧
      const atSec = duration > 0 ? ((idx - 1) * duration) / n : 0;
      frames.push({ buffer: fs.readFileSync(path.join(outDir, name)), atSec, width: outW, height: outH });
    }
    if (!frames.length) throw new Error('iris: 抽帧结果为空（ffmpeg 未产出任何帧）');
    return frames;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
