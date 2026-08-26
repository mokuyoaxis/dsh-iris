'use strict';
/**
 * dsh-iris —— Host 入口。
 * 给 DSH 装上眼睛和双手：多供应商媒体生成 + 视觉路由 + 🫧 常驻泡泡。
 * M2：新增视频生成（文生/图生）；全部异步生成统一走任务盯守框架
 *     （提交即盯守、工具内等待超时自动转后台、DSH 重启后恢复接管）。
 * 架构纪律：无独立后台，与 DSH 俱荣俱损——定时器归 Fiber，产物落 $DSH_HOME。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as adapters from './adapters.js';
import * as store from './config.js';
import * as tasks from './tasks.js';
import { registerMedia, mediaLinksOf, authorizeMedia } from './media.js';

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

function sendText(res, status, text) {
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function serveMedia(req, res) {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'method not allowed');
    const parts = String(req.url || '').split('?')[0].split('/').filter(Boolean);
    // /iris/media/:taskId/:token/:name
    if (parts.length !== 5 || parts[0] !== 'iris' || parts[1] !== 'media') return sendText(res, 404, 'not found');
    let name;
    try {
      name = decodeURIComponent(parts[4]);
    } catch (_) {
      return sendText(res, 404, 'not found');
    }
    const hit = authorizeMedia(parts[2], parts[3], name);
    if (!hit) return sendText(res, 404, 'not found'); // 未命中一律 404，不给枚举线索
    res.writeHead(200, {
      'Content-Type': hit.entry.mime,
      'Content-Length': hit.size,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(hit.entry.file)}`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(method === 'HEAD' ? undefined : fs.readFileSync(hit.abs));
  } catch (err) {
    sendText(res, 500, 'media error');
  }
}

let mediaRouteMounted = false;
function mountIrisRoutes(routeCtx) {
  // Cordis 铁律：服务一律走 ctx.get() 可选访问；属性直读会在未 inject 时抛错炸掉整个插件
  const reg = routeCtx && typeof routeCtx.get === 'function'
    ? (routeCtx.get('webServer') || routeCtx.get('httpServer'))
    : undefined;
  if (!reg || typeof reg.register !== 'function' || mediaRouteMounted) return;
  try {
    const dispose = reg.register({
      kind: 'prefix',
      path: '/iris/media',
      handler: serveMedia
    });
    mediaRouteMounted = true;
    routeCtx.effect(() => () => {
      if (typeof dispose === 'function') dispose();
      mediaRouteMounted = false;
    }, 'iris: media routes');
    console.log('[iris] 媒体路由已挂载：/iris/media/:taskId/:token/:name');
  } catch (err) {
    console.error('[iris] 媒体路由挂载失败：', err && err.message);
  }
}

/** 从工作台配置解析出「画图供应商」的启动参数 */
function imageBackendFor(provider) {
  if (!provider) return null;
  if ((provider.mediaProtocol || 'dashscope') === 'openai-images') {
    return { protocol: 'openai-images', key: provider.apiKey, baseUrl: provider.baseUrl, model: provider.imageModel || 'gpt-image-1' };
  }
  return { protocol: 'dashscope', key: provider.apiKey, baseUrl: provider.baseUrl, model: provider.imageModel || 'wan2.2-t2i-flash' };
}

/** 盯守依赖：按能力给轮询间隔与结果转存扩展名 */
function pollDeps(provider, cap) {
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

/* ---------------- 首帧图解析（视频用） ---------------- */

function toDataUrl(absPath, mediaType) {
  const buf = fs.readFileSync(absPath);
  return `data:${mediaType};base64,${buf.toString('base64')}`;
}

/** 在本插件的历史任务里找 iris 自己生成的图片附件 */
function findGeneratedAttachment(attachmentId) {
  for (const t of tasks.list()) {
    for (const a of t.attachments || []) {
      if (a.attachmentId === attachmentId) {
        return { absPath: path.join(outputDir(), a.file), mediaType: a.mediaType };
      }
    }
  }
  return null;
}

/**
 * 解析视频首帧：优先 attachment id（iris_draw_image 的产物），其次本地绝对路径。
 * @returns {{absPath:string, mediaType:string}|null} 文件信息；由调用方决定转 base64（i2v）还是临时上传（s2v）
 */
function resolveFirstFrameFile(args) {
  if (args.first_frame_attachment_id) {
    const hit = findGeneratedAttachment(String(args.first_frame_attachment_id).trim());
    if (!hit) throw new Error('iris: 找不到该 first_frame_attachment_id（仅支持本插件生成的图片，请传 iris_draw_image 返回的 attachment id）');
    if (!fs.existsSync(hit.absPath)) throw new Error('iris: 首帧图片的本地缓存已被清理，请重新生成或改用绝对路径');
    return hit;
  }
  if (args.first_frame_path) {
    const p = String(args.first_frame_path).trim();
    if (!path.isAbsolute(p)) throw new Error('iris: first_frame_path 必须是绝对路径');
    const mt = MEDIA_TYPES[path.extname(p).toLowerCase()];
    if (!mt) throw new Error('iris: 不支持的首帧图片格式：' + p);
    if (!fs.existsSync(p)) throw new Error('iris: 首帧文件不存在：' + p);
    return { absPath: p, mediaType: mt };
  }
  return null; // 纯文生视频
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

export async function apply(ctx) {
  // 首次运行：从工作台导入（幂等）
  const wb = path.join(process.env.HOME || os.homedir(), 'projects', 'ai-paint', 'data', 'config.json');
  const imported = store.importFromWorkbench(wb);
  if (imported.imported) console.log(`[iris] 已从工作台导入 ${imported.imported} 个服务商`);

  // 接管上次进程未跑完的异步任务（俱荣俱损：进程没了盯守就没了，重启后补上）
  const resumed = tasks.resumePending((t) => {
    const p = store.providerById(t.providerId);
    return p ? pollDeps(p, t.cap) : null;
  });
  if (resumed.length) console.log(`[iris] 已恢复接管 ${resumed.length} 个后台任务`);

  // Fiber 清理：插件停用/更新时停掉全部盯守句柄
  ctx.effect(() => () => tasks.stopWatchAll());

  // 媒体路由（视频/音频在对话流里的可播通路；图片仍走原生附件）
  ctx.inject(['webServer'], mountIrisRoutes);
  ctx.inject(['httpServer'], mountIrisRoutes);
  // 若 webServer 已在运行，inject 回调也会触发；这里兜底立即挂载一次
  mountIrisRoutes(ctx);

  const tools = ctx.tools;

  /* ---------- 🖼️ 画图 ---------- */
  ctx.effect(() => tools.register({
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
        model: { type: 'string', description: 'Override the configured image model id' }
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
      const provider = store.pickFor('image');
      if (!provider) throw new Error('iris: 没有可用供应商——先在 Iris 设置里添加并启用');
      const backend = imageBackendFor(provider);
      const model = args.model ? String(args.model) : backend.model;
      const task = tasks.create({
        cap: 'image', providerId: provider.id, providerName: provider.name,
        model, protocol: backend.protocol, prompt: prompt.slice(0, 4000)
      });

      /* --- 提交 --- */
      let files = []; // 本地绝对路径
      if (backend.protocol === 'dashscope') {
        let taskId;
        try {
          taskId = await adapters.submitImage({
            key: backend.key, model, prompt,
            size: args.size || undefined, n: args.n || 1
          });
        } catch (err) {
          tasks.update(task.id, { status: 'failed', error: String(err.message || err) });
          throw err;
        }
        tasks.update(task.id, { remoteTaskId: taskId });
        tasks.watch(tasks.get(task.id), pollDeps(provider, 'image'));

        /* --- 等待（超时转后台） --- */
        const final = await awaitTerminal(task.id, { timeoutMs: AWAIT_MS.image, signal: exec.signal });
        if (!final) {
          return {
            blocks: [{
              type: 'text',
              text: `[iris] 图像任务仍在后台盯守（task: ${task.id}）。稍后可用 iris_task_status 查询进度与文件路径。`
            }]
          };
        }
        if (final.status === 'canceled') throw new Error('已取消');
        if (final.status !== 'succeeded') throw new Error('生成失败：' + (final.error || '未知原因'));
        files = final.files.map((f) => path.join(outputDir(), f));
      } else {
        try {
          const outs = await adapters.openAiGenerateImage({
            key: backend.key, baseUrl: backend.baseUrl, model, prompt,
            size: args.size || undefined, n: args.n || 1
          });
          files = [];
          for (let i = 0; i < outs.length; i++) {
            const p = path.join(outputDir(), `${task.id}-${i}.png`);
            if (outs[i].b64) fs.writeFileSync(p, Buffer.from(outs[i].b64, 'base64'));
            else await adapters.downloadTo(outs[i].url, p);
            files.push(p);
          }
        } catch (err) {
          tasks.update(task.id, { status: 'failed', error: String(err.message || err) });
          throw err;
        }
        tasks.update(task.id, {
          status: 'succeeded',
          files: files.map((f) => path.basename(f)),
          finishedAt: new Date().toISOString()
        });
      }

      /* --- 转存为 DSH 持久附件 + 视觉自述（让工作 AI 知道画了什么） --- */
      const blocks = [];
      const refs = [];
      for (const f of files) {
        const mediaType = MEDIA_TYPES[path.extname(f).toLowerCase()] || 'image/png';
        const ref = await ctx.attachments.saveImage({ data: new Uint8Array(fs.readFileSync(f)), mediaType, name: path.basename(f) });
        refs.push(ref);
        blocks.push({ type: 'image', attachment: ref });
      }
      tasks.update(task.id, {
        attachments: refs.map((r, i) => ({
          attachmentId: r.attachmentId,
          file: path.basename(files[i]),
          mediaType: MEDIA_TYPES[path.extname(files[i]).toLowerCase()] || 'image/png'
        }))
      });

      // 用视觉模型自述（增强项；失败静默降级。M3 将替换为完整的视觉路由子系统）
      let note = '';
      try {
        const described = await describeFirstImage(ctx, refs[0], prompt);
        if (described) note = `画面内容：${described}`;
      } catch (_) {
        /* ignore */
      }

      blocks.unshift({
        type: 'text',
        text:
          `[iris] 图像已生成（${model}，task: ${task.id}）。` +
          (note ? `\n${note}` : '') +
          `\nattachment: ${refs.map((r) => r.attachmentId).join(', ')}`
      });
      return { blocks };
    }
  }));

  /* ---------- 🎬 视频生成 ---------- */
  ctx.effect(() => tools.register({
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
        model: { type: 'string', description: 'Override the configured video model id (default wan2.2-t2v-flash)' }
      },
      required: ['prompt']
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const prompt = String(args.prompt || '').trim();
      if (!prompt && !args.audio_path) throw new Error('iris: prompt 不能为空');
      const provider = store.pickFor('video');
      if (!provider) throw new Error('iris: 没有可用供应商——先在 Iris 设置里添加并启用');
      const model = args.model ? String(args.model) : (provider.videoModel || 'wan2.2-t2v-flash');
      const isS2V = /s2v/i.test(model);
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');

      const frame = resolveFirstFrameFile(args); // 参数不合法会直接抛人话错误
      let submitArgs;
      if (isS2V) {
        if (!frame) throw new Error('iris: s2v 数字人需要首帧——传 first_frame_attachment_id 或 first_frame_path');
        if (!args.audio_path) throw new Error('iris: s2v 数字人需要 audio_path（wav/mp3，<20s 清晰人声）');
        const ap = String(args.audio_path).trim();
        if (!path.isAbsolute(ap)) throw new Error('iris: audio_path 必须是绝对路径');
        if (!fs.existsSync(ap)) throw new Error('iris: 音频文件不存在：' + ap);
        // 本地图/音 → 百炼临时 URL（oss://，48h）；s2v 不收 data: base64
        const imageUrl = await adapters.uploadTempFile({ key: provider.apiKey, model, filePath: frame.absPath });
        const audioUrl = await adapters.uploadTempFile({ key: provider.apiKey, model, filePath: ap });
        submitArgs = { imgDataUrl: imageUrl, audioUrl, resolution: args.resolution };
      } else {
        submitArgs = {
          prompt,
          imgDataUrl: frame ? toDataUrl(frame.absPath, frame.mediaType) : undefined,
          size: args.size ? String(args.size) : '1280*720',
          duration: args.duration ? Number(args.duration) : undefined
        };
      }

      const task = tasks.create({
        cap: 'video', providerId: provider.id, providerName: provider.name,
        model, ...(isS2V
          ? { mode: 's2v', resolution: args.resolution || '480P' }
          : { size: args.size || '1280*720', ...(args.duration ? { duration: Number(args.duration) } : {}), mode: frame ? 'i2v' : 't2v' }),
        prompt: prompt.slice(0, 4000)
      });

      let remoteId;
      try {
        remoteId = await adapters.submitVideo({ key: provider.apiKey, model, ...submitArgs });
      } catch (err) {
        tasks.update(task.id, { status: 'failed', error: String(err.message || err) });
        throw err;
      }
      tasks.update(task.id, { remoteTaskId: remoteId });
      tasks.watch(tasks.get(task.id), pollDeps(provider, 'video'));

      const final = await awaitTerminal(task.id, { timeoutMs: AWAIT_MS.video, signal: exec.signal });
      if (!final) {
        return `[iris] 视频任务已提交并转入后台盯守（task: ${task.id}，remoteTask: ${remoteId}）。\n` +
          `渲染通常需要数分钟；完成后用 iris_task_status 查询产物路径。`;
      }
      if (final.status === 'canceled') throw new Error('已取消');
      if (final.status !== 'succeeded') throw new Error('视频生成失败：' + (final.error || '未知原因'));

      const paths = (final.files || []).map((f) => path.join(outputDir(), f));
      const links = mediaLinksOf(final);
      const secs = Math.round((Date.now() - new Date(final.createdAt).getTime()) / 1000);
      return `[iris] 视频已生成（${model}，${final.mode || 't2v'}，约 ${secs}s）：\n` +
        paths.join('\n') +
        (links.length ? `\n\n${links.join('\n')}\n（点击即在本机浏览器播放）` : '') +
        `\ntask: ${final.id}`;
    }
  }));

  /* ---------- 🔊 语音合成 ---------- */
  ctx.effect(() => tools.register({
    name: 'iris_speak_text',
    description: 'Synthesize speech audio from text using the configured TTS model (qwen-tts / compatible). Returns the saved audio file path.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak' },
        voice: { type: 'string', description: "Voice name, e.g. 'Cherry' (DashScope qwen-tts voices)" },
        model: { type: 'string', description: 'Override the configured TTS model id' }
      },
      required: ['text']
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const text = String(args.text || '').trim();
      if (!text) throw new Error('iris: text 不能为空');
      const provider = store.pickFor('tts');
      if (!provider) throw new Error('iris: 没有可用供应商——先在 Iris 设置里添加并启用');
      const model = args.model ? String(args.model) : (provider.ttsModel || 'qwen-tts-latest');
      const voice = args.voice || (provider.ttsVoice || 'Cherry');
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');

      const task = tasks.create({ cap: 'tts', providerId: provider.id, providerName: provider.name, model, voice, prompt: text.slice(0, 500) });
      try {
        const r = await adapters.synthesizeTts({ key: provider.apiKey, model, text, voice });
        const fileName = `iris-tts-${Date.now()}.${r.audioUrl ? adapters.extFromUrl(r.audioUrl, 'wav') : 'wav'}`;
        const p = path.join(outputDir(), fileName);
        if (r.audioUrl) await adapters.downloadTo(r.audioUrl, p);
        else fs.writeFileSync(p, Buffer.from(r.audioB64, 'base64'));
        tasks.update(task.id, { status: 'succeeded', files: [fileName], finishedAt: new Date().toISOString() });
        const media = registerMedia(task.id, p);
        return `[iris] 语音已合成（${model}）：${p}\ntask: ${task.id}` +
          (media ? `\n[♪ 音频播放](${media.url})` : '');
      } catch (err) {
        tasks.update(task.id, { status: 'failed', error: String(err.message || err) });
        throw err;
      }
    }
  }));

  /* ---------- 📋 任务查询 ---------- */
  ctx.effect(() => tools.register({
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
  }));

  console.log('[iris] tools registered (draw_image, generate_video, speak_text, task_status)');
};

/**
 * 视觉自述：优先用 DSH 全局模型注册表中声明了视觉能力的模型；
 * 这里保持极简——M3 会替换成完整的视觉路由子系统（自持 qwen-vl 为主、全局模型降级为辅）。
 */
async function describeFirstImage(ctx, ref, originalPrompt) {
  const llm = ctx.get && ctx.get('llm');
  if (!llm || typeof llm.stream !== 'function') return '';
  const chunks = [];
  const opts = {
    sessionId: undefined,
    provider: undefined,
    model: undefined,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `用不超过两句话描述这张图片的主题与构图。生成该图的提示词是：「${String(originalPrompt).slice(0, 200)}」` },
          { type: 'image', attachment: ref }
        ]
      }
    ]
  };
  for await (const chunk of llm.stream(opts)) {
    const t = chunk && chunk.delta;
    if (typeof t === 'string') chunks.push(t);
    if (chunks.join('').length > 300) break;
  }
  return chunks.join('').trim().slice(0, 300);
}
