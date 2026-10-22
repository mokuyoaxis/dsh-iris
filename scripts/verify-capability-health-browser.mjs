/** Real Chromium + installed DSH React + actual Iris API, isolated configuration and localhost media only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === '--dsh-root' && args[2] === '--browser-executable');
const dshRoot = fs.realpathSync(args[1]), executable = fs.realpathSync(args[3]);
const requireDsh = createRequire(path.join(dshRoot, 'package.json'));
const assets = path.join(path.dirname(requireDsh.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/assets');
const entryFile = fs.readdirSync(assets).find(name => /^index-.*\.js$/.test(name));
const frontend = fs.readFileSync(path.join(assets, entryFile), 'utf8');
const builtinName = frontend.match(/function (\w+)\(\)\{return\{react:/)?.[1];
const bootStart = frontend.indexOf('const fo=globalThis.dshDesktopBoot');
assert(builtinName && bootStart > 0, 'review the cached DSH frontend shape before running');
const runtime = frontend.slice(0, bootStart) + '\nexport const irisTestBuiltins = ' + builtinName + '();\n';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-health-browser-'));
process.env.DSH_HOME = path.join(work, 'home'); process.env.IRIS_IMPORT_WORKBENCH_CONFIG = '';
const store = await import('../lib/config.js');
const { serveApi } = await import('../lib/api.js');
const { createDshRuntime, dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const core = createDshRuntime({ dataRoot: dshCoreDataRoot() });
const sharp = (await import('sharp')).default;
const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ae6c65' } }).png().toBuffer();
const rawClient = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const client = rawClient.replace(
  'var clientSlots = clientSlotsPort(ctx);',
  'window.__irisHealth = { WorkbenchPanel }; var clientSlots = clientSlotsPort(ctx);');
const preloadOldStyles = process.env.IRIS_VERIFY_STALE_STYLES === '1';
const report = { status: 'running', work, runtime: entryFile, checks: [], browserErrors: [], providerRequests: [], directoryRequests: [],
  fullDailyDshBoot: false, sourceMountInstrumentation: true, preloadOldStyles, realPaidCalls: 0, clientSha256: createHash('sha256').update(rawClient).digest('hex') };
const save = () => fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n');
let origin, legacy = false, rejectNext = false, rejectDirectory = false;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px/1.5 sans-serif;background:#1c1d24;color:#e6e6e6;margin:24px}#mount{max-width:1060px;margin:auto}button,input,select{font:inherit}
body.light{background:#f4f5f8;color:#252637;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f2f3f7;--dsw-alias-border-l1:#dcdfe8;--dsw-alias-label-primary:#252637;--dsw-alias-label-secondary:#626779;--dsw-alias-brand-primary:#5366d8;--dsw-alias-label-primary-inverted:#fff;--dsw-alias-state-success-primary:#237c54;--dsw-alias-state-error-primary:#be4253}
@media(max-width:640px){body{margin:12px}}</style>
${preloadOldStyles ? '<style id="iris-wb-css">/* stale Iris stylesheet fixture */ .iris-wb-section-arrow{display:inline-flex;gap:7px}</style><script>window.__irisOldStyle=document.getElementById("iris-wb-css")</script>' : ''}
</head><body><main id="mount"></main>
<script>window.__ModuleLoader__={load(entry){window.__irisEntry=entry}};</script><script src="/iris-client.js"></script>
<script type="module">import{irisTestBuiltins}from'/assets/runtime.js';const React=irisTestBuiltins.react;
window.__irisEntry.factory(name=>{if(name==='react')return React;throw Error(name)}).apply({slots:{inject(_seat,callback){callback()},register(){return()=>{}}}});
const c=window.__irisHealth;irisTestBuiltins['react-dom/client'].createRoot(document.getElementById('mount')).render(React.createElement(c.WorkbenchPanel));
window.__mounted=true;</script></body></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
  if (url.pathname === '/iris-client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(client); return; }
  if (url.pathname === '/assets/runtime.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(runtime); return; }
  if (url.pathname.startsWith('/assets/') && !url.pathname.includes('..')) {
    const file = path.join(assets, url.pathname.slice(8));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(fs.readFileSync(file)); return; }
  }
  if (url.pathname === '/v1/models') {
    report.directoryRequests.push({ path: url.pathname, failed: rejectDirectory });
    await new Promise(resolve => setTimeout(resolve, 900));
    res.writeHead(rejectDirectory ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rejectDirectory ? { error: { message: 'fixture directory unavailable' } }
      : { data: [{ id: 'canvas-image', capabilities: ['IG'] }, { id: 'new-image-directory-entry-with-a-deliberately-long-name', capabilities: ['IG'] }] }));
    return;
  }
  if (url.pathname === '/v1/images/generations') {
    let body = ''; for await (const chunk of req) body += chunk;
    report.providerRequests.push(JSON.parse(body).model);
    await new Promise(resolve => setTimeout(resolve, 900));
    res.writeHead(rejectNext ? 401 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rejectNext ? { error: { message: 'fixture credential rejected' } } : { data: [{ b64_json: png.toString('base64') }] }));
    rejectNext = false; return;
  }
  if (legacy && url.pathname === '/iris/api/actions/assignments_get') {
    const { runAction: executeAction } = await import('../lib/actions.js');
    const runAction = (host, name, args, options = {}) => executeAction(host, name, args, { ...options, core });
    const data = await runAction({}, 'assignments_get'); delete data.policies; delete data.readiness;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); return;
  }
  if (url.pathname.startsWith('/iris/')) { serveApi(req, res, {}, core); return; }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
const provider = store.upsert({ name: 'Studio · 本地测试连接', baseUrl: origin + '/v1', auth: 'none', mediaProtocol: 'openai-images', enabled: true,
  models: [{ id: 'canvas-image', capabilities: ['image-gen'] }, { id: 'canvas-image-pro-with-a-deliberately-long-model-name', capabilities: ['image-gen'] }] });
store.setFunctionPolicy('image-gen', 'auto');
const taskProvider = store.upsert({ name: '真实任务入口夹具', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'fixture-never-used',
  mediaProtocol: 'dashscope', models: [{ id: 'fixture-video', capabilities: ['video-gen'] }, { id: 'fixture-asr', capabilities: ['transcribe'] },
    { id: 'fixture-music', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' }] });
for (const cap of ['video-gen', 'transcribe', 'music-gen']) store.setFunctionPolicy(cap, 'auto');
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('browser verifier forbids external requests');
  return originalFetch(input, options);
};
const browserDir = path.join(work, 'browser');
const child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking',
  '--disable-extensions', '--disable-sync', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + browserDir, 'about:blank'],
{ stdio: ['ignore', 'ignore', 'pipe'] });
const log = fs.createWriteStream(path.join(work, 'browser.log')); child.stderr.pipe(log);
const closed = new Promise(resolve => child.once('close', resolve));
let socket, nextId = 0; const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check, label) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await check()) return; await sleep(100); } throw new Error('Timed out: ' + label); };
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value;
};
const click = async text => {
  await wait(() => evaluate(`[...document.querySelectorAll('.iris-health button')].some(n=>n.textContent.trim()===${JSON.stringify(text)}&&!n.disabled)`), 'ready button ' + text);
  return evaluate(`{const n=[...document.querySelectorAll('.iris-health button')].find(n=>n.textContent.trim()===${JSON.stringify(text)});n.click()}`);
};
const select = cap => evaluate(`document.querySelector('[data-health-capability="${cap}"]').click()`);
const capture = async name => {
  await evaluate('window.scrollTo(0,0)'); await sleep(150);
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(work, name + '.png'), Buffer.from(r.data, 'base64'));
};
const measure = async label => {
  report.layout ||= {};
  report.layout[label] = await evaluate(`(() => {
    const box = node => { if (!node) return null; const r=node.getBoundingClientRect(),s=getComputedStyle(node);
      return {width:r.width,height:r.height,fontSize:s.fontSize,padding:s.padding,gap:s.gap,minHeight:s.minHeight}; };
    return {viewport:{width:innerWidth,height:innerHeight},page:box(document.querySelector('.iris-workbench-page')),
      health:box(document.querySelector('.iris-health')),healthButton:box(document.querySelector('.iris-health-head button')),
      healthCards:[...document.querySelectorAll('[data-health-capability]')].map(box),
      sections:[...document.querySelectorAll('.iris-wb-section')].map(node=>({name:node.dataset.irisSection,
        open:node.tagName!=='DETAILS'||node.open,head:box(node.querySelector('.iris-wb-section-head')),box:box(node),
        label:node.querySelector('.iris-wb-section-arrow')?.innerText?.trim()}))};
  })()`);
};
try {
  child.once('error', error => { report.browserErrors.push(error.message); });
  await wait(() => fs.existsSync(path.join(browserDir, 'DevToolsActivePort')), 'Chromium startup');
  const port = fs.readFileSync(path.join(browserDir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const page = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(origin), { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request?.reject(new Error(message.error.message)); else request?.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') report.browserErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Page.javascriptDialogOpening') report.browserErrors.push('unexpected native dialog');
  });
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
  await wait(() => evaluate('window.__mounted && document.querySelectorAll("[data-health-capability]").length===6 && document.querySelector(".iris-health-footer").textContent.includes("配置检查于")'), 'six cards and metadata');
  assert.equal(await evaluate('document.querySelector("#iris-health-content").hidden'), true);
  assert.equal(await evaluate('[...document.querySelectorAll("details.iris-wb-section")].every(n=>!n.open)'), true);
  report.initialToggleLabels = await evaluate('[...document.querySelectorAll(".iris-wb-section-arrow")].map(n=>n.innerText.trim())');
  assert.equal(await evaluate('[...document.querySelectorAll(".iris-wb-section-arrow")].every(n=>n.innerText.trim()==="展开" && n.textContent.trim()==="展开")'), true, 'one label in DOM, independent of CSS visibility');
  if (preloadOldStyles) assert.equal(await evaluate('document.querySelectorAll("#iris-wb-css").length===1 && document.getElementById("iris-wb-css")===window.__irisOldStyle && document.getElementById("iris-wb-css").textContent.includes(".iris-workbench-page {")'), true, 'refresh old stylesheet in place');
  await measure('desktop-collapsed');
  await capture('workbench-collapsed-dark');
  await evaluate('document.body.classList.add("light")'); await capture('workbench-collapsed-light');
  for (const width of [390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: true });
    await measure('mobile-collapsed-' + width);
    assert.equal(await evaluate('document.querySelector(".iris-health-head button").getBoundingClientRect().height>=40 && document.querySelector(".iris-pm-add").getBoundingClientRect().height>=40'), true, 'mobile controls retain touch size');
    await capture('workbench-default-mobile-' + width + '-light');
    assert.equal(await evaluate('document.querySelector(".iris-workbench-page").scrollWidth<=document.querySelector(".iris-workbench-page").clientWidth'), true);
  }
  await evaluate('document.body.classList.remove("light")');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector("[data-iris-section=preferences] > summary").focus()');
  report.keyboardContext = await evaluate('({focused:document.hasFocus(),activeElement:document.activeElement.tagName})');
  assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineWidth'), '2px');
  for (const open of [true, false]) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wait(() => evaluate(`document.querySelector('[data-iris-section=preferences]').open===${open}`), 'keyboard accordion toggle');
    await wait(() => evaluate(`document.querySelector('[data-iris-section=preferences] .iris-wb-section-arrow').textContent.trim()===${JSON.stringify(open ? '收起' : '展开')}`), 'single keyboard toggle label');
  }
  for (const open of [true, false]) {
    await evaluate('document.querySelector("[data-iris-section=preferences] > summary").click()');
    await wait(() => evaluate(`document.querySelector('[data-iris-section=preferences]').open===${open} && document.querySelector('[data-iris-section=preferences] .iris-wb-section-arrow').textContent.trim()===${JSON.stringify(open ? '收起' : '展开')}`), 'single mouse toggle label');
  }
  await evaluate('document.activeElement.blur()');
  report.checks.push('actual WorkbenchPanel: default-collapsed inspection/settings/history; active tasks and works remain visible in shared section styling');
  assert.deepEqual(report.providerRequests, []);
  assert.deepEqual(report.directoryRequests, [], 'workbench mount and read-only inspection must not discover models');
  await click('展开检测');
  await measure('desktop-health-expanded');
  await click('检查配置'); await wait(() => evaluate('!document.querySelector("[data-health-refresh]").disabled'), 'read-only check');
  assert.deepEqual(report.providerRequests, []);
  report.checks.push('six capabilities including music; mount/configuration checks perform zero provider requests');
  await select('image-gen');
  await click('查看功能设置');
  assert.equal(await evaluate('document.querySelector("[data-iris-section=pools]").open'), true);
  await wait(() => evaluate('document.querySelector("[data-iris-section=pools] .iris-wb-section-arrow").textContent.trim()==="收起"'), 'programmatic reveal updates label');
  await measure('desktop-pools-expanded');
  await evaluate('document.querySelector("[data-iris-section=pools]").open=false');
  await click('实测此模型');
  assert.equal(await evaluate('!!document.querySelector(".iris-health-confirm")'), true);
  await capture('desktop-confirm');
  await click('取消'); assert.deepEqual(report.providerRequests, []);
  await click('实测此模型');
  await evaluate(`{const n=[...document.querySelectorAll('.iris-health button')].find(n=>n.textContent==='确认并实测');n.click();n.click()}`);
  await wait(() => evaluate('!!document.querySelector(".iris-health-result.running")'), 'visible progress');
  assert.equal(await evaluate('document.querySelector("[data-health-refresh]").disabled'), true);
  await click('收起检测');
  assert.equal(await evaluate('document.querySelector("#iris-health-content").hidden'), true);
  await wait(() => evaluate('!!document.querySelector(".iris-health-result.passed") && !document.querySelector("[data-health-refresh]").disabled'), 'passed test and refreshed health');
  assert.equal(await evaluate('document.querySelector("#iris-health-content").hidden'), true);
  await click('展开检测');
  assert.deepEqual(report.providerRequests, ['canvas-image']);
  assert.equal(store.modelHealth(provider.id, 'canvas-image', 'image-gen').status, 'verified');
  assert.equal(await evaluate('document.querySelector("[data-health-capability=image-gen]").textContent.includes("1/2 近期成功")'), true);
  await capture('desktop-success');
  report.checks.push('inline consent/cancel; slow single-target real API probe submits once on double click; authoritative health becomes 1/2 verified');
  rejectNext = true; await click('实测此模型'); await click('确认并实测');
  await wait(() => evaluate('!!document.querySelector(".iris-health-result.failed") && !document.querySelector("[data-health-refresh]").disabled'), 'failed test');
  assert.deepEqual(report.providerRequests, ['canvas-image', 'canvas-image']);
  report.checks.push('rejected provider request displays failed result without automatic retry or another model');
  for (const [cap, action] of [['video-gen', 'video'], ['transcribe', 'transcribe'], ['music-gen', 'music']]) {
    await select(cap); await click('前往功能验证 ↗');
    await wait(() => evaluate(`document.querySelector('[data-iris-action="${action}"]').classList.contains('open')`), 'real task form ' + cap);
    assert.equal(await evaluate('document.querySelector("[data-iris-section=actions]").open'), true);
  }
  assert.deepEqual(report.providerRequests, ['canvas-image', 'canvas-image']);
  await evaluate(`{const field=document.querySelector('[data-iris-action=video] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'保留的创作草稿');field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-iris-section=actions]').open=false;}`);
  await evaluate('document.querySelector("[data-iris-section=actions]").open=true');
  assert.equal(await evaluate('document.querySelector("[data-iris-action=video] textarea").value'), '保留的创作草稿');
  assert.deepEqual(report.providerRequests, ['canvas-image', 'canvas-image']);
  report.checks.push('native sections support keyboard toggles; setting/task jumps reveal the parent section and folding preserves draft values without submitting');
  report.checks.push('video, transcription and music open actual task forms without empty probes or generation');
  await evaluate(`{const n=[...document.querySelectorAll('.iris-pm-top')].find(n=>n.textContent.includes('Studio'));n.click()}`);
  await wait(() => evaluate('!!document.querySelector(".iris-pm-ver[aria-label*=canvas-image]")'), 'model badge');
  const directorySelector = '[data-provider-directory="' + provider.id + '"]';
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(directorySelector)}).open`), false, 'model directory starts collapsed');
  await evaluate(`document.querySelector(${JSON.stringify(directorySelector)}).open=true`);
  await evaluate(`{const n=document.querySelector(${JSON.stringify(directorySelector)}+' button');n.click();n.click()}`);
  await wait(() => evaluate(`document.querySelector(${JSON.stringify(directorySelector)}).getAttribute('aria-busy')==='true'`), 'directory busy state');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(directorySelector)}+' button').disabled`), true);
  await wait(() => evaluate(`document.querySelector(${JSON.stringify(directorySelector)}).textContent.includes('2 个模型')&&!document.querySelector(${JSON.stringify(directorySelector)}+' button').disabled`), 'directory snapshot');
  assert.equal(report.directoryRequests.length, 1, 'double click performs one directory GET');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(directorySelector)}).textContent.includes('目录未列出 1 项')`), true);
  assert.equal(store.allProviders().find(p=>p.id===provider.id).models.length, 2, 'sync preserves configured models');
  assert.equal(store.assignmentOrder('image-gen').length, 2, 'directory discovery does not authorize new model');
  const newRow = '.iris-pm-mrow';
  assert.equal(await evaluate(`[...document.querySelectorAll(${JSON.stringify(newRow)})].find(n=>n.textContent.includes('new-image-directory-entry')).querySelectorAll('.danger,select,.iris-pm-ver').length`), 0, 'pending directory entry offers confirmation before test/protocol/remove controls');
  await capture('directory-synchronized-dark');
  rejectDirectory = true;
  await evaluate(`document.querySelector(${JSON.stringify(directorySelector)}+' button').click()`);
  await wait(() => evaluate(`document.querySelector(${JSON.stringify(directorySelector)}).textContent.includes('保留')&&!document.querySelector(${JSON.stringify(directorySelector)}+' button').disabled`), 'failed directory preserves cache');
  assert.equal(report.directoryRequests.length, 2);
  assert.equal(store.allProviders().find(p=>p.id===provider.id).modelDirectory.models.length, 2);
  assert.deepEqual(report.providerRequests, ['canvas-image', 'canvas-image'], 'directory sync never submits media');
  report.checks.push('directory defaults collapsed; slow sync/double click sends one GET; new IDs pending, unlisted config retained; failure keeps full cache without generation');
  await evaluate('document.querySelector("[data-iris-section=preferences]").open=true');
  for (const width of [390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: true });
    await evaluate(`document.querySelector(${JSON.stringify(directorySelector)}).scrollIntoView()`);
    assert.equal(await evaluate('document.querySelector(".iris-workbench-page").scrollWidth<=document.querySelector(".iris-workbench-page").clientWidth'), true, 'open directory fits at ' + width);
    const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(work, 'directory-mobile-' + width + '.png'), Buffer.from(shot.data, 'base64'));
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
  await click('收起检测');
  await evaluate('document.querySelector(".iris-pm-ver[aria-label*=canvas-image]").click()');
  await wait(() => evaluate('document.querySelector("#iris-health-detail h3").textContent.includes("图片")'), 'badge direct inspection');
  assert.equal(await evaluate('document.querySelector("#iris-health-content").hidden'), false);
  assert.deepEqual(report.providerRequests, ['canvas-image', 'canvas-image']);
  report.checks.push('Chinese model health badge routes to shared inspection without native dialog or request');
  legacy = true; await click('检查配置');
  await wait(() => evaluate('document.querySelector(".iris-health").textContent.includes("暂停模型实测")'), 'old server notice');
  assert.equal(await evaluate('[...document.querySelectorAll(".iris-health-model-head button")].every(n=>n.disabled)'), true);
  report.checks.push('HTTP-200 legacy server response disables every real probe');
  legacy = false; await click('检查配置');
  await wait(() => evaluate('!document.querySelector("[data-health-refresh]").disabled && !document.querySelector(".iris-health").textContent.includes("暂停模型实测")'), 'new server restored');
  await capture('desktop-dark');
  await evaluate('document.querySelector("[data-health-capability=image-gen]").focus()');
  assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineWidth'), '2px');
  await evaluate('document.activeElement.blur()');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".iris-health-row")).transitionDuration'), '0s');
  await cdp('Emulation.setEmulatedMedia', { features: [] });
  await evaluate('document.body.classList.add("light")'); await capture('desktop-light');
  for (const width of [390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: true });
    await capture('mobile-' + width + '-light');
    assert.equal(await evaluate('document.querySelector(".iris-health").scrollWidth<=document.querySelector(".iris-health").clientWidth'), true, 'health panel must not overflow at ' + width);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".iris-health-grid")).gridTemplateColumns.split(" ").length'), 1);
    await click('收起检测'); await capture('workbench-mobile-' + width + '-light');
    assert.equal(await evaluate('document.querySelector(".iris-workbench-page").scrollWidth<=document.querySelector(".iris-workbench-page").clientWidth'), true, 'the entire workbench must fit at ' + width);
    await click('展开检测');
  }
  await evaluate('document.body.classList.remove("light")'); await capture('mobile-dark');
  await evaluate('document.querySelector("#iris-health-detail").scrollIntoView()');
  await sleep(100);
  const detailShot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(work, 'mobile-detail.png'), Buffer.from(detailShot.data, 'base64'));
  report.checks.push('desktop dark/light and 390/320px mobile screenshots; compact single-column cards, no health panel overflow, visible keyboard focus and reduced motion');
  assert.deepEqual(report.browserErrors, []); report.status = 'pass'; save();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: path.join(work, 'report.json') }));
} catch (error) {
  report.status = 'fail'; report.error = error.message;
  if (socket?.readyState === WebSocket.OPEN) { try { await capture('failed'); fs.writeFileSync(path.join(work, 'failed-dom.html'), await evaluate('document.documentElement.outerHTML')); } catch (e) { report.diagnosticError = e.message; } }
  save(); console.error(error); console.error('报告：' + path.join(work, 'report.json')); process.exitCode = 1;
} finally {
  await core.dispose();
  socket?.close(); child.kill('SIGTERM'); await closed; log.end(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
}
