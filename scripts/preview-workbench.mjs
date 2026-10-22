import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const resources = new Map([
  ['/', ['prototypes/workbench/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['prototypes/workbench/index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['prototypes/workbench/styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['prototypes/workbench/app.js', 'text/javascript; charset=utf-8']],
  ['/view-model.js', ['prototypes/workbench/view-model.js', 'text/javascript; charset=utf-8']],
  ['/demo-transport.js', ['prototypes/workbench/demo-transport.js', 'text/javascript; charset=utf-8']],
  ['/assets/iris-mark.svg', ['docs/assets/logo/iris-mark.svg', 'image/svg+xml']],
  ['/assets/sample.webp', ['docs/assets/examples/iris-flower-generated.webp', 'image/webp']]
]);
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' blob:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";

/** Static, loopback-only developer preview. No Core, configuration or HTTP API. */
export async function startWorkbenchPreview({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('预览端口必须是 0–65535 的整数');
  let origin;
  const server = http.createServer((request, response) => {
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      response.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
        'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        ...(status === 405 ? { Allow: 'GET, HEAD' } : {}) });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    };
    if (request.headers.host !== new URL(origin).host) return send(421, 'Use the printed loopback preview URL.');
    if (request.headers.origin && request.headers.origin !== origin) return send(403, 'Origin not allowed.');
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Static preview only.');
    let target;
    try { target = new URL(request.url, origin); }
    catch (_) { return send(400, 'Invalid preview URL.'); }
    if (target.origin !== origin) return send(400, 'Invalid preview URL.');
    const resource = resources.get(target.pathname);
    if (!resource) return send(404, 'Not found.');
    send(200, fs.readFileSync(path.join(root, resource[0])), resource[1]);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) {
    throw new TypeError('Usage: node scripts/preview-workbench.mjs [--port 0-65535]');
  }
  const preview = await startWorkbenchPreview({ port: args.length ? Number(args[1]) : 0 });
  console.log(`Iris 静态演示原型：${preview.origin}/`);
  console.log('不连接模型、不读取 Core/配置。Ctrl+C 关闭预览。');
  let closing = false;
  const close = () => { if (!closing) { closing = true; preview.close().catch(error => { console.error(error.message); process.exitCode = 1; }); } };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
