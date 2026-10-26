/** Actual DSH React + Iris Workbench/API; ComfyUI is a local HTTP fixture without GPU. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { comfyProtocolFixture, COMFY_WORKFLOW } from '../tests/fixtures/comfyui-protocol-fixture.mjs';
import { FLOW_RESULT } from '../tests/fixtures/image-flow-fixture.mjs';
import { guarded } from '../lib/guard.js';

const args = process.argv.slice(2);
assert(args.length === 6 && args[0] === '--dsh-root' && args[2] === '--browser-executable' && args[4] === '--output');
const dshRoot = fs.realpathSync(args[1]), executable = fs.realpathSync(args[3]), out = path.resolve(args[5]);
fs.mkdirSync(out, { mode: 0o700 });
const requireDsh = createRequire(path.join(dshRoot, 'package.json'));
const assets = path.join(path.dirname(requireDsh.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/assets');
const entryFile = fs.readdirSync(assets).find(name => /^index-.*\.js$/.test(name)), frontend = fs.readFileSync(path.join(assets, entryFile), 'utf8');
const builtins = frontend.match(/function (\w+)\(\)\{return\{react:/)?.[1], boot = /const \w+=globalThis\.dshDesktopBoot/.exec(frontend);
assert(builtins && boot, 'review installed DSH frontend before extracting its real React runtime');
const runtime = frontend.slice(0, boot.index) + '\nexport const irisTestBuiltins=' + builtins + '();\n';
process.env.DSH_HOME = path.join(out, 'isolated-home'); process.env.IRIS_IMPORT_WORKBENCH_CONFIG = '';
const store = await import('../lib/config.js'), { serveApi } = await import('../lib/api.js');
const { createDshRuntime, dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const { listCoreTasks, inspectCoreTask } = await import('../lib/core-tasks.js');
const { readCoreArtifactBytes } = await import('../lib/core-artifacts.js');
const { providerForImageModel } = await import('../lib/provider-protocol.js');
const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
const core = createDshRuntime({ dataRoot: dshCoreDataRoot() }), comfy = await comfyProtocolFixture();
const guardedApi = guarded((req, res) => serveApi(req, res, {}, core));
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const client = source.replace('var clientSlots = clientSlotsPort(ctx);', 'window.__WorkbenchPanel=WorkbenchPanel;var clientSlots = clientSlotsPort(ctx);');
const report = { status: 'running', sourceSha256: createHash('sha256').update(source).digest('hex'), runtime: entryFile,
  checks: [], errors: [], actions: [], layouts: {}, actualPaidCalls: 0, fullDailyDshBoot: false, realComfyGpu: false };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const style = `body{font:14px/1.5 sans-serif;margin:24px;background:#f4f5f8;color:#252637;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f2f3f7;--dsw-alias-border-l1:#dcdfe8;--dsw-alias-label-primary:#252637;--dsw-alias-label-secondary:#626779;--dsw-alias-brand-primary:#6F69B8}body.dark{background:#1c1d24;color:#eee;--dsw-alias-bg-layer-1:#26262e;--dsw-alias-bg-layer-2:#32323c;--dsw-alias-border-l1:#3a3a44;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#aaa}#mount{max-width:1060px;margin:auto}@media(max-width:640px){body{margin:12px}}`;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head><body><main id="mount"></main><script>window.__ModuleLoader__={load(entry){window.__irisEntry=entry}}</script><script src="/client.js"></script><script type="module">import{irisTestBuiltins as b}from'/assets/runtime.js';const R=b.react;window.__irisEntry.factory(n=>{if(n==='react')return R;throw Error(n)}).apply({slots:{inject(s,c){c()},register(){return()=>{}}}});b['react-dom/client'].createRoot(document.getElementById('mount')).render(R.createElement(window.__WorkbenchPanel));window.__mounted=true;</script></body></html>`;
let origin;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
  if (url.pathname === '/client.js' || url.pathname === '/assets/runtime.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(url.pathname === '/client.js' ? client : runtime); return; }
  if (url.pathname.startsWith('/assets/')) {
    const file = path.join(assets, path.basename(url.pathname));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(fs.readFileSync(file)); return; }
  }
  if (url.pathname.startsWith('/iris/')) { if (url.pathname.startsWith('/iris/api/actions/')) report.actions.push(url.pathname); guardedApi(req, res); return; }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); assert.equal(url.hostname, '127.0.0.1', 'no external test requests'); return originalFetch(input, options); };
const profile = path.join(out, 'browser-profile'), log = fs.createWriteStream(path.join(out, 'browser.log'));
const child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.pipe(log); const closed = new Promise(resolve => child.once('close', resolve));
let socket, sequence = 0; const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (fn, label) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await fn()) return; await sleep(80); } throw new Error('Timeout: ' + label); };
function cdp(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 20000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const value = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description); return value.result.value; }
const click = async (text, scope = 'document') => { assert(await evaluate(`(()=>{const n=[...${scope}.querySelectorAll('button')].find(n=>n.textContent===${JSON.stringify(text)});if(!n||n.disabled)return false;n.click();return true})()`), text); };
const field = (label, scope = 'document') => `([...${scope}.querySelectorAll('label')].find(n=>[...n.childNodes].some(c=>c.nodeType===3&&c.textContent.trim()===${JSON.stringify(label)}))?.querySelector('input,select,textarea')||[...${scope}.querySelectorAll('.iris-pm-field,.iris-act-field')].find(n=>n.querySelector('label')?.textContent===${JSON.stringify(label)})?.querySelector('input,select,textarea'))`;
const set = async (expression, value) => { await evaluate(`(()=>{const n=${expression};if(!n)throw Error('missing field');const p=n.tagName==='SELECT'?HTMLSelectElement.prototype:n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(n,${JSON.stringify(String(value))});n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`); };
const capture = async name => { const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')); };
async function upload(file) { const document = await cdp('DOM.getDocument'); const node = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector: '[data-comfy-file]' }); await cdp('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [file] }); }
try {
  child.once('error', error => report.errors.push(error.message));
  await wait(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'browser startup');
  const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const page = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(origin), { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.id) { const p = pending.get(value.id); pending.delete(value.id); if (value.error) p?.reject(new Error(value.error.message)); else p?.resolve(value.result); }
    if (value.method === 'Runtime.exceptionThrown') report.errors.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
    if (value.method === 'Page.javascriptDialogOpening') report.errors.push('Unexpected native dialog'); });
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Page.bringToFront'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await wait(() => evaluate('!!(window.__mounted&&document.querySelector(".iris-pm-add"))'), 'actual Workbench mounted');
  await click('+ 添加供应商'); await set(field('连接预设'), 'comfyui');
  assert.equal(await evaluate(field('认证方式') + '.value'), 'none'); assert.equal(await evaluate('!!document.querySelector("input[type=password]")'), false);
  await set(field('Base URL *'), comfy.baseUrl); await click('保存');
  await wait(() => evaluate('!!document.querySelector("[data-comfy-file]")'), 'saved Comfy connection opens');
  const provider = store.allProviders()[0]; assert.equal(provider.auth, 'none'); assert.equal(comfy.graphs.length, 0);
  report.checks.push('actual provider preset saves a local connection without key or generation and opens dedicated panel');
  const invalid = path.join(out, 'canvas-not-api.json'), raw = path.join(out, 'raw-api.json'), template = path.join(out, 'portrait-template.json');
  fs.writeFileSync(invalid, '{"nodes":[]}'); fs.writeFileSync(raw, JSON.stringify(COMFY_WORKFLOW.graph)); fs.writeFileSync(template, JSON.stringify(COMFY_WORKFLOW));
  await upload(invalid); await wait(() => evaluate('document.body.textContent.includes("导入失败")'), 'canvas rejected');
  await upload(raw); await wait(() => evaluate('document.body.textContent.includes("已读取 ' + Object.keys(COMFY_WORKFLOW.graph).length + ' 个节点")'), 'raw API graph');
  await set(field('正向提示词节点'), '6'); await set(field('尺寸节点'), '5');
  await click('只读检查'); await wait(() => evaluate('document.body.textContent.includes("静态检查通过")'), 'raw draft inspection');
  assert.equal(comfy.graphs.length, 0); assert.equal(store.allProviders()[0].models?.length || 0, 0);
  await upload(template); await wait(() => evaluate(field('工作流名称') + '?.value==="portrait-template"'), 'parameter template imported');
  const readBefore = comfy.requests.length; await evaluate(`{const n=[...document.querySelectorAll('button')].find(n=>n.textContent==='只读检查');n.click();n.click()}`);
  await wait(() => evaluate('document.body.textContent.includes("静态检查通过")'), 'template inspected');
  assert.equal(comfy.requests.length - readBefore, new Set(Object.values(COMFY_WORKFLOW.graph).map(node => node.class_type)).size);
  const panel = `document.querySelector('[aria-label="ComfyUI 工作流"]')`;
  assert.equal(await evaluate('getComputedStyle(' + panel + ',"::before").animationName'), 'iris-comfy-arrive');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate('getComputedStyle(' + panel + ',"::before").animationName'), 'none');
  await cdp('Emulation.setEmulatedMedia', { features: [] });
  const config = fs.readFileSync(path.join(store.irisHome(), 'providers.json'));
  await click('只读检查'); await wait(() => evaluate('[...document.querySelectorAll("button")].some(n=>n.textContent==="只读检查"&&!n.disabled)'), 'readonly done');
  assert(fs.readFileSync(path.join(store.irisHome(), 'providers.json')).equals(config)); assert.equal(comfy.graphs.length, 0);
  report.checks.push('raw/API-template imports, explicit positive/size binding, invalid canvas rejection, read-only checks do not save or queue, duplicate check submits once');
  await capture('workflow-light');
  await evaluate(`{const n=[...document.querySelectorAll('button')].find(n=>n.textContent==='保存工作流');n.click();n.click()}`);
  await wait(() => evaluate('document.body.textContent.includes("工作流已保存")'), 'template save');
  assert.equal(store.allProviders()[0].models.length, 1); assert.equal(store.assignments()['image-gen'].mode, 'auto');
  assert.equal(report.actions.filter(url => url.endsWith('/providers_save_comfy_workflow')).length, 1); assert.equal(comfy.graphs.length, 0);
  await click('保存工作流'); await wait(() => evaluate('!!document.querySelector("[aria-label=确认替换工作流]")'), 'replace confirmation'); await click('取消', `document.querySelector('[aria-label="确认替换工作流"]')`);
  report.checks.push('one explicit save keeps a parameter template, enables the opted-in auto pool and requires confirmation for replacement');
  await evaluate('document.querySelector("[data-iris-section=actions]").open=true;document.querySelector("[data-iris-action=image] .iris-act-head").click()');
  const image = `document.querySelector('[data-iris-action="image"]')`;
  await wait(() => evaluate(`${image}.querySelector('select')?.options.length>1`), 'image candidates');
  await set(field('模型 (可选)', image), provider.id + '::portrait-template'); await set(field('提示词', image), 'An iris flower');
  const params = `document.querySelector('[aria-label="ComfyUI 画图参数"]')`;
  await wait(() => evaluate(`!!(${params})`), 'parameter panel selected');
  assert.equal(await evaluate(`${params}.querySelector('details').open`), false);
  await click('只读检查并读取选项'); await wait(() => evaluate(`${field('LoRA', params)}?.tagName==='SELECT'`), 'LoRA choices');
  await evaluate(`${params}.querySelector('details').open=true`);
  await set(field('LoRA', params), JSON.stringify('portrait.safetensors'));
  await set(field('模型权重', params), 0.65); await set(field('CLIP 权重', params), 0.4); await set(field('种子', params), 7);
  assert.equal(await evaluate(`${params}.textContent.includes('静态检查通过')`), false, 'parameter changes invalidate old result');
  for (const width of [1280, 390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 640 });
    await evaluate(`${params}.scrollIntoView({block:'center'})`); await sleep(100);
    report.layouts[width] = await evaluate(`({width:innerWidth,page:document.documentElement.scrollWidth,panel:document.querySelector('.iris-workbench-page').scrollWidth,client:document.querySelector('.iris-workbench-page').clientWidth})`);
    assert(report.layouts[width].page <= width, 'page fits ' + width); assert(report.layouts[width].panel <= report.layouts[width].client, 'workbench fits ' + width);
    await capture('parameters-' + width + '-light');
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.body.classList.add("dark")'); await capture('parameters-dark'); await evaluate('document.body.classList.remove("dark")');
  assert.equal(comfy.graphs.length, 0); report.checks.push('named LoRA/numeric controls, default folding, stale check clearing, light/dark, 320/390px and reduced motion');
  await evaluate(`{const n=${image}.querySelector('.iris-act-run');n.click();n.click()}`);
  await wait(() => comfy.graphs.length === 1 && listCoreTasks(dshCoreDataRoot()).total === 1, 'actual image task');
  await core.stopProviderTaskWatchesForDsh(); comfy.phase = 'done';
  const task = listCoreTasks(dshCoreDataRoot()).tasks[0], current = store.providerById(provider.id);
  await core.observeProviderTaskForDsh({ taskId: task.id, adapter: createConfiguredProviderAdapter(providerForImageModel(current, 'portrait-template')) });
  const done = inspectCoreTask(dshCoreDataRoot(), task.id); assert.equal(done.outcome, 'succeeded');
  assert(readCoreArtifactBytes(dshCoreDataRoot(), done.artifactIds[0]).bytes.equals(FLOW_RESULT));
  assert.equal(comfy.graphs[0]['10'].inputs.lora_name, 'portrait.safetensors'); assert.equal(comfy.graphs[0]['10'].inputs.strength_model, 0.65); assert.equal(comfy.graphs[0]['10'].inputs.strength_clip, 0.4); assert.equal(comfy.graphs[0]['3'].inputs.seed, 7);
  await evaluate('window.dispatchEvent(new CustomEvent("iris-core-artifacts-changed"))');
  await wait(() => evaluate(`document.body.textContent.includes(${JSON.stringify(done.artifactIds[0])})`), 'artifact visible');
  await capture('completed-artifact'); assert.equal(comfy.graphs.length, 1);
  const denied = await fetch(origin + '/iris/api/actions/providers_check_comfy_workflow', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' }, body: JSON.stringify({ id: provider.id, model_id: 'portrait-template' }) }); assert.equal(denied.status, 403);
  report.checks.push('actual browser image action submits once, binds LoRA and both weights/seed, observes original Task, displays verified Artifact; foreign Origin rejected');
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; if (socket?.readyState === 1) { try { await capture('failure'); } catch {} } throw error; }
finally {
  report.providerRequests = comfy.requests; save(); globalThis.fetch = originalFetch;
  if (socket?.readyState === 1) { try { await cdp('Browser.close'); } catch {} socket.close(); }
  if (child.exitCode === null) child.kill('SIGTERM'); await closed; await core.dispose(); await comfy.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => log.end(resolve));
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, output: out }));
