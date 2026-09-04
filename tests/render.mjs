/**
 * dsh-iris HTML 截图后端测试（阶段 3C）：/iris/render 静态路由 + BrowserHtmlRenderer。
 * 运行：node tests/render.mjs
 * 覆盖：
 *   ① serveRender：正常 200 / 路径穿越 404 / 非文件 404 / POST 405；
 *   ② BrowserHtmlRenderer：临时目录创建、index.html 写入、open→openUrl→screenshot→close
 *      调用序列、PNG 读取、目录清理；
 *   ③ 缺浏览器服务 → RenderError 人话错误；空 HTML → RenderError。
 * 全部用 stub browser + 真实本地 HTTP 服务器，零真实浏览器。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';

process.env.DSH_HOME = '/tmp/iris-render-home-' + Date.now();

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

const { renderRoot, serveRender, BrowserHtmlRenderer, RenderError } = await import('../lib/render.js');

/* ---------- ① /iris/render 静态路由 ---------- */
const root = renderRoot();
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, 'abc123'), { recursive: true });
fs.writeFileSync(path.join(root, 'abc123', 'index.html'), '<h1>hello render</h1>');

const srv = http.createServer((req, res) => serveRender(req, res));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const get = (p) => new Promise((resolve) => {
  const r = http.request(`http://127.0.0.1:${port}${p}`, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  r.on('error', () => resolve({ status: 0 }));
  r.end();
});

let r = await get('/iris/render/abc123/index.html');
assert(r.status === 200 && r.body === '<h1>hello render</h1>', '渲染文件 200 + 内容', r.status);
const csp = r.headers && r.headers['content-security-policy'];
assert(csp && /sandbox/.test(csp) && /default-src 'none'/.test(csp) && /connect-src 'none'/.test(csp), '渲染 HTML 有 CSP sandbox 且禁脚本网络', csp);
// .html 必须 text/html（Chromium 在 nosniff 下拒绝 octet-stream → ERR_ABORTED）
const ct = await new Promise((resolve) => {
  const req = http.request(`http://127.0.0.1:${port}/iris/render/abc123/index.html`, (res) => {
    res.resume();
    res.on('end', () => resolve(res.headers['content-type'] || ''));
  });
  req.end();
});
assert(ct && ct.startsWith('text/html'), '渲染 HTML 的 Content-Type: text/html', ct);
r = await get('/iris/render/abc123/../index.html');
assert(r.status === 404, '路径穿越 404', r.status);
r = await get('/iris/render/../abc123/index.html');
assert(r.status === 404, '段内穿越 404', r.status);
r = await get('/iris/render/abc123/nonexist.html');
assert(r.status === 404, '不存在文件 404', r.status);
r = await get('/iris/media/x/y/z');
assert(r.status === 404, '错误前缀 404', r.status);
await new Promise((resolve) => {
  const req = http.request(`http://127.0.0.1:${port}/iris/render/abc123/index.html`, { method: 'POST' }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.end();
}).then((s) => assert(s === 405, 'POST 405', s));
srv.close();
srv.closeAllConnections();

/* ---------- ② BrowserHtmlRenderer（stub browser） ---------- */
const calls = [];
const fakePng = await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
const stubBrowser = {
  async open() { calls.push(['open']); return 'sess-1'; },
  async openUrl(session, req) { calls.push(['openUrl', session, req.url, req.newTab]); },
  async screenshot(session, req) {
    calls.push(['screenshot', session, req.fullPage, req.savePath]);
    fs.writeFileSync(req.savePath, fakePng); // 模拟浏览器产出 PNG
  },
  async close(session) { calls.push(['close', session]); }
};

const renderer = new BrowserHtmlRenderer({ browser: stubBrowser, waitMs: 5 });
const out = await renderer.render({ html: '<h1>hi</h1>', fullPage: true });
assert(out.png && out.png.length === fakePng.length, '返回 PNG buffer');

// 调用序列
const seq = calls.map((c) => c[0]).join(' → ');
assert(seq === 'open → openUrl → screenshot → close', '调用序列', seq);
// openUrl 的 URL 是宿主路由
const url = calls[1][2];
assert(/\/iris\/render\/[0-9a-f]{12}\/index\.html$/.test(url), 'openUrl 用宿主 /iris/render URL', url);
assert(calls[2][2] === true && typeof calls[2][3] === 'string' && calls[2][3].endsWith('render.png'), 'screenshot fullPage+savePath');
// 临时目录已清理
const dirs = fs.readdirSync(root).filter((d) => !d.startsWith('.'));
assert(dirs.length === 1 && dirs[0] === 'abc123', '渲染临时目录已清理', dirs);

// width/height 折中：包一层 min-width/min-height 容器（不崩即可）
calls.length = 0;
const sized = await renderer.render({ html: '<p>x</p>', width: 320, height: 240 });
assert(sized.png && calls[1][2].includes('/index.html'), '尺寸折中渲染');
const dirs2 = fs.readdirSync(root).filter((d) => !d.startsWith('.'));
assert(dirs2.length === 1 && dirs2[0] === 'abc123', '第二次渲染目录也已清理', dirs2);

/* ---------- ③ 缺服务 / 空 HTML ---------- */
let err1 = null;
try { await new BrowserHtmlRenderer({ browser: null }).render({ html: '<h1>x</h1>' }); } catch (e) { err1 = e; }
assert(err1 instanceof RenderError && /浏览器服务不可用/.test(err1.message), '缺浏览器服务报错', err1 && err1.message);
let err2 = null;
try { await new BrowserHtmlRenderer({ browser: stubBrowser }).render({ html: '   ' }); } catch (e) { err2 = e; }
assert(err2 instanceof RenderError && /html 不能为空/.test(err2.message), '空 HTML 报错', err2 && err2.message);

console.log('ALL OK —— HTML 截图后端 6 组断言全部通过（静态路由 200/穿越/404/405 + 渲染器序列/清理/错误）');