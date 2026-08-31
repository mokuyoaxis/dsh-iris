'use strict';
/**
 * Iris 泡泡工作台 —— Host 侧状态 API（M4）。
 *
 * 数据通路完全复用 `/iris/media` 的宿内 webServer 前缀路由模式，
 * 只新增一个 JSON 出口：GET /iris/api/state。
 *
 * 输出纪律（与整仓一致）：
 * - 只回标量字段（字符串/数字/布尔/受限数组），apiKey 永不明文，只给 hint；
 * - 文件路径只给相对 outputs/ 的 basename + 授权播放链接（token 随机 128bit）；
 * - tasks/providers 读的是 $DSH_HOME/iris/v1 的持久 JSON，与任务盯守共用同一存储。
 */
import fs from 'node:fs';
import path from 'node:path';
import { irisHome } from './config.js';
import { mimeOf, mediaUrl } from './media.js';

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

/** Key 只给头尾提示，绝不回明文 */
function keyHint(key) {
  const t = String(key || '');
  if (!t) return '';
  if (t.length <= 8) return '****';
  return `${t.slice(0, 3)}****${t.slice(-4)}`;
}

function providerPublic(p) {
  return {
    id: p.id,
    name: p.name || p.id,
    type: p.type || 'openai',
    baseUrl: p.baseUrl,
    enabled: p.enabled !== false,
    mediaProtocol: p.mediaProtocol || 'dashscope',
    apiKeyHint: keyHint(p.apiKey),
    capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
    imageModel: p.imageModel || '',
    videoModel: p.videoModel || '',
    ttsModel: p.ttsModel || '',
    visionModel: p.visionModel || ''
  };
}

function mediaOf(task) {
  const list = Array.isArray(task.media) ? task.media : [];
  return list
    .filter((e) => e && e.token && e.file)
    .map((e) => ({
      file: e.file,
      mime: e.mime || mimeOf(e.file),
      url: mediaUrl(task.id, e)
    }));
}

function taskPublic(t) {
  const elapsedMs =
    t.elapsedMs ||
    (t.finishedAt && t.createdAt ? new Date(t.finishedAt).getTime() - new Date(t.createdAt).getTime() : undefined);
  return {
    id: t.id,
    cap: t.cap || '',
    status: t.status || 'running',
    progress: t.progress || '',
    model: t.model || '',
    providerName: t.providerName || '',
    prompt: String(t.prompt || '').slice(0, 120),
    createdAt: t.createdAt || '',
    finishedAt: t.finishedAt || '',
    elapsedMs,
    error: t.error || '',
    saved: !!t.saved,
    expired: !!t.expired,
    mode: t.mode || '',
    files: Array.isArray(t.files) ? t.files.map((f) => path.basename(f)) : [],
    media: mediaOf(t)
  };
}

function loadTasks() {
  const cache = readJsonSafe(path.join(irisHome(), 'tasks.json'));
  const tasks = Array.isArray(cache && cache.tasks) ? cache.tasks : [];
  return tasks;
}

function loadProviders() {
  const cache = readJsonSafe(path.join(irisHome(), 'providers.json'));
  return Array.isArray(cache && cache.providers) ? cache.providers : [];
}

/** 构建完整工作台状态（纯 JSON，可序列化） */
export function buildState() {
  const tasks = loadTasks();
  const providers = loadProviders();

  const all = [...tasks].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const running = all.filter((t) => t.status === 'running' && !t.expired);
  const recent = all
    .filter((t) => t.status !== 'running')
    .slice(0, 30)
    .map(taskPublic);

  return {
    iris: {
      home: irisHome()
    },
    providers: providers.map(providerPublic),
    tasks: {
      recent,
      running: running.slice(0, 10).map(taskPublic)
    }
  };
}

/** webServer 前缀路由 handler：GET/HEAD /iris/api/state */
export function serveApi(req, res) {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      if (!res.headersSent) res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    const urlPath = String(req.url || '').split('?')[0];
    if (urlPath !== '/iris/api/state') {
      if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const body = JSON.stringify(buildState());
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(method === 'HEAD' ? undefined : body);
  } catch (err) {
    console.error('[iris] /iris/api 异常:', err && err.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"iris api error"}');
  }
}