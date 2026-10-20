import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import sharp from 'sharp';
import { resolveRenderAddress } from '../lib/render-address.js';
import { createDshHostAdapter } from '../lib/dsh-host-adapter.js';
import { BrowserHtmlRenderer, serveRender, renderRoot } from '../lib/render.js';
import { webBase } from '../lib/media.js';
import { hostDoctor } from '../lib/doctor.js';
import { guarded } from '../lib/guard.js';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-render-address');
const savedOverride = process.env.DSH_WEB_BASE;
delete process.env.DSH_WEB_BASE;
try {
  for (const [listener, baseUrl] of [
    [{ host: '127.0.0.1', port: 3080 }, 'http://127.0.0.1:3080'],
    [{ host: '127.0.0.1', port: 3180 }, 'http://127.0.0.1:3180'],
    [{ host: '0.0.0.0', port: 3180 }, 'http://127.0.0.1:3180'],
    [{ host: '::', port: 3180 }, 'http://[::1]:3180'],
    [{ host: '[::]', port: 3180 }, 'http://[::1]:3180'],
    [{ host: '::1', port: 3180 }, 'http://[::1]:3180'],
    [{ host: 'localhost', port: 3180 }, 'http://localhost:3180'],
    [{ host: '127.0.0.1', port: 3443, protocol: 'https:' }, 'https://127.0.0.1:3443']
  ]) {
    assert.deepEqual(resolveRenderAddress(listener), { source: 'host', status: 'resolved', baseUrl });
  }
  for (const listener of [undefined, {}, { host: 'localhost', port: 0 }, { host: 'localhost', port: '3180' }]) {
    const result = resolveRenderAddress(listener);
    assert.equal(result.status, 'fallback');
    assert.equal(result.baseUrl, 'http://127.0.0.1:3080');
    assert.match(result.message, /DSH_WEB_BASE/);
  }
  for (const listener of [{ host: 'x@y', port: 3180 }, { host: '::1%lo', port: 3180 },
    { host: 'localhost', port: 3180, protocol: 'file:' }]) {
    assert.equal(resolveRenderAddress(listener).status, 'invalid');
  }
  const prefix = resolveRenderAddress({ host: 'localhost', port: 3180 }, ' https://proxy.example/iris-host/// ');
  assert.equal(prefix.source, 'environment');
  assert.equal(prefix.baseUrl, 'https://proxy.example/iris-host');
  for (const value of ['not a URL', 'file:///tmp/html', 'https://user:secret@example.test',
    'https://example.test?token=secret', 'https://example.test#secret']) {
    const result = resolveRenderAddress({ host: 'localhost', port: 3180 }, value);
    assert.equal(result.status, 'invalid', '显式错误配置不静默回落');
    assert(!JSON.stringify(result).includes('secret'), '不回显含凭据或 token 的原始地址');
  }

  let port, navigated, closes = 0;
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#fff' } }).png().toBuffer();
  const browser = {
    async open() { return 'local-render'; },
    async openUrl(session, request, signal) {
      assert.equal(session, 'local-render');
      navigated = new URL(request.url);
      const response = await fetch(request.url, { signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
      assert.match(await response.text(), /实际端口/);
    },
    async screenshot() { return { dataUrl: 'data:image/png;base64,' + png.toString('base64') }; },
    async close() { closes++; }
  };
  const listener = { host: '0.0.0.0', get port() { return port; },
    get config() { throw new Error('不得读取私有配置'); },
    getOrigin() { throw new Error('只读诊断不调用宿主方法'); } };
  const host = createDshHostAdapter({ get(name) { return ({ browser, webServer: listener })[name]; } });
  assert.equal(host.ports.browser.address.status, 'fallback', '监听前不捏造动态端口');
  const server = http.createServer(guarded(serveRender));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  try {
    assert.equal(host.ports.browser.address.baseUrl, 'http://127.0.0.1:' + port, '已有 Adapter 读取最新实际端口');
    const result = await host.ports.browser.renderHtml({ html: '<p>实际端口</p>', fullPage: false });
    assert.deepEqual(Buffer.from(result.bytes), png);
    assert.equal(navigated.hostname, '127.0.0.1');
    assert.equal(navigated.port, String(port));
    assert.equal(closes, 1);
    assert.deepEqual(fs.readdirSync(renderRoot()), []);
    assert.equal(webBase(), 'http://127.0.0.1:3080', 'P2 不改变公开媒体链接基址语义');
    const report = hostDoctor(host);
    assert(report.checks.some(item => item.id === 'render-address' && item.status === 'ok' && item.summary.includes(String(port))));
    assert(report.checks.some(item => item.id === 'browser' && /接口已提供/.test(item.summary)));
    assert.equal(closes, 1, 'Doctor 不启动或调用浏览器');
    process.env.DSH_WEB_BASE = 'http://127.0.0.1:3180/reverse-prefix/';
    assert.equal(host.ports.browser.address.baseUrl, 'http://127.0.0.1:3180/reverse-prefix');
    process.env.DSH_WEB_BASE = 'https://user:secret@example.test';
    const invalid = hostDoctor(host);
    assert(invalid.checks.some(item => item.id === 'render-address' && item.status === 'warn'));
    assert(!JSON.stringify(invalid).includes('secret'));
    await assert.rejects(host.ports.browser.renderHtml({ html: '<p>invalid override</p>' }), { code: 'IRIS_RENDER_ADDRESS_INVALID' });
    assert.equal(closes, 1, '无效显式地址在创建会话前拒绝');
    assert.deepEqual(fs.readdirSync(renderRoot()), []);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  // 路径前缀不得在拼接时丢失；缺宿主的直接渲染器仍保留默认行为。
  process.env.DSH_WEB_BASE = 'https://proxy.example/nested/';
  const direct = new BrowserHtmlRenderer({ browser: { ...browser, async openUrl(_session, request) {
    assert.match(request.url, /^https:\/\/proxy\.example\/nested\/iris\/render\//);
  } }, waitMs: 0 });
  await direct.render({ html: '<p>prefix</p>' });
} finally {
  if (savedOverride === undefined) delete process.env.DSH_WEB_BASE;
  else process.env.DSH_WEB_BASE = savedOverride;
}
console.log('ALL OK —— 截图实际监听端口/协议、通配监听地址、显式前缀覆盖、无效配置脱敏、旧宿主回落及零调用 Doctor');
