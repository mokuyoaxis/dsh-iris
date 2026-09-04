'use strict';
/**
 * dsh-iris —— Host 入口。
 * 给 DSH 装上眼睛和双手：多供应商媒体生成 + 视觉路由 + Iris 工作台。
 * M2：新增视频生成（文生/图生）；全部异步生成统一走任务盯守框架
 *     （提交即盯守、工具内等待超时自动转后台、DSH 重启后恢复接管）。
 * 架构纪律：无独立后台，与 DSH 俱荣俱损——定时器归 Fiber，产物落 $DSH_HOME。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as adapters from './adapters.js';
import * as store from './config.js';
import * as cap from './capability.js';
import * as tasks from './tasks.js';
import { registerMedia, mediaLinksOf, authorizeMedia, serveMedia } from './media.js';
import { serveApi, closeAllSse, purgeStaleUploads } from './api.js';
import { buildVisionBackends, askWithBackends } from './vision.js';
import { cropImage, pixelDiff, imageDimensions } from './pixels.js';
import { locateObject } from './locate.js';
import { serveRender, BrowserHtmlRenderer } from './render.js';
import { guarded } from './guard.js';
import { longOcr } from './ocr.js';
import { runAction, listActions } from './actions.js';
import { ffmpegAvailable, extractFrames, probeVideo, extractAudioTrack } from './media-probe.js';
import { buildContactSheet, summarizeMedia } from './summarize.js';

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

/** 工具内同步等待上限；超过即转后台盯守，用 iris_task_status 查询 */
const AWAIT_MS = { image: 180000, video: 480000 };

function outputDir() {
  const dir = tasks.outputsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------- 媒体路由：/iris/media/:taskId/:token/:name ---------------- */

let mediaRouteMounted = false;
function mountIrisRoutes(routeCtx) {
  // Cordis 铁律：服务一律走 ctx.get() 可选访问；属性直读会在未 inject 时抛错炸掉整个插件
  const reg = routeCtx && typeof routeCtx.get === 'function'
    ? (routeCtx.get('webServer') || routeCtx.get('httpServer'))
    : undefined;
  if (!reg || typeof reg.register !== 'function' || mediaRouteMounted) return;
  try {
    const disposeMedia = reg.register({
      kind: 'prefix',
      path: '/iris/media',
      handler: guarded(serveMedia)
    });
    const disposeApi = reg.register({
      kind: 'prefix',
      path: '/iris/api',
      handler: guarded((req, res) => serveApi(req, res, routeCtx))
    });
    const disposeRender = reg.register({
      kind: 'prefix',
      path: '/iris/render',
      handler: guarded(serveRender)
    });
    mediaRouteMounted = true;
    routeCtx.effect(() => () => {
      if (typeof disposeMedia === 'function') disposeMedia();
      if (typeof disposeApi === 'function') disposeApi();
      if (typeof disposeRender === 'function') disposeRender();
      closeAllSse(); // SSE 长连接随插件停用一起关闭，不留悬挂连接
      mediaRouteMounted = false;
    }, 'iris: media+api+actions+render routes');
    console.log('[iris] 媒体+工作台+操作路由已挂载：/iris/media · /iris/api · /iris/api/actions · /iris/render');
  } catch (err) {
    console.error('[iris] 路由挂载失败：', err && err.message);
  }
}

/** 盯守依赖：按能力给轮询间隔与结果转存扩展名 */
export function pollDeps(provider, cap) {
  if (cap === 'transcribe') {
    // 转写任务的结果在 transcription_text 而非 urls——重启接管必须走专用轮询器，
    // 否则 pollTask 拿到空 urls，盯守会「成功」但转写文本静默丢失。
    // （与 iris_transcribe_audio 工具内的盯守依赖保持同构。）
    return {
      key: () => provider.apiKey,
      poll: async ({ key, remoteTaskId }) => {
        const r = await adapters.pollTranscriptionTask({ key, remoteTaskId });
        return { done: r.done, ok: r.ok, urls: r.text ? [r.text] : [], message: r.message };
      },
      intervalMs: 2500,
      onSuccess: async (t, r) => {
        tasks.update(t.id, { transcribeText: (r.urls && r.urls.join('')) || '' });
        return [];
      }
    };
  }
  return {
    key: () => provider.apiKey,
    poll: ({ key, remoteTaskId }) => adapters.pollTask({ key, remoteTaskId }),
    intervalMs: cap === 'video' ? 6000 : 2500,
    onSuccess: async (t, r) => {
      fs.mkdirSync(outputDir(), { recursive: true });
      const names = [];
      for (const url of r.urls || []) {
        const name = `${t.id}-${names.length}.${adapters.extFromUrl(url, cap === 'video' ? 'mp4' : 'png')}`;
        await adapters.downloadTo(url, path.join(outputDir(), name));
        names.push(name);
      }
      // 登记媒体链接（token 授权），对话流里可点播
      for (const n of names) registerMedia(t.id, path.join(outputDir(), n));
      return names;
    }
  };
}

/**
 * 在工具调用内同步等待任务到终态。
 * @returns 终态任务记录；null = 等待超时（任务已转后台继续盯守）
 * @throws 取消时抛错并标记 canceled
 */
async function awaitTerminal(taskId, { timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal && signal.aborted) {
      tasks.cancel(taskId, '用户取消');
      throw new Error('已取消');
    }
    const t = tasks.get(taskId);
    if (t && t.status !== 'running') return t;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/* ---------------- 图片 data URL（视觉工具共用） ---------------- */

function toDataUrl(absPath, mediaType) {
  const buf = fs.readFileSync(absPath);
  return `data:${mediaType};base64,${buf.toString('base64')}`;
}

function fmtTask(t) {
  const lines = [`[${t.cap}] ${t.id} · ${t.status}${t.progress ? ' · ' + t.progress : ''} · ${t.model}`];
  lines.push('prompt: ' + String(t.prompt || '').slice(0, 120));
  if (t.error) lines.push('error: ' + t.error);
  if ((t.files || []).length) lines.push('files:\n' + t.files.map((f) => path.join(tasks.outputsDir(), f)).join('\n'));
  const links = mediaLinksOf(t);
  if (links.length) lines.push('links:\n' + links.join('\n'));
  if (t.remoteTaskId) lines.push('remoteTask: ' + t.remoteTaskId);
  return lines.join('\n');
}

export const name = 'dsh-iris';
export const inject = ['tools'];

/**
 * 隔离单点失败：任何非核心环节（导入/恢复/路由/单个工具注册）抛错
 * 都只记日志，绝不让插件条目 reject —— 历史教训：iris 一次直读未 inject
 * 的服务就把整个宿主炸掉（见 dsh-web.log 的 boot 崩溃）。这里一律不许再犯。
 */
function guard(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`[iris] ${label} 失败（已隔离，不影响宿主）:`, err && err.message || err);
    return undefined;
  }
}

/** 单工具注册隔离：注册失败的收益是诊断日志，而不是宿主陪葬 */
function safeRegister(ctx, definition) {
  guard(`工具注册 ${definition && definition.name}`, () => {
    ctx.effect(() => ctx.tools.register(definition));
  });
}

export async function apply(ctx) {

  guard('上传临时文件清理', () => purgeStaleUploads());

  // 首次运行：从工作台导入（幂等）
  guard('工作台导入', () => {
    const wb = path.join(process.env.HOME || os.homedir(), 'projects', 'ai-paint', 'data', 'config.json');
    const imported = store.importFromWorkbench(wb);
    if (imported.imported) console.log(`[iris] 已从工作台导入 ${imported.imported} 个服务商`);
  });

  // 接管上次进程未跑完的异步任务（恢复循环本身在 tasks.js 里逐任务防御）
  guard('恢复后台任务', () => {
    const resumed = tasks.resumePending((t) => {
      const p = store.providerById(t.providerId);
      return p ? pollDeps(p, t.cap) : null;
    });
    if (resumed.length) console.log(`[iris] 已恢复接管 ${resumed.length} 个后台任务`);
  });

  // Fiber 清理：插件停用/更新时停掉全部盯守句柄
  guard('盯守句柄注册', () => {
    ctx.effect(() => () => tasks.stopWatchAll());
  });

  // 媒体路由（视频/音频在对话流里的可播通路；图片仍走原生附件）
  ctx.inject(['webServer'], mountIrisRoutes);
  ctx.inject(['httpServer'], mountIrisRoutes);
  // 若 webServer 已在运行，inject 回调也会触发；这里兜底立即挂载一次
  guard('媒体路由兜底挂载', () => mountIrisRoutes(ctx));

  const tools = ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    console.error('[iris] tools 服务不可用，跳过全部工具注册（宿主不受影响）');
    return;
  }

  /* ---------- 🖼️ 画图 ---------- */
  safeRegister(ctx, {
    name: 'iris_draw_image',
    description:
      'Generate an image from a detailed prompt using the user-configured image model (DashScope wan* or OpenAI-images-compatible). ' +
      'Returns a durable DSH attachment rendered in the conversation plus a vision-model description so you know what was drawn.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed visual description of the image to create' },
        size: { type: 'string', description: "Output size; DashScope uses 'W*H' (e.g. '1024*1024'), OpenAI uses 'WxH'. Default provider default." },
        n: { type: 'string', description: "Number of images, default '1'" },
        model: { type: 'string', description: 'Override with a providerId::modelId reference (legacy bare model id also accepted)' }
      },
      required: ['prompt']
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => value.blocks
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) throw new Error('iris: prompt 不能为空');
      const submitted = await runAction(ctx, 'image', args, { signal: exec.signal });
      let final = tasks.get(submitted.taskId);
      if (final && final.status === 'running') {
        final = await awaitTerminal(submitted.taskId, { timeoutMs: AWAIT_MS.image, signal: exec.signal });
      }
      if (!final) {
        return { blocks: [{ type: 'text', text: `[iris] 图像任务仍在后台盯守（task: ${submitted.taskId}）。稍后可用 iris_task_status 查询进度与文件路径。` }] };
      }
      if (final.status === 'canceled') throw new Error('已取消');
      if (final.status !== 'succeeded') throw new Error('生成失败：' + (final.error || '未知原因'));

      const files = (final.files || []).map((f) => path.join(outputDir(), f));
      const blocks = [];
      const refs = [];
      for (const f of files) {
        const mediaType = MEDIA_TYPES[path.extname(f).toLowerCase()] || 'image/png';
        const ref = await attachmentService(ctx).saveImage({ data: new Uint8Array(fs.readFileSync(f)), mediaType, name: path.basename(f) });
        refs.push(ref);
        blocks.push({ type: 'image', attachment: ref });
      }
      tasks.update(final.id, {
        attachments: refs.map((r, i) => ({
          attachmentId: r.attachmentId,
          file: path.basename(files[i]),
          mediaType: MEDIA_TYPES[path.extname(files[i]).toLowerCase()] || 'image/png'
        }))
      });

      let note = '';
      try {
        const described = await describeFirstImage(ctx, refs[0], files[0], prompt);
        if (described) note = `画面内容：${described}`;
      } catch (_) { /* 增强失败不影响生成结果 */ }
      blocks.unshift({
        type: 'text',
        text: `[iris] 图像已生成（${submitted.model || final.model}，task: ${final.id}）。` +
          (note ? `\n${note}` : '') +
          `\nattachment: ${refs.map((r) => r.attachmentId).join(', ')}`
      });
      return { blocks };
    }
  });

  /* ---------- 🎬 视频生成 ---------- */
  safeRegister(ctx, {
    name: 'iris_generate_video',
    description:
      'Generate a video with the configured DashScope video model. Three modes: ' +
      '(1) text-to-video from a prompt (wan* t2v); ' +
      '(2) image-to-video with a first frame — an attachment id returned by iris_draw_image or an absolute local path; ' +
      '(3) s2v digital-human talking video (model wan2.2-s2v): first frame + audio_path (wav/mp3, <20s), local files are auto-uploaded to Bailian temp storage. ' +
      'Submission returns fast; the render is watched in the background — if it exceeds the inline wait you get a task id for iris_task_status.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the motion/scene for the video' },
        first_frame_attachment_id: { type: 'string', description: 'Attachment id of an image generated by iris_draw_image, used as the first frame' },
        first_frame_path: { type: 'string', description: 'Absolute path to a local image used as the first frame (alternative to attachment id)' },
        audio_path: { type: 'string', description: 'Absolute path to a wav/mp3 file (<15MB, <20s, clear human voice). Required for s2v models like wan2.2-s2v' },
        resolution: { type: 'string', description: "s2v only: output tier '480P' (default) or '720P'" },
        size: { type: 'string', description: "t2v/i2v only: output size 'W*H', e.g. '1280*720' (default)" },
        duration: { type: 'number', description: 't2v/i2v only: duration in seconds, if the model supports it' },
        model: { type: 'string', description: 'Override with a providerId::modelId reference (legacy bare model id accepted)' }
      },
      required: ['prompt']
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const submitted = await runAction(ctx, 'video', args, { signal: exec.signal });
      const final = await awaitTerminal(submitted.taskId, { timeoutMs: AWAIT_MS.video, signal: exec.signal });
      if (!final) {
        return `[iris] 视频任务已提交并转入后台盯守（task: ${submitted.taskId}，remoteTask: ${submitted.remoteTaskId}）。\n` +
          '渲染通常需要数分钟；完成后用 iris_task_status 查询产物路径。';
      }
      if (final.status === 'canceled') throw new Error('已取消');
      if (final.status !== 'succeeded') throw new Error('视频生成失败：' + (final.error || '未知原因'));
      const paths = (final.files || []).map((f) => path.join(outputDir(), f));
      const links = mediaLinksOf(final);
      const secs = Math.round((Date.now() - new Date(final.createdAt).getTime()) / 1000);
      return `[iris] 视频已生成（${submitted.model || final.model}，${final.mode || 't2v'}，约 ${secs}s）：\n` +
        paths.join('\n') +
        (links.length ? `\n\n${links.join('\n')}\n（点击即在本机浏览器播放）` : '') +
        `\ntask: ${final.id}`;
    }
  });

  /* ---------- 🔊 语音合成 ---------- */
  safeRegister(ctx, {
    name: 'iris_speak_text',
    description: 'Synthesize speech audio from text using the configured TTS model (qwen-tts / compatible). Returns the saved audio file path.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak' },
        voice: { type: 'string', description: "Voice name, e.g. 'Cherry' (DashScope qwen-tts voices)" },
        model: { type: 'string', description: 'Override with a providerId::modelId reference (legacy bare model id accepted)' }
      },
      required: ['text']
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const submitted = await runAction(ctx, 'tts', args, { signal: exec.signal });
      const final = tasks.get(submitted.taskId);
      if (!final || final.status !== 'succeeded') throw new Error('语音合成失败：' + ((final && final.error) || '未知原因'));
      const fileName = (final.files || [])[0];
      const p = path.join(outputDir(), fileName);
      const media = (final.media || [])[0];
      return `[iris] 语音已合成（${submitted.model || final.model}）：${p}\ntask: ${final.id}` +
        (media ? `\n[♪ 音频播放](${mediaLinksOf(final)[0]})` : '');
    }
  });

  /* ---------- 🎙️ 音频转写（阶段 7.2） ---------- */
  safeRegister(ctx, {
    name: 'iris_transcribe_audio',
    description: 'Transcribe an audio file (wav/mp3) to text using the configured DashScope provider (qwen-audio-3.0-asr-flash-filetrans). The audio is uploaded to Bailian temp storage, then an async task is submitted. Returns the full recognized text.',
    parameters: {
      type: 'object',
      properties: {
        audio_path: { type: 'string', description: 'Absolute path to the audio file (wav/mp3)' },
        model: { type: 'string', description: 'Override with a providerId::modelId transcription reference (legacy bare model id accepted)' }
      },
      required: ['audio_path']
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const submitted = await runAction(ctx, 'transcribe', args, { signal: exec.signal });
      const final = await awaitTerminal(submitted.taskId, { timeoutMs: 120000, signal: exec.signal });
      if (!final) return `[iris] 音频转写任务已提交并转入后台（task: ${submitted.taskId}）。完成后用 iris_task_status 查询。`;
      if (final.status === 'canceled') throw new Error('已取消');
      if (final.status !== 'succeeded') throw new Error('转写失败：' + (final.error || '未知原因'));
      return `[iris] 音频转写完成（${submitted.model || final.model}）：\n${final.transcribeText || ''}`;
    }
  });

  /* ---------- 🎞️ 视频抽帧（阶段 7.1，ffmpeg 可选） ---------- */
  safeRegister(ctx, {
    name: 'iris_video_frames',
    description:
      'Extract N frames (uniformly sampled across the video) from a local video file using the system ffmpeg. ' +
      'Frames are scaled to a target width, saved as durable DSH attachments (jpeg/png), and returned as image blocks ' +
      'so you can inspect the video content. Requires ffmpeg + ffprobe on PATH (optional system dependency; other iris tools are unaffected).',
    parameters: {
      type: 'object',
      properties: {
        video_path: { type: 'string', description: 'Absolute path to the local video file (mp4/webm/mov etc.)' },
        max_frames: { type: 'integer', description: 'Max frames to extract, clamped to 1..20 (default 8)' },
        target_width: { type: 'integer', description: 'Scale frames to this width, keeping aspect ratio (default 640, max 4096)' },
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'Output frame format (default jpeg)' },
        quality: { type: 'integer', description: 'JPEG quality 1-100 (default 85)' }
      },
      required: ['video_path']
    },
    output: { schema: { type: 'object' }, render: (_args, value) => value.blocks },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      const p = String(args.video_path || '').trim();
      if (!p || !path.isAbsolute(p)) throw new Error('iris: video_path 必须是绝对路径');
      if (!ffmpegAvailable()) throw new Error('iris: ffmpeg 不可用，无法抽帧（可选安装 ffmpeg/ffprobe 后启用；不影响其他 iris 工具）');
      const meta = probeVideo(p);
      const frames = await extractFrames({
        inputPath: p,
        maxFrames: args.max_frames,
        targetWidth: args.target_width,
        format: args.format,
        quality: args.quality,
        signal: exec.signal
      });
      const mediaType = args.format === 'png' ? 'image/png' : 'image/jpeg';
      const ext = args.format === 'png' ? 'png' : 'jpg';
      const blocks = [];
      const refs = [];
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const ref = await attachmentService(ctx).saveImage({
          data: new Uint8Array(f.buffer),
          mediaType,
          name: `iris-frame-${Date.now()}-${i + 1}.${ext}`
        });
        refs.push(ref);
        blocks.push({ type: 'image', attachment: ref });
      }
      const ats = frames.map((f) => f.atSec.toFixed(1) + 's').join(', ');
      blocks.unshift({
        type: 'text',
        text:
          `[iris] 视频抽帧完成：${frames.length} 帧（${meta.durationSec.toFixed(1)}s 视频，` +
          `${frames[0].width}x${frames[0].height}，${mediaType === 'image/png' ? 'PNG' : 'JPEG'}）。\n` +
          `时间戳：${ats}\n` +
          `attachments: ${refs.map((r) => r.attachmentId).join(', ')}`
      });
      return { blocks };
    }
  });

  /* ---------- 📝 多模态视频摘要（阶段 7.3，ffmpeg 可选） ---------- */
  safeRegister(ctx, {
    name: 'iris_media_summarize',
    description:
      'Summarize a local video by compressing it into a contact sheet of sampled frames (with timestamps) plus an optional ' +
      'auto-transcribed audio track, then asking the vision model to describe content. Returns the summary text plus the contact sheet as a DSH image attachment. ' +
      'Requires ffmpeg + ffprobe on PATH. Transcription reuses the configured provider (qwen-audio-3.0-asr-flash-filetrans) when the video has an audio track.',
    parameters: {
      type: 'object',
      properties: {
        video_path: { type: 'string', description: 'Absolute path to the local video file (mp4/webm/mov etc.)' },
        question: { type: 'string', description: 'Custom question about the video content (default: summarize scenes/theme)' },
        max_frames: { type: 'integer', description: 'Frames to sample for the contact sheet, clamped to 1..12 (default 8)' },
        target_width: { type: 'integer', description: 'Frame width for sampling (default 640)' },
        transcribe: { type: 'boolean', description: 'Auto-transcribe the audio track if present (default true)' },
        model: { type: 'string', description: 'Override the configured vision model id' }
      },
      required: ['video_path']
    },
    output: { schema: { type: 'object' }, render: (_args, value) => value.blocks },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      const p = String(args.video_path || '').trim();
      if (!p || !path.isAbsolute(p)) throw new Error('iris: video_path 必须是绝对路径');
      if (!ffmpegAvailable()) throw new Error('iris: ffmpeg 不可用，无法分析视频（可选安装 ffmpeg/ffprobe 后启用）');
      const meta = probeVideo(p);
      const frames = await extractFrames({
        inputPath: p,
        maxFrames: Math.min(Number(args.max_frames) || 8, 12),
        targetWidth: args.target_width,
        format: 'jpeg',
        quality: 70,
        signal: exec.signal
      });

      // 音轨转写（可选；与独立 transcribe capability 共用同一动作与 failover）
      let transcript = '';
      let transcriptNote = '';
      const wantTranscribe = args.transcribe !== false && meta.hasAudio;
      if (wantTranscribe) {
        if (store.pickAllFor(cap.CAPABILITIES.TRANSCRIBE).length) {
          try {
            const audio = await extractAudioTrack({ inputPath: p, signal: exec.signal });
            try {
              const submitted = await runAction(ctx, 'transcribe', { audio_path: audio.filePath }, { signal: exec.signal });
              const final = await awaitTerminal(submitted.taskId, { timeoutMs: 120000, signal: exec.signal });
              if (final && final.status === 'succeeded') transcript = final.transcribeText || '';
              else if (!final) transcriptNote = `\n（音轨转写仍在后台：task ${submitted.taskId}，本次摘要未含语音内容）`;
            } finally {
              fs.rmSync(audio.outDir, { recursive: true, force: true });
            }
          } catch (err) {
            transcriptNote = '\n（音轨转写失败，本次摘要仅画面：' + String(err.message || err).slice(0, 160) + '）';
          }
        } else {
          transcriptNote = '\n（视频含音轨但未配置转写供应商，本次摘要仅画面）';
        }
      }

      // contact sheet → attachment → 视觉摘要
      const sheet = await buildContactSheet({ frames, cols: 3 });
      const ref = await attachmentService(ctx).saveImage({
        data: new Uint8Array(sheet.buffer),
        mediaType: 'image/png',
        name: `iris-sheet-${Date.now()}.png`
      });
      const visionProviders = store.pickAllFor(cap.CAPABILITIES.VISION);
      const backends = buildVisionBackends(ctx, { providers: visionProviders, model: args.model });
      const { answer, via, model } = await summarizeMedia({
        backends, question: args.question, transcript,
        imageDataUrl: `data:image/png;base64,${sheet.buffer.toString('base64')}`,
        ref, signal: exec.signal
      });
      const viaLabel = via === 'selfstack' ? 'iris 自持栈' : 'DSH 全局视觉模型';
      return {
        blocks: [
          {
            type: 'text',
            text:
              `[iris] 视频摘要完成（${model} · ${viaLabel}，${meta.durationSec.toFixed(1)}s / ${frames.length} 帧联系表）：\n` +
              `${answer}${transcriptNote || ''}\n` +
              `contact sheet attachment: ${ref.attachmentId}`
          },
          { type: 'image', attachment: ref }
        ]
      };
    }
  });

  /* ---------- 👁 视觉路由（M3）：显式工具，自持栈为主 ---------- */

  safeRegister(ctx, {
    name: 'iris_look_at_image',
    description:
      'Look at a local image file and answer one question about it with the configured vision model (qwen-vl via the self-hosted provider stack; falls back to the global DSH vision model). The image is saved as a durable attachment so follow-ups can reference it.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Absolute path to the image file (png/jpg/jpeg/webp)' },
        question: { type: 'string', description: 'Question or extraction request about the image; defaults to a detailed description' },
        model: { type: 'string', description: 'Override the configured vision model id (default qwen-vl-plus)' }
      },
      required: ['image_path']
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const p = String(args.image_path || '').trim();
      if (!path.isAbsolute(p)) throw new Error('iris: image_path 必须是绝对路径');
      const mt = MEDIA_TYPES[path.extname(p).toLowerCase()];
      if (!mt || mt === 'image/gif') throw new Error('iris: 不支持的图片格式（png/jpg/jpeg/webp）：' + p);
      if (!fs.existsSync(p)) throw new Error('iris: 图片不存在：' + p);
      const question = String(args.question || '').trim() || '详细描述这张图片。';
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');

      const dataUrl = toDataUrl(p, mt);
      const ref = await attachmentService(ctx).saveImage({ data: new Uint8Array(fs.readFileSync(p)), mediaType: mt, name: path.basename(p) });
      return runVisionTool(ctx, exec, { origin: 'tool', model: args.model, question, ref, dataUrl });
    }
  });

  safeRegister(ctx, {
    name: 'iris_relook_attachment',
    description:
      'Ask a NEW question about an image that was already seen in this session: pass its attachment_id (from user uploads, tool results, or any iris-generated image). Pixels are re-read via the vision model.',
    parameters: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string', description: 'The attachment_id of an image that appeared in this session or was generated by iris' },
        question: { type: 'string', description: 'New question about the image pixels' },
        model: { type: 'string', description: 'Override the configured vision model id' }
      },
      required: ['attachment_id', 'question']
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = String(args.attachment_id || '').trim();
      if (!id) throw new Error('iris: attachment_id 不能为空');
      const question = String(args.question || '').trim();
      if (!question) throw new Error('iris: question 不能为空');
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');

      // 定位：本会话出现过的图片优先，其次本插件产物记录
      const hit = (await sessionAttachmentRef(ctx, exec, id)) || findOwnAttachment(id);
      if (!hit) throw new Error('iris: 该 attachment 不在本会话中、也不是 iris 生成的图片：' + id);

      let dataUrl;
      if (hit.absPath) {
        dataUrl = toDataUrl(hit.absPath, hit.ref.mediaType || MEDIA_TYPES[path.extname(hit.absPath).toLowerCase()] || 'image/png');
      } else {
        const stored = await attachmentService(ctx).readImage(hit.ref, exec.signal);
        dataUrl = `data:${stored.mediaType || hit.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`;
      }
      return runVisionTool(ctx, exec, { origin: 'relook', model: args.model, question, ref: hit.ref, dataUrl });
    }
  });

  /* ---------- 📋 任务查询 ---------- */
  safeRegister(ctx, {
    name: 'iris_task_status',
    description:
      'Query iris generation tasks (image/video/tts). Pass a task_id for one task, or omit it to list the latest tasks with status, progress, errors and output file paths.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id, e.g. from a background-handoff notice; omit to list recent tasks' }
      },
      required: []
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.task_id) {
        const t = tasks.get(String(args.task_id).trim());
        if (!t) throw new Error('iris: 没有这个任务：' + args.task_id);
        return fmtTask(t);
      }
      const recent = tasks.list().slice(0, 5);
      if (!recent.length) return '[iris] 还没有生成任务记录。';
      return recent.map(fmtTask).join('\n---\n');
    }
  });

  /* ---------- ✂️ 确定性像素工具（阶段 2） ---------- */
  safeRegister(ctx, {
    name: 'iris_crop',
    description:
      'Crop a rectangular region from an image (absolute local path or a session attachment_id) and save the result as a durable DSH attachment. ' +
      'Returns the new attachment id and the cropped dimensions.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Absolute path to the source image (png/jpg/jpeg/webp)' },
        attachment_id: { type: 'string', description: 'Attachment id of an image seen in this session or generated by iris (alternative to image_path)' },
        left: { type: 'integer', description: 'Left edge x, 0-based, in pixels' },
        top: { type: 'integer', description: 'Top edge y, 0-based, in pixels' },
        width: { type: 'integer', description: 'Crop width in pixels (must be positive)' },
        height: { type: 'integer', description: 'Crop height in pixels (must be positive)' }
      },
      required: ['left', 'top', 'width', 'height']
    },
    output: { schema: { type: 'object' }, render: (_args, value) => value.blocks },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      const input = await resolveImageInput(ctx, exec, {
        image_path: args.image_path,
        attachment_id: args.attachment_id
      });
      const { buffer, width, height, mime } = await cropImage({
        input: input.buffer,
        left: args.left,
        top: args.top,
        width: args.width,
        height: args.height
      });
      const ref = await attachmentService(ctx).saveImage({
        data: new Uint8Array(buffer),
        mediaType: mime,
        name: `iris-crop-${Date.now()}.png`
      });
      return {
        blocks: [
          { type: 'text', text: `[iris] 裁剪完成：${width}x${height}（原区域 ${args.left},${args.top},${args.width},${args.height}）\nattachment: ${ref.attachmentId}` },
          { type: 'image', attachment: ref }
        ]
      };
    }
  });

  safeRegister(ctx, {
    name: 'iris_pixel_diff',
    description:
      'Compute a pixel-level difference between two images (absolute local paths or session attachment_ids). ' +
      'Images of different sizes are normalized to the smaller one. ' +
      'Returns the diff ratio (0-1), the worst regions on an 8x8 grid, and saves a heatmap PNG as a durable DSH attachment.',
    parameters: {
      type: 'object',
      properties: {
        image_a_path: { type: 'string', description: 'Absolute path to the first image' },
        image_b_path: { type: 'string', description: 'Absolute path to the second image' },
        attachment_a_id: { type: 'string', description: 'Session attachment id of the first image (alternative to image_a_path)' },
        attachment_b_id: { type: 'string', description: 'Session attachment id of the second image (alternative to image_b_path)' },
        grid: { type: 'integer', description: 'Grid size for worst-region analysis, default 8' },
        top_regions: { type: 'integer', description: 'How many worst regions to report, default 3' }
      },
      required: []
    },
    output: { schema: { type: 'object' }, render: (_args, value) => value.blocks },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      if (!(args.image_a_path || args.attachment_a_id)) throw new Error('iris: 需要 image_a_path 或 attachment_a_id');
      if (!(args.image_b_path || args.attachment_b_id)) throw new Error('iris: 需要 image_b_path 或 attachment_b_id');
      const a = await resolveImageInput(ctx, exec, { image_path: args.image_a_path, attachment_id: args.attachment_a_id });
      const b = await resolveImageInput(ctx, exec, { image_path: args.image_b_path, attachment_id: args.attachment_b_id });
      const { ratio, diffPixels, totalPixels, width, height, worstRegions, heatmap, mime } = await pixelDiff({
        inputA: a.buffer,
        inputB: b.buffer,
        grid: args.grid || 8,
        topRegions: args.top_regions || 3
      });
      const ref = await attachmentService(ctx).saveImage({
        data: new Uint8Array(heatmap),
        mediaType: mime,
        name: `iris-diff-${Date.now()}.png`
      });
      const pct = (ratio * 100).toFixed(2);
      const regions = worstRegions.map((r) => `(col ${r.col},row ${r.row}) ${(r.score * 100).toFixed(1)}%`).join(' ');
      return {
        blocks: [
          {
            type: 'text',
            text: `[iris] 像素差异 ${pct}%（${diffPixels}/${totalPixels}px，归一化 ${width}x${height}）\n` +
              `最差区域（${worstRegions.length} 格）: ${regions}\n` +
              `热力图 attachment: ${ref.attachmentId}`
          },
          { type: 'image', attachment: ref }
        ]
      };
    }
  });

  /* ---------- 📍 模型驱动定位（阶段 3A） ---------- */
  safeRegister(ctx, {
    name: 'iris_locate',
    description:
      'Locate an object/region described by `target` in an image (absolute path or session attachment_id), ' +
      'returning the pixel bounding box (x1,y1,x2,y2) in original image coordinates. ' +
      'Use the returned bbox with iris_crop to extract the region.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Absolute path to the source image (png/jpg/jpeg/webp)' },
        attachment_id: { type: 'string', description: 'Session attachment id of an image (alternative to image_path)' },
        target: { type: 'string', description: 'The object or UI element to locate, e.g. "send button"' },
        model: { type: 'string', description: 'Override the vision model for this locate call (e.g. qwen3-vl-235b-a22b-thinking for higher grounding precision; default is the provider visionModel, typically qwen-vl-plus)' }
      },
      required: ['target']
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      const input = await resolveImageInput(ctx, exec, {
        image_path: args.image_path,
        attachment_id: args.attachment_id
      });
      const { width, height } = await imageDimensions(input.buffer);
      const dataUrl = `data:${input.mediaType};base64,${input.buffer.toString('base64')}`;
      const visionProviders = store.pickAllFor(cap.CAPABILITIES.VISION);
      const backends = buildVisionBackends(ctx, { providers: visionProviders, model: args.model });
      const r = await locateObject(backends, {
        target: args.target,
        imageDataUrl: dataUrl,
        width,
        height,
        signal: exec.signal
      });
      if (!r.found) return `[iris] 在图片中未找到「${args.target}」（${r.via} · ${r.model}）`;
      return `[iris] 定位「${args.target}」：bbox (${r.x1},${r.y1},${r.x2},${r.y2}) / ${width}x${height}（${r.via} · ${r.model}）\n` +
        `裁剪指令：iris_crop(image_path="${args.image_path || args.attachment_id}", left=${r.x1}, top=${r.y1}, width=${r.x2 - r.x1}, height=${r.y2 - r.y1})`;
    }
  });

  /* ---------- 🖼️ HTML 截图（阶段 3C，基于 dsh-builtin-browser） ---------- */
  safeRegister(ctx, {
    name: 'iris_html_screenshot',
    description:
      'Render an HTML string to a page screenshot using the shared browser. ' +
      'Creates a temporary HTML file, opens it in the browser via the host web server, ' +
      'captures a full-page screenshot, saves the PNG as a durable DSH attachment, ' +
      'and cleans up the temporary files. ' +
      'Requires the dsh-builtin-browser plugin to be enabled.',
    parameters: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Raw HTML content to render' },
        width: { type: 'integer', description: 'Minimum container width in pixels (optional, advisory — no viewport control)' },
        height: { type: 'integer', description: 'Minimum container height in pixels (optional, advisory)' },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport. Default true.' }
      },
      required: ['html']
    },
    output: { schema: { type: 'object' }, render: (_args, value) => value.blocks },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      const browser = ctx.get('browser');
      if (!browser) {
        throw new Error('iris: 浏览器服务不可用（ctx.get("browser") 为空）——需要启用 dsh-builtin-browser 插件');
      }
      const renderer = new BrowserHtmlRenderer({ browser });
      const { png } = await renderer.render({
        html: args.html,
        width: args.width,
        height: args.height,
        fullPage: args.fullPage !== false
      });
      const { width: outW, height: outH } = await imageDimensions(png);
      const ref = await attachmentService(ctx).saveImage({
        data: new Uint8Array(png),
        mediaType: 'image/png',
        name: `iris-html-${Date.now()}.png`
      });
      return {
        blocks: [
          {
            type: 'text',
            text: `[iris] HTML 截图完成（${outW}x${outH}，fullPage: ${args.fullPage !== false}）\n` +
              `attachment: ${ref.attachmentId}` +
              `\n注意：渲染在共享浏览器临时标签页中完成，页面短暂可见属正常行为。`
          },
          { type: 'image', attachment: ref }
        ]
      };
    }
  });

  /* ---------- 📄 长截图 OCR（阶段 3B，视觉模型分块） ---------- */
  safeRegister(ctx, {
    name: 'iris_long_ocr',
    description:
      'OCR a (possibly long) image: slice it into chunks (1200px tall with 120px overlap by default) ' +
      'and read the text chunk by chunk with the vision model, then join the results in top-to-bottom order. ' +
      'Returns the full recognized text plus per-chunk details. Good for long screenshots / documents.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Absolute path to the image (png/jpg/jpeg/webp)' },
        attachment_id: { type: 'string', description: 'Session attachment id of the image (alternative to image_path)' },
        chunk_height: { type: 'integer', description: 'Chunk height in pixels, default 1200' },
        overlap: { type: 'integer', description: 'Overlap between chunks in pixels to avoid cutting text lines, default 120' }
      },
      required: []
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      const input = await resolveImageInput(ctx, exec, {
        image_path: args.image_path,
        attachment_id: args.attachment_id
      });
      const visionProviders = store.pickAllFor(cap.CAPABILITIES.VISION);
      const backends = buildVisionBackends(ctx, { providers: visionProviders });
      const result = await longOcr({
        input: input.buffer,
        backends,
        chunkHeight: args.chunk_height || 1200,
        overlap: args.overlap || 120,
        signal: exec.signal
      });
      const errCount = result.chunks.filter((c) => c.error).length;
      const head = `[iris] 长截图 OCR 完成：${result.width}x${result.height}px，${result.totalChunks} 块${errCount ? '（' + errCount + ' 块失败）' : ''}\n`;
      if (!result.fullText) return head + '（未识别到文字）';
      return head + result.fullText;
    }
  });

  console.log('[iris] tools registered: iris_draw_image, iris_generate_video, iris_speak_text, iris_transcribe_audio, iris_task_status, iris_look_at_image, iris_relook_attachment, iris_crop, iris_pixel_diff, iris_locate, iris_html_screenshot, iris_long_ocr, iris_video_frames, iris_media_summarize');
};

/* ---------------- 视觉路由（M3 补全）：look/relook 共用执行器 + 降级链 ---------------- */

/** 附件服务必须走 ctx.get()（不在 inject 里，直接属性访问会炸掉插件） */
function attachmentService(ctx) {
  const s = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
  if (!s || typeof s.saveImage !== 'function' || typeof s.readImage !== 'function') {
    throw new Error('iris: 附件服务不可用（ctx.get("attachments") 为空）');
  }
  return s;
}

/**
 * 把「本地绝对路径 或 本会话 attachment_id」解析为图片 buffer。
 * crop / pixel_diff 共用（阶段 2）。
 * @returns {Promise<{buffer:Buffer, mediaType:string, name:string}>}
 */
async function resolveImageInput(ctx, exec, { image_path, attachment_id }) {
  if (image_path) {
    const p = String(image_path).trim();
    if (!path.isAbsolute(p)) throw new Error('iris: image_path 必须是绝对路径');
    const mt = MEDIA_TYPES[path.extname(p).toLowerCase()];
    if (!mt || mt === 'image/gif') throw new Error('iris: 不支持的图片格式（png/jpg/jpeg/webp）：' + p);
    if (!fs.existsSync(p)) throw new Error('iris: 图片不存在：' + p);
    return { buffer: fs.readFileSync(p), mediaType: mt, name: path.basename(p) };
  }
  if (attachment_id) {
    const id = String(attachment_id).trim();
    const hit = (await sessionAttachmentRef(ctx, exec, id)) || findOwnAttachment(id);
    if (!hit) throw new Error('iris: 该 attachment 不在本会话中、也不是 iris 生成的图片：' + id);
    if (hit.absPath) {
      return {
        buffer: fs.readFileSync(hit.absPath),
        mediaType: hit.ref.mediaType || MEDIA_TYPES[path.extname(hit.absPath).toLowerCase()] || 'image/png',
        name: path.basename(hit.absPath)
      };
    }
    const stored = await attachmentService(ctx).readImage(hit.ref, exec && exec.signal);
    return {
      buffer: Buffer.from(stored.data),
      mediaType: stored.mediaType || hit.ref.mediaType || 'image/png',
      name: hit.ref.name || 'image.png'
    };
  }
  throw new Error('iris: 需要 image_path 或 attachment_id');
}

/** 在本插件的任务产物里按 attachmentId 找 iris 自生成的图片（relook 的兜底） */
export function findOwnAttachment(attachmentId) {
  for (const t of tasks.all()) {
    for (const a of t.attachments || []) {
      if (a.attachmentId === attachmentId) {
        const absPath = path.join(outputDir(), a.file);
        if (fs.existsSync(absPath)) {
          return { ref: { attachmentId: a.attachmentId, mediaType: a.mediaType }, absPath };
        }
        return null; // 本地缓存已被清理策略删除，需重新生成
      }
    }
  }
  return null;
}

/**
 * 防御式扫描当前会话的完整事件日志，找「本会话出现过的图片」附件引用
 * （用户上传、其他工具产物、iris 生成的图都会出现在会话事件里）。
 * 不依赖精确事件类型：递归扫任何载荷中的 attachment 块 / attachmentId 字段。
 * @returns {Promise<{ref:object}|null>} 找到则带可直接 readImage 的 ref
 */
export async function sessionAttachmentRef(ctx, exec, attachmentId) {
  const agent = exec && exec.agent;
  const session = agent && agent.session;
  const sq = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
  if (!sq || !session || typeof sq.readSession !== 'function') return null;
  let events;
  try {
    events = (await sq.readSession(session.id)).events;
  } catch (_) {
    return null; // 读不到会话记录 → 交给 findOwnAttachment 兜底
  }
  if (!Array.isArray(events)) return null;
  const wanted = String(attachmentId || '');
  if (!wanted) return null;
  const ref = findAttachmentRefIn(events, wanted);
  return ref ? { ref } : null;
}

/** 递归扫描对象/数组，返回第一个匹配 wanted 的图片附件引用（防循环、限扫描量） */
function findAttachmentRefIn(nodes, wanted) {
  const seen = new Set();
  const stack = Array.isArray(nodes) ? [...nodes] : [nodes];
  let scanned = 0;
  while (stack.length && scanned < 4000) {
    const node = stack.pop();
    scanned++;
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    // 形态 1：附件块 { type:'image', attachment:{ attachmentId,... } } —— 最优先
    if (
      node.attachment && typeof node.attachment === 'object' &&
      node.attachment.attachmentId === wanted && typeof node.attachment.mediaType === 'string'
    ) {
      return node.attachment;
    }
    // 形态 2：引用对象本身 { attachmentId, mediaType }（兜底）
    if (node.attachmentId === wanted && typeof node.mediaType === 'string') {
      return node;
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

/**
 * 看图问答（阶段 1：VisionBackend 降级链）。
 * 只取声明/推断出 vision 能力的自持栈 provider（严格选择），按序组装后端链，
 * 全局视觉模型兜底；每个后端的失败现场保留在 errors 里。
 * @returns {{answer:string,via:'selfstack'|'global',model?:string,backendId:string}}
 */
export async function askVision(ctx, { question, ref, dataUrl, signal, model }) {
  const visionProviders = store.pickAllFor(cap.CAPABILITIES.VISION);
  const backends = buildVisionBackends(ctx, { providers: visionProviders, model });
  return askWithBackends(backends, { question, ref, imageDataUrl: dataUrl, signal });
}

/**
 * look / relook 共用执行器：看图问答 → 人话结果（标注模型归属，方便排查走哪条链）。
 * @returns {Promise<string>} 直接作为工具输出
 */
export async function runVisionTool(ctx, exec, { origin, model, question, ref, dataUrl }) {
  if (exec && exec.signal && exec.signal.aborted) throw new Error('已取消');
  const { answer, via, model: usedModel } = await askVision(ctx, {
    question,
    ref,
    dataUrl,
    signal: exec && exec.signal,
    model
  });
  const label = origin === 'relook' ? '重看回答' : '看图回答';
  const viaLabel = via === 'selfstack' ? 'iris 自持栈' : 'DSH 全局视觉模型';
  return `[iris] ${label}（${usedModel || '默认'} · ${viaLabel}）：\n${answer}`;
}

/* ---------------- 视觉自述（画图后增强项）：走 askVision 降级链，失败静默 ---------------- */
async function describeFirstImage(ctx, ref, absPath, originalPrompt) {
  try {
    const mt = MEDIA_TYPES[path.extname(absPath).toLowerCase()] || 'image/png';
    const { answer } = await askVision(ctx, {
      question: `用不超过两句话描述这张图片的主题与构图。生成该图的提示词是：「${String(originalPrompt).slice(0, 200)}」`,
      ref,
      dataUrl: toDataUrl(absPath, mt),
      signal: undefined
    });
    return answer.slice(0, 300);
  } catch (_) {
    return ''; // 自述是增强项，失败不影响交付
  }
}

