'use strict';
/**
 * dsh-iris —— Host 入口。
 * 给 DSH 装上眼睛和双手：多供应商媒体生成 + 视觉路由 + 🫧 常驻泡泡。
 * M1：工具（画图/语音/看图）+ 配置自持 + 工作台导入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as adapters from './adapters.js';
import * as store from './config.js';

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

function outputDir() {
  const dir = path.join(store.irisHome(), 'outputs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 从工作台配置解析出「画图供应商」的启动参数 */
function imageBackendFor(provider) {
  if (!provider) return null;
  if ((provider.mediaProtocol || 'dashscope') === 'openai-images') {
    return { protocol: 'openai-images', key: provider.apiKey, baseUrl: provider.baseUrl, model: provider.imageModel || 'gpt-image-1' };
  }
  return { protocol: 'dashscope', key: provider.apiKey, baseUrl: provider.baseUrl, model: provider.imageModel || 'wan2.2-t2i-flash' };
}

export const name = 'dsh-iris';
export const inject = ['tools'];

export async function apply(ctx) {
  // 首次运行：从工作台导入（幂等）
  const wb = path.join(process.env.HOME || os.homedir(), 'projects', 'ai-paint', 'data', 'config.json');
  const imported = store.importFromWorkbench(wb);
  if (imported.imported) console.log(`[iris] 已从工作台导入 ${imported.imported} 个服务商`);

  const tools = ctx.tools;

  /* ---------- 🖼️ 画图 ---------- */
  ctx.effect(() => tools.register({
    name: 'iris_draw_image',
    description:
      'Generate an image from a detailed prompt using the user-configured image model (DashScope wan* or OpenAI-images-compatible). ' +
      'Returns a durable DSH attachment rendered in the conversation plus a vision-model description so you know what was drawn.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Detailed visual description of the image to create' },
      size: { type: 'string', description: "Output size; DashScope uses 'W*H' (e.g. '1024*1024'), OpenAI uses 'WxH'. Default provider default." },
      n: { type: 'string', description: "Number of images, default '1'" },
      model: { type: 'string', description: 'Override the configured image model id' }
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
      const started = Date.now();

      let files = []; // {bytes, ext}
      if (backend.protocol === 'dashscope') {
        const taskId = await adapters.submitImage({
          key: backend.key, model, prompt,
          size: args.size || undefined, n: args.n || 1
        });
        // 盯守至多 ~3 分钟
        const deadline = Date.now() + 180000;
        for (;;) {
          if (exec.signal && exec.signal.aborted) throw new Error('已取消');
          await new Promise((r) => setTimeout(r, 2500));
          const r = await adapters.pollTask({ key: backend.key, remoteTaskId: taskId });
          if (r.done && !r.ok) throw new Error('生成失败：' + (r.message || '未知原因'));
          if (r.done) {
            files = [];
            for (const url of r.urls) {
              const ext = adapters.extFromUrl(url, 'png');
              const p = path.join(outputDir(), `iris-img-${Date.now()}-${files.length}.${ext}`);
              await adapters.downloadTo(url, p);
              files.push(p);
            }
            break;
          }
          if (Date.now() > deadline) throw new Error('生成超时（3 分钟），任务可能仍在服务端继续');
        }
      } else {
        const outs = await adapters.openAiGenerateImage({
          key: backend.key, baseUrl: backend.baseUrl, model, prompt,
          size: args.size || undefined, n: args.n || 1
        });
        files = [];
        for (let i = 0; i < outs.length; i++) {
          const p = path.join(outputDir(), `iris-img-${Date.now()}-${i}.png`);
          if (outs[i].b64) fs.writeFileSync(p, Buffer.from(outs[i].b64, 'base64'));
          else await adapters.downloadTo(outs[i].url, p);
          files.push(p);
        }
      }

      // 转存为 DSH 持久附件 + 视觉自述（让工作 AI 知道画了什么）
      const blocks = [];
      const refs = [];
      for (const f of files) {
        const mediaType = MEDIA_TYPES[path.extname(f).toLowerCase()] || 'image/png';
        const ref = await ctx.attachments.saveImage({ data: new Uint8Array(fs.readFileSync(f)), mediaType, name: path.basename(f) });
        refs.push(ref);
        blocks.push({ type: 'image', attachment: ref });
      }

      // 用视觉模型自述（若 llm 服务与视觉模型可用则增强；失败静默降级）
      let note = '';
      try {
        const described = await describeFirstImage(ctx, refs[0], prompt);
        if (described) note = `画面内容：${described}`;
      } catch (_) {
        /* 自述是增强项，失败不影响交付 */
      }

      blocks.unshift({
        type: 'text',
        text:
          `[iris] 图像已生成（${model}，${((Date.now() - started) / 1000).toFixed(1)}s）。` +
          (note ? `\n${note}` : '') +
          `\nattachment: ${refs.map((r) => r.attachmentId).join(', ')}`
      });
      return { blocks };
    }
  }));

  /* ---------- 🔊 语音合成 ---------- */
  ctx.effect(() => tools.register({
    name: 'iris_speak_text',
    description: 'Synthesize speech audio from text using the configured TTS model (qwen-tts / compatible). Returns the saved audio file path.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to speak' },
      voice: { type: 'string', description: "Voice name, e.g. 'Cherry' (DashScope qwen-tts voices)" },
      model: { type: 'string', description: 'Override the configured TTS model id' }
    },
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const text = String(args.text || '').trim();
      if (!text) throw new Error('iris: text 不能为空');
      const provider = store.pickFor('tts');
      if (!provider) throw new Error('iris: 没有可用供应商——先在 Iris 设置里添加并启用');
      const key = provider.apiKey;
      const model = args.model ? String(args.model) : (provider.ttsModel || 'qwen-tts-latest');
      if (exec.signal && exec.signal.aborted) throw new Error('已取消');
      const r = await adapters.synthesizeTts({ key, model, text, voice: args.voice || (provider.ttsVoice || 'Cherry') });
      const fileName = `iris-tts-${Date.now()}.${r.audioUrl ? adapters.extFromUrl(r.audioUrl, 'wav') : 'wav'}`;
      const p = path.join(outputDir(), fileName);
      if (r.audioUrl) await adapters.downloadTo(r.audioUrl, p);
      else fs.writeFileSync(p, Buffer.from(r.audioB64, 'base64'));
      return `[iris] 语音已合成（${model}）：${p}\n音频为 wav 格式，可直接用系统播放器打开。`;
    }
  }));

  console.log('[iris] tools registered (draw_image, speak_text)');
};

/**
 * 视觉自述：优先用 DSH 全局模型注册表中声明了视觉能力的模型；
 * 这里保持极简——M3 会替换成完整的视觉路由子系统。
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
