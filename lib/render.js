'use strict';
/**
 * Iris HTML 渲染抽象（阶段 3C/HTML 截图）。
 *
 * HtmlRenderer 接口：render({ html, width?, height?, fullPage? }) →
 *   Promise<{ png: Buffer }>
 *
 * BrowserHtmlRenderer：基于宿主 webServer 的 /iris/render/ 静态路由 +
 * dsh-builtin-browser 的 ctx.browser 服务（可选访问，软耦合）。
 * - 不 import dsh-builtin-browser 包，只在运行时探测 ctx.get('browser')
 * - HTML 通过宿主路由以同源 HTTP 打开（避免 file:// 的 CORS 限制）
 * - 每次调用独立临时渲染目录，用后即删
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { irisHome } from './config.js';
import { webBase, mimeOf } from './media.js';

export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderError';
  }
}

/** 渲染临时目录根：$DSH_HOME/iris/v1/render/ */
export function renderRoot() {
  return path.join(irisHome(), 'render');
}

/**
 * 基于 ctx.browser（dsh-builtin-browser）的 HTML → PNG 渲染器。
 * @param {{browser?: object, waitMs?: number}} opts browser 为 ctx.get('browser') 服务
 */
export class BrowserHtmlRenderer {
  constructor({ browser, waitMs = 1200 }) {
    this.browser = browser;
    this.waitMs = waitMs;
  }

  async render({ html, width, height, fullPage }) {
    const b = this.browser;
    if (!b || typeof b.open !== 'function' || typeof b.openUrl !== 'function' || typeof b.screenshot !== 'function') {
      throw new RenderError('iris: 浏览器服务不可用（ctx.get("browser") 为空）——需要启用 dsh-builtin-browser 插件');
    }
    const text = String(html || '').trim();
    if (!text) throw new RenderError('iris_html_screenshot: html 不能为空');

    // 每次调用独立子目录（随机名），写 index.html
    const dir = path.join(renderRoot(), crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    let content = text;
    if (width || height) {
      const w = width ? Math.floor(width) : 'auto';
      const h = height ? Math.floor(height) : 'auto';
      content = `<div style="min-width:${w}px;min-height:${h}px">${text}</div>`;
    }
    const htmlPath = path.join(dir, 'index.html');
    fs.writeFileSync(htmlPath, content, { mode: 0o600 });
    const url = `${webBase()}/iris/render/${path.basename(dir)}/index.html`;
    const pngPath = path.join(dir, 'render.png');

    try {
      const session = await b.open();
      try {
        await b.openUrl(session, { url, newTab: true });
        if (this.waitMs > 0) {
          await new Promise((r) => setTimeout(r, this.waitMs)); // 等页面加载（无加载完成事件可用的折中）
        }
        await b.screenshot(session, { fullPage: fullPage !== false, savePath: pngPath });
      } finally {
        try { await b.close(session); } catch (_) { /* 幂等 */ }
      }
      if (!fs.existsSync(pngPath)) throw new RenderError('iris_html_screenshot: 浏览器未产出截图文件');
      return { png: fs.readFileSync(pngPath) };
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
