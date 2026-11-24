'use strict';
/**
 * Iris 媒体分析探测（阶段 7.1）—— 视频抽帧。
 *
 * ffmpeg 是可选系统可执行文件：启动时直接执行版本探测，缺失则 `ffmpegAvailable()` 返回
 * false，抽帧工具在执行时报清晰的人话错误（其余功能不受影响）。静态版 ffmpeg
 * （johnvansickle）同样可用。本模块为纯后端：零 npm 依赖，可离线单测。
 *
 * 抽帧契约：
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
    const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    const fp = spawnSync('ffprobe', ['-version'], { stdio: 'ignore', windowsHide: true });
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
    '-show_entries', 'format=duration,size:stream=width,height,codec_name,codec_type',
    '-of', 'json',
    inputPath
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('iris: ffprobe 读取失败: ' + (r.stderr || '').slice(0, 300));
  let data;
  try { data = JSON.parse(r.stdout); } catch (_) { throw new Error('iris: ffprobe 输出解析失败'); }
  const fmt = data.format || {};
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video' || s.width);
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  return {
    durationSec: Number(fmt.duration) || 0,
    sizeBytes: Number(fmt.size) || 0,
    width: videoStream ? Number(videoStream.width) || 0 : 0,
    height: videoStream ? Number(videoStream.height) || 0 : 0,
    codec: videoStream ? videoStream.codec_name || '' : '',
    hasAudio: !!audioStream,
    audioCodec: audioStream ? audioStream.codec_name || '' : ''
  };
}

/** 校验并收敛抽帧参数，返回规范化配置 */
export function normalizeFramesOptions({ maxFrames, targetWidth = 640, quality = 85, format = 'jpeg', mode = 'uniform' } = {}) {
  if (format !== 'jpeg' && format !== 'png') throw new Error('iris: format 只支持 jpeg 或 png');
  if (mode !== 'uniform' && mode !== 'last') throw new Error('iris: mode 只支持 uniform 或 last');
  const rawMax = maxFrames === undefined ? (mode === 'last' ? 1 : 8) : maxFrames;
  const n = Math.round(Number(rawMax));
  if (!Number.isFinite(n) || n < 1) throw new Error('iris: maxFrames 必须是 ≥1 的整数');
  if (mode === 'last' && n !== 1) throw new Error('iris: last 模式仅提取单张尾帧（maxFrames 必须为 1）');
  const clampedN = Math.min(n, MAX_FRAMES);
  const w = Math.round(Number(targetWidth));
  if (!Number.isFinite(w) || w < MIN_WIDTH) throw new Error(`iris: targetWidth 必须是 ≥${MIN_WIDTH} 的整数`);
  const clampedW = Math.min(w, MAX_WIDTH);
  const q = Math.round(Number(quality));
  if (!Number.isFinite(q) || q < 1 || q > 100) throw new Error('iris: quality 必须是 1–100 的整数');
  return { maxFrames: clampedN, targetWidth: clampedW, quality: q, format, mode };
}

/** 校验并收敛音视频合轨参数 */
export function normalizeMuxOptions({ audioFit = 'shortest', audioMode = 'replace', audioVolume = 1 } = {}) {
  if (!['shortest', 'loop_audio', 'pad_silence'].includes(audioFit)) {
    throw new Error('iris: audioFit 只支持 shortest、loop_audio 或 pad_silence');
  }
  if (!['replace', 'mix'].includes(audioMode)) {
    throw new Error('iris: audioMode 只支持 replace 或 mix');
  }
  const vol = Number(audioVolume);
  if (!Number.isFinite(vol) || vol < 0.1 || vol > 2) {
    throw new Error('iris: audioVolume 必须是 0.1–2.0 之间的有限数字');
  }
  return { audioFit, audioMode, audioVolume: Number(vol.toFixed(4)) };
}

/** 用 ffprobe 读取音频元数据 */
export function probeAudio(inputPath) {
  if (!ffmpegAvailable()) throw new Error('iris: ffmpeg 不可用，无法分析音频（可选安装 ffmpeg/ffprobe 后启用）');
  if (!fs.existsSync(inputPath)) throw new Error('iris: 音频文件不存在: ' + inputPath);
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_name,codec_type,sample_rate,channels',
    '-of', 'json',
    inputPath
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('iris: ffprobe 读取音频失败: ' + (r.stderr || '').slice(0, 300));
  let data;
  try { data = JSON.parse(r.stdout); } catch (_) { throw new Error('iris: ffprobe 音频输出解析失败'); }
  const fmt = data.format || {};
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  return {
    durationSec: Number(fmt.duration) || 0,
    sizeBytes: Number(fmt.size) || 0,
    hasAudio: !!audioStream,
    audioCodec: audioStream ? audioStream.codec_name || '' : '',
    sampleRate: audioStream ? Number(audioStream.sample_rate) || 0 : 0,
    channels: audioStream ? Number(audioStream.channels) || 0 : 0
  };
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
 * 从视频抽取 N 张帧（时间均匀采样或单张尾帧），输出 JPEG/PNG buffer 数组。
 * @param {{inputPath:string, maxFrames?:number, targetWidth?:number, quality?:number, format?:'jpeg'|'png', mode?:'uniform'|'last', signal?:AbortSignal}}
 * @returns {Promise<Array<{buffer:Buffer, atSec:number, width:number, height:number, sampleMode:'uniform'|'last'}>>}
 */
export async function extractFrames({ inputPath, maxFrames, targetWidth = 640, quality = 85, format = 'jpeg', mode = 'uniform', signal } = {}) {
  const opts = normalizeFramesOptions({ maxFrames, targetWidth, quality, format, mode });
  if (!ffmpegAvailable()) throw new Error('iris: ffmpeg 不可用，无法抽帧（可选安装 ffmpeg/ffprobe 后启用）');
  if (!inputPath || typeof inputPath !== 'string') throw new Error('iris: inputPath 必须是视频文件的绝对路径');
  if (!fs.existsSync(inputPath)) throw new Error('iris: 视频文件不存在: ' + inputPath);
  const meta = probeVideo(inputPath);
  const duration = meta.durationSec;
  if (!(duration > 0)) throw new Error('iris: 无法读取视频时长（文件可能不是有效视频）');
  const { width: outW, height: outH } = scaledDimensions(meta.width, meta.height, opts.targetWidth);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-frames-'));
  const ext = opts.format === 'png' ? '.png' : '.jpg';
  try {
    if (opts.mode === 'last') {
      const outFile = path.join(outDir, 'last' + ext);
      const buildLastArgs = (seekTail) => {
        const args = ['-v', 'error'];
        if (seekTail) args.push('-sseof', '-3');
        args.push('-i', inputPath, '-vf', `scale='min(${opts.targetWidth},iw)':-2`, '-fps_mode', 'passthrough', '-update', '1');
        if (opts.format !== 'png') args.push('-q:v', String(opts.quality));
        args.push('-y', outFile);
        return args;
      };
      const tryTailSeek = duration > 3.5;
      try {
        await runFfmpeg(buildLastArgs(tryTailSeek), { signal });
      } catch (err) {
        if (signal?.aborted || !tryTailSeek) throw err;
      }
      if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
        if (tryTailSeek) {
          await runFfmpeg(buildLastArgs(false), { signal });
        }
      }
      if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
        throw new Error('iris: 尾帧抽取结果为空（ffmpeg 未产出任何帧）');
      }
      return [{ buffer: fs.readFileSync(outFile), atSec: Math.max(0, Number(duration.toFixed(3))), width: outW, height: outH, sampleMode: 'last' }];
    }
    const n = opts.maxFrames;
    // fps 滤镜均匀抽帧：fps = n/duration（分数形式对短视频也精确产出 N 帧）
    const fps = `${n}/${duration}`;
    const outFile = path.join(outDir, 'f%d' + ext);
    const args = ['-v', 'error', '-i', inputPath, '-vf', `fps=${fps},scale='min(${opts.targetWidth},iw)':-2`];
    if (opts.format === 'png') args.push(outFile);
    else args.push('-q:v', String(opts.quality), outFile);
    await runFfmpeg(args, { signal });
    const frames = [];
    const names = fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    for (const name of names) {
      const idx = Number(name.replace(/^f/, '').replace(/\.(jpg|png)$/, ''));
      if (!Number.isFinite(idx) || idx < 1 || idx > n) continue; // 只取前 N 帧
      const atSec = duration > 0 ? ((idx - 1) * duration) / n : 0;
      frames.push({ buffer: fs.readFileSync(path.join(outDir, name)), atSec, width: outW, height: outH, sampleMode: 'uniform' });
    }
    if (!frames.length) throw new Error('iris: 抽帧结果为空（ffmpeg 未产出任何帧）');
    return frames;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * 本地零计费音视频合轨：将已有视频与音频合并为带 AAC 音轨的 MP4 buffer。
 * @param {{videoPath:string, audioPath:string, audioFit?:'shortest'|'loop_audio'|'pad_silence', audioMode?:'replace'|'mix', audioVolume?:number, maxOutputBytes?:number, timeoutMs?:number, signal?:AbortSignal}}
 */
export async function muxVideoAudio({
  videoPath,
  audioPath,
  audioFit = 'shortest',
  audioMode = 'replace',
  audioVolume = 1,
  maxOutputBytes = 32 * 1024 * 1024,
  timeoutMs = 60000,
  signal
} = {}) {
  const opts = normalizeMuxOptions({ audioFit, audioMode, audioVolume });
  if (!ffmpegAvailable()) throw new Error('iris: ffmpeg 不可用，无法执行音视频合轨（可选安装 ffmpeg/ffprobe 后启用）');
  if (!videoPath || typeof videoPath !== 'string' || !fs.existsSync(videoPath)) {
    throw new Error('iris: 视频文件不存在');
  }
  if (!audioPath || typeof audioPath !== 'string' || !fs.existsSync(audioPath)) {
    throw new Error('iris: 音频文件不存在');
  }
  const videoMeta = probeVideo(videoPath);
  if (!(videoMeta.durationSec > 0) || !(videoMeta.width > 0) || !(videoMeta.height > 0)) {
    throw new Error('iris: 无法读取有效视频流或时长');
  }
  const audioMeta = probeAudio(audioPath);
  if (!audioMeta.hasAudio || !(audioMeta.durationSec > 0)) {
    throw new Error('iris: 无法读取有效音频流或时长');
  }
  const effectiveAudioMode = opts.audioMode === 'mix' && videoMeta.hasAudio ? 'mix' : 'replace';
  const copyVideo = videoMeta.codec === 'h264' && path.extname(videoPath).toLowerCase() === '.mp4';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-mux-'));
  const outFile = path.join(outDir, 'muxed.mp4');
  const volFilter = opts.audioVolume === 1 ? 'anull' : `volume=${opts.audioVolume}`;
  let filterComplex;
  if (effectiveAudioMode === 'replace') {
    filterComplex = opts.audioFit === 'pad_silence'
      ? `[1:a]${volFilter},apad[aout]`
      : `[1:a]${volFilter}[aout]`;
  } else {
    const mixDuration = opts.audioFit === 'shortest' ? 'shortest' : 'first';
    filterComplex = `[1:a]${volFilter}[a1];[0:a][a1]amix=inputs=2:duration=${mixDuration}:dropout_transition=0:normalize=0[aout]`;
  }
  const args = [
    '-v', 'error',
    '-i', videoPath,
    ...(opts.audioFit === 'loop_audio' ? ['-stream_loop', '-1'] : []),
    '-i', audioPath,
    '-filter_complex', filterComplex,
    '-map', '0:v:0',
    '-map', '[aout]',
    ...(copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '22']),
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-shortest',
    '-t', String(Number((videoMeta.durationSec + 0.5).toFixed(3))),
    '-movflags', '+faststart',
    '-y', outFile
  ];
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    await runFfmpeg(args, { signal: combinedSignal });
    if (!fs.existsSync(outFile)) throw new Error('iris: 音视频合轨结果为空');
    const size = fs.statSync(outFile).size;
    if (size === 0) throw new Error('iris: 音视频合轨结果为空');
    if (size > maxOutputBytes) {
      throw Object.assign(new Error('iris: 合轨输出超过允许的大小上限'), { code: 'IRIS_COMMAND_OUTPUT_TOO_LARGE' });
    }
    const media = probeVideo(outFile);
    if (!media.hasAudio || !(media.durationSec > 0) || !(media.width > 0)) {
      throw new Error('iris: 合轨输出缺少有效视频或音频流');
    }
    return {
      buffer: fs.readFileSync(outFile),
      mediaType: 'video/mp4',
      media,
      options: { audioFit: opts.audioFit, audioMode: effectiveAudioMode, audioVolume: opts.audioVolume }
    };
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw Object.assign(new Error('iris: 音视频合轨超时'), { code: 'IRIS_COMMAND_PROCESSING_TIMEOUT' });
    }
    throw error;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * 从视频提取音轨（mp3，libmp3lame；静态 ffmpeg 已内置）。7.3 摘要的音轨转写输入。
 * @param {{inputPath:string, signal?:AbortSignal}} opts
 * @returns {Promise<{filePath:string, outDir:string, mime:string}>} 调用方负责 finally 清理 outDir
 */
export async function extractAudioTrack({ inputPath, signal } = {}) {
  if (!ffmpegAvailable()) throw new Error('iris: ffmpeg 不可用，无法提取音轨（可选安装 ffmpeg/ffprobe 后启用）');
  if (!inputPath || typeof inputPath !== 'string') throw new Error('iris: inputPath 必须是视频文件的绝对路径');
  if (!fs.existsSync(inputPath)) throw new Error('iris: 视频文件不存在: ' + inputPath);
  const meta = probeVideo(inputPath);
  if (!meta.hasAudio) throw new Error('iris: 该视频没有音轨，无需提取');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-audio-'));
  const filePath = path.join(outDir, 'track.mp3');
  try {
    await runFfmpeg([
      '-v', 'error', '-i', inputPath,
      '-vn', '-acodec', 'libmp3lame', '-q:a', '4',
      '-y', filePath
    ], { signal });
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      throw new Error('iris: 音轨提取结果为空（ffmpeg 未产出音频）');
    }
    return { filePath, outDir, mime: 'audio/mpeg' };
  } catch (err) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw err;
  }
}
