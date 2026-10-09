'use strict';
/**
 * dsh-iris —— Host 入口。
 * 给 DSH 装上眼睛和双手：多供应商媒体生成 + 视觉路由 + Iris 工作台。
 * M2：新增视频生成（文生/图生）；全部异步生成统一走任务盯守框架
 *     （提交即盯守、工具内等待超时自动转后台、DSH 重启后恢复接管）。
 * 架构纪律：无独立后台，与 DSH 俱荣俱损——定时器归 Fiber，产物落 $DSH_HOME。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as adapters from './adapters.js';
import * as store from './config.js';
import * as cap from './capability.js';
import * as tasks from './tasks.js';
import { registerMedia, mediaLinksOf, authorizeMedia, serveMedia } from './media.js';
import { serveApi, closeAllSse, purgeStaleUploads } from './api.js';
import { runVisionRequest, readVisionImageFile } from './vision-model-routing.js';
import { waitForModelWork } from './model-call-runtime.js';
import { hasHostPort, requireHostPort } from './host-contract.js';
import { createDshHostAdapter } from './dsh-host-adapter.js';
import { cropForDsh, diffForDsh, framesForDsh, summaryFramesForDsh, visionImageForDsh, htmlForDsh, inspectProviderTaskForDsh, projectCoreTaskForDsh, readCoreArtifactMediaForDsh, resumeProviderTaskWatchesForDsh, stopProviderTaskWatchesForDsh } from './dsh-core-adapter.js';
import { imageDimensions } from './pixels.js';
import { runLocateRequest, runSummaryRequest, describeGeneratedImage } from './composite-vision-routing.js';
import { normalizeSummarySource, summaryFrameRecords, summaryTimelineLabel } from './summary-input.js';
import { normalizeVisionImageSource } from './vision-input.js';
import { serveRender } from './render.js';
import { ensurePrivateDir, hardenPrivateTree } from './private-storage.js';
import { guarded } from './guard.js';
import { formatOcrResult } from './ocr.js';
import { runOcrRequest } from './ocr-model-routing.js';
import { runAction, listActions, taskPollDeps } from './actions.js';
import { ffmpegAvailable, extractFrames, probeVideo, extractAudioTrack } from './media-probe.js';
import { registerBundledSkills } from './bundled-skills.js';
import {
  EXPECTED_IRIS_ROUTES, IRIS_PLUGIN_ID, beginHostRuntime, recordHostRoutes, recordHostSkills, recordHostTool
} from './host-runtime.js';
export { doctor, formatDoctorReport, hostDoctor } from './doctor.js';

const PACKAGE_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown'; }
  catch (_) { return 'unknown'; }
})();

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

/** DSH 私有对象只在宿主边界转换；可选服务可能晚到，因此按操作刷新快照。 */
function dshHost(ctx) {
  return createDshHostAdapter(ctx);
}

/** 工具内同步等待上限；超过即转后台盯守，用 iris_task_status 查询 */
const AWAIT_MS = { image: 180000, video: 480000, transcribe: 120000 };

function outputDir() {
  const dir = tasks.outputsDir();
  return ensurePrivateDir(dir);
}

/* ---------------- 媒体路由：/iris/media/:taskId/:token/:name ---------------- */

let mediaRouteMounted = false;
function mountIrisRoutes(routeCtx) {
  // Cordis 服务只在 DSH 宿主边界探测；Command 与通用工具辅助函数不接收原始 ctx
  const host = dshHost(routeCtx);
  const reg = hasHostPort(host, 'routes') ? host.ports.routes : undefined;
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
      handler: guarded((req, res) => serveApi(req, res, dshHost(routeCtx)))
    });
    const disposeRender = reg.register({
      kind: 'prefix',
      path: '/iris/render',
      handler: guarded(serveRender)
    });
    mediaRouteMounted = true;
    recordHostRoutes(EXPECTED_IRIS_ROUTES);
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

/** 向后兼容导出；真实实现与人工接管共用 actions.taskPollDeps。 */
export function pollDeps(provider, cap) {
  return taskPollDeps(provider, { cap });
}

/** 旧 status 与 Task v2 事实轴共同决定工具是否应停止等待。 */
export function taskWaitFinished(task) {
  if (!task) return false;
  if (task.status !== 'running') return true;
  return tasks.isV2Task(task) && task.phase === 'terminal';
}

/** 把 v2 正交事实转换成不会误导用户的工具错误；空串表示已成功可交付。 */
export function taskTerminalProblem(task, label = '任务') {
  if (!task) return label + '记录不存在';
  if (!tasks.isV2Task(task)) {
    if (task.status === 'canceled') return '已取消';
    if (task.status !== 'succeeded') return label + '失败：' + (task.error || '未知原因');
    return '';
  }
  if (task.outcome === 'succeeded' && task.deliveryState === 'ready') return '';
  if (task.outcome === 'succeeded' && task.deliveryState === 'failed') {
    return label + '已成功，但产物交付失败：' + (task.error || '可稍后重新交付；禁止重新生成');
  }
  if (task.acceptance === 'unknown' || task.outcome === 'unknown') {
    return label + '的远端受理或结果状态未知：' + (task.error || '禁止自动重提，请先人工确认');
  }
  if (task.cancelState === 'unknown') {
    return label + '的远端取消状态未知：' + (task.error || '请先人工确认');
  }
  if (task.outcome === 'canceled') return '已取消';
  if (task.outcome === 'failed') return label + '失败：' + (task.error || '供应商明确返回失败');
  return task.phase === 'terminal'
    ? label + '需要人工处理：' + (task.error || '状态未能自动收口')
    : '';
}

/**
 * 在工具调用内同步等待任务到终态。
 * @returns 终态任务记录；null = 等待超时（任务已转后台继续盯守）
 * @throws 取消时抛错并记录保守取消事实
 */
async function awaitTerminal(taskId, { timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal && signal.aborted) {
      tasks.cancel(taskId, '用户取消');
      throw new Error('已取消');
    }
    const t = tasks.get(taskId);
    if (taskWaitFinished(t)) return t;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function coreTaskWaitFinished(task) {
  return Boolean(task && (task.phase === 'terminal'
    || (task.outcome === 'succeeded' && ['ready', 'failed'].includes(task.deliveryState))));
}

function coreTaskTerminalProblem(task, label = '任务') {
  if (!task) return label + '记录不存在';
  if (task.outcome === 'succeeded' && task.deliveryState === 'ready') return '';
  if (task.outcome === 'succeeded' && task.deliveryState === 'failed') {
    return label + '已成功，但 Core Artifact 交付失败：'
      + (task.lastError?.safeMessage || '可稍后重新交付；禁止重新生成');
  }
  if (task.acceptance === 'unknown' || task.outcome === 'unknown') {
    return label + '的远端受理或结果状态未知：'
      + (task.lastError?.safeMessage || '禁止自动重提，请先人工确认');
  }
  if (task.outcome === 'canceled') return label + '已取消';
  if (task.outcome === 'failed') return label + '失败：'
    + (task.lastError?.safeMessage || '供应商明确返回失败');
  return label + '需要人工处理';
}

async function awaitCoreTerminal(taskId, { timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error('已取消；Core 任务仍保留远端受理事实，可稍后查询');
    const task = await inspectProviderTaskForDsh(taskId, { signal });
    if (coreTaskWaitFinished(task)) return task;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export const name = 'mokuyoaxis-dsh-iris';
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
function safeRegister(host, definition) {
  let registered = false;
  guard(`工具注册 ${definition && definition.name}`, () => {
    requireHostPort(host, 'tools', '注册 Agent 工具').register(definition);
    registered = true;
  });
  if (registered) recordHostTool(definition.name);
}

export async function apply(ctx) {
  beginHostRuntime({ pluginId: IRIS_PLUGIN_ID, version: PACKAGE_VERSION });
  guard('Iris 私有存储权限收紧', () => hardenPrivateTree(store.irisHome()));

  guard('上传临时文件清理', () => purgeStaleUploads());

  // 仅按用户显式指定的路径导入旧配置；不扫描其他项目。
  guard('工作台导入', () => {
    const wb = process.env.IRIS_IMPORT_WORKBENCH_CONFIG;
    if (!wb) return;
    if (!path.isAbsolute(wb)) throw new Error('IRIS_IMPORT_WORKBENCH_CONFIG 必须是绝对路径');
    const imported = store.importFromWorkbench(wb);
    if (imported.imported) console.log(`[iris] 已从工作台导入 ${imported.imported} 个服务商`);
    else console.log('[iris] 工作台导入：' + imported.reason);
  });

  // 接管上次进程未跑完的异步任务（恢复循环本身在 tasks.js 里逐任务防御）
  guard('恢复后台任务', () => {
    const resumed = tasks.resumePending((t) => {
      const p = store.providerById(t.providerId);
      return p ? pollDeps(p, t.cap) : null;
    });
    if (resumed.length) console.log(`[iris] 已恢复接管 ${resumed.length} 个后台任务`);
  });

  try {
    const resumed = await resumeProviderTaskWatchesForDsh();
    if (resumed.length) console.log(`[iris] 已恢复接管 ${resumed.length} 个 Core 图片任务`);
  } catch (error) {
    console.error('[iris] 恢复 Core 图片后台任务失败（已隔离，不影响宿主）:', error?.message || error);
  }

  // Fiber 清理：插件停用/更新时停掉 legacy 与 Core 的全部 Host 盯守句柄
  guard('盯守句柄注册', () => {
    ctx.effect(() => () => {
      tasks.stopWatchAll();
      stopProviderTaskWatchesForDsh();
    });
  });

  // 媒体路由（视频/音频在对话流里的可播通路；图片仍走原生附件）
  ctx.inject(['webServer'], mountIrisRoutes);
  ctx.inject(['httpServer'], mountIrisRoutes);
  // 若 webServer 已在运行，inject 回调也会触发；这里兜底立即挂载一次
  guard('媒体路由兜底挂载', () => mountIrisRoutes(ctx));

  // DSH 的 Skill registry 是可选宿主能力。存在时把 npm 包内两项 Skill 注册到
  // 全局层；项目目录中的同名 Skill 仍由 DSH 原生优先级覆盖。
  ctx.inject(['skills'], (skillCtx) => {
    guard('随包 Skill 注册', () => {
      const names = registerBundledSkills(dshHost(skillCtx));
      recordHostSkills(names);
      console.log('[iris] 随包 Skill 已注册：' + names.join(' · '));
    });
  });

  const host = dshHost(ctx);
  if (!hasHostPort(host, 'tools')) {
    console.error('[iris] tools 服务不可用，跳过全部工具注册（宿主不受影响）');
    return;
  }

  async function coreImageToolResult(submitted, prompt, signal) {
    let final = await inspectProviderTaskForDsh(submitted.taskId, { signal });
    if (!coreTaskWaitFinished(final)) final = await awaitCoreTerminal(submitted.taskId, { timeoutMs: AWAIT_MS.image, signal });
    if (!final) return { blocks: [{ type: 'text', text: `[iris] Core 图片任务仍在后台观察（task: ${submitted.taskId}）。稍后可用 iris_task_status 查询进度与 Artifact。` }] };
    const terminalProblem = coreTaskTerminalProblem(final, '图像生成');
    if (terminalProblem) throw new Error(terminalProblem);
    const projected = await projectCoreTaskForDsh(dshHost(ctx), submitted.taskId, { signal });
    const refs = projected.artifacts.map((item) => item.attachment);
    const blocks = projected.artifacts.map((item) => ({ type: 'image', attachment: item.attachment }));
    let note = '';
    try {
      const described = await describeGeneratedImage(dshHost(ctx), {
        providers: store.pickAllFor(cap.CAPABILITIES.VISION), onRateLimit: store.recordRateLimit, originalPrompt: prompt, signal,
        async prepareImage(inputSignal) {
          const first = await readCoreArtifactMediaForDsh(projected.artifacts[0].artifact.id, { signal: inputSignal });
          return { bytes: new Uint8Array(first.bytes), mediaType: first.artifact.mediaType };
        }
      });
      if (described) note = `画面内容：${described}`;
    } catch (_) { /* 自述失败不影响 Core 交付 */ }
    blocks.unshift({ type: 'text', text:
      `[iris] 图像已生成（${submitted.model}，Core task: ${submitted.taskId}）。` +
      (submitted.sourceArtifactId ? `\n原图 artifact: ${submitted.sourceArtifactId}` : '') +
      (note ? `\n${note}` : '') +
      `\nartifact: ${projected.artifacts.map((item) => item.artifact.id).join(', ')}` +
      `\nattachment: ${refs.map((ref) => ref.attachmentId).join(', ')}`
    });
    return { blocks };
  }

  /* ---------- 🖼️ 画图 ---------- */
  safeRegister(host, {
    name: 'iris_draw_image',
    description:
      'Generate an image from a detailed prompt using the user-configured image model and its configured image protocol. ' +
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
      const submitted = await runAction(dshHost(ctx), 'image', args, { signal: exec.signal });
      if (submitted.storage === 'core') {
        return coreImageToolResult(submitted, prompt, exec.signal);
      }
      let final = tasks.get(submitted.taskId);
      if (final && !taskWaitFinished(final)) {
        final = await awaitTerminal(submitted.taskId, { timeoutMs: AWAIT_MS.image, signal: exec.signal });
      }
      if (!final) {
        return { blocks: [{ type: 'text', text: `[iris] 图像任务仍在后台盯守（task: ${submitted.taskId}）。稍后可用 iris_task_status 查询进度与文件路径。` }] };
      }
      const terminalProblem = taskTerminalProblem(final, '图像生成');
      if (terminalProblem) throw new Error(terminalProblem);

      const files = (final.files || []).map((f) => path.join(outputDir(), f));
      const blocks = [];
      const refs = [];
      for (const f of files) {
        const mediaType = MEDIA_TYPES[path.extname(f).toLowerCase()] || 'image/png';
        const ref = await attachmentService(host).saveImage({ data: new Uint8Array(fs.readFileSync(f)), mediaType, name: path.basename(f) });
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
        const described = await describeGeneratedImage(dshHost(ctx), {
          providers: store.pickAllFor(cap.CAPABILITIES.VISION), onRateLimit: store.recordRateLimit, originalPrompt: prompt, signal: exec.signal,
          prepareImage: signal => readVisionImageFile(files[0], MEDIA_TYPES[path.extname(files[0]).toLowerCase()] || 'image/png', signal)
        });
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

  safeRegister(host, {
    name: 'iris_edit_image',
    description: 'Edit an existing Core image by Artifact ID and an instruction using a configured openai-chat-images model. Returns new Core Artifacts and DSH image attachments; preserves the source image and records its provenance.',
    parameters: {
      type: 'object', properties: {
        source_artifact_id: { type: 'string', description: 'Core Artifact ID of the source PNG, JPEG or WebP image (up to 20 MiB)' },
        prompt: { type: 'string', description: 'Describe the changes and what should be preserved in the source image' },
        model: { type: 'string', description: 'Optional providerId::modelId; image protocol must be openai-chat-images' },
        n: { type: 'string', description: "Number of images, default '1'" }
      }, required: ['source_artifact_id', 'prompt']
    },
    output: { schema: { type: 'object' }, render: (_args, value) => value.blocks },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const submitted = await runAction(dshHost(ctx), 'image_edit', args, { signal: exec.signal });
      return coreImageToolResult(submitted, String(args.prompt || '').trim(), exec.signal);
    }
  });

  /* ---------- 🎬 视频生成 ---------- */
  safeRegister(host, {
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
        prompt: { type: 'string', description: 'Motion/scene description, required for t2v/i2v; optional for s2v' },
        first_frame_attachment_id: { type: 'string', description: 'Attachment id of an image generated by iris_draw_image, used as the first frame' },
        first_frame_path: { type: 'string', description: 'Absolute path to a local image used as the first frame (alternative to attachment id)' },
        audio_path: { type: 'string', description: 'Absolute path to a wav/mp3 file (<15MB, <20s, clear human voice). Required for s2v models like wan2.2-s2v' },
        resolution: { type: 'string', description: "s2v only: output tier '480P' (default) or '720P'" },
        size: { type: 'string', description: "t2v/i2v only: output size 'W*H', e.g. '1280*720' (default)" },
        duration: { type: 'number', description: 't2v/i2v only: duration in seconds, if the model supports it' },
        model: { type: 'string', description: 'Override with a providerId::modelId reference (legacy bare model id accepted)' }
      },
      required: []
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const submitted = await runAction(dshHost(ctx), 'video', { ...args, session_id: exec.agent?.session?.id }, { signal: exec.signal });
      if (submitted.storage === 'core') {
        let final = await inspectProviderTaskForDsh(submitted.taskId, { signal: exec.signal });
        if (!coreTaskWaitFinished(final)) {
          final = await awaitCoreTerminal(submitted.taskId, { timeoutMs: AWAIT_MS.video, signal: exec.signal });
        }
        if (!final) {
          return `[iris] Core 视频任务已提交并转入后台观察（task: ${submitted.taskId}，remoteTask: ${submitted.remoteTaskId}）。\n` +
            '渲染通常需要数分钟；完成后用 iris_task_status 查询进度与 Artifact，或在工作台「重新观察」。';
        }
        const terminalProblem = coreTaskTerminalProblem(final, '视频生成');
        if (terminalProblem) throw new Error(terminalProblem);
        const secs = Math.round((Date.now() - new Date(final.createdAt).getTime()) / 1000);
        const links = final.artifactIds.map((artifactId) =>
          '/iris/api/core/artifact/' + encodeURIComponent(artifactId) + '/media');
        return `[iris] 视频已生成（${submitted.model || final.modelRef}，${submitted.mode || 't2v'}，约 ${secs}s，Core task: ${final.id}）：\n` +
          `artifact: ${final.artifactIds.join(', ')}\n` +
          links.join('\n') +
          '\n（链接受 DSH Host 与浏览器同源守卫保护；Artifact ID 持有者可访问，请勿公开）';
      }
      const final = await awaitTerminal(submitted.taskId, { timeoutMs: AWAIT_MS.video, signal: exec.signal });
      if (!final) {
        return `[iris] 视频任务已提交并转入后台盯守（task: ${submitted.taskId}，remoteTask: ${submitted.remoteTaskId}）。\n` +
          '渲染通常需要数分钟；完成后用 iris_task_status 查询产物路径。';
      }
      const terminalProblem = taskTerminalProblem(final, '视频生成');
      if (terminalProblem) throw new Error(terminalProblem);
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
  safeRegister(host, {
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
      const submitted = await runAction(dshHost(ctx), 'tts', args, { signal: exec.signal });
      if (submitted.storage === 'core') {
        const final = await inspectProviderTaskForDsh(submitted.taskId, { signal: exec.signal });
        const terminalProblem = coreTaskTerminalProblem(final, '语音合成');
        if (terminalProblem) throw new Error(terminalProblem);
        const links = final.artifactIds.map((artifactId) =>
          '/iris/api/core/artifact/' + encodeURIComponent(artifactId) + '/media');
        return `[iris] 语音已合成（${submitted.model || final.modelRef}，Core task: ${final.id}）：\n` +
          `artifact: ${final.artifactIds.join(', ')}\n` +
          links.map((link) => `[♪ 音频播放](${link})`).join('\n');
      }
      const final = tasks.get(submitted.taskId);
      const terminalProblem = taskTerminalProblem(final, '语音合成');
      if (terminalProblem) throw new Error(terminalProblem);
      const fileName = (final.files || [])[0];
      const p = path.join(outputDir(), fileName);
      const media = (final.media || [])[0];
      return `[iris] 语音已合成（${submitted.model || final.model}）：${p}\ntask: ${final.id}` +
        (media ? `\n[♪ 音频播放](${mediaLinksOf(final)[0]})` : '');
    }
  });

  /* ---------- 🎙️ 音频转写（阶段 7.2） ---------- */
  safeRegister(host, {
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
      const submitted = await runAction(dshHost(ctx), 'transcribe', args, { signal: exec.signal });
      if (submitted.storage === 'core') {
        let final = await inspectProviderTaskForDsh(submitted.taskId, { signal: exec.signal });
        if (!coreTaskWaitFinished(final)) {
          final = await awaitCoreTerminal(submitted.taskId, { timeoutMs: AWAIT_MS.transcribe, signal: exec.signal });
        }
        if (!final) {
          return `[iris] Core 转写任务已提交并转入后台观察（task: ${submitted.taskId}）。完成后用 iris_task_status 查询进度与 Artifact。`;
        }
        const terminalProblem = coreTaskTerminalProblem(final, '音频转写');
        if (terminalProblem) throw new Error(terminalProblem);
        const texts = [];
        for (const artifactId of final.artifactIds) {
          const media = await readCoreArtifactMediaForDsh(artifactId, { signal: exec.signal });
          texts.push(Buffer.from(media.bytes).toString('utf8'));
        }
        return `[iris] 音频转写完成（${submitted.model || final.modelRef}，Core task: ${final.id}）：\n` +
          texts.join('\n') +
          `\nartifact: ${final.artifactIds.join(', ')}`;
      }
      const final = await awaitTerminal(submitted.taskId, { timeoutMs: 120000, signal: exec.signal });
      if (!final) return `[iris] 音频转写任务已提交并转入后台（task: ${submitted.taskId}）。完成后用 iris_task_status 查询。`;
      const terminalProblem = taskTerminalProblem(final, '音频转写');
      if (terminalProblem) throw new Error(terminalProblem);
      return `[iris] 音频转写完成（${submitted.model || final.model}）：\n${final.transcribeText || ''}`;
    }
  });

  /* ---------- 🎞️ 视频抽帧（阶段 7.1，ffmpeg 可选） ---------- */
  safeRegister(host, {
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
      const { media: meta, frames } = await framesForDsh({
        videoPath: args.video_path,
        maxFrames: args.max_frames,
        targetWidth: args.target_width,
        format: args.format,
        quality: args.quality,
        signal: exec.signal
      });
      const mediaType = frames[0].mediaType;
      const ext = mediaType === 'image/png' ? 'png' : 'jpg';
      const blocks = [];
      const refs = [];
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const ref = await attachmentService(host).saveImage({
          data: new Uint8Array(f.bytes),
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
          `frame_artifact_ids: ${JSON.stringify(frames.map(f => f.artifact.id))}\n` +
          `attachments: ${refs.map((r) => r.attachmentId).join(', ')}`
      });
      return { blocks, artifactIds: frames.map((frame) => frame.artifact.id) };
    }
  });

  /* ---------- 📝 多模态视频摘要（阶段 7.3，ffmpeg 可选） ---------- */
  safeRegister(host, {
    name: 'iris_media_summarize',
    description:
      'Summarize a local video or existing Core video-frame Artifacts as one contact sheet (with timestamps) plus an optional ' +
      'auto-transcribed audio track, then asking the vision model to describe content. Returns the summary text plus the contact sheet as a DSH image attachment. ' +
      'Provide exactly one of video_path or frame_artifact_ids. Existing frames are read in timestamp order without ffmpeg or the original video. ' +
      'The video_path mode requires ffmpeg + ffprobe and can auto-transcribe the audio track with the configured provider.',
    parameters: {
      type: 'object',
      properties: {
        video_path: { type: 'string', description: 'Absolute path to the local video file (mp4/webm/mov etc.)' },
        frame_artifact_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, uniqueItems: true,
          description: 'Existing Core video-frame IDs from iris_video_frames; sorted by timestamp. Use instead of video_path, without sampling options or auto-transcription.' },
        question: { type: 'string', description: 'Custom question about the video content (default: summarize scenes/theme)' },
        max_frames: { type: 'integer', description: 'Frames to sample for the contact sheet, clamped to 1..12 (default 8)' },
        target_width: { type: 'integer', description: 'Frame width for sampling (default 640)' },
        transcribe: { type: 'boolean', description: 'Auto-transcribe the audio track for video_path (default true unless transcribe_text is provided). Existing frames only consume explicit text.' },
        transcribe_text: { type: 'string', description: 'Optional existing transcript text; does not create a transcription task' },
        model: { type: 'string', description: 'Override the configured vision model id' }
      },
      required: []
    },
    output: { schema: { type: 'object' }, render: (_args, value) => value.blocks },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      const source = normalizeSummarySource(args);
      const p = String(args.video_path || '').trim();
      if (source === 'video') {
        if (!p || !path.isAbsolute(p)) throw new Error('iris: video_path 必须是绝对路径');
        if (!ffmpegAvailable()) throw new Error('iris: ffmpeg 不可用，无法分析视频（可选安装 ffmpeg/ffprobe 后启用）');
      }
      const { answer, via, model, sheet, meta, frames, transcriptNote } = await runSummaryRequest(dshHost(ctx), {
        providers: store.pickAllFor(cap.CAPABILITIES.VISION), onRateLimit: store.recordRateLimit, model: args.model, question: args.question, signal: exec.signal,
        async prepareMedia(signal) {
          if (source === 'core-artifacts') {
            return { ...await summaryFramesForDsh({ frameArtifactIds: args.frame_artifact_ids, signal }), transcript: args.transcribe_text };
          }
          const meta = probeVideo(p);
          const frames = await extractFrames({
            inputPath: p, maxFrames: Math.min(Number(args.max_frames) || 8, 12),
            targetWidth: args.target_width, format: 'jpeg', quality: 70, signal
          });
          // 显式选项保留自动转写；消费已完成的 Core Artifact，不重提远端任务。
          let transcript = args.transcribe_text || '', transcriptNote = '';
          if (args.transcribe !== false && !transcript.trim() && meta.hasAudio) {
            if (store.pickAllFor(cap.CAPABILITIES.TRANSCRIBE).length) {
              try {
                const audio = await extractAudioTrack({ inputPath: p, signal });
                try {
                  const submitted = await runAction(dshHost(ctx), 'transcribe', { audio_path: audio.filePath }, { signal });
                  const final = await awaitCoreTerminal(submitted.taskId, { timeoutMs: 120000, signal });
                  if (final?.outcome === 'succeeded' && final.deliveryState === 'ready') {
                    const texts = [];
                    for (const artifactId of final.artifactIds) {
                      const media = await readCoreArtifactMediaForDsh(artifactId, { signal });
                      texts.push(Buffer.from(media.bytes).toString('utf8'));
                    }
                    transcript = texts.join('\n');
                  } else transcriptNote = '\n（音轨转写未完成，本次摘要仅画面；可用 iris_task_status 查询 Core task）';
                } finally {
                  fs.rmSync(audio.outDir, { recursive: true, force: true });
                }
              } catch (err) {
                if (signal.aborted) throw signal.reason;
                transcriptNote = '\n（音轨转写失败，本次摘要仅画面；可用 iris_task_status 查询转写任务）';
              }
            } else transcriptNote = '\n（视频含音轨但未配置转写供应商，本次摘要仅画面）';
          }
          return { meta, frames, transcript, transcriptNote };
        }
      });
      // 成功摘要的同一张拼图作为显式工具产物发布。
      if (exec.signal?.aborted) throw exec.signal.reason;
      const ref = await attachmentService(host).saveImage({
        data: new Uint8Array(sheet.buffer),
        mediaType: 'image/png',
        name: `iris-sheet-${Date.now()}.png`
      });
      if (exec.signal?.aborted) throw exec.signal.reason;
      const viaLabel = via === 'selfstack' ? 'iris 自持栈' : 'DSH 全局视觉模型';
      return {
        frames: summaryFrameRecords(frames),
        blocks: [
          {
            type: 'text',
            text:
              `[iris] 视频摘要完成（${model} · ${viaLabel}，${summaryTimelineLabel(meta)} / ${frames.length} 帧联系表）：\n` +
              `${answer}${transcriptNote || ''}\n` +
              `contact sheet attachment: ${ref.attachmentId}`
          },
          { type: 'image', attachment: ref }
        ]
      };
    }
  });

  /* ---------- 👁 视觉路由（M3）：显式工具，自持栈为主 ---------- */

  safeRegister(host, {
    name: 'iris_look_at_image',
    description:
      'Look at a local image file or an existing Core image Artifact and answer one question with the configured vision model (self-hosted provider stack, then DSH default vision). Provide exactly one of image_path or artifact_id. Local files are saved as durable DSH attachments; Core images are read directly without export or Core writes.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Absolute path to the image file (png/jpg/jpeg/webp)' },
        artifact_id: { type: 'string', description: 'Existing Core image Artifact ID in the current profile (alternative to image_path)' },
        question: { type: 'string', description: 'Question or extraction request about the image; defaults to a detailed description' },
        model: { type: 'string', description: 'Override the configured vision model id (default qwen-vl-plus)' }
      },
      required: []
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const source = normalizeVisionImageSource(args);
      const p = String(args.image_path || '').trim();
      const mt = MEDIA_TYPES[path.extname(p).toLowerCase()];
      if (source === 'image_path') {
        if (!path.isAbsolute(p)) throw new Error('iris: image_path 必须是绝对路径');
        if (!mt || mt === 'image/gif') throw new Error('iris: 不支持的图片格式（png/jpg/jpeg/webp）：' + p);
        if (!fs.existsSync(p)) throw new Error('iris: 图片不存在：' + p);
      }
      const question = String(args.question || '').trim() || '详细描述这张图片。';
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');

      return runVisionTool(dshHost(ctx), exec, { origin: 'tool', model: args.model, question, artifactId: args.artifact_id,
        async prepareImage(signal) {
          if (source === 'artifact_id') return visionImageForDsh({ artifactId: args.artifact_id, signal });
          const image = await readVisionImageFile(p, mt, signal);
          await waitForModelWork(() => attachmentService(host).saveImage({ data: image.bytes, mediaType: mt, name: path.basename(p) }), signal);
          return image;
        }
      });
    }
  });

  safeRegister(host, {
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

      return runVisionTool(dshHost(ctx), exec, { origin: 'relook', model: args.model, question,
        async prepareImage(signal) {
          // 会话扫描、解引用与读图都属于这次操作的总预算。
          const hit = (await waitForModelWork(() => sessionAttachmentRef(host, exec, id), signal)) || findOwnAttachment(id);
          if (!hit) throw new Error('iris: 图片引用不可用');
          if (hit.absPath) return readVisionImageFile(hit.absPath, hit.ref.mediaType || MEDIA_TYPES[path.extname(hit.absPath).toLowerCase()] || 'image/png', signal);
          const stored = await waitForModelWork(() => attachmentService(host).readImage(hit.ref, signal), signal);
          return { bytes: new Uint8Array(stored.data), mediaType: stored.mediaType || hit.ref.mediaType };
        }
      });
    }
  });

  /* ---------- 📋 任务查询 ---------- */
  safeRegister(host, {
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
      const result = await runAction(dshHost(ctx), 'status', args || {});
      return result.text;
    }
  });

  /* ---------- ✂️ 确定性像素工具（阶段 2） ---------- */
  safeRegister(host, {
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
      const input = await resolveImageInput(dshHost(ctx), exec, {
        image_path: args.image_path,
        attachment_id: args.attachment_id
      });
      const result = await cropForDsh({
        ...(args.image_path
          ? { imagePath: String(args.image_path).trim() }
          : { bytes: input.buffer, mediaType: input.mediaType }),
        left: args.left,
        top: args.top,
        width: args.width,
        height: args.height,
        signal: exec.signal
      });
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      const ref = await attachmentService(host).saveImage({
        data: new Uint8Array(result.bytes),
        mediaType: result.mediaType,
        name: `iris-crop-${Date.now()}.png`
      });
      return {
        blocks: [
          { type: 'text', text: `[iris] 裁剪完成：${result.width}x${result.height}（原区域 ${args.left},${args.top},${args.width},${args.height}）\nattachment: ${ref.attachmentId}` },
          { type: 'image', attachment: ref }
        ]
      };
    }
  });

  safeRegister(host, {
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
      const a = await resolveImageInput(dshHost(ctx), exec, { image_path: args.image_a_path, attachment_id: args.attachment_a_id });
      const b = await resolveImageInput(dshHost(ctx), exec, { image_path: args.image_b_path, attachment_id: args.attachment_b_id });
      const result = await diffForDsh({
        imageA: { bytes: a.buffer, mediaType: a.mediaType },
        imageB: { bytes: b.buffer, mediaType: b.mediaType },
        grid: args.grid, topRegions: args.top_regions, signal: exec.signal
      });
      const { ratio, diffPixels, totalPixels, width, height, worstRegions } = result.metrics;
      const ref = await attachmentService(host).saveImage({
        data: new Uint8Array(result.bytes),
        mediaType: result.mediaType,
        name: `iris-diff-${Date.now()}.png`
      });
      const pct = (ratio * 100).toFixed(2);
      const regions = worstRegions.map((r) => `(col ${r.col},row ${r.row}) ${(r.score * 100).toFixed(1)}%`).join(' ');
      return {
        artifactIds: [result.artifact.id],
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
  safeRegister(host, {
    name: 'iris_locate',
    description:
      'Locate an object/region described by `target` in an image (exactly one of absolute image_path, Core artifact_id, or session attachment_id), ' +
      'returning the pixel bounding box (x1,y1,x2,y2) in original image coordinates. ' +
      'Use the bbox with iris_crop for path/session images or CLI run crop with artifact_id for Core images; do not treat a Core ID as a file path.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Absolute path to the source image (png/jpg/jpeg/webp)' },
        artifact_id: { type: 'string', description: 'Existing Core image Artifact ID in the current profile (alternative to image_path or attachment_id)' },
        attachment_id: { type: 'string', description: 'Session attachment id of an image (alternative to image_path)' },
        target: { type: 'string', description: 'The object or UI element to locate, e.g. "send button"' },
        model: { type: 'string', description: 'Override the vision model for this locate call (e.g. qwen3-vl-235b-a22b-thinking for higher grounding precision; default is the provider visionModel, typically qwen-vl-plus)' }
      },
      required: ['target']
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const r = await runLocateRequest(dshHost(ctx), {
        providers: store.pickAllFor(cap.CAPABILITIES.VISION), onRateLimit: store.recordRateLimit, model: args.model, target: args.target,
        prepareImage: signal => resolveVisionImageInput(dshHost(ctx), exec, args, signal), signal: exec.signal
      });
      const { width, height } = r;
      const sourceNote = args.artifact_id ? `\nCore Artifact: ${args.artifact_id}` : '';
      if (!r.found) return `[iris] 在图片中未找到「${args.target}」（${r.via} · ${r.model}）${sourceNote}`;
      if (args.artifact_id) return `[iris] 定位「${args.target}」：bbox (${r.x1},${r.y1},${r.x2},${r.y2}) / ${width}x${height}（${r.via} · ${r.model}）${sourceNote}\n` +
        `裁剪区域：left=${r.x1}, top=${r.y1}, width=${r.x2 - r.x1}, height=${r.y2 - r.y1}`;
      return `[iris] 定位「${args.target}」：bbox (${r.x1},${r.y1},${r.x2},${r.y2}) / ${width}x${height}（${r.via} · ${r.model}）\n` +
        `裁剪指令：iris_crop(image_path="${args.image_path || args.attachment_id}", left=${r.x1}, top=${r.y1}, width=${r.x2 - r.x1}, height=${r.y2 - r.y1})`;
    }
  });

  /* ---------- 🖼️ HTML 截图（阶段 3C，基于 dsh-builtin-browser） ---------- */
  safeRegister(host, {
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
      const browser = requireHostPort(dshHost(ctx), 'browser', 'HTML 截图');
      const rendered = await htmlForDsh({
        browser,
        html: args.html,
        width: args.width,
        height: args.height,
        fullPage: args.fullPage !== false,
        signal: exec.signal
      });
      const png = Buffer.from(rendered.bytes);
      const { width: outW, height: outH } = await imageDimensions(png);
      const ref = await attachmentService(host).saveImage({
        data: new Uint8Array(png),
        mediaType: 'image/png',
        name: `iris-html-${Date.now()}.png`
      });
      return {
        blocks: [
          {
            type: 'text',
            text: `[iris] HTML 截图完成（${outW}x${outH}，fullPage: ${args.fullPage !== false}）\n` +
              `artifact: ${rendered.artifact.id}\nattachment: ${ref.attachmentId}` +
              `\n注意：渲染在共享浏览器临时标签页中完成，页面短暂可见属正常行为。`
          },
          { type: 'image', attachment: ref }
        ]
      };
    }
  });

  /* ---------- 📄 长截图 OCR（阶段 3B，视觉模型分块） ---------- */
  safeRegister(host, {
    name: 'iris_long_ocr',
    description:
      'OCR a (possibly long) image from exactly one of image_path, Core artifact_id, or session attachment_id: slice it into chunks (1200px tall with 120px overlap by default) ' +
      'and read the text chunk by chunk with the vision model, then join the results in top-to-bottom order. ' +
      'Marks partial results when chunks fail. Cancellation or timeout stops the whole operation. Good for long screenshots / documents.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Absolute path to the image (png/jpg/jpeg/webp)' },
        artifact_id: { type: 'string', description: 'Existing Core image Artifact ID in the current profile (alternative to image_path or attachment_id)' },
        attachment_id: { type: 'string', description: 'Session attachment id of the image (alternative to image_path)' },
        chunk_height: { type: 'integer', description: 'Chunk height in pixels, default 1200' },
        overlap: { type: 'integer', description: 'Overlap between chunks in pixels to avoid cutting text lines, default 120' }
      },
      required: []
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const host = dshHost(ctx);
      const result = await runOcrRequest(host, {
        providers: store.pickAllFor(cap.CAPABILITIES.VISION), onRateLimit: store.recordRateLimit,
        prepareImage: operationSignal => resolveVisionImageInput(host, exec, args, operationSignal),
        chunkHeight: args.chunk_height,
        overlap: args.overlap,
        signal: exec.signal
      });
      return formatOcrResult(result) + (args.artifact_id ? `\nCore Artifact: ${args.artifact_id}` : '');
    }
  });

  console.log('[iris] tools registered: iris_draw_image, iris_edit_image, iris_generate_video, iris_speak_text, iris_transcribe_audio, iris_task_status, iris_look_at_image, iris_relook_attachment, iris_crop, iris_pixel_diff, iris_locate, iris_html_screenshot, iris_long_ocr, iris_video_frames, iris_media_summarize');
};

/* ---------------- 视觉路由（M3 补全）：look/relook 共用执行器 + 降级链 ---------------- */

/** 通用工具只消费 Host attachments 端口。 */
function attachmentService(host) {
  const attachments = requireHostPort(host, 'attachments', '处理 DSH 附件');
  if (typeof attachments.saveImage !== 'function' || typeof attachments.readImage !== 'function') {
    throw new Error('iris: Host attachments 端口缺少 saveImage/readImage');
  }
  return attachments;
}

/**
 * 把「本地绝对路径 或 本会话 attachment_id」解析为图片 buffer。
 * crop / pixel_diff 共用（阶段 2）。
 * @returns {Promise<{buffer:Buffer, mediaType:string, name:string}>}
 */
async function resolveImageInput(host, exec, { image_path, attachment_id }) {
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
    const hit = (await sessionAttachmentRef(host, exec, id)) || findOwnAttachment(id);
    if (!hit) throw new Error('iris: 该 attachment 不在本会话中、也不是 iris 生成的图片：' + id);
    if (hit.absPath) {
      return {
        buffer: fs.readFileSync(hit.absPath),
        mediaType: hit.ref.mediaType || MEDIA_TYPES[path.extname(hit.absPath).toLowerCase()] || 'image/png',
        name: path.basename(hit.absPath)
      };
    }
    const stored = await attachmentService(host).readImage(hit.ref, exec && exec.signal);
    return {
      buffer: Buffer.from(stored.data),
      mediaType: stored.mediaType || hit.ref.mediaType || 'image/png',
      name: hit.ref.name || 'image.png'
    };
  }
  throw new Error('iris: 需要 image_path 或 attachment_id');
}

/** 视觉解引用在整体预算内；路径限额读，Host 会话/附件等待可取消。 */
async function resolveVisionImageInput(host, exec, input, signal) {
  const source = normalizeVisionImageSource(input, { allowAttachment: true });
  const { image_path, artifact_id, attachment_id } = input;
  if (source === 'artifact_id') return visionImageForDsh({ artifactId: artifact_id, signal });
  if (image_path) {
    const file = String(image_path).trim();
    const mediaType = MEDIA_TYPES[path.extname(file).toLowerCase()];
    if (!path.isAbsolute(file) || !mediaType || mediaType === 'image/gif') throw new Error('invalid vision image');
    return readVisionImageFile(file, mediaType, signal);
  }
  if (attachment_id) {
    const id = String(attachment_id).trim();
    const hit = await waitForModelWork(() => sessionAttachmentRef(host, exec, id), signal) || findOwnAttachment(id);
    if (!hit) throw new Error('unavailable vision attachment');
    if (hit.absPath) return readVisionImageFile(hit.absPath,
      hit.ref.mediaType || MEDIA_TYPES[path.extname(hit.absPath).toLowerCase()] || 'image/png', signal);
    const stored = await waitForModelWork(() => attachmentService(host).readImage(hit.ref, signal), signal);
    return { bytes: stored.data, mediaType: stored.mediaType || hit.ref.mediaType || 'image/png' };
  }
  throw new Error('missing vision image');
}

/** 在本插件的任务产物里按 attachmentId 找 iris 自生成的图片（relook 的兜底） */
export function findOwnAttachment(attachmentId) {
  for (const t of tasks.all()) {
    for (const a of t.attachments || []) {
      if (a.attachmentId === attachmentId) {
        const absPath = path.join(tasks.outputsDir(), a.file);
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
export async function sessionAttachmentRef(host, exec, attachmentId) {
  const agent = exec && exec.agent;
  const session = agent && agent.session;
  const wanted = String(attachmentId || '');
  if (!session || !wanted || !host?.ports?.sessions) return null;
  try {
    const ref = await host.ports.sessions.findImageAttachment(session.id, wanted);
    return ref ? { ref } : null;
  } catch (_) {
    return null; // 读不到会话记录 → 交给 findOwnAttachment 兜底
  }
}

/**
 * 看图问答（阶段 1：VisionBackend 降级链）。
 * 只取声明/推断出 vision 能力的自持栈 provider（严格选择），按序组装后端链，
 * 全局视觉模型兜底；每个后端的失败现场保留在 errors 里。
 * @returns {{answer:string,via:'selfstack'|'global',model?:string,backendId:string}}
 */
export async function askVision(host, { question, dataUrl, image, prepareImage, signal, model, budget }) {
  const visionProviders = store.pickAllFor(cap.CAPABILITIES.VISION);
  return runVisionRequest(host, { providers: visionProviders, model, question, dataUrl, image, prepareImage, signal, budget, onRateLimit: store.recordRateLimit });
}

/**
 * look / relook 共用执行器：看图问答 → 人话结果（标注模型归属，方便排查走哪条链）。
 * @returns {Promise<string>} 直接作为工具输出
 */
export async function runVisionTool(host, exec, { origin, model, question, dataUrl, image, prepareImage, artifactId }) {
  if (exec && exec.signal && exec.signal.aborted) throw new Error('已取消');
  const { answer, via, model: usedModel } = await askVision(host, {
    question,
    dataUrl,
    image,
    prepareImage,
    signal: exec && exec.signal,
    model
  });
  const label = origin === 'relook' ? '重看回答' : '看图回答';
  const viaLabel = via === 'selfstack' ? 'iris 自持栈' : 'DSH 全局视觉模型';
  return `[iris] ${label}（${usedModel || '默认'} · ${viaLabel}）：\n${answer}` + (artifactId ? `\nCore Artifact: ${artifactId}` : '');
}
