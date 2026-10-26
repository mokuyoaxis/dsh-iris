import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { readAllOperations } from '../../lib/operation-store.js';
import { FLOW_MODEL, FLOW_RESULT, imageFlowFixture } from './image-flow-fixture.mjs';

export async function verifyImageGenerationBrowser({ out, cdp, evaluate, click, wait, chooseToken, readyRun, tree,
  report, save, dimensions, measure, capture, pausedResponses, restart }) {
  const result = report.imageGeneration = { status: 'running', checks: [], actualPaidCalls: 0, realComfyGpu: false }, apps = [];
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const root = path.join(out, 'generation-core'), config = path.join(out, 'generation-providers.json'), tokenFile = path.join(out, 'generation-token');
  const fixture = imageFlowFixture(root), app = createApplicationRuntime({ dataRoot: root, ...fixture }); apps.push(app);
  let session, token = 0, comfyServer;
  const posts = () => report.requests.filter(request => request.method === 'POST');
  async function login(keepHash = false) {
    const file = tokenFile + '-' + ++token; writeLocalApiTokenFile(file, session.accessToken, root);
    if (keepHash) await cdp('Page.reload'); else await cdp('Page.navigate', { url: session.origin + '/' });
    await wait(() => evaluate("Boolean(document.documentElement.dataset.theme&&!document.querySelector('#connection').hidden)"), 'generation login');
    await chooseToken(file);
    await wait(() => evaluate("!document.querySelector('#workspace').hidden&&document.querySelector('#model-summary').textContent!=='读取中'"), 'generation workspace');
  }
  async function input(prompt = '画一朵淡紫色鸢尾花。', model = FLOW_MODEL) {
    await evaluate(`document.querySelector('#model').value=${JSON.stringify(model)};document.querySelector('#model').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#edit-prompt').value=${JSON.stringify(prompt)};document.querySelector('#edit-prompt').dispatchEvent(new Event('input',{bubbles:true}))`);
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'generation draft ready');
  }
  async function status(text) { await wait(() => evaluate(`document.querySelector('#status-title').textContent===${JSON.stringify(text)}&&document.querySelector('#viewer').getAttribute('aria-busy')==='false'`), 'generation status ' + text); }
  try {
    await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true });
    fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'flow-fixture', name: 'Controlled fixture', auth: 'none', baseUrl: 'http://127.0.0.1:1',
      mediaProtocol: 'openai-chat-images', models: [{ id: 'edit', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': { mode: 'auto', models: [] } } }), { mode: 0o600 });
    session = await restart(root, config, fixture, { allowConnectionManagement: true, connectionStore: path.join(out, 'generation-connections') });
    await dimensions(1366, 900); await login();
    await evaluate("document.querySelector('#appearance-theme').value='light';document.querySelector('#appearance-theme').dispatchEvent(new Event('input',{bubbles:true}))");
    await check('new v2 workspace defaults to generation without an upload', "document.querySelector('[data-creation-mode=generate]').getAttribute('aria-pressed')==='true'&&document.querySelector('#source-input').hidden&&document.querySelector('#start-edit').textContent==='开始生成'");
    await input(); await measure('generation-desktop-draft'); await capture('generation-desktop-draft');
    const before = posts().length; await click('#start-edit'); await evaluate("document.querySelector('#start-edit').click()");
    await status('图片已就绪');
    assert.equal(posts().length - before, 2); assert.equal(fixture.calls.submit.length, 1);
    const runId = await evaluate('location.hash.slice(1)');
    await check('generation shows only the result, and comparison controls are hidden', "document.querySelector('#source-card').hidden&&document.querySelector('#view-modes').hidden&&!document.querySelector('#output-image').hidden&&document.querySelector('#select-source').disabled&&!document.querySelector('#select-output').disabled");
    await click('#select-output'); await status('已选择结果'); await click('#download');
    const selected = (await app.execute('flow.inspect', { run_id: runId })).run.selection.artifactId;
    const output = path.join(out, 'downloads', 'iris-' + selected + '.png'); await wait(() => fs.existsSync(output), 'generation download');
    assert.deepEqual(fs.readFileSync(output), FLOW_RESULT); result.checks.push('generation download preserves the selected original bytes');
    const saved = tree(root), beforeReload = posts().length; await login(true); await readyRun(runId);
    assert.deepEqual(tree(root), saved); assert.equal(posts().length, beforeReload); assert.equal(fixture.calls.submit.length, 1);
    result.checks.push('refresh reconnects the selected generation without writes or another submit');
    await dimensions(390); await measure('generation-mobile'); await capture('generation-mobile');
    await dimensions(390);
    result.themeBeforeClick = await evaluate("document.documentElement.dataset.theme"); save();
    await evaluate("window.irisThemeEvents=[];for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,e=>irisThemeEvents.push({type:e.type,target:e.target.id,parent:e.target.parentElement?.id,theme:document.documentElement.dataset.theme,detail:e.detail,x:e.clientX,y:e.clientY,scroll:scrollY,rect:document.querySelector('#theme').getBoundingClientRect().toJSON(),time:performance.now()}),true)");
    await click('#theme');
    try { await wait(() => evaluate(`document.documentElement.dataset.theme!==${JSON.stringify(result.themeBeforeClick)}`), 'native theme click applied'); }
    catch (error) {
      result.themeEvents = await evaluate('irisThemeEvents');
      result.themeClickState = await evaluate("({theme:document.documentElement.dataset.theme,active:document.activeElement?.id,scale:visualViewport.scale,offset:visualViewport.offsetTop,scroll:scrollY,rect:document.querySelector('#theme').getBoundingClientRect().toJSON()})");
      result.themeListeners = (await cdp('Runtime.evaluate', { expression: "getEventListeners(document.querySelector('#theme')).click?.length", includeCommandLineAPI: true, returnByValue: true })).result.value;
      result.programmaticTheme = await evaluate("document.querySelector('#theme').click();document.documentElement.dataset.theme"); save(); throw error;
    }
    result.themeEvents = await evaluate('irisThemeEvents'); save();
    await check('theme button toggles the current appearance', `document.documentElement.dataset.theme!==${JSON.stringify(result.themeBeforeClick)}`);
    if (await evaluate("document.documentElement.dataset.theme!=='dark'")) await click('#theme');
    result.darkTheme = await evaluate("({theme:document.documentElement.dataset.theme,panel:getComputedStyle(document.querySelector('#viewer')).backgroundColor,variable:getComputedStyle(document.documentElement).getPropertyValue('--panel'),label:document.querySelector('#theme').textContent})"); save();
    await check('generation dark theme applies actual dark panel colors', "document.documentElement.dataset.theme==='dark'&&getComputedStyle(document.querySelector('#viewer')).backgroundColor==='rgb(38, 34, 46)'");
    await capture('generation-mobile-dark'); await click('#theme'); await dimensions(320); await measure('generation-320'); await dimensions(1366, 900);
    await click('#reuse-selected');
    await wait(() => evaluate("!document.querySelector('#draft-preview').hidden"), 'generated artwork as an edit source');
    await check('generated selection can start a new editable draft without executing', "document.querySelector('[data-creation-mode=edit]').getAttribute('aria-pressed')==='true'&&!document.querySelector('#source-input').hidden&&document.querySelector('#edit-prompt').value===''");
    assert.equal(fixture.calls.submit.length, 1);
    await click('#new-run'); await input('创建回包丢失时，只接回原流程。');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/generations', requestStage: 'Response' }] });
    await click('#start-edit'); await wait(() => pausedResponses.length > 0, 'held generation creation response');
    await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionClosed' }); await cdp('Fetch.disable');
    await status('已保存，尚未开始');
    assert.equal(fixture.calls.submit.length, 1); assert.equal(readAllOperations(root).length, 1); assert.equal((await app.execute('flow.list', {})).total, 2);
    result.checks.push('lost creation response recovers one generation Run and never auto-continues');
    await click('#media-tab'); await wait(() => evaluate("document.querySelectorAll('.gallery-card').length===2"), 'generation gallery');
    await check('unstarted generation has an honest empty cover', "document.querySelector('#gallery-grid').textContent.includes('尚未生成')");
    await capture('generation-gallery');
    await click('#connections-tab'); await wait(() => evaluate("!document.querySelector('#connection-fields').disabled"), 'generation connection catalog');
    const connectionWrites = posts().length;
    await click('#connection-image-options input[value=image-generate]');
    await check('connection center selects generation independently from editing', "document.querySelector('#connection-image-options input[value=image-generate]').checked&&document.querySelector('#connection-tools input[value=iris_core_create_generation]').checked");
    assert.equal(posts().length, connectionWrites); assert.equal(fixture.calls.submit.length, 1);

    // Switch only this owned service to a real HTTP adapter backed by a controlled ComfyUI API.
    let phase = 'queued', submissions = 0;
    const remoteCalls = [];
    comfyServer = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const url = new URL(request.url, 'http://fixture'); remoteCalls.push({ method: request.method, path: request.url });
      const send = value => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/system_stats') return send({ system: {} });
      if (url.pathname === '/prompt') { submissions++; result.comfySubmittedGraph = JSON.parse(Buffer.concat(chunks)).prompt; return send({ prompt_id: 'browser-comfy-task', number: 0, node_errors: {} }); }
      if (url.pathname === '/queue') return send({ queue_running: [], queue_pending: [[0, 'browser-comfy-task']] });
      if (url.pathname === '/history/browser-comfy-task') return send(phase === 'queued' ? {} : { 'browser-comfy-task': { status: { completed: true, status_str: 'success' }, outputs: { '9': { images: [{ filename: 'iris.png', subfolder: '', type: 'output' }] } } } });
      if (url.pathname === '/view') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(FLOW_RESULT); return; }
      response.writeHead(404); response.end();
    });
    await new Promise(resolve => comfyServer.listen(0, '127.0.0.1', resolve));
    const comfyUrl = 'http://127.0.0.1:' + comfyServer.address().port;
    session = await restart(root, config, undefined); await login();
    await click('#providers-tab'); await wait(() => evaluate("!document.querySelector('#provider-fields').disabled"), 'ComfyUI provider form');
    await click('#provider-new');
    await evaluate("document.querySelector('#provider-preset').value='comfyui';document.querySelector('#provider-preset').dispatchEvent(new Event('change',{bubbles:true}))");
    await check('ComfyUI preset selects the native protocol, no auth, and a local service entry', "document.querySelector('#provider-auth').value==='none'&&document.querySelector('#provider-protocol').value==='comfyui'&&!document.querySelector('#comfyui-tools').hidden&&document.querySelector('#comfyui-open').href==='http://127.0.0.1:8188/'");
    await evaluate(`document.querySelector('#provider-url').value=${JSON.stringify(comfyUrl)};document.querySelector('#provider-url').dispatchEvent(new Event('input',{bubbles:true}))`);
    const graph = { '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'Prompt template' } }, '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Iris' } } };
    const workflowFile = path.join(out, 'my-workflow.json'); fs.writeFileSync(workflowFile, JSON.stringify(graph), { mode: 0o600 });
    const doc = await cdp('DOM.getDocument'), file = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#comfyui-file' });
    await cdp('DOM.setFileInputFiles', { nodeId: file.nodeId, files: [workflowFile] });
    await wait(() => evaluate("!document.querySelector('#comfyui-bindings').hidden"), 'API workflow import');
    await evaluate("document.querySelector('#comfyui-prompt-node').value='6';document.querySelector('#comfyui-prompt-node').dispatchEvent(new Event('change',{bubbles:true}))");
    await click('#comfyui-add');
    await check('workflow import creates a model draft without calling ComfyUI', "document.querySelector('#provider-models').textContent.includes('my-workflow')&&document.querySelector('#provider-models').textContent.includes('工作流尚未保存')");
    assert.equal(remoteCalls.length, 0);
    await click('#provider-save'); await wait(() => evaluate("document.querySelector('#providers-feedback').textContent.includes('已保存')&&!document.querySelector('#provider-fields').disabled"), 'saved ComfyUI workflow');
    await check('saved workflow details are collapsed and no private graph is read back', "!document.querySelector('#comfyui-tools').open&&document.querySelector('#provider-models').textContent.includes('已保存工作流')");
    assert.equal(submissions, 0); await measure('comfyui-provider'); await capture('comfyui-provider');
    await click('#studio-tab'); await click('#new-run');
    const stored = JSON.parse(fs.readFileSync(config)), provider = stored.providers.find(provider => provider.mediaProtocol === 'comfyui');
    await input('用导入的工作流画一朵鸢尾花。', encodeURIComponent(provider.id) + '::my-workflow');
    await click('#start-edit'); await status('原任务进行中'); assert.equal(submissions, 1);
    phase = 'done'; await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'manual ComfyUI observation');
    await click('#start-edit'); await status('图片已就绪');
    assert.equal(result.comfySubmittedGraph['6'].inputs.text, '用导入的工作流画一朵鸢尾花。'); assert.equal(submissions, 1);
    assert(remoteCalls.some(call => call.path.startsWith('/view?'))); assert(!remoteCalls.some(call => /interrupt|upload/.test(call.path)));
    result.remoteCalls = remoteCalls; result.checks.push('native ComfyUI adapter sends one mapped workflow and explicitly observes/downloads the original task');
    await capture('comfyui-result'); result.status = 'passed'; save();
  } finally { await Promise.allSettled(apps.map(app => app.dispose())); if (comfyServer) { comfyServer.closeAllConnections(); await new Promise(resolve => comfyServer.close(resolve)); } }
}
