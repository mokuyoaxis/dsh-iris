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

/**
 * 网络调用超时档位（2026-09-03 健康检查）：挂死的连接绝不能冻住盯守 tick——
 * MAX_WATCH_MS 只在 tick 顶部检查，单次 poll 的 await 挂起就永远走不到那行。
 * 超时抛 TimeoutError，汇入既有错误路径（轮询进 errStreak 容忍、提交进 submitGuard 标 failed）。
 * 各函数带 timeoutMs 参数（默认取档位），便于离线测试注入短超时。
 */
export const T_SUBMIT = 30000;    // 任务提交
export const T_POLL = 15000;      // 单次状态轮询
export const T_UPLOAD = 60000;    // 临时文件上传（几 MB 音频）
export const T_DOWNLOAD = 120000; // 产物转存（大视频）
export const T_SYNC_GEN = 180000; // 同步生成（openai-images / qwen-tts）
export const T_VISION = 120000;   // 视觉流式回答

function timeoutSignal(ms, external) {
  const t = AbortSignal.timeout(ms);
  return external ? AbortSignal.any([external, t]) : t;
}

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

/* ---------------- DashScope：图像（旧异步 / 新版多模态） ---------------- */
/**
 * DashScope 图像模型目前有两套 HTTP 协议：
 * - wan2.5 及以下、qwen-image / qwen-image-plus：旧 text2image 异步协议；
 * - wan2.6+、新版 qwen-image、z-image：新版多模态协议。
 * 未知模型保守走旧协议，避免擅自改变已有自定义模型的调用方式。
 */
export function dashscopeImageMode(model) {
  const name = String(model || '').trim().toLowerCase();
  if (/^wanx/.test(name) || /^wan2\.[0-5](?:-|$)/.test(name)) return 'legacy-async';
  if (/^qwen-image(?:$|-plus(?:-|$))/.test(name)) return 'legacy-async';
  if (/^(?:wan2\.[67](?:-|$)|qwen-image|z-image)/.test(name)) return 'multimodal-sync';
  return 'legacy-async';
}

/** 新版多模态同步协议：响应中直接返回图片 URL。 */
export async function generateImageMultimodal({ key, model, prompt, size, n = 1, timeoutMs = T_SYNC_GEN, signal }) {
  const res = await fetch(`${DASHSCOPE}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: authHeaders(key),
    signal: timeoutSignal(timeoutMs, signal),
    body: JSON.stringify({
      model,
      input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
      parameters: { ...(size ? { size } : {}), n: Number(n) || 1 }
    })
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '生成失败');
  const urls = [];
  for (const choice of (body && body.output && body.output.choices) || []) {
    for (const item of (choice && choice.message && choice.message.content) || []) {
      const url = item && (item.image || item.image_url || item.url);
      if (typeof url === 'string' && url) urls.push(url);
    }
  }
  if (!urls.length) throw new Error('生成完成但未返回图片');
  return urls;
}

/** 统一启动图像生成；调用方按 remoteTaskId / urls 区分后台任务与同步结果。 */
export async function startImageGeneration(opts) {
  if (dashscopeImageMode(opts && opts.model) === 'multimodal-sync') {
    return { remoteTaskId: null, urls: await generateImageMultimodal(opts) };
  }
  return { remoteTaskId: await submitImage(opts), urls: [] };
}
export async function submitImage({ key, model, prompt, size, n = 1, timeoutMs = T_SUBMIT, signal }) {
  const res = await fetch(`${DASHSCOPE}/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: { ...authHeaders(key), 'X-DashScope-Async': 'enable' },
    signal: timeoutSignal(timeoutMs, signal),
    body: JSON.stringify({ model, input: { prompt }, parameters: { ...(size ? { size } : {}), n: Number(n) || 1 } })
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
export async function submitVideo({ key, model, prompt, imgDataUrl, size = '1280*720', duration, audioUrl, resolution, timeoutMs = T_SUBMIT, signal }) {
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
    signal: timeoutSignal(timeoutMs, signal),
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
export async function uploadTempFile({ key, model, filePath, timeoutMs = T_UPLOAD, signal }) {
  const u = new URL(`${DASHSCOPE}/uploads`);
  u.searchParams.set('action', 'getPolicy');
  u.searchParams.set('model', model);
  const pres = await fetch(u, { headers: authHeaders(key), signal: timeoutSignal(timeoutMs, signal) });
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
  const up = await fetch(pol.upload_host, { method: 'POST', body: fd, signal: timeoutSignal(timeoutMs, signal) });
  if (up.status !== 200) throw new Error(`临时上传失败：HTTP ${up.status}`);
  return 'oss://' + keyPath;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN']);

/** @returns {{done:boolean, ok:boolean, urls:string[], message?:string}} */
export async function pollTask({ key, remoteTaskId, timeoutMs = T_POLL }) {
  const res = await fetch(`${DASHSCOPE}/tasks/${encodeURIComponent(remoteTaskId)}`, {
    headers: authHeaders(key),
    signal: timeoutSignal(timeoutMs)
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '查询任务失败');
  const out = (body && body.output) || {};
  const status = out.task_status || 'UNKNOWN';
  const urls = [];
  const addUrl = (url) => {
    if (typeof url === 'string' && url && !urls.includes(url)) urls.push(url);
  };
  // 结果形态因能力而异（且字段名不统一）：t2i/t2v 常为数组 [{url}]；
  // s2v 为对象 {video_url}；偶见数组元素用 video_url 键。全部兼容。
  if (Array.isArray(out.results)) {
    for (const r of out.results) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.url === 'string') addUrl(r.url);
      else if (typeof r.video_url === 'string') addUrl(r.video_url);
    }
  } else if (out.results && typeof out.results === 'object') {
    if (typeof out.results.video_url === 'string') addUrl(out.results.video_url);
    if (typeof out.results.url === 'string') addUrl(out.results.url);
  }
  // 新版图像协议把结果放在 choices[].message.content[].image。
  for (const choice of Array.isArray(out.choices) ? out.choices : []) {
    for (const item of (choice && choice.message && choice.message.content) || []) {
      addUrl(item && (item.image || item.image_url || item.url));
    }
  }
  if (typeof out.video_url === 'string') addUrl(out.video_url);
  if (!TERMINAL.has(status)) return { done: false, ok: false, urls };
  return {
    done: true,
    ok: status === 'SUCCEEDED',
    urls,
    message: status === 'SUCCEEDED' ? undefined : (out.message || out.code || `任务终止（${status}）`)
  };
}

/* ---------------- DashScope：qwen-tts（同步） ---------------- */
export async function synthesizeTts({ key, model = 'qwen-tts-latest', text, voice = 'Cherry', timeoutMs = T_SYNC_GEN, signal }) {
  const res = await fetch(`${DASHSCOPE}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: authHeaders(key),
    signal: timeoutSignal(timeoutMs, signal),
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
export async function openAiGenerateImage({ key, baseUrl, model, prompt, size = '1024x1024', n = 1, timeoutMs = T_SYNC_GEN, signal }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: authHeaders(key),
    signal: timeoutSignal(timeoutMs, signal),
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

/* ---------------- 模型发现（OpenAI 兼容 GET /models，各家通用） ---------------- */
/**
 * 拉取 provider 可用模型 id 列表。OpenAI 标准端点，DashScope compatible-mode 亦支持。
 * 免费只读；返回 [{ id }] 原样（分类由 models.js 规则负责）。
 * @returns {Promise<string[]>}
 */
export async function listModels({ key, baseUrl, timeoutMs = T_SUBMIT }) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('iris: 供应商缺 baseUrl，无法发现模型');
  const res = await fetch(`${base}/models`, { headers: authHeaders(key), signal: timeoutSignal(timeoutMs) });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '模型发现失败');
  const items = (body && Array.isArray(body.data) && body.data) || (Array.isArray(body && body.models) ? body.models : []);
  const ids = [];
  for (const it of items) {
    const id = typeof it === 'string' ? it : it && it.id;
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/* ---------------- 视觉理解（OpenAI 兼容 SSE 流式） ---------------- */
/**
 * qwen-vl 走自持栈的主通道：POST {baseUrl}/chat/completions，SSE 增量拼接。
 * baseUrl 形如 https://dashscope.aliyuncs.com/compatible-mode/v1。
 * @param {AbortSignal} [signal] 取消传播
 * @returns {Promise<string>} 完整回答文本
 */
export async function visionStream({ key, baseUrl, model = 'qwen-vl-plus', prompt, imageDataUrl, signal, timeoutMs = T_VISION }) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(key),
      signal: timeoutSignal(timeoutMs, signal),
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

export async function downloadTo(url, filePath, { timeoutMs = T_DOWNLOAD, signal } = {}) {
  const res = await fetch(url, { signal: timeoutSignal(timeoutMs, signal) });
  if (!res.ok) throw new Error(`下载结果失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync, renameSync } = await import('node:fs');
  // 原子落盘：先写 .tmp 再 rename，失败/超时不留半截产物
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, buf);
  renameSync(tmp, filePath);
  return buf.length;
}

/* ---------------- DashScope：非实时语音识别（异步任务） ---------------- */
/**
 * 提交音频转写任务。音频先通过 uploadTempFile 上传到 oss://，再提交。
 * @param {{key:string, model:string, audioUrl:string}} opts audioUrl 为 oss:// 或公网 URL
 * @returns {Promise<string>} remoteTaskId
 */
export async function submitTranscription({ key, model = 'qwen-audio-3.0-asr-flash-filetrans', audioUrl, timeoutMs = T_SUBMIT, signal }) {
  const headers = { ...authHeaders(key), 'X-DashScope-Async': 'enable' };
  if (/^oss:\/\//.test(audioUrl || '')) headers['X-DashScope-OssResourceResolve'] = 'enable';
  // Qwen3 Filetrans 使用单值 file_url；Qwen-Audio 3.0、Fun-ASR、Paraformer 使用 file_urls。
  const input = /^qwen3-asr-.*filetrans/i.test(model || '')
    ? { file_url: audioUrl }
    : { file_urls: [audioUrl] };
  const res = await fetch(`${DASHSCOPE}/services/audio/asr/transcription`, {
    method: 'POST',
    headers,
    signal: timeoutSignal(timeoutMs, signal),
    body: JSON.stringify({ model, input })
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '提交转写失败');
  const taskId = body && body.output && body.output.task_id;
  if (!taskId) throw new Error('提交成功但未返回 task_id');
  return taskId;
}

/** 从百炼转写结果 JSON 中提取正文，兼容 transcript.text 与 sentences[].text。 */
export function transcriptionText(payload) {
  const root = (payload && payload.output) || payload || {};
  const parts = [];
  for (const transcript of Array.isArray(root.transcripts) ? root.transcripts : []) {
    if (typeof transcript.text === 'string' && transcript.text.trim()) {
      parts.push(transcript.text.trim());
      continue;
    }
    const sentenceText = (Array.isArray(transcript.sentences) ? transcript.sentences : [])
      .map((sentence) => sentence && sentence.text)
      .filter((text) => typeof text === 'string' && text.trim())
      .join('');
    if (sentenceText) parts.push(sentenceText);
  }
  return parts.join('\n');
}

/** 轮询 ASR 任务；正式结果位于 results[].transcription_url 指向的 JSON。 */
export async function pollTranscriptionTask({ key, remoteTaskId, timeoutMs = T_POLL }) {
  const res = await fetch(`${DASHSCOPE}/tasks/${encodeURIComponent(remoteTaskId)}`, {
    headers: authHeaders(key),
    signal: timeoutSignal(timeoutMs)
  });
  const body = await readJson(res);
  if (!res.ok) throw providerError(res.status, body, '查询转写任务失败');
  const out = (body && body.output) || {};
  const status = out.task_status || 'UNKNOWN';
  let text = '';
  let subtaskSeen = false;
  let subtaskSucceeded = false;
  if (Array.isArray(out.results)) {
    for (const result of out.results) {
      if (!result || typeof result !== 'object') continue;
      if (typeof result.subtask_status === 'string') {
        subtaskSeen = true;
        if (result.subtask_status === 'SUCCEEDED') subtaskSucceeded = true;
      }
      if (typeof result.transcription_text === 'string') text += result.transcription_text;
      else if (typeof result.text === 'string') text += result.text;
      if (status === 'SUCCEEDED' && result.subtask_status !== 'FAILED' && typeof result.transcription_url === 'string') {
        const transcriptRes = await fetch(result.transcription_url, { signal: timeoutSignal(timeoutMs) });
        if (!transcriptRes.ok) throw new Error(`下载转写结果失败：HTTP ${transcriptRes.status}`);
        const transcriptBody = await readJson(transcriptRes);
        if (!transcriptBody) throw new Error('下载转写结果失败：响应不是 JSON');
        text += transcriptionText(transcriptBody);
      }
    }
  }
  if (typeof out.text === 'string') text = out.text;
  if (typeof out.transcription_text === 'string') text = out.transcription_text;
  if (!TERMINAL.has(status)) return { done: false, text };
  const ok = status === 'SUCCEEDED' && (!subtaskSeen || subtaskSucceeded);
  return {
    done: true,
    ok,
    text,
    message: ok ? undefined : (out.message || out.code || '转写子任务失败')
  };
}
