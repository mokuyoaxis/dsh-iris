/** Real cached Chromium + DSH's bundled React + actual Iris client/API; fixture media only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === '--dsh-root' && args[2] === '--browser-executable');
const dshRoot = fs.realpathSync(args[1]);
const executable = fs.realpathSync(args[3]);
const requireDsh = createRequire(path.join(dshRoot, 'package.json'));
const frontendRoot = path.join(path.dirname(requireDsh.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/assets');
const entryFile = fs.readdirSync(frontendRoot).find(name => /^index-.*\.js$/.test(name));
const frontend = fs.readFileSync(path.join(frontendRoot, entryFile), 'utf8');
const builtinName = frontend.match(/function (\w+)\(\)\{return\{react:/)?.[1];
const bootStart = frontend.indexOf('const fo=globalThis.dshDesktopBoot');
assert(builtinName && bootStart > 0, 'cached frontend shape requires a reviewed verifier update');
// Keep the official runtime intact up to its application entry; do not boot a daily profile.
const runtime = frontend.slice(0, bootStart) + '\nexport const irisTestBuiltins = ' + builtinName + '();\n';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-pool-browser-'));
process.env.DSH_HOME = path.join(work, 'home');
process.env.IRIS_IMPORT_WORKBENCH_CONFIG = '';
const report = { status: 'running', work, checks: [], fixtureMediaCalls: [], browserErrors: [],
  runtime: entryFile, fullDailyDshBoot: false, realBrowser: executable, sourceMountInstrumentation: true };
const save = () => fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const { createDshHostAdapter } = await import('../lib/dsh-host-adapter.js');
const { serveApi } = await import('../lib/api.js');
const { createDshRuntime, dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const core = createDshRuntime({ dataRoot: dshCoreDataRoot(), getHost: () => host() });
const { runAction: executeAction } = await import('../lib/actions.js');
const runAction = (host, name, args, options = {}) => executeAction(host, name, args, { ...options, core });
const sharp = (await import('sharp')).default;
const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#367aa8' } }).png().toBuffer();
const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(
  'var clientSlots = clientSlotsPort(ctx);',
  'window.__irisTest = { ProviderManager, CapabilityAssigner, ActionGroups }; var clientSlots = clientSlotsPort(ctx);');
let origin;
let legacyAssignments = true, delayNextPolicyWrite = 0, delayNextAssignmentRead = 0;
report.policyWrites = 0; report.assignmentReads = 0;
const services = {
  llm: { listProviders: () => [{ id: 'fixture', name: 'Fixture media' }],
    listConfigurableProviders: () => [{ provider: 'fixture', displayName: 'Fixture media', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'fixture'] }] },
  settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { fixture: { baseURL: origin + '/v1', apiKeyEnv: 'IRIS_BROWSER_FIXTURE_KEY' } } } }] },
  credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'browser-fixture-key' }) }
};
const host = () => createDshHostAdapter({ get: name => services[name] });
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px sans-serif;background:#202128;color:#eee;margin:16px}#mount{max-width:1100px;margin:auto}button,input,select{font:inherit}h2{margin-top:20px}</style>
</head><body><div id="mount"></div><script>window.__ModuleLoader__={load(entry){window.__irisEntry=entry}};</script>
<script src="/iris-client.js"></script><script type="module">
import { irisTestBuiltins } from '/assets/runtime.js';
const React=irisTestBuiltins.react;
window.__irisEntry.factory(name=>{if(name==='react')return React;throw new Error(name)}).apply({slots:{inject(_seat,callback){callback()},register(){return ()=>{}}}});
const c=window.__irisTest;
irisTestBuiltins['react-dom/client'].createRoot(document.getElementById('mount')).render(React.createElement('main',{},
 React.createElement('h2',{},'连接与模型'),React.createElement(c.ProviderManager),
 React.createElement('h2',{},'功能池与调用方式'),React.createElement(c.CapabilityAssigner),
 React.createElement('h2',{},'操作'),React.createElement(c.ActionGroups)));
window.__mounted=true;
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
  if (url.pathname === '/iris-client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(client); return; }
  if (url.pathname === '/assets/runtime.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(runtime); return; }
  if (url.pathname.startsWith('/assets/') && !url.pathname.includes('..')) {
    const file = path.join(frontendRoot, url.pathname.slice('/assets/'.length));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(fs.readFileSync(file)); return; }
  }
  if (url.pathname === '/v1/images/generations') {
    let body = ''; for await (const chunk of req) body += chunk;
    const { model } = JSON.parse(body);
    report.fixtureMediaCalls.push(model);
    res.writeHead(model === 'a' ? 401 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(model === 'a' ? { error: { message: 'fixture rejected before acceptance' } }
      : { data: [{ b64_json: image.toString('base64') }] })); return;
  }
  if (url.pathname === '/iris/api/actions/assignments_get') {
    report.assignmentReads++;
    if (legacyAssignments) {
      const result = await runAction(host(), 'assignments_get');
      delete result.policies; delete result.readiness;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return;
    }
    if (delayNextAssignmentRead) {
      const delay = delayNextAssignmentRead; delayNextAssignmentRead = 0;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  if (url.pathname === '/iris/api/actions/assignments_set') {
    report.policyWrites++;
    if (legacyAssignments) { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"error":"fixture old server cannot accept policies"}'); return; }
    if (delayNextPolicyWrite) {
      const delay = delayNextPolicyWrite; delayNextPolicyWrite = 0;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  if (url.pathname.startsWith('/iris/')) { serveApi(req, res, host(), core); return; }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = 'http://127.0.0.1:' + server.address().port;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('browser verifier forbids external provider requests');
  return originalFetch(input, options);
};
const browserDir = path.join(work, 'browser');
const child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run',
  '--remote-debugging-port=0', '--user-data-dir=' + browserDir, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const browserLog = fs.createWriteStream(path.join(work, 'browser.log'), { mode: 0o600 });
child.stderr.pipe(browserLog);
const closed = new Promise(resolve => child.once('close', resolve));
let socket;
let nextId = 0;
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
  throw new Error('Timed out: ' + label);
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const button = text => evaluate(`{const node=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!node)throw new Error('button missing: '+${JSON.stringify(text)});node.click();}`);
const change = (selector, value) => evaluate(`{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('field missing');
 if(node.tagName==='SELECT'){node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));}
 else{const proto=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));}}`);
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
    if (message.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await wait(() => evaluate('window.__mounted===true && !!document.querySelector(".iris-pm-add")'), 'real React mount');
  await wait(() => evaluate('document.body.textContent.includes("当前服务端尚未加载功能池策略")'), 'old server warning');
  assert.equal(await evaluate('[...document.querySelectorAll("[data-function] > select")].every(n=>n.disabled)'), true);
  await change('[data-function=image-gen] > select', 'auto');
  assert.equal(report.policyWrites, 0);
  legacyAssignments = false;
  await button('重新检查服务端');
  await wait(() => evaluate('!!document.querySelector("[data-function=image-gen] > select") && !document.querySelector("[data-function=image-gen] > select").disabled'), 'new server capability recognized');
  report.checks.push('real DOM: HTTP-200 old server shape is detected; mode controls stay disabled and no policy writes are issued');
  await button('+ 添加供应商');
  await wait(() => evaluate('[...document.querySelectorAll("option")].some(n=>n.textContent.includes("DSH · Fixture media"))'), 'DSH connection directory');
  await change('.iris-pm-card select', JSON.stringify(['llm-pi-ai', 'fixture']));
  assert.equal(await evaluate('!!document.querySelector("input[type=password]")'), false);
  // Select by label because the connection and protocol fields have separate parents.
  await evaluate(`{const label=[...document.querySelectorAll('label')].find(n=>n.textContent==='媒体协议');const select=label.parentElement.querySelector('select');select.value='openai-images';select.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await button('保存');
  await wait(() => evaluate('!!document.querySelector("input[placeholder*=发现后]")'), 'model confirmation form');
  for (const model of ['a', 'b']) {
    await change('input[placeholder*=发现后]', model);
    if (!await evaluate('document.querySelector("input[value=image-gen]").checked')) await evaluate('document.querySelector("input[value=image-gen]").click()');
    await button('保存模型用途');
    await wait(async () => (await runAction(host(), 'providers_list')).providers[0]?.models.some(m => m.id === model), 'model ' + model);
  }
  await wait(() => evaluate('document.querySelector("[data-function=image-gen]").textContent.includes("2 个可用候选")'), 'automatic candidate count');
  assert.equal((await runAction(host(), 'assignments_get')).policies['image-gen'].mode, 'auto');
  assert.equal(report.fixtureMediaCalls.length, 0);
  report.checks.push('real DOM: DSH reference hides key fields; two model confirmations enable a two-item automatic pool without extra assignments or probes');
  await evaluate(`[...document.querySelectorAll('.iris-act-head')].find(n=>n.textContent.includes('画图')).click()`);
  await wait(() => evaluate('!!document.querySelector(".iris-act-card textarea")'), 'opened action form');
  await wait(() => evaluate('document.querySelector(".iris-act-card.open").classList.contains("health-configured")'), 'host reference readiness badge');
  await change('.iris-act-card textarea', 'fixture generation');
  const modelRef = await evaluate('document.querySelector(".iris-act-card select").value');
  assert.equal(modelRef, '', 'automatic UI must not pin its first candidate');
  await button('执行');
  await wait(() => evaluate('!!document.querySelector(".iris-act-result img")'), 'automatic generation and image');
  assert.deepEqual(report.fixtureMediaCalls, ['a', 'b']);
  await wait(() => evaluate('document.querySelector(".iris-act-result img")?.naturalWidth===64'), 'decoded image');
  report.checks.push('actual browser/API/Core: first candidate rejected, second candidate delivers a real PNG; no implicit model pin');
  delayNextPolicyWrite = 1000; delayNextAssignmentRead = 500;
  const beforeWrite = report.policyWrites;
  await change('[data-function=image-gen] > select', 'disabled');
  await wait(() => evaluate('document.querySelector("[data-function=image-gen]").textContent.includes("正在保存")'), 'visible saving feedback');
  assert.equal(await evaluate('document.querySelector("[data-function=image-gen] > select").disabled'), true);
  await change('[data-function=image-gen] > select', 'manual');
  await wait(() => evaluate('document.querySelector("[data-function=image-gen]").textContent.includes("正在更新候选")'), 'visible acknowledged write and preview refresh');
  await wait(() => evaluate('document.querySelector("[data-function=image-gen]").textContent.includes("已保存：停用")'), 'visible final saved confirmation');
  assert.equal(report.policyWrites, beforeWrite + 1, 'busy controls must not issue another write');
  report.checks.push('slow actual API: visible saving, accepted write and final readback phases; another change while busy does not write');
  await wait(async () => (await runAction(host(), 'assignments_get')).policies['image-gen'].mode === 'disabled', 'function disabled');
  await wait(() => evaluate('document.querySelector(".iris-act-card.open").textContent.includes("此功能已停用")'), 'updated disabled readiness');
  await button('执行');
  await wait(() => evaluate('!!document.querySelector(".iris-act-result.err")'), 'disabled message');
  assert.deepEqual(report.fixtureMediaCalls, ['a', 'b']);
  report.checks.push('disabled function rejects another browser execution with zero new provider calls');
  await change('[data-function=image-gen] > select', 'manual');
  await wait(() => evaluate('document.querySelector("[data-function=image-gen]").textContent.includes("已保存：仅用所选模型")'), 'manual mode confirmed');
  await wait(() => evaluate('!!document.querySelector("[data-function=image-gen] .iris-pm-model-sel")'), 'manual selector');
  const options = await runAction(host(), 'providers_list');
  const b = options.providers[0].id + '::b';
  await change('[data-function=image-gen] .iris-pm-model-sel', b);
  await wait(async () => (await runAction(host(), 'assignments_get')).order['image-gen'][0] === b, 'manual model saved');
  await wait(() => evaluate('!document.querySelector("[data-function=image-gen] > select").disabled'), 'manual readback finished');
  await button('执行');
  await wait(() => report.fixtureMediaCalls.length === 3, 'manual execution');
  assert.deepEqual(report.fixtureMediaCalls, ['a', 'b', 'b']);
  await wait(() => evaluate('document.querySelector(".iris-act-result img")?.naturalWidth===64'), 'manual image delivery');
  report.checks.push('manual mode calls only the selected B and never supplements A');
  const beforeConfirm = report.policyWrites;
  await change('[data-function=image-gen] > select', 'auto');
  await wait(() => evaluate('!!document.querySelector(".iris-cap-confirm")'), 'inline automatic pool confirmation');
  assert.equal(await evaluate('document.querySelector("[data-function=image-gen]").textContent.includes("已保存：")'), false);
  assert.equal(report.policyWrites, beforeConfirm);
  await button('取消');
  await wait(() => evaluate('!document.querySelector(".iris-cap-confirm")'), 'inline cancellation');
  assert.equal(await evaluate('document.querySelector("[data-function=image-gen] > select").value'), 'manual');
  assert.equal(report.policyWrites, beforeConfirm);
  await change('[data-function=image-gen] > select', 'auto');
  await wait(() => evaluate('!!document.querySelector(".iris-cap-confirm")'), 'inline confirmation reopened');
  const readsBeforeConfirm = report.assignmentReads;
  await evaluate(`{const n=[...document.querySelectorAll('button')].find(n=>n.textContent==='确认启用自动池');n.click();n.click();}`);
  await wait(() => evaluate('document.querySelector("[data-function=image-gen]").textContent.includes("已保存：按功能自动选择")'), 'automatic policy visibly confirmed');
  assert.equal(report.policyWrites, beforeConfirm + 1);
  assert.equal(report.assignmentReads, readsBeforeConfirm + 1, 'one preview read shared by the settings and open Action card');
  assert.deepEqual(report.fixtureMediaCalls, ['a', 'b', 'b']);
  report.checks.push('inline confirmation/cancel is non-blocking; repeat confirmation writes once; fresh preview is shared without extra requests or generation');
  for (const [name, width, mobile] of [['desktop', 1280, false], ['mobile', 390, true]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile });
    await sleep(150);
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(work, name + '.png'), Buffer.from(screenshot.data, 'base64'));
  }
  assert.deepEqual(report.browserErrors, []);
  report.status = 'pass'; save();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: path.join(work, 'report.json') }));
} catch (error) {
  report.status = 'fail'; report.error = error.message;
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      fs.writeFileSync(path.join(work, 'failed-dom.html'), await evaluate('document.documentElement.outerHTML'));
      const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(work, 'failed.png'), Buffer.from(screenshot.data, 'base64'));
    } catch (diagnosticError) { report.diagnosticError = diagnosticError.message; }
  }
  save(); console.error(error); console.error('报告：' + path.join(work, 'report.json')); process.exitCode = 1;
}
finally {
  await core.dispose();
  socket?.close(); child.kill('SIGTERM'); await closed; browserLog.end();
  await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
}
