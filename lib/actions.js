'use strict';
/**
 * Iris 动作执行层（阶段 5 GUI 操作面板）。
 *
 * 把 11 个工具的 execute 逻辑抽取为可复用的 action 函数，供：
 * ① `POST /iris/api/actions/:name` 路由（GUI 直连，submit-only 不等待）
 * ② 工具 execute 体（Agent 调用，可等待）
 *
 * 每个 action 是纯函数 `(ctx, args, { signal }) => result`，
 * 结果只有可序列化 JSON（无 live 对象）。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as adapters from './adapters.js';
import * as store from './config.js';
import * as cap from './capability.js';
import * as models from './models.js';
import * as tasks from './tasks.js';
import { registerMedia, mediaLinksOf, webBase } from './media.js';
import { buildVisionBackends, askWithBackends, testVisionCapability, RED_TEST_IMAGE } from './vision.js';
import { cropImage, pixelDiff, imageDimensions } from './pixels.js';
import { locateObject } from './locate.js';
import { BrowserHtmlRenderer } from './render.js';
import { longOcr } from './ocr.js';
import { ffmpegAvailable, extractFrames, probeVideo } from './media-probe.js';
import { buildContactSheet, summarizeMedia } from './summarize.js';

const MEDIA_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif'
};

/* ---------------- 视觉效果自述（辅助 iris_draw_image） ---------------- */
async function describeFirstImage(ctx, ref, absPath, originalPrompt) {
  try {
    const mt = MEDIA_TYPES[path.extname(absPath).toLowerCase()] || 'image/png';
    const buf = fs.readFileSync(absPath);
    const dataUrl = `data:${mt};base64,${buf.toString('base64')}`;
    const backends = buildVisionBackends(ctx, { providers: store.pickAllFor(cap.CAPABILITIES.VISION) });
    const { answer } = await askWithBackends(backends, {
      question: `用不超过两句话描述这张图片的主题与构图。生成该图的提示词是：「${String(originalPrompt).slice(0, 200)}」`,
      imageDataUrl: dataUrl,
      signal: undefined
    });
    return answer.slice(0, 300);
  } catch (_) { return ''; }
}

/* ---------------- IO 目录 ---------------- */
function outputDir() {
  const dir = path.join(store.irisHome(), 'outputs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------- 动作注册表 ---------------- */

const actions = {};

/**
 * 注册一个 action。
 * @param {string} name 动作名（用于路由）
 * @param {Function} fn (ctx, args, { signal }) => { ok, text?, imageDataUrl?, taskId?, blocks? }
 */
function register(name, fn) {
  actions[name] = fn;
}

/** 获取已注册的动作名列表 */
export function listActions() {
  return Object.keys(actions);
}

/** 执行一个动作 */
export async function runAction(ctx, name, args, { signal } = {}) {
  const fn = actions[name];
  if (!fn) throw new Error(`iris: 未知动作 "${name}"`);
  return fn(ctx, args, { signal });
}

/* ============ 动作实现 ============ */

/* ---------- 🖼️ 画图 ---------- */
register('image', async (ctx, args, { signal }) => {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('iris: prompt 不能为空');
  const provider = store.pickFor(cap.CAPABILITIES.IMAGE);
  if (!provider) throw new Error('iris: 没有可用供应商——先在 Iris 设置里添加并启用');
  const protocol = (provider.mediaProtocol || 'dashscope') === 'openai-images' ? 'openai-images' : 'dashscope';
  const model = args.model ? String(args.model) : (provider.imageModel || (protocol === 'openai-images' ? 'gpt-image-1' : 'wan2.2-t2i-flash'));
  const task = tasks.create({
    cap: 'image', providerId: provider.id, providerName: provider.name,
    model, protocol, prompt: prompt.slice(0, 4000)
  });
  if (protocol === 'dashscope') {
    const remoteTaskId = await tasks.submitGuard(task, () => adapters.submitImage({ key: provider.apiKey, model, prompt, size: args.size, n: args.n }));
    tasks.update(task.id, { remoteTaskId });
    tasks.watch(tasks.get(task.id), {
      key: () => provider.apiKey,
      poll: ({ key, remoteTaskId }) => adapters.pollTask({ key, remoteTaskId }),
      intervalMs: 2500,
      onSuccess: async (t, r) => {
        fs.mkdirSync(outputDir(), { recursive: true });
        const names = [];
        for (const url of r.urls || []) {
          const name = `${t.id}-${names.length}.${adapters.extFromUrl(url, 'png')}`;
          await adapters.downloadTo(url, path.join(outputDir(), name));
          names.push(name);
        }
        for (const n of names) registerMedia(t.id, path.join(outputDir(), n));
        return names;
      }
    });
  } else {
    const files = await tasks.submitGuard(task, async () => {
      const outs = await adapters.openAiGenerateImage({ key: provider.apiKey, baseUrl: provider.baseUrl, model, prompt, size: args.size, n: args.n });
      const written = [];
      for (let i = 0; i < outs.length; i++) {
        const p = path.join(outputDir(), `${task.id}-${i}.png`);
        if (outs[i].b64) fs.writeFileSync(p, Buffer.from(outs[i].b64, 'base64'));
        else await adapters.downloadTo(outs[i].url, p);
        written.push(p);
      }
      return written;
    });
    tasks.update(task.id, { status: 'succeeded', files: files.map((f) => path.basename(f)), finishedAt: new Date().toISOString() });
    for (const f of files) registerMedia(task.id, f);
  }
  return { ok: true, taskId: task.id, text: `[iris] 图像任务已提交（${model}，task: ${task.id}）` };
});

/* ---------- 🎬 视频生成 ---------- */
register('video', async (ctx, args, { signal }) => {
  const prompt = String(args.prompt || '').trim();
  const provider = store.pickFor(cap.CAPABILITIES.VIDEO);
  if (!provider) throw new Error('iris: 没有可用供应商——先在 Iris 设置里添加并启用');
  const model = args.model ? String(args.model) : (provider.videoModel || 'wan2.2-t2v-flash');
  const isS2V = /s2v/i.test(model);
  let submitArgs;
  if (isS2V) {
    if (!args.first_frame_attachment_id && !args.first_frame_path) throw new Error('iris: s2v 需要首帧');
    if (!args.audio_path) throw new Error('iris: s2v 需要 audio_path');
    const imageUrl = await adapters.uploadTempFile({ key: provider.apiKey, model, filePath: args.first_frame_path });
    const audioUrl = await adapters.uploadTempFile({ key: provider.apiKey, model, filePath: args.audio_path });
    submitArgs = { imgDataUrl: imageUrl, audioUrl, resolution: args.resolution };
  } else {
    submitArgs = { prompt, imgDataUrl: undefined, size: args.size || '1280*720', duration: args.duration };
  }
  const task = tasks.create({ cap: 'video', providerId: provider.id, providerName: provider.name, model, prompt: String(prompt || '').slice(0, 4000) });
  const remoteId = await tasks.submitGuard(task, () => adapters.submitVideo({ key: provider.apiKey, model, ...submitArgs }));
  tasks.update(task.id, { remoteTaskId: remoteId });
  tasks.watch(tasks.get(task.id), {
    key: () => provider.apiKey,
    poll: ({ key, remoteTaskId }) => adapters.pollTask({ key, remoteTaskId }),
    intervalMs: 6000,
    onSuccess: async (t, r) => {
      fs.mkdirSync(outputDir(), { recursive: true });
      const names = [];
      for (const url of r.urls || []) {
        const name = `${t.id}-${names.length}.${adapters.extFromUrl(url, 'mp4')}`;
        await adapters.downloadTo(url, path.join(outputDir(), name));
        names.push(name);
      }
      for (const n of names) registerMedia(t.id, path.join(outputDir(), n));
      return names;
    }
  });
  return { ok: true, taskId: task.id, text: `[iris] 视频任务已提交（${model}，task: ${task.id}）` };
});

/* ---------- 🔊 语音合成 ---------- */
register('tts', async (ctx, args, { signal }) => {
  const text = String(args.text || '').trim();
  if (!text) throw new Error('iris: text 不能为空');
  const provider = store.pickFor(cap.CAPABILITIES.TTS);
  if (!provider) throw new Error('iris: 没有可用供应商——先在 Iris 设置里添加并启用');
  const model = args.model ? String(args.model) : (provider.ttsModel || 'qwen-tts-latest');
  const voice = args.voice || (provider.ttsVoice || 'Cherry');
  const task = tasks.create({ cap: 'tts', providerId: provider.id, providerName: provider.name, model, voice, prompt: text.slice(0, 500) });
  const fileName = await tasks.submitGuard(task, async () => {
    const r = await adapters.synthesizeTts({ key: provider.apiKey, model, text, voice });
    const name = `iris-tts-${Date.now()}.${r.audioUrl ? adapters.extFromUrl(r.audioUrl, 'wav') : 'wav'}`;
    const p = path.join(outputDir(), name);
    if (r.audioUrl) await adapters.downloadTo(r.audioUrl, p);
    else fs.writeFileSync(p, Buffer.from(r.audioB64, 'base64'));
    return name;
  });
  tasks.update(task.id, { status: 'succeeded', files: [fileName], finishedAt: new Date().toISOString() });
  registerMedia(task.id, path.join(outputDir(), fileName));
  return { ok: true, taskId: task.id, text: `[iris] 语音已合成（${model}，task: ${task.id}）` };
});

/* ---------- 👁 看图 ---------- */
register('look', async (ctx, args, { signal }) => {
  const p = String(args.image_path || '').trim();
  if (!p || !path.isAbsolute(p)) throw new Error('iris: image_path 必须是绝对路径');
  const mt = MEDIA_TYPES[path.extname(p).toLowerCase()];
  if (!mt || mt === 'image/gif') throw new Error('iris: 不支持的图片格式');
  if (!fs.existsSync(p)) throw new Error('iris: 图片不存在');
  const dataUrl = `data:${mt};base64,${fs.readFileSync(p).toString('base64')}`;
  const backends = buildVisionBackends(ctx, { providers: store.pickAllFor(cap.CAPABILITIES.VISION), model: args.model });
  const { answer, via, model } = await askWithBackends(backends, { question: (args.question || '详细描述这张图片。'), imageDataUrl: dataUrl, signal });
  const viaLabel = via === 'selfstack' ? 'iris 自持栈' : 'DSH 全局视觉模型';
  return { ok: true, text: `[iris] 看图回答（${model} · ${viaLabel}）：\n${answer}` };
});

/* ---------- ✂️ 裁剪 ---------- */
register('crop', async (ctx, args, { signal }) => {
  const p = String(args.image_path || '').trim();
  if (!p || !path.isAbsolute(p)) throw new Error('iris: image_path 必须是绝对路径');
  if (!fs.existsSync(p)) throw new Error('iris: 图片不存在');
  const { buffer, width, height, mime } = await cropImage({ input: p, left: args.left, top: args.top, width: args.width, height: args.height });
  const b64 = buffer.toString('base64');
  return { ok: true, text: `[iris] 裁剪完成：${width}x${height}（原区域 ${args.left},${args.top},${args.width},${args.height}）`, imageDataUrl: `data:${mime};base64,${b64}` };
});

/* ---------- 📷 像素 diff ---------- */
register('diff', async (ctx, args, { signal }) => {
  if (!args.image_a_path || !args.image_b_path) throw new Error('iris: 需要 image_a_path 和 image_b_path');
  const { ratio, diffPixels, totalPixels, width, height, worstRegions, heatmap, mime } = await pixelDiff({
    inputA: args.image_a_path, inputB: args.image_b_path, grid: args.grid || 8, topRegions: args.top_regions || 3
  });
  const pct = (ratio * 100).toFixed(2);
  const regions = worstRegions.map((r) => `(col ${r.col},row ${r.row}) ${(r.score * 100).toFixed(1)}%`).join(' ');
  return {
    ok: true,
    text: `[iris] 像素差异 ${pct}%（${diffPixels}/${totalPixels}px，归一化 ${width}x${height}）\n最差区域（${worstRegions.length} 格）: ${regions}`,
    imageDataUrl: `data:${mime};base64,${heatmap.toString('base64')}`
  };
});

/* ---------- 📍 定位 ---------- */
register('locate', async (ctx, args, { signal }) => {
  const p = String(args.image_path || '').trim();
  if (!p || !path.isAbsolute(p)) throw new Error('iris: image_path 必须是绝对路径');
  if (!fs.existsSync(p)) throw new Error('iris: 图片不存在');
  const buf = fs.readFileSync(p);
  const mt = MEDIA_TYPES[path.extname(p).toLowerCase()] || 'image/png';
  const dataUrl = `data:${mt};base64,${buf.toString('base64')}`;
  const { width, height } = await imageDimensions(buf);
  const backends = buildVisionBackends(ctx, { providers: store.pickAllFor(cap.CAPABILITIES.VISION), model: args.model });
  const r = await locateObject(backends, { target: args.target, imageDataUrl: dataUrl, width, height, signal });
  if (!r.found) return { ok: true, text: `[iris] 在图片中未找到「${args.target}」` };
  return { ok: true, text: `[iris] 定位「${args.target}」：bbox (${r.x1},${r.y1},${r.x2},${r.y2}) / ${width}x${height}（${r.via} · ${r.model}）` };
});
/* ---------- 🖼️ HTML 截图 ---------- */
register('html', async (ctx, args, { signal }) => {
  const html = String(args.html || '').trim();
  if (!html) throw new Error('iris: html 不能为空');
  const browser = ctx.get('browser');
  if (!browser) throw new Error('iris: 浏览器服务不可用——需要启用 dsh-builtin-browser 插件');
  const renderer = new BrowserHtmlRenderer({ browser });
  const { png } = await renderer.render({ html, width: args.width, height: args.height, fullPage: args.fullPage !== false });
  return { ok: true, text: `[iris] HTML 截图完成（fullPage: ${args.fullPage !== false}）`, imageDataUrl: `data:image/png;base64,${png.toString('base64')}` };
});

/* ---------- 📄 长截图 OCR ---------- */
register('ocr', async (ctx, args, { signal }) => {
  const p = String(args.image_path || '').trim();
  if (!p || !path.isAbsolute(p)) throw new Error('iris: image_path 必须是绝对路径');
  if (!fs.existsSync(p)) throw new Error('iris: 图片不存在');
  const backends = buildVisionBackends(ctx, { providers: store.pickAllFor(cap.CAPABILITIES.VISION) });
  const result = await longOcr({ input: p, backends, chunkHeight: args.chunk_height || 1200, overlap: args.overlap || 120, signal });
  const errCount = result.chunks.filter((c) => c.error).length;
  const head = `[iris] 长截图 OCR 完成：${result.width}x${result.height}px，${result.totalChunks} 块${errCount ? '（' + errCount + ' 块失败）' : ''}\n`;
  return { ok: true, text: result.fullText ? head + result.fullText : head + '（未识别到文字）' };
});

/* ---------- 📋 任务查询 ---------- */
register('status', async (ctx, args, { signal }) => {
  if (args.task_id) {
    const t = tasks.get(String(args.task_id).trim());
    if (!t) throw new Error('iris: 没有这个任务：' + args.task_id);
    const lines = [`[${t.cap}] ${t.id} · ${t.status}${t.progress ? ' · ' + t.progress : ''} · ${t.model}`];
    if (t.prompt) lines.push('prompt: ' + String(t.prompt).slice(0, 120));
    if (t.error) lines.push('error: ' + t.error);
    if ((t.files || []).length) lines.push('files:\n' + t.files.map((f) => path.join(outputDir(), f)).join('\n'));
    const links = mediaLinksOf(t);
    if (links.length) lines.push('links:\n' + links.join('\n'));
    return { ok: true, text: lines.join('\n') };
  }
  const recent = tasks.list().slice(0, 5);
  if (!recent.length) return { ok: true, text: '[iris] 还没有生成任务记录。' };
  return { ok: true, text: recent.map((t) => `[${t.cap}] ${t.id} · ${t.status} · ${t.model}`).join('\n') };
});

/* ---------- 🧹 任务清理（阶段 4 续：元数据删除，产物文件默认保留） ---------- */

/** 扫描 outputs/ 里不被任何任务记录引用的孤儿文件（files[] + media[].file 并集） */
function scanOrphanArtifacts() {
  const dir = outputDir();
  if (!fs.existsSync(dir)) return { files: [], bytes: 0 };
  const referenced = new Set();
  for (const t of tasks.all()) {
    for (const f of t.files || []) referenced.add(path.basename(f));
    for (const m of t.media || []) referenced.add(path.basename(m.file));
    for (const a of t.attachments || []) if (a.file) referenced.add(path.basename(a.file));
  }
  const files = [];
  let bytes = 0;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    let st;
    try { st = fs.statSync(abs); } catch (_) { continue; }
    if (!st.isFile()) continue;
    if (referenced.has(name)) continue;
    files.push({ name, bytes: st.size });
    bytes += st.size;
  }
  return { files, bytes };
}

/** 删除单条任务记录（仅终态；运行中须先取消）。只删元数据，产物文件保留。 */
register('tasks_delete', async (ctx, args) => {
  const id = String(args.task_id || '').trim();
  if (!id) throw new Error('iris: task_id 不能为空');
  const r = tasks.remove(id);
  if (!r.ok) throw new Error('iris: ' + r.reason);
  return { ok: true, removed: 1, text: `[iris] 已删除任务记录 ${id}（产物文件保留在 outputs/）` };
});

/**
 * 批量清理任务记录：scope = completed（所有终态）| older_than（早于 days 天）| all（等同 completed，运行中受保护）。
 * 只删元数据，绝不动运行中任务，产物文件默认保留。
 */
register('tasks_clear', async (ctx, args) => {
  const scope = String(args.scope || 'completed').trim();
  if (!['completed', 'older_than', 'all'].includes(scope)) throw new Error('iris: scope 需为 completed/older_than/all');
  let removed;
  if (scope === 'older_than') {
    const days = Number(args.days);
    if (!Number.isFinite(days) || days < 0) throw new Error('iris: days 需为非负数字');
    const cutoff = Date.now() - days * 86400000;
    removed = tasks.prune((t) => new Date(t.createdAt).getTime() < cutoff);
  } else {
    // completed / all：删除全部终态记录（运行中永不被 prune 命中）
    removed = tasks.prune(() => true);
  }
  return { ok: true, removed: removed.length, text: `[iris] 已清理 ${removed.length} 条任务记录（产物文件保留）` };
});

/** 孤儿产物报告：outputs/ 里无任务引用的文件 + 总占用（只读，不删） */
register('tasks_orphans', async () => {
  const { files, bytes } = scanOrphanArtifacts();
  const mb = (bytes / 1048576).toFixed(1);
  if (!files.length) return { ok: true, count: 0, bytes: 0, text: '[iris] 没有孤儿产物，outputs/ 干净。' };
  const preview = files.slice(0, 12).map((f) => `  ${f.name} (${(f.bytes / 1024).toFixed(0)}KB)`).join('\n');
  return {
    ok: true, count: files.length, bytes,
    text: `[iris] ${files.length} 个孤儿产物，共 ${mb}MB：\n${preview}${files.length > 12 ? `\n  … 另 ${files.length - 12} 个` : ''}`
  };
});

/** 删除孤儿产物文件（不可逆，客户端须二次确认）。任务记录不动。 */
register('tasks_purge_orphans', async () => {
  const { files, bytes } = scanOrphanArtifacts();
  const dir = outputDir();
  let deleted = 0;
  for (const f of files) {
    try { fs.rmSync(path.join(dir, f.name), { force: true }); deleted++; } catch (_) { /* 单个失败不阻断 */ }
  }
  return { ok: true, deleted, bytes, text: `[iris] 已删除 ${deleted} 个孤儿产物，释放 ${(bytes / 1048576).toFixed(1)}MB` };
});

/* ---------- 👁 重看（GUI：只查 iris 自己的任务产物，无会话上下文） ---------- */
register('relook', async (ctx, args, { signal }) => {
  const id = String(args.attachment_id || '').trim();
  if (!id) throw new Error('iris: attachment_id 不能为空');
  const question = String(args.question || '').trim();
  if (!question) throw new Error('iris: question 不能为空');
  // GUI 无会话事件扫描能力：只在 iris 自己的任务产物里找（findOwnAttachment 逻辑）
  let hit = null;
  for (const t of tasks.list()) {
    for (const a of t.attachments || []) {
      if (a.attachmentId === id) {
        const absPath = path.join(store.irisHome(), 'outputs', a.file);
        if (fs.existsSync(absPath)) { hit = { absPath, mediaType: a.mediaType }; break; }
      }
    }
    if (hit) break;
  }
  if (!hit) throw new Error('iris: 该 attachment 不在 iris 生成的任务产物中（GUI 重看仅支持 iris 画图产物）');
  const mt = hit.mediaType || MEDIA_TYPES[path.extname(hit.absPath).toLowerCase()] || 'image/png';
  const dataUrl = `data:${mt};base64,${fs.readFileSync(hit.absPath).toString('base64')}`;
  const backends = buildVisionBackends(ctx, { providers: store.pickAllFor(cap.CAPABILITIES.VISION), model: args.model });
  const { answer, via, model } = await askWithBackends(backends, { question, imageDataUrl: dataUrl, signal });
  const viaLabel = via === 'selfstack' ? 'iris 自持栈' : 'DSH 全局视觉模型';
  return { ok: true, text: `[iris] 重看回答（${model} · ${viaLabel}）：\n${answer}` };
});

/* ============ 供应商管理动作（阶段 6 条目 3-5） ============ */

/** 列出全部供应商及其模型池（管理 GUI 用；apiKey 只给 hint） */
register('providers_list', async (ctx, args) => {
  const list = store.allProviders();
  return {
    ok: true,
    providers: list.map((p) => ({
      id: p.id,
      name: p.name || p.id,
      type: p.type || 'openai',
      baseUrl: p.baseUrl,
      enabled: p.enabled !== false,
      mediaProtocol: p.mediaProtocol || 'dashscope',
      apiKeyHint: String(p.apiKey || '').length <= 8 ? '****' : String(p.apiKey).slice(0, 3) + '****' + String(p.apiKey).slice(-4),
      models: models.providerModels(p).map((m) => ({ id: m.id, capabilities: m.capabilities, verified: m.verified || null, source: m.source || 'auto' })),
      capabilities: store.capabilitiesOf(p)
    }))
  };
});

/** 新增/更新供应商 */
register('providers_upsert', async (ctx, args) => {
  const id = args.id || undefined;
  const saved = store.upsert({
    id, name: args.name, type: args.type, baseUrl: args.baseUrl, apiKey: args.apiKey,
    enabled: args.enabled !== false, mediaProtocol: args.mediaProtocol,
    imageModel: args.imageModel, videoModel: args.videoModel,
    ttsModel: args.ttsModel, visionModel: args.visionModel,
    models: args.models
  });
  return { ok: true, providerId: saved.id };
});

/** 删除供应商 */
register('providers_remove', async (ctx, args) => {
  const ok = store.removeProvider(String(args.id || ''));
  return { ok, removed: ok };
});

/** 设置某供应商的模型池（覆盖显式 models） */
register('providers_set_models', async (ctx, args) => {
  const p = store.setProviderModels(String(args.id || ''), Array.isArray(args.models) ? args.models : []);
  if (!p) throw new Error('iris: 供应商不存在');
  return { ok: true };
});

/**
 * 模型发现（P2）：GET /models 拉全量 → 按规则过滤出媒体能力模型 → 写入显式池。
 * 免费只读；拉不到/不支持则原样保留现有池（优雅降级），报人话错误。
 */
register('providers_discover', async (ctx, args) => {
  const p = store.providerById(String(args.id || ''));
  if (!p) throw new Error('iris: 供应商不存在或未启用');
  let ids;
  try {
    ids = await adapters.listModels({ key: p.apiKey, baseUrl: p.baseUrl });
  } catch (err) {
    throw new Error('iris: 模型发现失败（保留现有池）：' + String(err.message || err));
  }
  const media = [];
  for (const id of ids) {
    const caps = models.capabilitiesOfModel(id);
    if (caps.length) media.push({ id, capabilities: caps });
  }
  if (!media.length) {
    return { ok: true, total: ids.length, media: 0, text: `[iris] ${p.name}：拉到 ${ids.length} 个模型，无媒体能力匹配——可在模型池区手动添加并标能力` };
  }
  store.setProviderModels(p.id, media);
  return { ok: true, total: ids.length, media: media.length, text: `[iris] ${p.name}：发现 ${ids.length} 个模型，${media.length} 个媒体能力模型已入池（按能力标注）` };
});

/** 能力实测（红色测试图）：对某供应商的 vision 模型跑 testVisionCapability */
register('providers_test_vision', async (ctx, args) => {
  const p = store.providerById(String(args.id || ''));
  if (!p) throw new Error('iris: 供应商不存在');
  const visionProviders = store.pickAllFor(cap.CAPABILITIES.VISION).filter((x) => x.id === p.id);
  if (!visionProviders.length) return { ok: true, tested: false, text: '该供应商未配置 vision 模型，跳过' };
  const backends = buildVisionBackends(ctx, { providers: visionProviders });
  const backend = backends[0];
  if (!backend) return { ok: true, tested: false, text: '该供应商的 vision 配置不可用（类型非 openai）' };
  const r = await testVisionCapability(backend, { timeoutMs: 15000, signal: args._signal });
  return {
    ok: true,
    tested: true,
    passed: r.ok,
    text: r.ok
      ? `[iris] 视觉能力实测通过：模型认出红色测试图（${backend.model}）`
      : `[iris] 视觉能力实测未通过：${r.error || '未识别出红色'}`
  };
});

/* ============ 模型池逐模型管理（阶段 9 P3：手动增删改 + 逐能力实测） ============ */

/** 按能力实测单个模型；返回 {ok, note}。image/video 会产生真实调用（成本已在 UI 标注）。 */
async function probeModel(ctx, p, modelId, capability) {
  if (capability === cap.CAPABILITIES.VISION) {
    const backend = buildVisionBackends(ctx, { providers: [p], model: modelId })[0];
    if (!backend) return { ok: false, note: '非 openai 类型，无法直测' };
    const r = await testVisionCapability(backend, { timeoutMs: 15000, signal: null });
    return { ok: r.ok, note: r.ok ? '认出红色测试图' : (r.error || '未识别出红色') };
  }
  if (capability === cap.CAPABILITIES.TTS) {
    const r = await adapters.synthesizeTts({ key: p.apiKey, model: modelId, text: '你好', voice: 'Cherry' });
    const ok = !!(r.audioUrl || r.audioB64);
    return { ok, note: ok ? '合成返回音频' : '无音频返回' };
  }
  if (capability === cap.CAPABILITIES.IMAGE) {
    if ((p.mediaProtocol || 'dashscope') === 'openai-images') {
      const outs = await adapters.openAiGenerateImage({ key: p.apiKey, baseUrl: p.baseUrl, model: modelId, prompt: 'red circle', size: '256x256', n: 1 });
      return { ok: outs.length > 0, note: outs.length ? '生成返回图片' : '无图片返回' };
    }
    const taskId = await adapters.submitImage({ key: p.apiKey, model: modelId, prompt: '红色圆形', size: '512*512', n: 1 });
    // 有界轮询到终态（图像通常 5–15s）
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await adapters.pollTask({ key: p.apiKey, remoteTaskId: taskId });
      if (st.done) return { ok: st.ok && (st.urls || []).length > 0, note: st.ok ? '生成成功' : (st.message || '生成失败') };
    }
    return { ok: false, note: '生成超时（>60s）' };
  }
  if (capability === cap.CAPABILITIES.VIDEO) {
    // 视频渲染太慢太贵：只做提交受理（证明模型 id 有效 + 鉴权 + 参数），不等成片
    const taskId = await adapters.submitVideo({ key: p.apiKey, model: modelId, prompt: 'test', size: '480*832' });
    return { ok: !!taskId, note: taskId ? '提交受理（未等成片）' : '无 task_id' };
  }
  return { ok: false, note: '未知能力' };
}

/** 手动添加模型到池（能力可选，缺省按规则推断） */
register('providers_add_model', async (ctx, args) => {
  const id = String(args.id || '');
  const modelId = String(args.model_id || '').trim();
  if (!modelId) throw new Error('iris: model_id 不能为空');
  const caps = Array.isArray(args.capabilities) && args.capabilities.length
    ? args.capabilities.filter((c) => cap.isKnownCapability(c))
    : models.capabilitiesOfModel(modelId);
  const entry = store.addProviderModel(id, modelId, caps);
  if (!entry) throw new Error('iris: 供应商不存在');
  return { ok: true, text: `[iris] 已添加模型 ${modelId}（能力：${caps.join(',') || '未标注'}）` };
});

/** 从池移除模型 */
register('providers_remove_model', async (ctx, args) => {
  const ok = store.removeProviderModel(String(args.id || ''), String(args.model_id || ''));
  if (!ok) throw new Error('iris: 模型不在池中');
  return { ok: true, text: `[iris] 已移除模型 ${args.model_id}` };
});

/** 纠正某模型的能力标签 */
register('providers_set_model_caps', async (ctx, args) => {
  const caps = (Array.isArray(args.capabilities) ? args.capabilities : []).filter((c) => cap.isKnownCapability(c));
  const ok = store.setModelCapabilities(String(args.id || ''), String(args.model_id || ''), caps);
  if (!ok) throw new Error('iris: 模型不在池中');
  return { ok: true, text: `[iris] ${args.model_id} 能力已设为：${caps.join(',') || '（空）'}` };
});

/** 逐模型实测某能力 → 存 verified（"test it, don't guess it"；用户手动触发，发现不自动跑） */
register('providers_test_model', async (ctx, args) => {
  const p = store.providerById(String(args.id || ''));
  if (!p) throw new Error('iris: 供应商不存在或未启用');
  const modelId = String(args.model_id || '').trim();
  const capability = String(args.capability || '').trim();
  if (!modelId || !cap.isKnownCapability(capability)) throw new Error('iris: 需 model_id 与合法 capability');
  let result;
  try {
    result = await probeModel(ctx, p, modelId, capability);
  } catch (err) {
    result = { ok: false, note: String(err.message || err) };
  }
  store.setModelVerified(p.id, modelId, capability, result);
  return {
    ok: true,
    passed: result.ok,
    text: `[iris] ${modelId} · ${capability} 实测${result.ok ? '通过' : '未通过'}：${result.note}`
  };
});

/* ============ 能力分配动作（阶段 6 条目 4） ============ */

/** 查询：全部分配 + 每个能力可用的模型池（client 渲染下拉/排序） */
register('assignments_get', async (ctx, args) => {
  const pool = models.modelPool(store.allProviders());
  const byCap = {};
  for (const m of pool) {
    for (const c of m.capabilities) {
      if (!byCap[c]) byCap[c] = [];
      if (!byCap[c].some((x) => x.id === m.id)) byCap[c].push({ id: m.id, providerId: m.providerId });
    }
  }
  // order：归一化的有序分配列表（GUI 直接渲染 failover 顺序，无需处理单字符串旧格式）
  const order = {};
  for (const c of Object.keys(byCap)) order[c] = store.assignmentOrder(c);
  return { ok: true, assignments: store.assignments(), order, poolByCapability: byCap };
});

/**
 * 设置某能力分配：
 *   model_ids 数组 = 有序 failover 列表（空数组 = 清除，回退池顺序自动）；
 *   model_id 单值 = 兼容旧写法（清除该能力其余分配）。
 */
register('assignments_set', async (ctx, args) => {
  const capability = String(args.capability || '').trim();
  if (!capability) throw new Error('iris: capability 不能为空');
  if (Array.isArray(args.model_ids)) {
    const ids = args.model_ids.map((x) => String(x || '').trim()).filter(Boolean);
    if (!store.setAssignmentOrder(capability, ids)) {
      throw new Error('iris: 分配列表含不在全局池中或不具备该能力的模型');
    }
    return { ok: true, capability, model_ids: ids };
  }
  const modelId = args.model_id ? String(args.model_id).trim() : '';
  const ok = modelId ? store.setAssignment(capability, modelId) : store.clearAssignment(capability);
  if (!ok) throw new Error('iris: 该模型不在全局池中或不具备此能力');
  return { ok: true, capability, model_id: modelId };
});

/* ============ 音频转写（阶段 7.2） ============ */

register('transcribe', async (ctx, args, { signal }) => {
  const p = String(args.audio_path || '').trim();
  if (!p || !path.isAbsolute(p)) throw new Error('iris: audio_path 必须是绝对路径');
  if (!fs.existsSync(p)) throw new Error('iris: 音频文件不存在');
  const provider = store.pickFor(cap.CAPABILITIES.TTS); // 复用 TTS 供应商（同百炼 key）
  if (!provider) throw new Error('iris: 没有可用供应商');
  const model = args.model ? String(args.model) : (provider.ttsModel ? String(provider.ttsModel).replace(/tts.*/i, 'audio-turbo') : 'qwen-audio-turbo');
  const task = tasks.create({ cap: 'transcribe', providerId: provider.id, providerName: provider.name, model, prompt: 'audio transcribe: ' + path.basename(p) });
  // 上传到百炼临时存储（oss://）+ 提交；任一抛错即标 failed，不留 running 孤儿
  const remoteTaskId = await tasks.submitGuard(task, async () => {
    const audioUrl = await adapters.uploadTempFile({ key: provider.apiKey, model, filePath: p });
    return adapters.submitTranscription({ key: provider.apiKey, model, audioUrl });
  });
  tasks.update(task.id, { remoteTaskId });
  tasks.watch(tasks.get(task.id), {
    key: () => provider.apiKey,
    poll: async ({ key, remoteTaskId }) => {
      const r = await adapters.pollTranscriptionTask({ key, remoteTaskId });
      return { done: r.done, ok: r.ok, urls: r.text ? [r.text] : [], message: r.message };
    },
    intervalMs: 2500,
    onSuccess: async (t, r) => {
      // 转写文本存到任务记录（text 字段），无文件产物
      tasks.update(t.id, { transcribeText: (r.urls && r.urls.join('')) || '' });
      return [];
    }
  });
  return { ok: true, taskId: task.id, text: `[iris] 音频转写任务已提交（${model}，task: ${task.id}）` };
});

/* ============ 视频抽帧（阶段 7.1） ============ */

register('video_frames', async (ctx, args, { signal }) => {
  const p = String(args.video_path || '').trim();
  if (!p || !path.isAbsolute(p)) throw new Error('iris: video_path 必须是绝对路径');
  if (!fs.existsSync(p)) throw new Error('iris: 视频文件不存在');
  if (!ffmpegAvailable()) throw new Error('iris: ffmpeg/ffprobe 不可用，无法抽帧（可选安装 ffmpeg 后启用）');
  const meta = probeVideo(p);
  const frames = await extractFrames({
    inputPath: p, maxFrames: args.max_frames, targetWidth: args.target_width,
    format: args.format || 'jpeg', quality: args.quality, signal
  });
  const mime = args.format === 'png' ? 'image/png' : 'image/jpeg';
  const summary = frames.map((f, i) =>
    `帧${i + 1} @${f.atSec.toFixed(1)}s  ${f.width}x${f.height}  ${(f.buffer.length / 1024).toFixed(0)}KB`
  ).join('\n');
  // 首帧预览 base64
  const firstFrame = `data:${mime};base64,${frames[0].buffer.toString('base64')}`;
  return {
    ok: true,
    text: `[iris] 视频抽帧完成：${frames.length} 帧（${meta.durationSec.toFixed(1)}s ${meta.width}x${meta.height}，${mime === 'image/png' ? 'PNG' : 'JPEG'}）\n${summary}\n\n（预览为首帧；全部帧请用对话工具 iris_video_frames 获取 attachment）`,
    imageDataUrl: firstFrame
  };
});

/* ============ 多模态视频摘要（阶段 7.3，GUI 同步快速版） ============ */

register('media_summarize', async (ctx, args, { signal }) => {
  const p = String(args.video_path || '').trim();
  if (!p || !path.isAbsolute(p)) throw new Error('iris: video_path 必须是绝对路径');
  if (!fs.existsSync(p)) throw new Error('iris: 视频文件不存在');
  if (!ffmpegAvailable()) throw new Error('iris: ffmpeg/ffprobe 不可用，无法分析视频（可选安装 ffmpeg 后启用）');
  const meta = probeVideo(p);
  const frames = await extractFrames({
    inputPath: p, maxFrames: Math.min(Number(args.max_frames) || 8, 12), targetWidth: args.target_width,
    format: 'jpeg', quality: 70, signal
  });
  const sheet = await buildContactSheet({ frames, cols: 3 });
  const backends = buildVisionBackends(ctx, { providers: store.pickAllFor(cap.CAPABILITIES.VISION), model: args.model });
  const { answer, via, model } = await summarizeMedia({
    backends, question: args.question,
    transcript: args.transcribe_text, // GUI 同步版：不自动转写，可粘贴已有转写文本
    imageDataUrl: `data:image/png;base64,${sheet.buffer.toString('base64')}`,
    signal
  });
  const viaLabel = via === 'selfstack' ? 'iris 自持栈' : 'DSH 全局视觉模型';
  const hasTrans = args.transcribe_text && String(args.transcribe_text).trim();
  return {
    ok: true,
    text: `[iris] 视频摘要完成（${model} · ${viaLabel}，${meta.durationSec.toFixed(1)}s / ${frames.length} 帧联系表${hasTrans ? ' + 转写文本' : ''}）：\n${answer}`,
    imageDataUrl: `data:image/png;base64,${sheet.buffer.toString('base64')}`
  };
});
