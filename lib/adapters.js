'use strict';
/**
 * Iris 媒体生成后端 —— 多协议适配器。
 * - dashscope：阿里云百炼（图像/视频异步任务 + qwen-tts 同步）
 * - openai-images：OpenAI Images 兼容协议（generations）
 * 所有函数只收显式 key；错误统一 throw Error(人话)。
 */
import fs from 'node:fs';
import path from 'node:path';

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

/**
 * 结构化 Provider 错误（阶段 1）。
 * 分类供 failover 决策使用：category 区分 auth / rate_limit / quota /
 * invalid_parameter / server / network / unknown；status 与 rootCause 保留现场。
 * message 保持人话（向后兼容 String(err.message)）。
 */
export class ProviderError extends Error {
  constructor({ category, status, message, rootCause }) {
    super(message);
    this.name = 'ProviderError';
    this.category = category;
    this.status = status;
    this.rootCause = rootCause;
  }
}

function classifyHttpError(status, body, fallback) {
  const msg = (body && (body.message || (body.output && body.output.message))) || (body && body.code) || `HTTP ${status}`;
  const code = String((body && body.code) || '');
  let category = 'unknown';
  let text;
  if (status === 401 || status === 403) {
    category = 'auth';
    text = `鉴权失败：${msg}`;
  } else if (status === 429) {
    category = /quota|insufficient|balance|limit|额度/i.test(msg + ' ' + code) ? 'quota' : 'rate_limit';
    text = `限流或额度不足：${msg}`;
  } else if (/InvalidParameter|NotFound\.Model|unsupported/i.test(code)) {
    category = 'invalid_parameter';
    text = `模型或参数不受支持：${msg}`;
  } else if (status >= 500) {
    category = 'server';
    text = `${fallback}：${msg}`;
  } else {
    text = `${fallback}：${msg}`;
  }
  return new ProviderError({ category, status, message: text, rootCause: msg });
}

/** 包装 fetch 层的网络异常（无 HTTP 状态） */
export function networkError(err) {
  const e = new ProviderError({
    category: 'network',
    status: 0,
    message: '网络错误：' + String((err && err.message) || err),
    rootCause: err
  });
  return e;
}

function providerError(status, body, fallback) {
  return classifyHttpError(status, body, fallback);
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
/**
 * 提交视频生成任务。按模型自动分流：
 * - wan*s2v（数字人音视频合成）：POST /services/aigc/image2video/video-synthesis
 *   input 固定 { image_url, audio_url }，仅收公网 URL 或 oss:// 临时 URL（不收 data: base64）；
 *   oss:// 必须带 X-DashScope-OssResourceResolve: enable 头。
 * - 其他（t2v/i2v）：POST /services/aigc/video-generation/video-synthesis，
 *   imgDataUrl 支持公网 URL 或 data:image base64。
 */
export async function submitVideo({ key, model, prompt, imgDataUrl, size = '1280*720', duration, audioUrl, resolution }) {
  const isS2V = /s2v/i.test(model || '');
  let url, input, parameters;
  const headers = { ...authHeaders(key), 'X-DashScope-Async': 'enable' };
  if (isS2V) {
    url = `${DASHSCOPE}/services/aigc/image2video/video-synthesis`;
    input = { image_url: imgDataUrl, audio_url: audioUrl };
    parameters = {};
    if (resolution) parameters.resolution = String(resolution);
    if (/^oss:\/\//.test(input.image_url) || /^oss:\/\//.test(input.audio_url)) {
      headers['X-DashScope-OssResourceResolve'] = 'enable';
    }
  } else {
    url = `${DASHSCOPE}/services/aigc/video-generation/video-synthesis`;
    input = { prompt };
    if (imgDataUrl) input.img_url = imgDataUrl;
    parameters = { size };
    if (duration) parameters.duration = Number(duration);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, input, parameters })
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '提交失败');
  const taskId = body && body.output && body.output.task_id;
  if (!taskId) throw new Error('提交成功但未返回 task_id');
  return taskId;
}

/* ---------------- DashScope：本地文件 → oss:// 临时 URL（48h） ---------------- */
/**
 * 百炼免费临时存储：文件与模型绑定、仅本账号可用、48h 自动清理。
 * 返回 oss:// 形式 URL；调用模型时请求头须带 X-DashScope-OssResourceResolve: enable
 * （submitVideo 的 s2v 分支已自动处理）。
 */
export async function uploadTempFile({ key, model, filePath }) {
  const u = new URL(`${DASHSCOPE}/uploads`);
  u.searchParams.set('action', 'getPolicy');
  u.searchParams.set('model', model);
  const pres = await fetch(u, { headers: authHeaders(key) });
  const pbody = await readJson(pres);
  if (!pres.ok || !pbody || !pbody.data) throw providerError(pres.status, pbody, '获取上传凭证失败');
  const pol = pbody.data;
  const name = path.basename(filePath);
  const keyPath = `${pol.upload_dir}/${Date.now()}-${name}`;
  const fd = new FormData();
  fd.append('OSSAccessKeyId', pol.oss_access_key_id);
  fd.append('Signature', pol.signature);
  fd.append('policy', pol.policy);
  fd.append('x-oss-object-acl', pol.x_oss_object_acl);
  fd.append('x-oss-forbid-overwrite', pol.x_oss_forbid_overwrite);
  fd.append('key', keyPath);
  fd.append('success_action_status', '200');
  fd.append('file', new Blob([fs.readFileSync(filePath)]), name);
  const up = await fetch(pol.upload_host, { method: 'POST', body: fd });
  if (up.status !== 200) throw new Error(`临时上传失败：HTTP ${up.status}`);
  return 'oss://' + keyPath;
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
  // 结果形态因能力而异（且字段名不统一）：t2i/t2v 常为数组 [{url}]；
  // s2v 为对象 {video_url}；偶见数组元素用 video_url 键。全部兼容。
  if (Array.isArray(out.results)) {
    for (const r of out.results) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.url === 'string') urls.push(r.url);
      else if (typeof r.video_url === 'string') urls.push(r.video_url);
    }
  } else if (out.results && typeof out.results === 'object') {
    if (typeof out.results.video_url === 'string') urls.push(out.results.video_url);
    if (typeof out.results.url === 'string') urls.push(out.results.url);
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

/* ---------------- 视觉理解（OpenAI 兼容 SSE 流式） ---------------- */
/**
 * qwen-vl 走自持栈的主通道：POST {baseUrl}/chat/completions，SSE 增量拼接。
 * baseUrl 形如 https://dashscope.aliyuncs.com/compatible-mode/v1。
 * @param {AbortSignal} [signal] 取消传播
 * @returns {Promise<string>} 完整回答文本
 */
export async function visionStream({ key, baseUrl, model = 'qwen-vl-plus', prompt, imageDataUrl, signal }) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(key),
      signal,
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageDataUrl } }
            ]
          }
        ]
      })
    });
  } catch (err) {
    throw networkError(err); // 网络层失败归类为 network
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* keep null */ }
    throw providerError(res.status, body, '视觉理解失败');
  }
  let full = '';
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    if (signal && signal.aborted) break;
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (typeof delta === 'string' && delta) full += delta;
      } catch (_) {
        /* 跳过不完整行 */
      }
    }
  }
  return full.trim();
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
