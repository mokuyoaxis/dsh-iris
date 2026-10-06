import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCommandService } from '../lib/command-service.js';
import { createChromiumBrowser } from '../lib/chromium-browser.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-html-core-'));
const runtime = createCoreRuntime({ dataRoot: path.join(root, 'core'), mode: 'writer' });
runtime.start();
try {
  const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: 'red' } }).png().toBuffer();
  let calls = 0;
  const service = createCommandService(runtime, { browser: { async renderHtml(input) {
    calls++; assert.equal(input.width, 1280); assert(input.signal); return { bytes: png, mediaType: 'image/png' };
  } } });
  const result = await service.execute('media.html', { html: '<b>Core</b>' });
  assert.equal(result.artifact.kind, 'html-screenshot');
  assert.deepEqual(readCoreArtifactBytes(path.join(root, 'core'), result.artifact.id).bytes, png);
  for (const input of [{ html: '' }, { html: 'x', width: -1 }, { html: 'x', full_page: 'false' }, { html: 'x', url: 'http://example.com' }]) {
    await assert.rejects(service.execute('media.html', input), { code: 'IRIS_COMMAND_INPUT_INVALID' });
  }
  assert.equal(calls, 1);
} finally { await runtime.dispose(); }

const executable = process.env.IRIS_TEST_BROWSER_EXECUTABLE;
if (executable) {
  let networkRequests = 0;
  const listener = http.createServer((_req, res) => { networkRequests++; res.end('unexpected'); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const browser = createChromiumBrowser({ executable, noSandbox: process.env.IRIS_TEST_BROWSER_NO_SANDBOX === 'true' });
  try {
    const html = `<style>body{margin:0;background:rgb(10,120,30)}div{height:1100px}</style><div></div>
      <img src="http://127.0.0.1:${listener.address().port}/external">
      <script>document.body.style.background='red';fetch('http://127.0.0.1:${listener.address().port}/script')</script>`;
    for (const fullPage of [true, false]) {
      const rendered = await browser.renderHtml({ html, width: 320, height: 200, fullPage });
      const dimensions = await sharp(rendered.bytes).metadata();
      assert.equal(dimensions.width, 320); assert.equal(fullPage ? dimensions.height > 1000 : dimensions.height === 200, true);
      const pixel = await sharp(rendered.bytes).extract({ left: 100, top: 100, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      assert.deepEqual([...pixel], [10, 120, 30]);
    }
    assert.equal(networkRequests, 0, 'CSP 必须阻止外部资源和脚本');
    const controller = new AbortController();
    const aborted = browser.renderHtml({ html: '<p>cancel</p>', width: 320, height: 200, fullPage: true, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(aborted, { name: 'AbortError' });
    const cli = spawnSync(process.execPath, ['bin/dsh-iris.js', 'media', 'html', '--data-root', path.join(root, 'cli-core'),
      '--browser-executable', executable, '--browser-no-sandbox', String(process.env.IRIS_TEST_BROWSER_NO_SANDBOX === 'true'),
      '--input', JSON.stringify({ html: '<style>body{margin:0;background:red}</style>', width: 80, height: 60, full_page: false }),
      '--output', path.join(root, 'export.png')], { encoding: 'utf8', env: { ...process.env, DSH_HOME: path.join(root, 'unused-dsh') }, timeout: 45000 });
    assert.equal(cli.status, 0, cli.stderr);
    const output = JSON.parse(cli.stdout);
    assert.deepEqual(output.artifact.metadata, { width: 80, height: 60 });
    assert.equal(fs.existsSync(path.join(root, 'unused-dsh')), false);
    console.log('PASS 真实 Chromium：整页/视口、CSP 阻止外部资源和脚本、取消、独立 CLI 及 Core PNG 导出');
  } finally { await new Promise(resolve => listener.close(resolve)); }
} else console.log('SKIP 真实 Chromium：设置 IRIS_TEST_BROWSER_EXECUTABLE 后运行；Core/Browser Port 测试已通过');
fs.rmSync(root, { recursive: true, force: true });
