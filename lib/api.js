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
import { irisHome, capabilitiesOf, onChange as onConfigChange } from './config.js';
import { mimeOf, mediaUrl } from './media.js';
import * as tasks from './tasks.js';
import { runAction } from './actions.js';

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
    capabilities: capabilitiesOf(p),
    // 迁移/推断结果是否与原始声明不同（UI 提示旧配置已推断）
    capabilityInferred: !Array.isArray(p.capabilities) || p.capabilities.length === 0,
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
    providers: providers.map(providerPublic),
    tasks: {
      recent,
      running: running.slice(0, 10).map(taskPublic)
    }
  };
}

/* ---------------- SSE 共享状态推送（阶段 4：状态变化即推，替代 5s 轮询） ---------------- */

/** 当前活跃 SSE 连接数（生命周期成本测量：连接管理面） */
export function sseClientCount() {
  return sseClients.size;
}

const sseClients = new Set(); // 活跃 res（长连接）
let sseHeartbeat = null;      // 心跳定时器（15s，防代理/浏览器空闲断连）
let sseThrottleTimer = null;  // 推送节流（400ms 合并，防盯守高频 update 刷屏）
let ssePending = false;
let sseBound = false;

function pushSse(res, data) {
  if (!res || res.writableEnded || res.destroyed) return;
  try {
    res.write(`data: ${data}\n\n`);
  } catch (_) {
    /* 连接已死，close 事件会清理 */
  }
}

function broadcastState() {
  if (!sseClients.size) return;
  let body;
  try {
    body = JSON.stringify(buildState());
  } catch (_) {
    return;
  }
  for (const res of [...sseClients]) pushSse(res, body);
}

/** 状态变化 → 节流合并后推送（400ms 窗口内多次落盘只推一次） */
function scheduleBroadcast() {
  if (ssePending) return;
  ssePending = true;
  sseThrottleTimer = setTimeout(() => {
    ssePending = false;
    broadcastState();
  }, 400);
  if (sseThrottleTimer && sseThrottleTimer.unref) sseThrottleTimer.unref();
}

function ensureHeartbeat() {
  if (sseHeartbeat) return;
  sseHeartbeat = setInterval(() => {
    for (const res of [...sseClients]) pushSse(res, ': ping'); // 注释行保持连接活跃
    if (!sseClients.size) stopHeartbeat();
  }, 15000);
  if (sseHeartbeat && sseHeartbeat.unref) sseHeartbeat.unref();
}

function stopHeartbeat() {
  if (sseHeartbeat) {
    clearInterval(sseHeartbeat);
    sseHeartbeat = null;
  }
}

/** 插件停用/路由卸载：关闭全部 SSE 长连接（生命周期成本：不留悬挂连接） */
export function closeAllSse() {
  for (const res of [...sseClients]) {
    try {
      res.end();
    } catch (_) {
      /* ignore */
    }
  }
  sseClients.clear();
  stopHeartbeat();
  if (sseThrottleTimer) {
    clearTimeout(sseThrottleTimer);
    sseThrottleTimer = null;
    ssePending = false;
  }
  unbindChangeBus(); // 退订状态总线：不留「停用后每次落盘仍空转节流定时器」的悬挂副作用
}

/** 订阅任务/配置变化总线（幂等，只绑一次） */
let sseBusDisposers = [];
function bindChangeBus() {
  if (sseBound) return;
  sseBound = true;
  sseBusDisposers = [tasks.onChange(scheduleBroadcast), onConfigChange(scheduleBroadcast)];
}
function unbindChangeBus() {
  for (const d of sseBusDisposers) {
    try { d(); } catch (_) { /* 幂等退订 */ }
  }
  sseBusDisposers = [];
  sseBound = false;
}

/** GET /iris/api/state/events —— SSE 流：连接即推当前状态，此后状态变化实时推送 */
function serveSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n'); // 断线 3s 自动重连
  sseClients.add(res);
  bindChangeBus();
  ensureHeartbeat();
  pushSse(res, JSON.stringify(buildState())); // 立即推当前状态
  const onClose = () => {
    sseClients.delete(res);
    if (!sseClients.size) stopHeartbeat();
  };
  res.on('close', onClose);
  res.on('error', onClose);
}

/** webServer 前缀路由 handler：GET/HEAD /iris/api/state 和 /iris/api/task/:id，POST /iris/api/actions/:name */
export function serveApi(req, res, ctx) {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    const urlPath = String(req.url || '').split('?')[0];

    // POST /iris/api/actions/:name —— GUI 直连触发工具执行
    if (method === 'POST') {
      const actionMatch = typeof ctx === 'object' && urlPath.match(/^\/iris\/api\/actions\/([A-Za-z0-9_-]+)\/?$/);
      if (!actionMatch) { return sendJson(res, 405, { error: 'method not allowed' }); }
      return handleAction(ctx, actionMatch[1], req, res);
    }
    // GET/HEAD 原逻辑
    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    // SSE 共享状态推送（阶段 4）：仅 GET /iris/api/state/events 长连接；HEAD 不适用（无 body）
    if (urlPath === '/iris/api/state/events') {
      if (method === 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      return serveSse(res);
    }
    const taskMatch = urlPath.match(/^\/iris\/api\/task\/([^/]+)$/);
    if (taskMatch) {
      return serveTaskDetail(taskMatch[1], method, res);
    }
    if (urlPath !== '/iris/api/state') {
      return sendJson(res, 404, { error: 'not found' });
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
    sendJson(res, 500, { error: 'iris api error' });
  }
}

function sendJson(res, status, obj) {
  if (res.writableEnded || res.destroyed) return; // 已结束/已销毁的连接不再写（end 后二次 end 防御）
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

/** POST /iris/api/actions/:name：读取 JSON body 调 runAction 返回结果 */
const MAX_BODY_BYTES = 1e6; // 1MB 上限（防滥用）
function handleAction(ctx, name, req, res) {
  const chunks = [];
  let totalBytes = 0; // 注意：必须按字节计——body 数组的 length 是块数不是字节数（旧代码的坑）
  let overflow = false;
  req.on('data', (c) => {
    if (overflow) return;
    totalBytes += c.length;
    if (totalBytes > MAX_BODY_BYTES) {
      overflow = true;
      chunks.length = 0; // 丢弃已收块，不再占内存
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (overflow) return sendJson(res, 413, { error: 'request body too large (limit 1MB)' });
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      const args = raw ? JSON.parse(raw) : {};
      const result = await runAction(ctx, name, args, {});
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: String((err && err.message) || err) });
    }
  });
  req.on('error', () => sendJson(res, 400, { error: 'bad request' }));
}

/** GET /iris/api/task/:id —— 返回完整任务详情（含完整 prompt、error、remoteTaskId、attachments） */
function serveTaskDetail(taskId, method, res) {
  const t = tasks.get(taskId);
  if (!t) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"task not found"}');
    return;
  }
  const elapsedMs =
    t.elapsedMs ||
    (t.finishedAt && t.createdAt ? new Date(t.finishedAt).getTime() - new Date(t.createdAt).getTime() : undefined);
  const body = JSON.stringify({
    id: t.id,
    cap: t.cap || '',
    status: t.status || '',
    progress: t.progress || '',
    model: t.model || '',
    providerName: t.providerName || '',
    prompt: t.prompt || '',
    createdAt: t.createdAt || '',
    finishedAt: t.finishedAt || '',
    elapsedMs: elapsedMs || undefined,
    error: t.error || '',
    mode: t.mode || '',
    remoteTaskId: t.remoteTaskId || '',
    files: Array.isArray(t.files) ? t.files.map((f) => path.basename(f)) : [],
    media: mediaOf(t),
    attachments: Array.isArray(t.attachments) ? t.attachments.map((a) => ({
      attachmentId: a.attachmentId,
      file: a.file || '',
      mediaType: a.mediaType || ''
    })) : []
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(method === 'HEAD' ? undefined : body);
}