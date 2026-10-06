import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// 与 DSH render 的页面权限一致：只渲染内联样式和内嵌图片，不执行脚本或加载网络资源。
const CSP = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";
const failure = (code, message) => Object.assign(new Error(message), { code });

export function createChromiumBrowser({ executable, noSandbox = false, timeoutMs = 30000 } = {}) {
  if (!executable || !path.isAbsolute(executable)) {
    throw failure('IRIS_BROWSER_REQUIRED', '请通过 --browser-executable 或 IRIS_BROWSER_EXECUTABLE 提供 Chromium 的绝对路径');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw failure('IRIS_BROWSER_INPUT_INVALID', '浏览器超时必须是 1–120000 毫秒');
  }
  return Object.freeze({ async renderHtml({ html, width, height, fullPage, signal }) {
    const operation = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    operation.throwIfAborted();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-browser-'));
    const route = '/' + crypto.randomBytes(16).toString('hex');
    const server = http.createServer((req, res) => {
      if (req.url !== route || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP,
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? '' : html);
    });
    let child;
    let closed;
    let nextId = 0;
    let incoming = Buffer.alloc(0);
    const pending = new Map();
    const events = new Map();
    const rejectPending = error => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      for (const event of events.values()) event.reject(error);
      events.clear();
    };
    const kill = () => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* 已结束 */ }
    };
    const onAbort = () => { rejectPending(operation.reason); kill(); };
    operation.addEventListener('abort', onAbort, { once: true });
    const send = (method, params = {}, sessionId) => {
      operation.throwIfAborted();
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => {
          if (error) { pending.delete(id); reject(failure('IRIS_BROWSER_FAILED', '浏览器通信失败')); }
        });
      });
    };
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      operation.throwIfAborted();
      const args = ['--headless=new', '--hide-scrollbars', '--remote-debugging-pipe', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
        '--user-data-dir=' + profile, ...(noSandbox ? ['--no-sandbox'] : [])];
      child = spawn(executable, args, { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
      closed = new Promise(resolve => {
        child.once('error', () => { rejectPending(failure('IRIS_BROWSER_FAILED', '无法启动 Chromium')); resolve(); });
        child.once('close', () => { rejectPending(failure('IRIS_BROWSER_FAILED', 'Chromium 提前退出；请检查可执行文件及运行环境')); resolve(); });
      });
      child.stdio[3].on('error', () => rejectPending(failure('IRIS_BROWSER_FAILED', '浏览器通信失败')));
      child.stdio[4].on('data', chunk => {
        incoming = Buffer.concat([incoming, chunk]);
        let separator;
        while ((separator = incoming.indexOf(0)) >= 0) {
          const packet = incoming.subarray(0, separator); incoming = incoming.subarray(separator + 1);
          let message;
          try { message = JSON.parse(packet.toString()); } catch (_) { continue; }
          if (message.id) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            if (request) message.error ? request.reject(failure('IRIS_BROWSER_FAILED', 'Chromium 无法完成截图操作')) : request.resolve(message.result);
          } else {
            const key = message.sessionId + ':' + message.method;
            const event = events.get(key);
            if (event) { events.delete(key); event.resolve(message.params); }
          }
        }
      });
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Page.enable', {}, sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      const loaded = new Promise((resolve, reject) => events.set(sessionId + ':Page.loadEventFired', { resolve, reject }));
      // 导航失败时也必须消费事件 Promise 的拒绝。
      loaded.catch(() => {});
      const navigation = await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + route }, sessionId);
      if (navigation.errorText) throw failure('IRIS_BROWSER_FAILED', 'HTML 页面无法加载');
      await loaded;
      const layout = await send('Page.getLayoutMetrics', {}, sessionId);
      const size = fullPage ? layout.cssContentSize : { width, height };
      const captureWidth = Math.max(width, Math.ceil(size.width)), captureHeight = Math.ceil(size.height);
      if (captureWidth > 16384 || captureHeight > 16384 || captureWidth * captureHeight > 40000000) {
        throw failure('IRIS_BROWSER_INPUT_INVALID', '截图尺寸超过限制（边长 16384，4000 万像素）');
      }
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage,
        clip: { x: 0, y: 0, width: captureWidth, height: captureHeight, scale: 1 } }, sessionId);
      operation.throwIfAborted();
      return { bytes: Buffer.from(screenshot.data, 'base64'), mediaType: 'image/png' };
    } finally {
      operation.removeEventListener('abort', onAbort);
      kill();
      if (closed) await closed;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true });
    }
  } });
}
