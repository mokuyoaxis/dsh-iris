import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { executeConfigCommand } from '../../lib/provider-config-service.js';
import { FLOW_SOURCE, FLOW_RESULT } from './image-flow-fixture.mjs';

export async function verifyPanelC3Browser({ out, dataRoot, tokenFile, cdp, evaluate, click, wait, chooseToken, readyRun,
  report, save, dimensions, measure, capture, pausedResponses, restart }) {
  const result = report.panelC3 = { checks: [], actualPaidCalls: 0, status: 'running' };
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const field = async (id, value) => evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  async function chooseFile(selector, file) {
    const document = await cdp('DOM.getDocument'), input = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector });
    await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
  }
  const calls = [], config = path.join(out, 'provider-settings.json'), image = path.join(out, 'local-background.png');
  fs.writeFileSync(image, FLOW_SOURCE, { mode: 0o600 }); fs.writeFileSync(config, JSON.stringify({ providers: [], assignments: {} }) + '\n', { mode: 0o600 });
  const upstream = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, path: request.url, ...(body ? { body: JSON.parse(body) } : {}) });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.method === 'GET' ? { data: [{ id: 'browser-edit' }, { id: 'unused-media' }] }
      : { choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + FLOW_RESULT.toString('base64') } }] } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await check('default light Panel has exactly the requested 105-degree six-color accent', "document.documentElement.dataset.theme==='light'&&getComputedStyle(document.documentElement).getPropertyValue('--iris-gradient').replaceAll(' ','').toLowerCase()==='linear-gradient(105deg,#45317d,#6f69b8,#bb78ad,#e59b76,#ed9c91,#f0d09c)'");
    await click('#appearance-open');
    await check('background options start collapsed with one correct disclosure', "!document.querySelector('#appearance-background').open&&document.querySelector('#appearance-background .disclosure').textContent==='展开'");
    await field('appearance-accent', 'rose'); await field('appearance-density', 'compact');
    await click('#appearance-background>summary');
    await wait(() => evaluate("!document.querySelector('#appearance-image').disabled"), 'background storage ready');
    await chooseFile('#appearance-image', image);
    await wait(() => evaluate("document.querySelector('#appearance-note').textContent==='背景已保存到此浏览器。'"), 'saved local background');
    await field('appearance-overlay', '75'); await field('appearance-blur', '6');
    await check('background preview uses local blob and bounded CSS properties under the existing CSP', "getComputedStyle(document.querySelector('.main-area'),'::before').backgroundImage.startsWith('url(\"blob:')&&getComputedStyle(document.querySelector('.main-area'),'::before').filter==='blur(6px)'&&getComputedStyle(document.querySelector('.main-area'),'::before').opacity==='0.25'");
    await click('#appearance-dialog details:not(#appearance-background)>summary');
    const themeFile = path.join(out, 'theme-import.json'), invalidTheme = path.join(out, 'theme-invalid.json');
    const theme = { contractVersion: 0, theme: 'light', accent: 'rose', density: 'compact', position: 'center', overlay: 75, blur: 6 };
    fs.writeFileSync(themeFile, JSON.stringify(theme)); fs.writeFileSync(invalidTheme, JSON.stringify({ ...theme, background: 'https://never-called.invalid/x' }));
    await chooseFile('#appearance-import', themeFile);
    await wait(() => evaluate("document.querySelector('#appearance-note').textContent.startsWith('已保存到此浏览器')"), 'valid data-only theme import');
    await chooseFile('#appearance-import', invalidTheme);
    await wait(() => evaluate("document.querySelector('#appearance-note').textContent.includes('当前设置已保留')"), 'invalid remote-background theme rejected');
    await click('#appearance-export');
    await wait(() => fs.existsSync(path.join(out, 'downloads/iris-theme.json')), 'theme JSON download');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'downloads/iris-theme.json'))), theme);
    result.checks.push('actual theme import/export stays data-only, excludes images/credentials and rejects a remote background field without changing preferences');
    await capture('appearance-desktop'); await click('#appearance-close'); await cdp('Page.reload');
    await wait(() => evaluate("document.documentElement.dataset.accent==='rose'&&getComputedStyle(document.querySelector('.main-area'),'::before').backgroundImage.includes('blob:')"), 'appearance and local image restored');
    await check('reload restores appearance but no session credential or automatic connection', "document.documentElement.dataset.density==='compact'&&!document.querySelector('#connection').hidden&&!document.querySelector('#token').value&&Object.keys(localStorage).every(k=>k==='iris.panel.appearance.v0')");
    await click('#appearance-open'); await click('#appearance-reset');
    await click('#appearance-background>summary'); await click('#appearance-remove');
    await wait(() => evaluate("document.querySelector('#appearance-note').textContent==='已移除此浏览器的背景。'"), 'background explicitly removed');
    await click('#appearance-close');
    await chooseToken(tokenFile);
    await wait(() => evaluate("!document.querySelector('#workspace').hidden"), 'read-only login');
    await check('read-only service hides provider management; model shortcut explains the explicit startup flag', "document.querySelector('#providers-tab').hidden");
    await click('#manage-models');
    await check('management shortcut gives a concrete enablement instruction', "document.querySelector('#feedback').textContent.includes('--allow-provider-management')");

    const session = await restart(config), token = path.join(out, 'management-session.token');
    writeLocalApiTokenFile(token, session.accessToken, dataRoot);
    await cdp('Page.navigate', { url: session.origin + '/' });
    await wait(() => evaluate("Boolean(document.documentElement.dataset.theme)"), 'management mount'); await chooseToken(token);
    await wait(() => evaluate("!document.querySelector('#providers-tab').hidden"), 'owner management handshake'); await click('#providers-tab');
    await wait(() => evaluate("!document.querySelector('#provider-fields').disabled"), 'empty settings ready');
    await field('provider-name', 'My image service <test>');
    await field('provider-url', 'http://127.0.0.1:' + upstream.address().port + '/v1');
    await field('provider-protocol', 'openai-chat-images'); await field('provider-key', 'browser-fixture-secret-not-real');
    await click('#provider-save');
    await wait(() => evaluate("document.querySelector('#providers-feedback').textContent.startsWith('已保存')"), 'first atomic connection save');
    assert.equal(calls.length, 0); assert.equal(JSON.parse(fs.readFileSync(config)).providers[0].models.length, 0);
    await check('connection-only save clears the key field, keeps advanced sections collapsed, and marks the credential presence without echo', "document.querySelector('#provider-key').value===''&&document.querySelector('#provider-key-state').textContent==='已保存 · 不回显'&&!document.querySelector('#provider-advanced').open&&!document.querySelector('#provider-functions').open&&!document.body.textContent.includes('browser-fixture-secret-not-real')");
    await click('#provider-discover');
    await wait(() => evaluate("document.querySelectorAll('#provider-directory-list .directory-item').length===2"), 'real directory read');
    assert.deepEqual(calls.map(call => [call.method, call.path]), [['GET', '/v1/models']]);
    await field('provider-directory-search', 'browser-edit'); await click('#provider-directory-list button');
    await click('#provider-models [data-capability="image-gen"]');
    await check('explicit model use enables a previously disabled image pool and shows the pending policy', "document.querySelector('#provider-save-summary').textContent.includes('图片：自动')");
    await click('#provider-save');
    await wait(() => evaluate("document.querySelector('#providers-feedback').textContent.startsWith('已保存')&&!document.querySelector('#provider-save').disabled"), 'model and policy atomic save');
    const configured = JSON.parse(fs.readFileSync(config)); assert.equal(configured.providers[0].models.length, 1); assert.equal(configured.assignments['image-gen'].mode, 'auto');
    assert.equal(calls.length, 1); result.checks.push('directory reference, explicit model capability and automatic pool save never submit media');
    await click('#provider-functions>summary');
    await evaluate("(()=>{const s=document.querySelector('#provider-assignments [data-function=\"image-gen\"]');s.value='manual';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await click('#provider-assignments .function-policy:first-child input'); await click('#provider-save');
    await wait(() => evaluate("document.querySelector('#providers-feedback').textContent.startsWith('已保存')&&!document.querySelector('#provider-save').disabled"), 'explicit manual pool saved');
    const manual = JSON.parse(fs.readFileSync(config)).assignments['image-gen'];
    assert.equal(manual.mode, 'manual'); assert.deepEqual(manual.models, [configured.providers[0].id + '::browser-edit']);
    result.checks.push('global manual mode and explicit ordered model selection persist through the same single save');
    await capture('providers-desktop');
    await dimensions(390); await measure('providers-390'); await capture('providers-mobile');
    await dimensions(320); await measure('providers-320');
    await click('#appearance-open'); await measure('appearance-320'); await click('#appearance-close'); await dimensions(1366, 900);

    // Conflict is detected against the original revision. The page must keep the draft rather than overwrite CLI changes.
    const cli = await executeConfigCommand(config, 'settings.show');
    await executeConfigCommand(config, 'providers.set', { provider: { id: cli.providers[0].id, name: 'Changed by CLI' } });
    await field('provider-name', 'Browser draft retained'); await click('#provider-save');
    await wait(() => evaluate("document.querySelector('#providers-feedback').textContent.includes('草稿已保留')"), 'visible revision conflict');
    await check('revision conflict retains draft and blocks a blind second save', "document.querySelector('#provider-name').value==='Browser draft retained'&&document.querySelector('#provider-save').disabled");
    assert.equal(JSON.parse(fs.readFileSync(config)).providers[0].name, 'Changed by CLI');
    await click('#providers-refresh'); await click('#providers-reload-yes');
    await wait(() => evaluate("document.querySelector('#provider-name').value==='Changed by CLI'&&!document.querySelector('#provider-save').disabled"), 'explicit reload after conflict');

    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/provider-management/save', requestStage: 'Response' }] });
    await field('provider-name', 'Committed before disconnect'); await click('#provider-save');
    await wait(() => pausedResponses.length > 0, 'committed settings held response');
    assert.equal(JSON.parse(fs.readFileSync(config)).providers[0].name, 'Committed before disconnect');
    await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionClosed' }); await cdp('Fetch.disable');
    await wait(() => evaluate("document.querySelector('#providers-feedback').textContent.includes('草稿已保留')&&document.querySelector('#provider-save').disabled"), 'unknown save no retry');
    await click('#providers-refresh'); await click('#providers-reload-yes');
    await wait(() => evaluate("document.querySelector('#provider-name').value==='Committed before disconnect'&&!document.querySelector('#provider-save').disabled"), 'read committed result after response loss');
    result.checks.push('lost save response remains unknown with no automatic resubmit; explicit reload reads the one committed result');

    await click('#studio-tab'); await click('#new-run');
    await wait(() => evaluate("[...document.querySelector('#model').options].filter(option=>option.value).length===1&&!document.querySelector('#draft-fields').disabled"), 'saved model available to creation');
    await field('model', encodeURIComponent(configured.providers[0].id) + '::browser-edit');
    await chooseFile('#image-file', image); await field('edit-prompt', 'Keep the shape; change the color.');
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'new configured image ready');
    await click('#start-edit');
    await wait(() => evaluate("document.querySelector('#status-title').textContent==='图片已就绪'&&!document.querySelector('#viewer').getAttribute('aria-busy').includes('true')"), 'real configured image edit');
    assert.deepEqual(calls.map(call => [call.method, call.path]), [['GET', '/v1/models'], ['POST', '/v1/chat/completions']]);
    assert.equal(calls[1].body.model, 'browser-edit');
    await check('one explicit creation uses the saved model and keeps the comparison background neutral', "getComputedStyle(document.querySelector('.image-stage')).backgroundColor==='rgb(245, 245, 246)'&&document.querySelector('#output-dimensions').textContent==='48 × 32'");
    await click('#select-output');
    await wait(() => evaluate("document.querySelector('#status-title').textContent==='已选择结果'"), 'selected real result');
    const runId = await evaluate('location.hash.slice(1)');
    const download = await fetch(session.origin + '/api/v0/runs/' + runId + '/download', { headers: { Authorization: 'Bearer ' + session.accessToken } });
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), FLOW_RESULT);
    await capture('iris-studio-desktop');
    result.checks.push('the configured model runs through real upload/Run/Operation/Task/selection and returns the original result bytes');
    await click('#providers-tab'); await click('#provider-new');
    await field('provider-name', 'Local without authentication'); await field('provider-url', 'http://127.0.0.1:' + upstream.address().port + '/v1'); await field('provider-auth', 'none');
    await check('new local auth:none connection does not require a dummy key', "!document.querySelector('#provider-key').required&&document.querySelector('#provider-key-action').value==='keep'");
    await click('#provider-save');
    await wait(() => evaluate("document.querySelector('#providers-feedback').textContent.startsWith('已保存')&&!document.querySelector('#provider-save').disabled"), 'local connection saved without key');
    assert.equal(JSON.parse(fs.readFileSync(config)).providers.length, 2); assert.equal(calls.length, 2);
    assert(!JSON.stringify(await evaluate('({...localStorage})')).includes('browser-fixture-secret-not-real'));
    assert(report.requests.every(item => item.url.startsWith('blob:') || new URL(item.url).origin === session.origin));
    result.providerRequests = calls.map(({ method, path }) => ({ method, path })); result.status = 'passed'; save();
  } finally { await new Promise(resolve => upstream.close(resolve)); }
}
