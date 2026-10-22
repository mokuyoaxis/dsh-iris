import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { startWorkbenchPreview } from './preview-workbench.mjs';

const args = process.argv.slice(2);
assert(args.length === 4 || (args.length === 5 && args[4] === '--no-sandbox'),
  'Usage: --browser-executable <path> --output <new-directory> [--no-sandbox]');
assert.equal(args[0], '--browser-executable'); assert.equal(args[2], '--output');
assert(path.isAbsolute(args[1]) && path.isAbsolute(args[3]), 'Use explicit absolute paths');
const executable = fs.realpathSync(args[1]), out = args[3];
fs.mkdirSync(out, { mode: 0o700 });
const root = fileURLToPath(new URL('../', import.meta.url));
const report = { status: 'running', checks: [], browserErrors: [], requests: [], layout: {}, screenshots: [],
  actualPaidCalls: 0, realApiImplemented: false, dailyDshBooted: false, noSandbox: args.includes('--no-sandbox') };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
save();
const preview = await startWorkbenchPreview();
const profile = path.join(out, 'browser-profile'), downloads = path.join(out, 'downloads');
fs.mkdirSync(downloads, { mode: 0o700 });
const browser = spawn(executable, ['--headless=new', ...(report.noSandbox ? ['--no-sandbox'] : []), '--disable-gpu',
  '--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
const browserLog = fs.createWriteStream(path.join(out, 'browser.log'), { mode: 0o600 });
browser.stderr.pipe(browserLog, { end: false });
let browserClosed = false, socket, sequence = 0;
const closed = new Promise(resolve => browser.once('close', (code, signal) => { browserClosed = true; report.browserExit = { code, signal }; resolve(); }));
browser.on('error', error => report.browserErrors.push(error.message));
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(80); }
  throw new Error('Timed out: ' + label);
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 12000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
async function click(selector) {
  const box = await evaluate(`(() => {const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Button unavailable');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
}
async function check(name, expression) { assert.equal(await evaluate(expression), true, name); report.checks.push(name); save(); }
async function dimensions(width, height) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(80);
}
async function measure(name) {
  report.layout[name] = await evaluate(`(() => {
    const visible=n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
      overflows:[...document.querySelectorAll('button,select,textarea,summary')].filter(visible).filter(n=>{const b=n.getBoundingClientRect();return b.left<-.5||b.right>innerWidth+.5}).map(n=>n.id||n.tagName),
      diagnosticsOpen:document.querySelector('#diagnostics').open};})()`);
  const size = report.layout[name]; assert(size.scrollWidth <= size.width, name + ' horizontal page overflow');
  assert.deepEqual(size.overflows, [], name + ' clipped controls'); save();
}
async function capture(name) {
  await evaluate('window.scrollTo(0,0)'); await sleep(80);
  const metrics = await cdp('Page.getLayoutMetrics');
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 } });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'), { mode: 0o600 });
  report.screenshots.push(name + '.png'); save();
}
const count = () => evaluate("Number(document.querySelector('#detail-submissions').textContent)");
async function scenario(name) {
  await click('#new-run');
  await evaluate(`document.querySelector('#scenario').value=${JSON.stringify(name)}`);
  await click('#start');
  await wait(() => evaluate("document.querySelector('#busy-indicator').hidden"), name);
}

try {
  await wait(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'Chromium startup');
  const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.id) {
      const request = pending.get(value.id); if (!request) return;
      pending.delete(value.id); clearTimeout(request.timer);
      if (value.error) request.reject(new Error(value.error.message)); else request.resolve(value.result);
    }
    if (value.method === 'Runtime.exceptionThrown') report.browserErrors.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
    if (value.method === 'Log.entryAdded' && value.params.entry.level === 'error') report.browserErrors.push(value.params.entry.text);
    if (value.method === 'Page.javascriptDialogOpening') report.browserErrors.push('Unexpected native dialog');
    if (value.method === 'Network.requestWillBeSent') report.requests.push({ method: value.params.request.method, url: value.params.request.url });
  });
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable'); await cdp('Log.enable');
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  report.browser = await cdp('Browser.getVersion');
  await dimensions(1366, 900);
  await cdp('Page.navigate', { url: preview.origin + '/' });
  await wait(() => evaluate("Boolean(document.querySelector('#model')?.options.length)"), 'prototype mount');
  await evaluate('document.fonts.ready');
  await evaluate('Promise.all([...document.images].map(image=>image.decode()))');
  await check('initial read is idle, no generation, diagnostics collapsed', "document.querySelector('#detail-submissions').textContent==='0'&&!document.querySelector('#diagnostics').open&&document.querySelector('#download').disabled");
  await measure('desktop-initial'); await capture('desktop-initial');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await check('keyboard focus is visible', "document.activeElement.matches(':focus-visible')&&document.activeElement!==document.body");
  await evaluate("document.querySelector('#prompt').value='   '");
  await click('#start');
  await check('blank prompt rejected before creating or submitting', "document.querySelector('#detail-run').textContent==='尚未创建'&&document.querySelector('#feedback').textContent.includes('填写')");
  await evaluate("document.querySelector('#prompt').value='保留花朵，让背景柔和。<img src=x onerror=alert(1)>'");
  await click('#start');
  await evaluate("document.querySelector('#start').click();document.querySelector('#start').click()");
  await wait(() => evaluate("document.querySelector('#status-title').textContent==='等待你的选择'"), 'normal completed');
  assert.equal(await count(), 1);
  await check('double click creates one demo submission and locks inputs', "document.querySelector('#input-fields').disabled&&document.querySelector('#start').disabled&&document.querySelectorAll('[onerror]').length===0");
  const firstId = await evaluate("document.querySelector('#detail-run').textContent");
  await click('#refresh');
  await click('#diagnostics>summary');
  await check('one expanded disclosure label', "document.querySelector('#diagnostics').open&&document.querySelector('#diagnostics>summary').innerText.includes('收起')&&!document.querySelector('#diagnostics>summary').innerText.includes('展开')");
  await click('#diagnostics>summary');
  await check('one collapsed disclosure label', "!document.querySelector('#diagnostics').open&&document.querySelector('#diagnostics>summary').innerText.includes('展开')&&!document.querySelector('#diagnostics>summary').innerText.includes('收起')");
  assert.equal(await count(), 1, 'refresh and disclosure are read-only');
  await click('#select-source');
  await check('selection and download are separate', "document.querySelector('#select-source').getAttribute('aria-pressed')==='true'&&!document.querySelector('#download').disabled&&!document.querySelector('#feedback').textContent.includes('下载请求')");
  await click('#view-overlay');
  await evaluate("document.querySelector('#compare-position').value='27';document.querySelector('#compare-position').dispatchEvent(new Event('input',{bubbles:true}))");
  await check('overlay slider changes presentation only', "!document.querySelector('#overlay-view').hidden&&document.querySelector('#compare-value').textContent==='27%'&&document.querySelector('#overlay-output').style.clipPath.includes('27%')");
  assert.equal(await count(), 1);
  await click('#overlay-select-output'); await click('#download');
  await wait(() => fs.readdirSync(downloads).some(name => name.endsWith('.webp')), 'sample download');
  const outputFile = path.join(downloads, fs.readdirSync(downloads).find(name => name.endsWith('.webp')));
  assert.deepEqual(fs.readFileSync(outputFile), fs.readFileSync(path.join(root, 'docs/assets/examples/iris-flower-generated.webp')));
  report.checks.push('downloaded example bytes match the existing sample exactly');
  await click('#view-pair'); await measure('desktop-completed'); await capture('desktop-completed');
  await click('#theme-button'); await capture('desktop-dark'); await click('#theme-button');

  await scenario('unknown');
  const unknownCount = await count();
  await check('unknown acceptance pauses with billing warning and no retry button', "document.querySelector('#status-title').textContent==='需要确认'&&document.querySelector('#status-message').textContent.includes('可能已经计费')&&document.querySelector('#continue').hidden&&document.querySelector('#start').disabled");
  await click('#refresh'); assert.equal(await count(), unknownCount); await capture('desktop-unknown');
  await scenario('delivery_failed');
  const deliveryCount = await count();
  await check('delivery interruption describes success and original-result recovery', "document.querySelector('#continue').textContent==='恢复结果'&&document.querySelector('#status-message').textContent.includes('生成已经成功')");
  await click('#continue'); await wait(() => evaluate("document.querySelector('#status-title').textContent==='等待你的选择'"), 'redelivery');
  assert.equal(await count(), deliveryCount);
  await scenario('needs_comparison');
  const compareCount = await count();
  await check('local comparison has its own action', "document.querySelector('#continue').textContent==='完成比较'");
  await click('#continue'); await wait(() => evaluate("document.querySelector('#status-title').textContent==='等待你的选择'"), 'comparison');
  assert.equal(await count(), compareCount);
  await scenario('running');
  const runningCount = await count(), taskId = await evaluate("document.querySelector('#detail-task').textContent");
  await click('#continue');
  await wait(() => evaluate("document.querySelector('#status-title').textContent==='等待你的选择'"), 'observe original');
  assert.equal(await count(), runningCount); assert.equal(await evaluate("document.querySelector('#detail-task').textContent"), taskId);
  report.checks.push('observe, redelivery and comparison keep the original task without another submission');

  await click('#new-run'); await evaluate("document.querySelector('#scenario').value='success'"); await click('#start'); await click('#cancel');
  await wait(() => evaluate("document.querySelector('#busy-indicator').hidden"), 'local cancel');
  const canceledCount = await count();
  await check('stopping wait preserves accepted task without declaring remote canceled', "document.querySelector('#status-title').textContent==='原任务进行中'&&document.querySelector('#detail-state').textContent==='accepted / none / none'&&document.querySelector('#feedback').textContent.includes('不代表远端')");
  await click('#continue'); await wait(() => evaluate("document.querySelector('#status-title').textContent==='等待你的选择'"), 'resume after stop');
  assert.equal(await count(), canceledCount);

  await click('#diagnostics>summary');
  await evaluate(`document.querySelector('#history').value=${JSON.stringify(firstId)};document.querySelector('#history').dispatchEvent(new Event('change',{bubbles:true}))`);
  assert.equal(await evaluate("document.querySelector('#detail-run').textContent"), firstId); assert.equal(await count(), canceledCount);
  report.checks.push('switching history restores original input and selection without executing');
  await click('#diagnostics>summary');

  await click('#new-run');
  const uploadPath = path.join(out, 'local-source.png');
  await sharp({ create: { width: 48, height: 32, channels: 3, background: '#b94f38' } }).png().toFile(uploadPath);
  const documentNode = await cdp('DOM.getDocument');
  const input = await cdp('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#image-file' });
  await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [uploadPath] });
  await wait(() => evaluate("document.querySelector('#file-name').textContent==='local-source.png'"), 'local file preview');
  await check('local upload uses a Blob URL and exact dimensions', "document.querySelector('#input-preview').src.startsWith('blob:')&&document.querySelector('#file-dimensions').textContent==='48 × 32'");
  await click('#start'); await wait(() => evaluate("document.querySelector('#status-title').textContent==='等待你的选择'"), 'local preview run');
  await click('#select-source'); await click('#download');
  await wait(() => fs.readdirSync(downloads).some(name => name.endsWith('.png')), 'original PNG download');
  const originalFile = path.join(downloads, fs.readdirSync(downloads).find(name => name.endsWith('.png')));
  assert.deepEqual(fs.readFileSync(originalFile), fs.readFileSync(uploadPath));
  report.checks.push('local source download preserves original bytes and media extension');

  for (const width of [390, 320]) {
    await dimensions(width, 844); await measure('mobile-' + width); await capture('mobile-' + width);
    await click('#diagnostics>summary'); await measure('mobile-' + width + '-expanded');
    await capture('mobile-' + width + '-expanded'); await click('#diagnostics>summary');
  }
  await click('#theme-button'); await capture('mobile-320-dark'); await click('#theme-button');
  await cdp('Page.reload');
  await wait(() => evaluate("document.querySelector('#detail-submissions')?.textContent==='0'&&document.querySelector('#model').options.length>0"), 'reload');
  await check('full reload clears demo memory and never automatically starts', "document.querySelector('#detail-run').textContent==='尚未创建'&&!document.querySelector('#diagnostics').open&&document.querySelector('#download').disabled");
  assert(report.requests.every(request => ['GET'].includes(request.method)), 'no browser upload or write requests');
  assert(report.requests.every(request => new URL(request.url).origin === preview.origin), 'no external browser requests');
  assert(report.requests.every(request => !new URL(request.url).pathname.startsWith('/api/')), 'no live API requests');
  assert.deepEqual(report.browserErrors, [], 'browser exceptions, CSP violations or console errors');
  report.checks.push('only same-origin static GET/blob reads, no API or external requests, no browser errors');
  report.sourceHashes = Object.fromEntries(['index.html', 'styles.css', 'app.js', 'view-model.js', 'demo-transport.js']
    .map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, 'prototypes/workbench', name))).digest('hex')]));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; process.exitCode = 1;
} finally {
  if (socket) socket.close();
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser verification ended')); }
  pending.clear();
  if (!browserClosed) {
    try { if (process.platform === 'win32') browser.kill('SIGTERM'); else process.kill(-browser.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await Promise.race([closed, sleep(4000)]);
    if (!browserClosed) { browser.kill('SIGKILL'); await closed; }
  }
  await preview.close(); await new Promise(resolve => browserLog.end(resolve)); save();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, output: out,
    ...(report.failure ? { failure: report.failure } : {}) }, null, 2));
}
