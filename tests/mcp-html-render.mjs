import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { LEGACY_BRIDGE_TOOLS_V0 } from '../lib/core-bridge-selection.js';
import { connectionSkillResources } from '../lib/connection-skill.js';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-html-render');
const dataRoot = path.join(root, 'core-v1');
const cliBin = path.resolve('bin/dsh-iris.js');
const uuid = () => crypto.randomUUID();
const services = [];
const stdioClients = [];
const children = [];

async function makePng(width, height, background) {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

function findRealChromium() {
  if (process.env.IRIS_TEST_BROWSER_EXECUTABLE) {
    return {
      executable: process.env.IRIS_TEST_BROWSER_EXECUTABLE,
      noSandbox: process.env.IRIS_TEST_BROWSER_NO_SANDBOX === 'true'
    };
  }
  const cacheRoot = path.join(process.env.HOME || '', '.cache/ms-playwright');
  if (!fs.existsSync(cacheRoot)) return null;
  for (const entry of fs.readdirSync(cacheRoot).filter(name => name.startsWith('chromium-')).sort().reverse()) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux-arm64/chrome', 'chrome-linux/chrome']) {
      const candidate = path.join(cacheRoot, entry, rel);
      if (fs.existsSync(candidate)) return { executable: candidate, noSandbox: true };
    }
  }
  return null;
}

try {
  // 1. Initialize standalone v1 root (no execution, no provider config).
  const app = createApplicationRuntime({ dataRoot });
  try {
    await app.execute('flow.init', {});
    await app.execute('execution.init', {});
  } finally {
    await app.dispose();
  }

  assert(!LEGACY_BRIDGE_TOOLS_V0.includes('iris_core_render_html'), 'LEGACY_BRIDGE_TOOLS_V0 must remain frozen');

  // 2. Synchronous constructor validation (zero I/O).
  const dummyBrowser = { async renderHtml() { return { bytes: Buffer.alloc(0), mediaType: 'image/png' }; } };
  assert.throws(() => createLocalReadApi({ dataRoot, browserExecutable: 'relative/chrome' }), { code: 'IRIS_API_CONFIG_INVALID' });
  assert.throws(() => createLocalReadApi({ dataRoot, browserExecutable: '/bin/sh', browser: dummyBrowser }), { code: 'IRIS_API_CONFIG_INVALID' });
  assert.throws(() => createLocalReadApi({ dataRoot, browserNoSandbox: true }), { code: 'IRIS_API_CONFIG_INVALID' });
  assert.throws(() => createLocalReadApi({ dataRoot, browserNoSandbox: 'true', browser: dummyBrowser }), TypeError);
  assert.throws(() => createLocalReadApi({ dataRoot, browser: {} }), TypeError);
  for (const badTimeout of [0, -10, 60001, 1.5, '1000']) {
    assert.throws(() => createLocalReadApi({ dataRoot, browser: dummyBrowser, browserTimeoutMs: badTimeout }), { code: 'IRIS_API_CONFIG_INVALID' });
  }

  // 3. Startup filesystem validation for browserExecutable.
  for (const badPath of [
    path.join(root, 'does-not-exist-chrome'),
    root
  ]) {
    const badApi = createLocalReadApi({ dataRoot, allowLocalWrites: true, browserExecutable: badPath });
    await assert.rejects(badApi.start(), { code: 'IRIS_API_CONFIG_INVALID' });
  }
  if (process.platform !== 'win32') {
    const nonExec = path.join(root, 'not-executable.txt');
    fs.writeFileSync(nonExec, 'hello', { mode: 0o600 });
    const badApi = createLocalReadApi({ dataRoot, allowLocalWrites: true, browserExecutable: nonExec });
    await assert.rejects(badApi.start(), { code: 'IRIS_API_CONFIG_INVALID' });
  }
  const insideRootExec = path.join(dataRoot, 'fake-chrome');
  fs.writeFileSync(insideRootExec, '#!/bin/sh\n', { mode: 0o700 });
  const insideApi = createLocalReadApi({ dataRoot, allowLocalWrites: true, browserExecutable: insideRootExec });
  await assert.rejects(insideApi.start(), { code: 'IRIS_API_CONFIG_INVALID' });
  fs.rmSync(insideRootExec);

  // 4. Default OFF check: html-render disabled -> 404, hidden from catalog & session.
  const defaultApi = createLocalReadApi({ dataRoot, allowLocalWrites: true });
  services.push(defaultApi);
  const defaultSession = await defaultApi.start();
  assert.equal(defaultApi.snapshot().htmlRenderEnabled, undefined);
  const defaultInfo = await (await fetch(defaultSession.origin + '/api/v0/session', {
    headers: { Authorization: 'Bearer ' + defaultSession.accessToken }
  })).json();
  assert.equal(defaultInfo.htmlRender, undefined);
  assert(!defaultInfo.operations.includes('html.render'));
  const defaultCatalog = await (await fetch(defaultSession.origin + '/api/v0/capabilities', {
    headers: { Authorization: 'Bearer ' + defaultSession.accessToken }
  })).json();
  assert(!defaultCatalog.groups.some(g => g.id === 'html-render'));
  assert.deepEqual(defaultCatalog.media.find(m => m.id === 'html-render').capabilities, []);
  const disabledRes = await fetch(defaultSession.origin + '/api/v0/html-render', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + defaultSession.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>hi</p>' })
  });
  assert.equal(disabledRes.status, 404);
  await disabledRes.arrayBuffer();
  await defaultApi.dispose();

  // 5. Read-only service with browser configured -> POST returns 405.
  const roApi = createLocalReadApi({ dataRoot, allowLocalWrites: false, browser: dummyBrowser });
  services.push(roApi);
  const roSession = await roApi.start();
  assert.equal(roApi.snapshot().htmlRenderEnabled, true);
  const roRes = await fetch(roSession.origin + '/api/v0/html-render', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + roSession.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>hi</p>' })
  });
  assert.equal(roRes.status, 405);
  await roRes.arrayBuffer();
  await roApi.dispose();

  // 6. Controlled mock browser on standalone v1 root (allowLocalWrites: true, allowExecution: false, no provider config).
  const mockCalls = [];
  let mockBehavior = 'ok';
  let releaseHold = null;
  let holdStarted = null;
  const mockPng = await makePng(64, 48, { r: 24, g: 118, b: 210 });
  const mockPngSmall = await makePng(40, 30, { r: 210, g: 80, b: 40 });
  const mockBrowser = {
    async renderHtml(input) {
      mockCalls.push({ html: input.html, width: input.width, height: input.height, fullPage: input.fullPage, hasSignal: input.signal instanceof AbortSignal });
      if (mockBehavior === 'hold') {
        holdStarted?.();
        await new Promise((resolve, reject) => {
          releaseHold = resolve;
          input.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      if (mockBehavior === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      if (mockBehavior === 'failed') throw Object.assign(new Error('chromium crashed at /private/secret/path'), { code: 'IRIS_BROWSER_FAILED' });
      if (mockBehavior === 'oversized') throw Object.assign(new Error('截图尺寸超过限制'), { code: 'IRIS_BROWSER_INPUT_INVALID' });
      return { bytes: input.fullPage === false ? mockPngSmall : mockPng, mediaType: 'image/png' };
    }
  };

  // Create 3 static connections: html-render only (read+create), html-render read-only, image-edit only (read+create).
  const grantsDir = path.join(root, 'grants');
  fs.mkdirSync(grantsDir, { recursive: true });
  const htmlPair = createConnectionPair({
    dataRoot, directory: path.join(grantsDir, 'html-rw'), origin: 'http://127.0.0.1:1',
    label: 'HTML render RW', scopes: ['read', 'create'], capabilities: ['html-render']
  });
  const htmlRoPair = createConnectionPair({
    dataRoot, directory: path.join(grantsDir, 'html-ro'), origin: 'http://127.0.0.1:1',
    label: 'HTML render RO', scopes: ['read'], capabilities: ['html-render']
  });
  const imagePair = createConnectionPair({
    dataRoot, directory: path.join(grantsDir, 'image-rw'), origin: 'http://127.0.0.1:1',
    label: 'Image edit RW', scopes: ['read', 'create'], capabilities: ['image-edit']
  });
  const mergedGrants = path.join(grantsDir, 'server-grants.json');
  const allGrants = [htmlPair, htmlRoPair, imagePair].flatMap(p => JSON.parse(fs.readFileSync(p.serverFile, 'utf8')).grants);
  fs.writeFileSync(mergedGrants, JSON.stringify({ schemaVersion: 0, grants: allGrants }, null, 2) + '\n', { mode: 0o600 });

  const mockApi = createLocalReadApi({
    dataRoot, allowLocalWrites: true, allowExecution: false, allowMcp: true,
    connectionsFile: mergedGrants, browser: mockBrowser
  });
  services.push(mockApi);
  const mockSession = await mockApi.start();
  assert.equal(mockApi.snapshot().htmlRenderEnabled, true);

  // Patch client files with live origin.
  for (const pair of [htmlPair, htmlRoPair, imagePair]) {
    const cfg = JSON.parse(fs.readFileSync(pair.clientFile, 'utf8'));
    cfg.origin = mockSession.origin;
    fs.writeFileSync(pair.clientFile, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  }

  const sessionInfo = await (await fetch(mockSession.origin + '/api/v0/session', {
    headers: { Authorization: 'Bearer ' + mockSession.accessToken }
  })).json();
  assert.equal(sessionInfo.htmlRender, true);
  assert(sessionInfo.operations.includes('html.render'));
  assert.equal(sessionInfo.limits.htmlBytes, 1024 * 1024);

  // Owner uploads an unbound import PNG to verify html-render-only isolation.
  const unboundImportPng = await makePng(16, 16, { r: 10, g: 20, b: 30 });
  const importRes = await fetch(mockSession.origin + '/api/v0/images', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + mockSession.accessToken, 'Content-Type': 'image/png', 'Idempotency-Key': uuid() },
    body: unboundImportPng
  });
  assert.equal(importRes.status, 201);
  const importedArtifactId = (await importRes.json()).artifact.artifactId;

  const htmlToken = JSON.parse(fs.readFileSync(htmlPair.clientFile, 'utf8')).accessToken;
  const htmlRoToken = JSON.parse(fs.readFileSync(htmlRoPair.clientFile, 'utf8')).accessToken;
  const imageToken = JSON.parse(fs.readFileSync(imagePair.clientFile, 'utf8')).accessToken;

  // Test stdio & HTTP MCP across both protocol versions.
  let renderedArtifactId;
  for (const transport of ['http', 'stdio']) {
    for (const version of ['2025-11-25', '2026-07-28']) {
      const client = transport === 'http'
        ? httpMcpClient(mockSession.origin, htmlToken, { version })
        : stdioMcpClient(cliBin, htmlPair.clientFile, 'read,create', { version });
      if (transport === 'stdio') stdioClients.push(client);
      await client.initialize();
      const listed = (await client.request('tools/list')).tools;
      assert.deepEqual(listed.map(t => t.name), ['iris_core_connection', 'iris_core_image', 'iris_core_render_html', 'iris_core_connections']);
      const renderTool = listed.find(t => t.name === 'iris_core_render_html');
      assert.deepEqual(renderTool.annotations, {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false
      });

      const callRes = await client.call('iris_core_render_html', {
        html: '<div style="color:#1876d2">Hello</div>', width: 320, height: 240, fullPage: false
      });
      assert.equal(callRes.isError, undefined, JSON.stringify(callRes));
      const payload = callRes.structuredContent;
      assert.equal(payload.contractVersion, 0);
      assert.match(payload.artifact.artifactId, /^artifact_[a-f0-9]{24}$/);
      assert.equal(payload.artifact.mediaType, 'image/png');
      assert.equal(payload.artifact.width, 40);
      assert.equal(payload.artifact.height, 30);
      assert(!JSON.stringify(callRes).includes(root), 'must never leak host paths');
      renderedArtifactId = payload.artifact.artifactId;

      // Read back the rendered PNG via iris_core_image on the same html-render-only connection.
      const imgRes = await client.call('iris_core_image', { artifactId: renderedArtifactId });
      assert.equal(imgRes.isError, undefined);
      const imageBlock = imgRes.content.find(c => c.type === 'image');
      assert.deepEqual(Buffer.from(imageBlock.data, 'base64'), mockPngSmall);

      // html-render-only connection MUST NOT read unbound import images belonging to other capabilities.
      const deniedImport = await client.call('iris_core_image', { artifactId: importedArtifactId });
      assert.equal(deniedImport.isError, true);
      assert.equal(deniedImport.structuredContent.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');

      if (transport === 'stdio') assert.equal((await client.close()).status, 0);
    }
  }
  assert.equal(mockCalls.length, 4);
  assert(mockCalls.every(c => c.width === 320 && c.height === 240 && c.fullPage === false && c.hasSignal));

  // Verify default width/height/fullPage and input validation via HTTP MCP.
  const httpClient = httpMcpClient(mockSession.origin, htmlToken);
  await httpClient.initialize();
  const defaultRender = await httpClient.call('iris_core_render_html', { html: '<b>Default viewport</b>' });
  assert.equal(defaultRender.isError, undefined);
  assert.equal(mockCalls.at(-1).width, 1280);
  assert.equal(mockCalls.at(-1).height, 720);
  assert.equal(mockCalls.at(-1).fullPage, true);

  const callsBeforeInvalid = mockCalls.length;
  for (const badArgs of [
    { html: '' },
    { html: '   \n\t ' },
    { html: '中'.repeat(350000) }, // >1 MiB UTF-8 despite <1M chars
    { html: '<p>x</p>', width: 0 },
    { html: '<p>x</p>', width: 4097 },
    { html: '<p>x</p>', height: 0 },
    { html: '<p>x</p>', height: 4097 },
    { html: '<p>x</p>', fullPage: 'false' },
    { html: '<p>x</p>', url: 'https://example.com' },
    { html: '<p>x</p>', outputPath: '/tmp/out.png' }
  ]) {
    const res = await httpClient.call('iris_core_render_html', badArgs).catch(err => ({ rejected: true, err }));
    assert(res.rejected || res.isError === true, 'invalid args must be rejected: ' + JSON.stringify(badArgs));
  }
  assert.equal(mockCalls.length, callsBeforeInvalid, 'invalid inputs must never invoke browser');

  // Read-only connection cannot see or call iris_core_render_html.
  const roClient = httpMcpClient(mockSession.origin, htmlRoToken);
  await roClient.initialize();
  const roTools = (await roClient.request('tools/list')).tools.map(t => t.name);
  assert(!roTools.includes('iris_core_render_html'));
  assert(roTools.includes('iris_core_image'));
  const roImg = await roClient.call('iris_core_image', { artifactId: renderedArtifactId });
  assert.equal(roImg.isError, undefined, 'read-only html-render connection can read html-screenshot');

  // Non-granted image-edit connection does not get iris_core_render_html, yet can read unbound html-screenshot.
  const imgClient = httpMcpClient(mockSession.origin, imageToken);
  await imgClient.initialize();
  assert(!(await imgClient.request('tools/list')).tools.some(t => t.name === 'iris_core_render_html'));
  assert.equal((await imgClient.call('iris_core_image', { artifactId: renderedArtifactId })).isError, undefined);

  // Concurrency 429, Timeout 504, Browser failed 502 (no path leakage), Oversized 400.
  mockBehavior = 'hold';
  const startedHolding = new Promise(resolve => { holdStarted = resolve; });
  const firstRender = fetch(mockSession.origin + '/api/v0/html-render', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + mockSession.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>hold</p>' })
  });
  await startedHolding;
  const busyRes = await fetch(mockSession.origin + '/api/v0/html-render', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + mockSession.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>second</p>' })
  });
  assert.equal(busyRes.status, 429);
  assert.equal((await busyRes.json()).error.code, 'IRIS_API_BUSY');
  releaseHold();
  assert.equal((await firstRender).status, 201);

  mockBehavior = 'timeout';
  const timeoutMcp = await httpClient.call('iris_core_render_html', { html: '<p>slow</p>' });
  assert.equal(timeoutMcp.isError, true);
  assert.equal(timeoutMcp.structuredContent.error.code, 'IRIS_HTML_RENDER_TIMEOUT');

  mockBehavior = 'failed';
  const failedMcp = await httpClient.call('iris_core_render_html', { html: '<p>boom</p>' });
  assert.equal(failedMcp.isError, true);
  assert.equal(failedMcp.structuredContent.error.code, 'IRIS_HTML_RENDER_FAILED');
  assert(!JSON.stringify(failedMcp).includes('/private/secret/path'), 'must never leak browser error internals');

  mockBehavior = 'oversized';
  const oversizedMcp = await httpClient.call('iris_core_render_html', { html: '<p>huge</p>' });
  assert.equal(oversizedMcp.isError, true);
  assert.equal(oversizedMcp.structuredContent.error.code, 'IRIS_API_INPUT_INVALID');

  // Skill generation check.
  const htmlClientCfg = JSON.parse(fs.readFileSync(htmlPair.clientFile, 'utf8'));
  const skill = connectionSkillResources({
    schemaVersion: 0, kind: 'iris-mcp-skill', rootId: htmlClientCfg.rootId, connectionId: htmlClientCfg.connectionId,
    revision: 1, label: 'HTML Render Skill', scopes: ['read', 'create'], capabilities: ['html-render'],
    tools: ['iris_core_connection', 'iris_core_image', 'iris_core_render_html', 'iris_core_connections']
  });
  const skillText = skill.bytes['SKILL.md'].toString('utf8');
  assert(skillText.includes('## Headless HTML/SVG render'));
  assert(skillText.includes('`iris_core_render_html`'));
  assert(skillText.includes('sandbox CSP'));

  await mockApi.dispose();
  console.log('PASS controlled html-render: validation, default-OFF, v1 standalone, stdio/HTTP 2025/2026, isolation, 429/504/502/400 & skill');

  // 7. CLI flag validation checks.
  const cliNoExec = spawnSync(process.execPath, [cliBin, 'api', 'serve', '--data-root', dataRoot,
    '--token-file', path.join(root, 'tok-bad1.txt'), '--browser-no-sandbox'], { encoding: 'utf8' });
  assert.notEqual(cliNoExec.status, 0);
  const cliRelExec = spawnSync(process.execPath, [cliBin, 'api', 'serve', '--data-root', dataRoot,
    '--token-file', path.join(root, 'tok-bad2.txt'), '--browser-executable', 'relative/chrome'], { encoding: 'utf8' });
  assert.notEqual(cliRelExec.status, 0);

  // 8. Real headless Chromium end-to-end test via real `api serve --browser-executable ...` + HTTP MCP!
  const chrome = findRealChromium();
  if (chrome) {
    let networkRequests = 0;
    const spy = http.createServer((_req, res) => { networkRequests++; res.end('blocked'); });
    await new Promise(resolve => spy.listen(0, '127.0.0.1', resolve));
    const spyPort = spy.address().port;

    const realRoot = path.join(root, 'core-real');
    const realApp = createApplicationRuntime({ dataRoot: realRoot });
    try {
      await realApp.execute('flow.init', {});
      await realApp.execute('execution.init', {});
    } finally {
      await realApp.dispose();
    }
    const comboPair = createConnectionPair({
      dataRoot: realRoot, directory: path.join(root, 'real-pair'), origin: 'http://127.0.0.1:1',
      label: 'Real Chromium Combo', scopes: ['read', 'create'], capabilities: ['html-render', 'local-media']
    });
    const tokenFile = path.join(root, 'real-owner-token.txt');
    const child = spawn(process.execPath, [
      cliBin, 'api', 'serve', '--data-root', realRoot, '--token-file', tokenFile,
      '--allow-local-writes', '--allow-mcp', '--connections-file', comboPair.serverFile,
      '--browser-executable', chrome.executable, ...(chrome.noSandbox ? ['--browser-no-sandbox'] : [])
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);

    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const started = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('api serve startup timeout: ' + stderr)), 15000);
      child.stdout.on('data', chunk => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx >= 0) {
          clearTimeout(timer);
          try { resolve(JSON.parse(buf.slice(0, idx))); }
          catch (err) { reject(err); }
        }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('api serve exited early: ' + code + ' ' + stderr)); });
    });
    try {
      assert.equal(started.htmlRenderEnabled, true);
      const comboToken = JSON.parse(fs.readFileSync(comboPair.clientFile, 'utf8')).accessToken;
      const realClient = httpMcpClient(started.origin, comboToken, { version: '2026-07-28', timeoutMs: 45000 });
      await realClient.initialize();

      const cardA = `<!doctype html><html><body style="margin:0;width:200px;height:120px;overflow:hidden;">
        <div style="width:200px;height:60px;background:rgb(24,118,210);"></div>
        <div style="width:200px;height:60px;background:rgb(235,190,40);"></div>
        <img src="http://127.0.0.1:${spyPort}/leak.png">
        <script>document.body.style.background='rgb(255,0,255)';fetch('http://127.0.0.1:${spyPort}/script');</script>
      </body></html>`;
      const cardB = `<!doctype html><html><body style="margin:0;width:200px;height:120px;overflow:hidden;">
        <div style="width:200px;height:60px;background:rgb(24,118,210);"></div>
        <div style="width:200px;height:60px;background:rgb(200,40,40);"></div>
      </body></html>`;

      const resA = await realClient.call('iris_core_render_html', { html: cardA, width: 200, height: 120, fullPage: false });
      assert.equal(resA.isError, undefined, JSON.stringify(resA));
      assert.equal(resA.structuredContent.artifact.width, 200);
      assert.equal(resA.structuredContent.artifact.height, 120);
      assert.equal(networkRequests, 0, 'CSP sandbox must block external image & script fetch');

      const imgA = await realClient.call('iris_core_image', { artifactId: resA.structuredContent.artifact.artifactId });
      assert.equal(imgA.isError, undefined);
      const pngA = Buffer.from(imgA.content.find(c => c.type === 'image').data, 'base64');
      const topPixel = await sharp(pngA).extract({ left: 100, top: 30, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      const botPixel = await sharp(pngA).extract({ left: 100, top: 90, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      assert.deepEqual([...topPixel], [24, 118, 210], 'top half color matches and script did not run');
      assert.deepEqual([...botPixel], [235, 190, 40], 'bottom half color matches');

      const resB = await realClient.call('iris_core_render_html', { html: cardB, width: 200, height: 120, fullPage: false });
      assert.equal(resB.isError, undefined, JSON.stringify(resB));

      // Visual self-check loop: crop top half of cardA & pixel-diff cardA vs cardB!
      const cropped = await realClient.call('iris_core_crop', {
        artifactId: resA.structuredContent.artifact.artifactId, left: 0, top: 0, width: 200, height: 60
      });
      assert.equal(cropped.isError, undefined, JSON.stringify(cropped));
      assert.equal(cropped.structuredContent.artifact.width, 200);
      assert.equal(cropped.structuredContent.artifact.height, 60);
      const cropRead = await realClient.call('iris_core_image', { artifactId: cropped.structuredContent.artifact.artifactId });
      assert.equal(cropRead.isError, undefined);

      const diff = await realClient.call('iris_core_pixel_diff', {
        imageAArtifactId: resA.structuredContent.artifact.artifactId,
        imageBArtifactId: resB.structuredContent.artifact.artifactId
      });
      assert.equal(diff.isError, undefined, JSON.stringify(diff));
      assert(diff.structuredContent.metrics.ratio > 0.45 && diff.structuredContent.metrics.ratio < 0.55,
        'expected ~50% diff ratio, got ' + diff.structuredContent.metrics.ratio);
      const heatmapRead = await realClient.call('iris_core_image', { artifactId: diff.structuredContent.artifact.artifactId });
      assert.equal(heatmapRead.isError, undefined);

      // Verify fullPage: true captures beyond viewport height!
      const tallCard = `<!doctype html><html><body style="margin:0;"><div style="width:180px;height:420px;background:rgb(15,150,90);"></div></body></html>`;
      const resTall = await realClient.call('iris_core_render_html', { html: tallCard, width: 180, height: 100, fullPage: true });
      assert.equal(resTall.isError, undefined, JSON.stringify(resTall));
      assert.equal(resTall.structuredContent.artifact.width, 180);
      assert(resTall.structuredContent.artifact.height >= 420, 'fullPage screenshot should capture full height, got ' + resTall.structuredContent.artifact.height);

      console.log('PASS real Chromium E2E via CLI api serve + HTTP MCP: render (viewport & fullPage) -> read pixels -> CSP zero-network/no-script -> crop -> pixel_diff heatmap');
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      await new Promise(resolve => spy.close(resolve));
    }
  } else {
    console.log('SKIP real Chromium E2E: set IRIS_TEST_BROWSER_EXECUTABLE to enable');
  }
} finally {
  for (const child of children) { try { child.kill('SIGTERM'); } catch (_) {} }
  for (const client of stdioClients) { try { await client.close(); } catch (_) {} }
  for (const service of services) { try { await service.dispose(); } catch (_) {} }
}
