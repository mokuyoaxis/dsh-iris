'use strict';
/**
 * Iris HTML 渲染抽象（阶段 3C/HTML 截图）。
 *
 * HtmlRenderer 接口：render({ html, width?, height?, fullPage? }) →
 *   Promise<{ png: Buffer }>
 *
 * BrowserHtmlRenderer：基于宿主 webServer 的 /iris/render/ 静态路由 +
 * DSH Host Adapter 注入的 browser 端口底层服务（可选访问，软耦合）。
 * - 不 import dsh-builtin-browser 包，不在通用渲染层探测 DSH ctx
 * - HTML 通过宿主路由以同源 HTTP 打开（避免 file:// 的 CORS 限制）
 * - 每次调用独立临时渲染目录，用后即删
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { irisHome } from './config.js';
import { mimeOf } from './media.js';
import { resolveRenderAddress } from './render-address.js';
import { ensurePrivateDir, writePrivateFile } from './private-storage.js';
import { imageDimensions } from './pixels.js';

const PNG_DATA_PREFIX = 'data:image/png;base64,';
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;

async function screenshotPng(result) {
  const dataUrl = result?.dataUrl;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_PREFIX)) {
    throw new RenderError('iris_html_screenshot: 浏览器没有返回 PNG 图片数据');
  }
  if (dataUrl.length > PNG_DATA_PREFIX.length + Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) {
    throw new RenderError('iris_html_screenshot: 截图超过 64 MiB，请缩短页面后重试');
  }
  const encoded = dataUrl.slice(PNG_DATA_PREFIX.length);
  const png = Buffer.from(encoded, 'base64');
  if (!png.length || png.length > MAX_SCREENSHOT_BYTES || png.toString('base64') !== encoded
      || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new RenderError('iris_html_screenshot: 浏览器返回的 PNG 图片数据无效');
  }
  let dimensions;
  try { dimensions = await imageDimensions(png); }
  catch (cause) {
    const error = new RenderError('iris_html_screenshot: 浏览器返回的 PNG 图片无法读取');
    error.cause = cause;
    throw error;
  }
  // 与独立 Chromium 后端保持相同的截图尺寸上限，采用实际图片尺寸而非浏览器声明值。
  if (dimensions.width > 16384 || dimensions.height > 16384 || dimensions.width * dimensions.height > 40000000) {
    throw new RenderError('iris_html_screenshot: 截图尺寸超过限制（边长 16384，4000 万像素）');
  }
  return png;
}

export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderError';
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new RenderError('iris_html_screenshot: 已取消');
  error.name = 'AbortError';
  throw error;
}

function waitForRender(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', canceled);
      resolve();
    };
    const canceled = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', canceled);
      const error = new RenderError('iris_html_screenshot: 已取消');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener?.('abort', canceled, { once: true });
  });
}

/** 渲染临时目录根：$DSH_HOME/iris/v1/render/ */
export function renderRoot() {
  return path.join(irisHome(), 'render');
}

/**
 * 基于 DSH Adapter 持有的原生 browser 服务完成 HTML → PNG。
 * @param {{browser?: object, waitMs?: number, getAddress?: function}} opts browser 只在 DSH Adapter 内构造
 */
export class BrowserHtmlRenderer {
  constructor({ browser, waitMs = 1200, getAddress = resolveRenderAddress }) {
    this.browser = browser;
    this.waitMs = waitMs;
    this.getAddress = getAddress;
  }

  async render({ html, width, height, fullPage, signal }) {
    const b = this.browser;
    if (!b || !['open', 'openUrl', 'screenshot', 'close'].every((name) => typeof b[name] === 'function')) {
      throw new RenderError('iris: 浏览器服务不可用——需要启用兼容的 dsh-builtin-browser 插件');
    }
    const text = String(html || '').trim();
    if (!text) throw new RenderError('iris_html_screenshot: html 不能为空');
    throwIfAborted(signal);
    const address = this.getAddress();
    if (address.status === 'invalid') {
      throw Object.assign(new RenderError(address.message), { code: address.code });
    }

    // 每次调用独立子目录（随机名），写 index.html
    const dir = path.join(renderRoot(), crypto.randomBytes(6).toString('hex'));
    ensurePrivateDir(dir);
    let content = text;
    if (width || height) {
      const w = width ? Math.floor(width) : 'auto';
      const h = height ? Math.floor(height) : 'auto';
      content = `<div style="min-width:${w}px;min-height:${h}px">${text}</div>`;
    }
    const htmlPath = path.join(dir, 'index.html');
    writePrivateFile(htmlPath, content);
    const url = `${address.baseUrl}/iris/render/${path.basename(dir)}/index.html`;
    try {
      // open 只接受可选的会话名称；取消发生在打开期间时，取得会话后仍须关闭。
      const session = await b.open();
      try {
        throwIfAborted(signal);
        await b.openUrl(session, { url, newTab: true }, signal);
        throwIfAborted(signal);
        await waitForRender(this.waitMs, signal); // 等页面加载（无加载完成事件可用的折中）
        throwIfAborted(signal);
        // 不要求浏览器写入 Iris 私有目录，兼容 downloadDir 内的保存路径限制。
        const result = await b.screenshot(session, { fullPage: fullPage !== false, format: 'png' }, signal);
        throwIfAborted(signal);
        const png = await screenshotPng(result);
        throwIfAborted(signal);
        return { png };
      } finally {
        try { await b.close(session); } catch (_) { /* 幂等 */ }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true }); // 用完即清
    }
  }
}

/* ---------------- /iris/render/ 静态路由（同源 HTTP 服务渲染目录） ---------------- */

/**
 * webServer 前缀路由 handler：GET/HEAD /iris/render/<dir>/<file>。
 * 只服务 renderRoot() 下两级路径（随机子目录 + 单文件），路径穿越一律 404。
 */
export function serveRender(req, res) {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      if (!res.headersSent) res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    const parts = String(req.url || '').split('?')[0].split('/').filter(Boolean);
    // /iris/render/<dir>/<file> —— 恰好 4 段（iris/render/dir/file）
    if (parts.length !== 4 || parts[0] !== 'iris' || parts[1] !== 'render') {
      return send404(res);
    }
    const [, , subdir, file] = parts;
    // 段必须是安全 basename（拒绝 .. / 空）
    for (const seg of [subdir, file]) {
      if (!seg || seg === '.' || seg === '..' || /[\\/]/.test(seg)) return send404(res);
    }
    const root = renderRoot();
    const abs = path.join(root, subdir, file);
    // 双保险：解析后必须仍在渲染根内
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return send404(res);
    }
    const size = fs.statSync(abs).size;
    // .html 必须是 text/html（Chromium 在 nosniff 下拒绝 octet-stream 的 HTML 导航 → ERR_ABORTED）
    const ext = path.extname(file).toLowerCase();
    const contentType = ext === '.html' || ext === '.htm'
      ? 'text/html; charset=utf-8'
      : mimeOf(file);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': size,
      'Cache-Control': 'no-store',
      // 不可信 HTML 只负责排版截图：无脚本、无网络、无表单，且为 opaque origin。
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(method === 'HEAD' ? undefined : fs.readFileSync(abs));
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('render error');
  }
}

function send404(res) {
  if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}
