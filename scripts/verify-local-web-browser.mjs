/** Real Chromium + real local HTTP/Core, with controlled Provider fixtures only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi, writeLocalApiTokenFile } from '../lib/local-api.js';
import { FLOW_MODEL, FLOW_SOURCE, FLOW_RESULT, imageFlowFixture, readFlowEvents } from '../tests/fixtures/image-flow-fixture.mjs';
import { httpMcpClient } from '../tests/fixtures/mcp-http-client.mjs';

const args = process.argv.slice(2);
assert(args.length >= 4 && args.slice(4).every(flag => ['--no-sandbox', '--execution-root', '--connection-management'].includes(flag)) && new Set(args.slice(4)).size === args.slice(4).length,
  'Usage: --browser-executable <absolute-path> --output <new-absolute-directory> [--no-sandbox] [--execution-root] [--connection-management]');
assert.equal(args[0], '--browser-executable'); assert.equal(args[2], '--output');
assert(path.isAbsolute(args[1]) && path.isAbsolute(args[3]));
const executable = fs.realpathSync(args[1]), out = args[3];
const management = args.includes('--connection-management');
fs.mkdirSync(out, { mode: 0o700 });
const report = { status: 'running', checks: [], browserErrors: [], requests: [], layout: {}, screenshots: [],
  actualPaidCalls: 0, realApiImplemented: true, dailyDshBooted: false, noSandbox: args.includes('--no-sandbox'),
  connectionManagement: management, requestRootVersion: args.includes('--execution-root') || management ? 1 : null };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function tree(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(name => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    return [name, { mode: stat.mode & 0o777, ...(stat.isFile() ? { sha256: digest(fs.readFileSync(file)) }
      : stat.isDirectory() ? { directory: true } : { link: fs.readlinkSync(file) }) }];
  }));
}
save();
const dataRoot = path.join(out, 'core'), fixture = imageFlowFixture(dataRoot);
const app = createApplicationRuntime({ dataRoot, ...fixture });
let api, session, browser, socket, sequence = 0, browserClosed = false, closed;
const pending = new Map(), pausedResponses = [], profile = path.join(out, 'browser-profile'), downloads = path.join(out, 'downloads');
fs.mkdirSync(downloads, { mode: 0o700 });
const browserLog = fs.createWriteStream(path.join(out, 'browser.log'), { mode: 0o600 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(80); }
  throw new Error('Timed out: ' + label);
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 12000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function click(selector) {
  const point = await evaluate(`(async () => {const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Control unavailable: '+${JSON.stringify(selector)});n.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=n.getBoundingClientRect();const point={x:r.x+r.width/2,y:r.y+r.height/2};if(!n.contains(document.elementFromPoint(point.x,point.y)))throw Error('Control obscured: '+${JSON.stringify(selector)});return point})()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function check(name, expression) { assert.equal(await evaluate(expression), true, name); report.checks.push(name); save(); }
async function dimensions(width, height = 844) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(80);
}
async function measure(name) {
  report.layout[name] = await evaluate(`(() => {
    const visible=n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      overflows:[...document.querySelectorAll('button,input,summary')].filter(visible).filter(n=>n.getBoundingClientRect().right>innerWidth+1||n.getBoundingClientRect().left< -1).map(n=>n.id||n.tagName),
      detailsOpen:document.querySelector('#run-details').open};})()`);
  assert(report.layout[name].scrollWidth <= report.layout[name].width, name + ' horizontal overflow');
  assert.deepEqual(report.layout[name].overflows, [], name + ' clipped controls'); save();
}
async function capture(name) {
  await evaluate('window.scrollTo(0,0)'); await sleep(80);
  const metrics = await cdp('Page.getLayoutMetrics');
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 } });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'), { mode: 0o600 });
  report.screenshots.push(name + '.png'); save();
}
async function chooseToken(file) {
  const document = await cdp('DOM.getDocument');
  const input = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#token-file' });
  await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
}
async function readyRun(id) {
  await wait(() => evaluate(`location.hash===${JSON.stringify('#' + id)}&&!document.querySelector('#viewer').getAttribute('aria-busy').includes('true')&&!document.querySelector('#run-view').hidden`), 'real Run ' + id);
}

try {
  await app.execute('flow.init', {});
  if (args.includes('--execution-root') || management) await app.execute('execution.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const create = prompt => app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt });
  const chosen = await create('保留主体，调整背景。<img src=x onerror=alert(1)>');
  const completed = await app.execute('flow.continue', { run_id: chosen.run.id });
  await app.execute('flow.select', { run_id: chosen.run.id, artifact_id: completed.run.output.artifactId });
  const unstarted = await create('保留轮廓，使用柔和的颜色。');
  const before = tree(dataRoot), eventsBefore = readFlowEvents(dataRoot);
  const tokenFile = path.join(out, 'session-token');
  const apiOptions = { dataRoot, serveWorkbench: true, ...(management ? {
    allowConnectionManagement: true, connectionStore: path.join(out, 'managed-connections'), allowMcp: true } : {}) };
  api = createLocalReadApi(apiOptions); session = await api.start();
  writeLocalApiTokenFile(tokenFile, session.accessToken, dataRoot);
  browser = spawn(executable, ['--headless=new', ...(report.noSandbox ? ['--no-sandbox'] : []), '--disable-gpu',
    '--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  browser.stderr.pipe(browserLog, { end: false });
  closed = new Promise(resolve => browser.once('close', (code, signal) => { browserClosed = true; report.browserExit = { code, signal }; resolve(); }));
  browser.on('error', error => report.browserErrors.push(error.message));
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
    if (value.method === 'Log.entryAdded' && /Content Security Policy|Refused to/.test(value.params.entry.text)) report.browserErrors.push(value.params.entry.text);
    if (value.method === 'Page.javascriptDialogOpening') report.browserErrors.push('Unexpected native dialog');
    if (value.method === 'Network.requestWillBeSent') report.requests.push({ method: value.params.request.method, url: value.params.request.url });
    if (value.method === 'Fetch.requestPaused') pausedResponses.push(value.params.requestId);
  });
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable'); await cdp('Log.enable');
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.testBlobs=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=b=>{const u=create(b);testBlobs.add(u);return u};URL.revokeObjectURL=u=>{testBlobs.delete(u);return revoke(u)}` });
  report.browser = await cdp('Browser.getVersion');
  await dimensions(1366, 900);
  await cdp('Page.navigate', { url: session.origin + '/#' + chosen.run.id });
  await wait(() => evaluate("Boolean(document.documentElement.dataset.theme&&!document.querySelector('#connection').hidden)"), 'login mount');
  await evaluate('document.fonts.ready');
  await check('public shell starts disconnected, with no stored credential', "!document.querySelector('#connection').hidden&&document.querySelector('#workspace').hidden&&localStorage.length===0&&sessionStorage.length===0&&!location.search");
  await measure('desktop-login'); await capture('desktop-login');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await check('keyboard focus is visible', "document.activeElement!==document.body&&document.activeElement.matches(':focus-visible')");
  await chooseToken(tokenFile); await readyRun(chosen.run.id);
  await check('file connection reads real history, original images and stored selection', "document.querySelectorAll('.history-item').length===2&&document.querySelector('#status-title').textContent==='已选择结果'&&!document.querySelector('#download').disabled&&document.querySelector('#source-dimensions').textContent==='48 × 32'&&document.querySelector('#output-dimensions').textContent==='48 × 32'");
  await check('prompt is literal text, details collapsed, missing config is nonblocking', "document.querySelector('#prompt').textContent.includes('<img src=x')&&document.querySelectorAll('[onerror]').length===0&&!document.querySelector('#run-details').open&&!document.querySelector('#model-panel').open&&document.querySelector('#model-summary').textContent==='未指定配置'");
  await check('token is absent from URL, input and browser storage', "!location.search&&!document.querySelector('#token').value&&!document.querySelector('#token-file').value&&localStorage.length===0&&sessionStorage.length===0");
  await measure('desktop-selected'); await capture('desktop-selected');
  await click('#run-details>summary');
  await wait(() => evaluate("document.querySelector('#run-details .disclosure').textContent==='收起'"), 'expanded disclosure text');
  await check('expanded details have one correct disclosure label', "document.querySelector('#run-details').open&&document.querySelector('#run-details .disclosure').textContent==='收起'");
  await click('#run-details>summary');
  await wait(() => evaluate("document.querySelector('#run-details .disclosure').textContent==='展开'"), 'collapsed disclosure text');
  await check('collapsed details have one correct disclosure label', "!document.querySelector('#run-details').open&&document.querySelector('#run-details .disclosure').textContent==='展开'");
  await click('#download');
  await wait(() => fs.readdirSync(downloads).some(file => file.endsWith('.png')), 'real selected download');
  const downloaded = fs.readdirSync(downloads).find(file => file.endsWith('.png'));
  assert.deepEqual(fs.readFileSync(path.join(downloads, downloaded)), FLOW_RESULT);
  report.download = { name: downloaded, sha256: digest(fs.readFileSync(path.join(downloads, downloaded))) };
  report.checks.push('download exactly matches the selected Core artifact bytes'); save();
  await check('download feedback acknowledges the browser handoff', "document.querySelector('#feedback').textContent.includes('交给浏览器')");
  let managedConnectionId, exportedToken;
  if (management) {
    await click('#connections-tab');
    await wait(() => evaluate("!document.querySelector('#connection-fields').disabled"), 'connection form ready');
    await check('connection center has six media choices, unsupported groups disabled and tools collapsed', "document.querySelectorAll('#connection-media input').length===6&&document.querySelectorAll('#connection-media input:disabled').length===5&&!document.querySelector('#connection-tool-details').open&&document.querySelector('#connection-tool-count').textContent==='8 个可用'");
    const label = '<img src=x onerror=alert(1)> / My own harness';
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/connection-management/connections', requestStage: 'Response' }] });
    await evaluate(`document.querySelector('#connection-name').value=${JSON.stringify(label)}`); await click('#connection-save');
    await wait(() => pausedResponses.length > 0, 'held create response after commit');
    assert.equal(fs.readdirSync(path.join(out, 'managed-connections/profiles')).length, 1);
    report.checks.push('real create commits exactly once before its response is lost');
    await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionReset' }); await cdp('Fetch.disable');
    await wait(() => evaluate("document.querySelector('#connections-feedback').textContent.includes('尚未确认')&&!document.querySelector('#connection-save').disabled"), 'unknown create outcome feedback');
    await check('lost create response stays unconfirmed and retains the draft for same-key retry', "document.querySelectorAll('.connection-item').length===0&&document.querySelector('#connection-name').value.includes('<img src=x')&&document.querySelector('#connections-feedback').classList.contains('error')");
    await evaluate(`document.querySelector('#connection-name').value=${JSON.stringify(label)};document.querySelector('#connection-save').click();document.querySelector('#connection-save').click()`);
    await wait(() => evaluate("document.querySelectorAll('.connection-item').length===1&&!document.querySelector('#connection-save').disabled"), 'durable connection created');
    managedConnectionId = await evaluate("document.querySelector('.connection-item').dataset.connectionId");
    assert.equal(fs.readdirSync(path.join(out, 'managed-connections/profiles')).length, 1, 'retry reuses the committed UUID and credential');
    await check('double click creates exactly one named connection and renders labels as text', "document.querySelectorAll('.connection-item').length===1&&document.querySelector('.connection-item strong').textContent.includes('<img src=x')&&!document.querySelector('[onerror]')&&document.querySelector('#connection-state').textContent==='尚未使用'&&document.querySelector('#connections-feedback').textContent.includes('已创建')");
    await measure('connections-desktop'); await capture('connections-desktop');
    await click('#connection-export-button');
    await wait(() => evaluate("!document.querySelector('#connection-export-result').hidden"), 'stdio export');
    const stdio = JSON.parse(await evaluate("document.querySelector('#connection-configuration').value"));
    assert.equal(stdio.mcpServers.iris.command, process.execPath);
    const stdioArgs = stdio.mcpServers.iris.args, clientPath = stdioArgs[stdioArgs.indexOf('--connection-file') + 1];
    assert.equal(fs.statSync(clientPath).mode & 0o777, 0o600);
    await check('template import and skill instructions start collapsed', "!document.querySelector('#connection-skill-details').open&&document.querySelector('#connection-skill-result').hidden&&!document.querySelector('#connection-template-file').closest('details').open");
    const templateFile = path.join(out, 'client-template.json');
    fs.writeFileSync(templateFile, JSON.stringify({ schemaVersion: 0, title: '<img onerror=alert(1)> · My client', transport: 'stdio', format: 'entry' }));
    const documentNode = await cdp('DOM.getDocument'), templateInput = await cdp('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#connection-template-file' });
    await cdp('DOM.setFileInputFiles', { nodeId: templateInput.nodeId, files: [templateFile] });
    await wait(() => evaluate("document.querySelector('#connection-template').value.length===64&&!document.querySelector('#connection-template-import').disabled"), 'persisted pure data template');
    await check('template import selects only format and transport, preserving the saved grant', "document.querySelector('#connection-format').value==='entry'&&document.querySelector('#connection-transport').value==='stdio'&&document.querySelector('#connection-transport').disabled&&document.querySelector('#connection-tool-count').textContent==='8 个可用'&&document.querySelector('#connection-template').selectedOptions[0].textContent.includes('<img onerror')&&!document.querySelector('[onerror]')");
    await click('#connection-export-button'); await wait(() => evaluate("!document.querySelector('#connection-export-result').hidden"), 'template-selected config');
    assert.equal(JSON.parse(await evaluate("document.querySelector('#connection-configuration').value")).command, process.execPath);
    await click('#connection-skill-details>summary'); await click('#connection-skill-generate');
    await wait(() => evaluate("!document.querySelector('#connection-skill-result').hidden"), 'matched skill preview');
    await check('skill preview uses selected read tools with English instructions and Chinese headings', "document.querySelector('#connection-skill-preview').value.includes('Available tools · 可用工具')&&document.querySelector('#connection-skill-preview').value.includes('iris_core_image')&&!document.querySelector('#connection-skill-preview').value.includes('iris_core_continue')&&!document.querySelector('#connection-skill-preview').value.includes('onerror')");
    await click('#connection-skill-download'); await wait(() => fs.existsSync(path.join(downloads, 'iris-skill.json')), 'real skill descriptor download');
    const skillBundle = JSON.parse(fs.readFileSync(path.join(downloads, 'iris-skill.json')));
    assert.equal(skillBundle.connectionId, managedConnectionId); assert.equal(skillBundle.tools.length, 8); assert(!Object.hasOwn(skillBundle, 'accessToken')); assert(!Object.hasOwn(skillBundle, 'files'));
    await check('skill download clears its preview and accurately reports not installed', "document.querySelector('#connection-skill-result').hidden&&!document.querySelector('#connection-skill-preview').value&&document.querySelector('#connections-feedback').textContent.includes('尚未安装')");
    await evaluate("document.querySelector('#connection-template').value='';document.querySelector('#connection-template').dispatchEvent(new Event('change'));document.querySelector('#connection-format').value='mcpServers'");
    await evaluate("document.querySelector('#connection-transport').value='http';document.querySelector('#connection-transport').dispatchEvent(new Event('input'))");
    await check('changing export options clears the old preview', "document.querySelector('#connection-export-result').hidden&&!document.querySelector('#connection-configuration').value");
    await click('#connection-export-button'); await wait(() => evaluate("!document.querySelector('#connection-export-result').hidden"), 'http export');
    const exported = JSON.parse(await evaluate("document.querySelector('#connection-configuration').value"));
    exportedToken = exported.mcpServers.iris.headers.Authorization.slice(7);
    assert.equal(exported.mcpServers.iris.url, session.origin + '/mcp');
    await check('HTTP credentials appear only after explicit export and are labelled', "document.querySelector('#connection-export-note').textContent.includes('密钥')&&localStorage.length===0&&sessionStorage.length===0&&!location.search");
    await click('#connection-download');
    await wait(() => fs.existsSync(path.join(downloads, 'iris-mcp.json')), 'real configuration download');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(downloads, 'iris-mcp.json'))), exported);
    await check('download clears the credential preview', "document.querySelector('#connection-export-result').hidden&&!document.querySelector('#connection-configuration').value");
    const remote = httpMcpClient(session.origin, exportedToken, { name: 'Any brand / actual MCP' });
    await remote.initialize(); await remote.call('iris_core_models', {});
    await click('#connections-refresh');
    await wait(() => evaluate("document.querySelector('#connection-state').textContent==='使用过'"), 'declared client fact');
    await check('real MCP declaration is separate from bridge and unproven liveness', "document.querySelector('#connection-facts').textContent.includes('Any brand / actual MCP')&&document.querySelector('#connection-facts').textContent.includes('Iris HTTP MCP bridge')&&document.querySelector('#connection-facts').textContent.includes('iris.mcp')&&document.querySelector('#connection-facts').textContent.includes('不表示持续在线')");
    await evaluate("document.querySelector('#connection-name').value='Renamed workspace'");
    await click('#connection-media input[value="image"]'); await click('#connection-save');
    await wait(() => evaluate("document.querySelector('.connection-item strong').textContent==='Renamed workspace'&&!document.querySelector('#connection-save').disabled"), 'save changed grant');
    assert.equal((await remote.request('tools/list')).tools.length, 2);
    await check('saved capability change is visible and tools remain collapsed', "document.querySelector('#connection-tool-count').textContent==='2 个可用'&&!document.querySelector('#connection-tool-details').open&&document.querySelector('#connections-feedback').textContent.includes('已保存')");
    // Hold an actual export response. A hidden-and-reopened tab must not reveal it later.
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/connection-management/connections/*/export', requestStage: 'Response' }] });
    await click('#connection-export-button'); await wait(() => pausedResponses.length > 0, 'held export response');
    await click('#media-tab'); await click('#connections-tab');
    await cdp('Fetch.continueRequest', { requestId: pausedResponses.shift() }); await cdp('Fetch.disable');
    await wait(() => evaluate("!document.querySelector('#connection-export-button').disabled"), 'released export response');
    await check('a late export cannot reveal credentials after leaving the tab', "document.querySelector('#connection-export-result').hidden&&!document.querySelector('#connection-configuration').value");
    await click('#connection-skill-details>summary');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/connection-management/connections/*/skill', requestStage: 'Response' }] });
    await click('#connection-skill-generate'); await wait(() => pausedResponses.length > 0, 'held skill response');
    await click('#media-tab'); await click('#connections-tab');
    await cdp('Fetch.continueRequest', { requestId: pausedResponses.shift() }); await cdp('Fetch.disable');
    await wait(() => evaluate("!document.querySelector('#connection-skill-generate').disabled"), 'released skill response');
    await check('a late skill snapshot clears pending feedback without repopulating a cleared view', "document.querySelector('#connection-skill-result').hidden&&!document.querySelector('#connection-skill-preview').value&&!document.querySelector('#connections-feedback').textContent.includes('正在处理')");
    for (const width of [390, 320]) {
      await dimensions(width); await measure('connections-mobile-' + width); await capture('connections-mobile-' + width);
      await click('#connection-tool-details>summary');
      await wait(() => evaluate("document.querySelector('#connection-tool-details .disclosure').textContent==='收起'"), 'tool disclosure toggle event');
      await check('tool disclosure expands once at ' + width, "document.querySelector('#connection-tool-details').open&&document.querySelector('#connection-tool-details .disclosure').textContent==='收起'");
      await measure('connections-mobile-expanded-' + width); await click('#connection-tool-details>summary');
    }
    await click('#theme'); await capture('connections-dark'); await click('#theme');
    await click('#connection-revoke');
    await check('revocation requires an explicit local confirmation', "!document.querySelector('#connection-revoke-confirm').hidden&&document.querySelector('#connection-state').textContent==='使用过'");
    await click('#connection-revoke-yes');
    await wait(() => evaluate("document.querySelector('#connection-state').textContent==='已撤销'"), 'revoked connection');
    await assert.rejects(remote.request('tools/list'), error => error.status === 401);
    await check('revoked connection keeps history and disables export/edit', "document.querySelectorAll('.connection-item').length===1&&document.querySelector('#connection-fields').disabled&&document.querySelector('#connection-export').hidden");
    await click('#connection-new'); await evaluate("document.querySelector('#connection-name').value='Renamed workspace'"); await click('#connection-save');
    await wait(() => evaluate("document.querySelectorAll('.connection-item').length===2&&!document.querySelector('#connection-save').disabled"), 'second same named profile');
    assert.notEqual(await evaluate("document.querySelector('.connection-item[aria-current=true]').dataset.connectionId"), managedConnectionId);
    await click('#media-tab'); await dimensions(1366, 900);
  }
  await click(`[data-run-id="${unstarted.run.id}"]`); await readyRun(unstarted.run.id);
  await check('unstarted real Run stays unsubmitted and disables download', "document.querySelector('#status-title').textContent==='已保存，尚未开始'&&document.querySelector('#download').disabled&&document.querySelector('#output-image').hidden&&testBlobs.size===1");
  // Rapid switches exercise request cancellation and stale-response ownership against the real API.
  await evaluate(`for(let i=0;i<6;i++)document.querySelector('[data-run-id="'+${JSON.stringify(chosen.run.id)}+'"]').click();document.querySelector('[data-run-id="'+${JSON.stringify(unstarted.run.id)}+'"]').click()`);
  await readyRun(unstarted.run.id);
  await check('late history responses cannot replace the final Run', `document.querySelector('#status-title').textContent==='已保存，尚未开始'&&location.hash===${JSON.stringify('#' + unstarted.run.id)}`);
  await click(`[data-run-id="${chosen.run.id}"]`); await readyRun(chosen.run.id);
  await click('#refresh'); await readyRun(chosen.run.id);
  await check('refresh preserves the same Run and local selection', `location.hash===${JSON.stringify('#' + chosen.run.id)}&&document.querySelector('#status-title').textContent==='已选择结果'`);
  // Hold a genuine list response to prove that a later explicit history click wins over refresh.
  await wait(() => evaluate("!document.querySelector('#refresh').disabled"), 'refresh finished');
  await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/runs?limit=20', requestStage: 'Response' }] });
  await click('#refresh'); await wait(() => pausedResponses.length > 0, 'held history response');
  await click(`[data-run-id="${unstarted.run.id}"]`); await readyRun(unstarted.run.id);
  await cdp('Fetch.continueRequest', { requestId: pausedResponses.shift() }); await cdp('Fetch.disable');
  await wait(() => evaluate("!document.querySelector('#refresh').disabled"), 'released history response');
  await check('a late refresh cannot undo a newer explicit history selection', `location.hash===${JSON.stringify('#' + unstarted.run.id)}&&document.querySelector('#status-title').textContent==='已保存，尚未开始'`);
  await click(`[data-run-id="${chosen.run.id}"]`); await readyRun(chosen.run.id);
  for (const width of [390, 320]) {
    await dimensions(width); await measure('mobile-' + width); await capture('mobile-' + width);
    await click('#run-details>summary'); await measure('mobile-' + width + '-expanded'); await click('#run-details>summary');
  }
  await click('#theme'); await capture('mobile-320-dark'); await click('#theme');
  await click('#disconnect');
  await check('disconnect releases Blob URLs and private view contents', "testBlobs.size===0&&document.querySelector('#workspace').hidden&&!document.querySelector('#prompt').textContent&&!document.querySelector('#token').value");
  await click('#paste-panel>summary');
  await evaluate(`document.querySelector('#token').value=${JSON.stringify(session.accessToken)}`); await click('#connect'); await readyRun(chosen.run.id);
  await cdp('Page.reload');
  await wait(() => evaluate("Boolean(document.documentElement.dataset.theme&&!document.querySelector('#connection').hidden)"), 'reload without credentials');
  await check('reload requires reconnection and keeps only the Run fragment', `location.hash===${JSON.stringify('#' + chosen.run.id)}&&document.querySelector('#workspace').hidden&&!document.querySelector('#token').value&&localStorage.length===0&&sessionStorage.length===0`);
  await chooseToken(tokenFile); await readyRun(chosen.run.id);
  const oldPort = Number(new URL(session.origin).port);
  await api.dispose(); api = createLocalReadApi(apiOptions); session = await api.start({ port: oldPort });
  const newToken = path.join(out, 'restarted-token'); writeLocalApiTokenFile(newToken, session.accessToken, dataRoot);
  await click('#refresh');
  await wait(() => evaluate("!document.querySelector('#connection').hidden&&document.querySelector('#feedback').textContent.includes('失效')"), 'token invalidation after service restart');
  await chooseToken(newToken); await readyRun(chosen.run.id);
  if (management) {
    await click('#connections-tab');
    await wait(() => evaluate("document.querySelectorAll('.connection-item').length===2"), 'restored managed profiles');
    await click('[data-connection-id="' + managedConnectionId + '"]');
    await check('service restart preserves revoked profile and clears runtime instances', "document.querySelector('#connection-state').textContent==='已撤销'&&document.querySelector('#connection-facts').textContent.includes('无握手实例')");
    await check('service restart preserves imported templates without scanning the client', "document.querySelector('#connection-template').options.length===2&&document.querySelector('#connection-template').options[1].textContent.includes('My client')");
    await assert.rejects(httpMcpClient(session.origin, exportedToken).request('tools/list'), error => error.status === 401);
    await click('#media-tab');
  }
  report.checks.push('service restart invalidates the old token; reconnect restores the same durable Run');
  assert(report.requests.every(request => request.method === 'GET' || management && request.method === 'POST'
    && /^\/api\/v0\/connection-management\/(?:templates|connections(?:\/[a-f0-9-]{36}\/(?:update|revoke|export|skill))?)$/.test(new URL(request.url).pathname)), 'browser writes are limited to explicit owner connection management');
  assert(report.requests.every(request => request.url.startsWith('blob:') || new URL(request.url).origin === session.origin), 'no external requests');
  assert(report.requests.every(request => !request.url.includes(session.accessToken)), 'token never appears in request URLs');
  assert.deepEqual(report.browserErrors, [], 'no uncaught browser exceptions or native dialogs');
  assert.deepEqual(tree(dataRoot), before); assert.deepEqual(readFlowEvents(dataRoot), eventsBefore);
  report.checks.push('browser navigation, refresh, download and restart leave Core and Provider events unchanged');
  report.core = { before, after: tree(dataRoot), eventsBefore, eventsAfter: readFlowEvents(dataRoot) };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; process.exitCode = 1;
  if (socket?.readyState === WebSocket.OPEN) {
    try { report.failureView = await evaluate("({detailsOpen:document.querySelector('#run-details')?.open,disclosure:document.querySelector('#run-details .disclosure')?.textContent,feedback:document.querySelector('#feedback')?.textContent,hash:location.hash,connectionState:document.querySelector('#connection-state')?.textContent,connectionFeedback:document.querySelector('#connections-feedback')?.textContent,selectedConnection:document.querySelector('.connection-item[aria-current=true]')?.dataset.connectionId,toolsOpen:document.querySelector('#connection-tool-details')?.open,toolDisclosure:document.querySelector('#connection-tool-details .disclosure')?.textContent,fieldsetDisabled:document.querySelector('#connection-fields')?.disabled})"); }
    catch (diagnosticError) { report.diagnosticError = diagnosticError.message; }
  }
} finally {
  if (socket) socket.close();
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser verification ended')); }
  pending.clear();
  if (browser && !browserClosed) {
    try { if (process.platform === 'win32') browser.kill('SIGTERM'); else process.kill(-browser.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await Promise.race([closed, sleep(4000)]);
    if (!browserClosed) { browser.kill('SIGKILL'); await closed; }
  }
  if (api) await api.dispose(); await app.dispose(); await new Promise(resolve => browserLog.end(resolve)); save();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, output: out,
    ...(report.failure ? { failure: report.failure } : {}) }, null, 2));
}
