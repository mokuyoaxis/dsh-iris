'use strict';
/**
 * Iris 媒体通道 —— 让视频/音频像图片一样在对话流里可点可播。
 *
 * 背景：DSH 附件服务只收图片（saveImage/readImage），mp4/wav 无原生通路。
 * 方案（学 vision-mix）：宿内 /iris/media 路由 + 工具结果返回播放链接。
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
