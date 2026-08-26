'use strict';
/**
 * Iris 媒体生成后端 —— 多协议适配器。
 * - dashscope：阿里云百炼（图像/视频异步任务 + qwen-tts 同步）
 * - openai-images：OpenAI Images 兼容协议（generations）
 * 所有函数只收显式 key；错误统一 throw Error(人话)。
 */

const DASHSCOPE = 'https://dashscope.aliyuncs.com/api/v1';

function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}

function providerError(status, body, fallback) {
  const msg = (body && (body.message || (body.output && body.output.message))) || (body && body.code) || `HTTP ${status}`;
  if (status === 401 || status === 403) return new Error(`鉴权失败：${msg}`);
  if (status === 429) return new Error(`限流或额度不足：${msg}`);
  if (/InvalidParameter|NotFound\.Model|unsupported/i.test(String((body && body.code) || ''))) {
    return new Error(`模型或参数不受支持：${msg}`);
  }
  return new Error(`${fallback}：${msg}`);
}

/* ---------------- DashScope：图像（异步） ---------------- */
export async function submitImage({ key, model, prompt, size = '1024*1024', n = 1 }) {
  const res = await fetch(`${DASHSCOPE}/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: { ...authHeaders(key), 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model, input: { prompt }, parameters: { size, n: Number(n) || 1 } })
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '提交失败');
  const taskId = body && body.output && body.output.task_id;
  if (!taskId) throw new Error('提交成功但未返回 task_id');
  return taskId;
}

/* ---------------- DashScope：视频（异步） ---------------- */
export async function submitVideo({ key, model, prompt, imgDataUrl, size = '1280*720', duration }) {
  const input = { prompt };
  if (imgDataUrl) input.img_url = imgDataUrl;
  const parameters = { size };
  if (duration) parameters.duration = Number(duration);
  const res = await fetch(`${DASHSCOPE}/services/aigc/video-generation/video-synthesis`, {
    method: 'POST',
    headers: { ...authHeaders(key), 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model, input, parameters })
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '提交失败');
  const taskId = body && body.output && body.output.task_id;
  if (!taskId) throw new Error('提交成功但未返回 task_id');
  return taskId;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN']);

/** @returns {{done:boolean, ok:boolean, urls:string[], message?:string}} */
export async function pollTask({ key, remoteTaskId }) {
  const res = await fetch(`${DASHSCOPE}/tasks/${encodeURIComponent(remoteTaskId)}`, {
    headers: authHeaders(key)
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '查询任务失败');
  const out = (body && body.output) || {};
  const status = out.task_status || 'UNKNOWN';
  const urls = [];
  for (const r of Array.isArray(out.results) ? out.results : []) {
    if (r && typeof r.url === 'string') urls.push(r.url);
  }
  if (typeof out.video_url === 'string') urls.push(out.video_url);
  if (!TERMINAL.has(status)) return { done: false, ok: false, urls };
  return {
    done: true,
    ok: status === 'SUCCEEDED',
    urls,
    message: status === 'SUCCEEDED' ? undefined : (out.message || out.code || `任务终止（${status}）`)
  };
}

/* ---------------- DashScope：qwen-tts（同步） ---------------- */
export async function synthesizeTts({ key, model = 'qwen-tts-latest', text, voice = 'Cherry' }) {
  const res = await fetch(`${DASHSCOPE}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ model, input: { text, voice } })
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '合成失败');
  const audio = body && body.output && body.output.audio;
  const url = audio && (audio.url || audio.audio_url);
  const b64 = audio && typeof audio.data === 'string' ? audio.data : null;
  if (!url && !b64) throw new Error('合成完成但未返回音频');
  return { audioUrl: url || null, audioB64: b64 };
}

/* ---------------- OpenAI Images 兼容（同步 base64/url） ---------------- */
export async function openAiGenerateImage({ key, baseUrl, model, prompt, size = '1024x1024', n = 1 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ model, prompt, size, n: Number(n) || 1 })
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '生成失败');
  const items = (body && Array.isArray(body.data) && body.data) || [];
  const out = [];
  for (const it of items) {
    if (it && typeof it.b64_json === 'string') out.push({ b64: it.b64_json });
    else if (it && typeof it.url === 'string') out.push({ url: it.url });
  }
  if (!out.length) throw new Error('生成完成但未返回图片数据');
  return out;
}

/* ---------------- 下载 / 扩展名 ---------------- */
export function extFromUrl(url, fallback = 'bin') {
  try {
    const m = new URL(url).pathname.match(/\.(\w{2,5})$/);
    if (m) return m[1].toLowerCase();
  } catch (_) {
    /* ignore */
  }
  return fallback;
}

export async function downloadTo(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载结果失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync } = await import('node:fs');
  writeFileSync(filePath, buf);
  return buf.length;
}
