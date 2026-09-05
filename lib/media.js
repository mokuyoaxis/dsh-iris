'use strict';
/**
 * Iris 媒体通道 —— 让视频/音频像图片一样在对话流里可点可播。
 *
 * 背景：DSH 附件服务只收图片（saveImage/readImage），mp4/wav 无原生通路。
 * 方案：宿内 /iris/media 路由 + 工具结果返回播放链接。
 *
 * 安全边界：
 * - token 是能力凭证：crypto 随机 128bit，只存在任务记录里，URL 不可枚举
 * - 文件定位只信任务记录（taskId+token 精确匹配），URL 里的文件名段仅作展示，
 *   绝不参与文件系统路径解析（防目录穿越）
 * - 未命中一律 404（不给枚举线索）；仅允许 GET/HEAD
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as tasks from './tasks.js';

const MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

/** Web 基址：默认本机 DSH GUI；反代/远程部署用 DSH_WEB_BASE 覆盖 */
export function webBase() {
  return String(process.env.DSH_WEB_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '');
}

export function mimeOf(name) {
  return MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

function kindLabel(mime) {
  if (mime.startsWith('video/')) return '▶ 视频';
  if (mime.startsWith('audio/')) return '♪ 音频';
  if (mime.startsWith('image/')) return '🖼 图片';
  return '📄 文件';
}

/**
 * 把一个已落盘的产物登记为可访问媒体：生成 token、写进任务记录、返回链接信息。
 * @returns {{file,token,mime,url}|null}
 */
export function registerMedia(taskId, absPath) {
  const t = tasks.get(taskId);
  if (!t) return null;
  const file = path.basename(absPath);
  if (!(t.media || []).some((e) => e.file === file)) {
    const entry = {
      file,
      token: crypto.randomBytes(16).toString('hex'),
      mime: mimeOf(file),
      createdAt: new Date().toISOString()
    };
    tasks.update(taskId, { media: [...(t.media || []), entry] });
    return { ...entry, url: mediaUrl(taskId, entry) };
  }
  const entry = t.media.find((e) => e.file === file);
  return { ...entry, url: mediaUrl(taskId, entry) };
}

export function mediaUrl(taskId, entry) {
  return `${webBase()}/iris/media/${taskId}/${entry.token}/${encodeURIComponent(entry.file)}`;
}

/** 任务记录里全部媒体的 Markdown 播放链接 */
export function mediaLinksOf(task) {
  return (task.media || []).map((e) => `- [${kindLabel(mimeOf(e.file))} 播放](${mediaUrl(task.id, e)})`);
}

/** 解析并授权一次媒体请求；未授权返回 null */
export function authorizeMedia(taskId, token, name) {
  const t = tasks.get(taskId);
  const entry = t && (t.media || []).find((e) => e.token === token && e.file === name);
  if (!entry) return null;
  const abs = path.join(tasks.outputsDir(), entry.file);
  if (!fs.existsSync(abs)) return null;
  return { entry, abs, size: fs.statSync(abs).size };
}

/* ---------------- HTTP 服务（GET/HEAD + Range 流式） ---------------- */

function sendText(res, status, text) {
  if (res.writableEnded || res.destroyed) return; // 已结束连接不再写（与 api.js sendJson 同纪律）
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * 解析单段 Range 头：bytes=start-end / bytes=start- / bytes=-suffix。
 * @returns {null|{invalid:true}|{start:number,end:number}} null = 无/不可解析 → 走 200 全量
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? undefined : Number(m[1]);
  let end = m[2] === '' ? undefined : Number(m[2]);
  if (start === undefined && end === undefined) return null;
  if (start === undefined) {
    const suffix = end;
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= size) return { invalid: true };
    if (end === undefined || !Number.isFinite(end) || end >= size) end = size - 1;
  }
  if (start > end) return null;
  return { start, end };
}

/**
 * 流式服务媒体产物：支持 HEAD、单段 Range（206 Partial Content / 416）、
 * 全量/部分都用 createReadStream 流式，避免大视频整体进内存。
 * 未命中一律 404；仅 GET/HEAD。
 */
export function serveMedia(req, res) {
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
    const base = {
      'Content-Type': hit.entry.mime,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(hit.entry.file)}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    };
    const range = parseRange(req.headers && req.headers.range, hit.size);
    if (range && range.invalid) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${hit.size}` });
      res.end();
      return;
    }
    if (range) {
      const len = range.end - range.start + 1;
      res.writeHead(206, { ...base, 'Content-Length': len, 'Content-Range': `bytes ${range.start}-${range.end}/${hit.size}` });
      if (method === 'HEAD') return res.end();
      const stream = fs.createReadStream(hit.abs, { start: range.start, end: range.end });
      stream.on('error', () => { try { res.destroy(); } catch (_) {} });
      res.on('close', () => { if (!res.writableEnded) stream.destroy(); }); // 客户端中途断开：立即释放读流，不留 fd 到 EOF
      stream.pipe(res);
      return;
    }
    res.writeHead(200, { ...base, 'Content-Length': hit.size });
    if (method === 'HEAD') return res.end();
    const stream = fs.createReadStream(hit.abs);
    stream.on('error', () => { try { res.destroy(); } catch (_) {} });
    res.on('close', () => { if (!res.writableEnded) stream.destroy(); });
    stream.pipe(res);
  } catch (err) {
    sendText(res, 500, 'media error');
  }
}
