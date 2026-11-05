import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { VIDEO_MODEL, VIDEO_MP4, videoFlowFixture } from './video-flow-fixture.mjs';

/** Real Chromium playback and download; only the remote provider is controlled. */
export async function verifyVideoBrowser({ out, tokenFile, cdp, evaluate, click, wait, chooseToken, report, save,
  dimensions, measure, capture, downloads, pausedResponses, restart }) {
  const result = report.video = { status: 'running', checks: [], realProvider: false, actualPaidCalls: 0 };
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const root = path.join(out, 'video-core'), config = path.join(out, 'video-providers.json');
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'video-fixture', enabled: true, apiKey: 'LOCAL_FIXTURE_NOT_A_REAL_KEY',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
    models: [{ id: 'text-video', capabilities: ['video-gen'] }] }], assignments: { 'video-gen': [VIDEO_MODEL] } }), { mode: 0o600 });
  const app = createApplicationRuntime({ dataRoot: root });
  const fixture = videoFlowFixture({ beforeSubmit: (input, { signal }) => {
    if (input.input.prompt !== 'STOP VIDEO') return;
    return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Object.assign(new Error('controlled local stop'), { name: 'AbortError' })), { once: true }); });
  } });
  let session, tokenSequence = 0;
  const field = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const status = title => wait(() => evaluate(`document.querySelector('#viewer').getAttribute('aria-busy')==='false'&&!document.querySelector('#run-view').hidden&&document.querySelector('#status-title').textContent===${JSON.stringify(title)}`), title);
  const readRun = async id => { const response = await fetch(session.origin + '/api/v0/runs/' + id, { headers: { Authorization: 'Bearer ' + session.accessToken } }); assert.equal(response.status, 200); return response.json(); };
  async function login() {
    const file = path.join(out, 'video-owner-' + ++tokenSequence); writeLocalApiTokenFile(file, session.accessToken, root);
    const time = await evaluate('performance.timeOrigin'); await cdp('Page.reload');
    await wait(() => evaluate(`performance.timeOrigin!==${time}&&Boolean(document.querySelector('#token-file'))`), 'new video document');
    if (!await evaluate(`sessionStorage.getItem('iris.workbench.session.v0')===${JSON.stringify(session.accessToken)}`)) {
      await wait(() => evaluate("!document.querySelector('#connection').hidden"), 'video login'); await chooseToken(file);
    }
    await wait(() => evaluate("document.body.classList.contains('connected')&&document.querySelector('#model-summary').textContent==='1 个候选'"), 'video catalog loaded');
  }
  try {
    await chooseToken(tokenFile); await wait(() => evaluate("document.body.classList.contains('connected')"), 'old root connected');
    await check('existing image root does not offer video creation', "document.querySelector('[data-creation-mode=video]').hidden&&document.querySelector('[data-gallery-kind=video]').hidden");
    await app.execute('flow.init', {}); await app.execute('execution.init', { video: true }); await app.dispose();
    const serviceModes = { allowProviderManagement: true, allowConnectionManagement: true, connectionStore: path.join(out, 'video-connections'), allowMcp: true };
    session = await restart(root, config, fixture, serviceModes); report.requestRootVersion = 4; await login();
    await click('#providers-tab');
    await wait(() => evaluate("!document.querySelector('[data-provider-section=health]').disabled"), 'provider configuration read');
    await click('[data-provider-section=health]');
    await wait(() => evaluate("document.querySelector('[data-health-capability=video-gen]')!==null"), 'video spectrum read');
    await click('[data-health-capability=video-gen]');
    await wait(() => evaluate("document.querySelector('#provider-health-models [data-probe-model]')!==null"), 'video health draft entry');
    await click('#provider-health-models [data-probe-model]');
    await check('video spectrum opens an actual model draft without executing', "document.querySelector('#model').value===" + JSON.stringify(VIDEO_MODEL) + "&&document.querySelector('[data-creation-mode=video]').getAttribute('aria-pressed')==='true'");
    assert.equal(fixture.calls.submit.length, 0);
    await check('video has a real model choice, prompt and optional parameters with no image or audio source', "document.querySelector('#source-input').hidden&&document.querySelector('#audio-source-input').hidden&&document.querySelector('#comfy-creation').hidden&&!document.querySelector('#advanced-settings').hidden&&!document.querySelector('#video-duration-field').hidden&&document.querySelector('#model').options.length===2");
    await field('#model', VIDEO_MODEL); await field('#edit-prompt', 'A purple iris swaying in the wind');
    await evaluate("document.querySelector('#advanced-settings').open=true"); await field('#edit-size', '320x180'); await field('#video-duration', '1.5');
    await click('#start-edit'); await status('原任务进行中');
    const id = await evaluate('location.hash.slice(1)'), original = await readRun(id);
    assert.equal(original.input.duration, 1.5); assert.equal(original.input.size, '320x180'); assert.equal(fixture.calls.submit.length, 1);
    result.checks.push('creation and first finite Operation retain explicit video parameters and one provider submit');
    session = await restart(root, config, fixture, serviceModes); await login(); await status('原任务进行中');
    assert.equal((await readRun(id)).task.id, original.task.id); assert.equal(fixture.calls.submit.length, 1);
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'explicit video observation ready');
    await click('#start-edit'); await status('视频已就绪');
    await wait(() => evaluate("document.querySelector('#output-video').readyState>=2&&document.querySelector('#output-video').videoWidth===320&&document.querySelector('#output-video').duration>0"), 'actual MP4 decoded by Chromium');
    result.media = await evaluate("(()=>{const v=document.querySelector('#output-video');return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,readyState:v.readyState}})()");
    await cdp('Runtime.evaluate', { expression: "document.querySelector('#output-video').play()", awaitPromise: true, userGesture: true });
    await check('browser accepts actual video playback', "!document.querySelector('#output-video').paused||document.querySelector('#output-video').ended");
    await check('ready video hides image comparisons and selection and enables original download', "!document.querySelector('#video-result').hidden&&document.querySelector('#image-pair').hidden&&document.querySelector('#view-modes').hidden&&document.querySelector('#reuse-selected').hidden&&!document.querySelector('#download').disabled&&document.querySelector('#download').textContent==='下载视频'&&document.querySelector('#start-edit').disabled");
    await click('#download'); let file;
    await wait(() => { file = fs.readdirSync(downloads).find(name => name.endsWith('.mp4')); return file; }, 'actual MP4 browser download');
    assert.deepEqual(fs.readFileSync(path.join(downloads, file)), VIDEO_MP4); result.download = file;
    assert.equal((await readRun(id)).task.id, original.task.id); assert.equal(fixture.calls.submit.length, 1); assert.equal(fixture.calls.poll.length, 1);
    result.checks.push('service restart observes the same Task, MP4 decodes in Chromium, browser download matches original bytes');
    for (const width of [1366, 390, 320]) { await dimensions(width, 960); await measure('video-result-' + width); await capture('video-result-' + width); }
    await dimensions(390, 960); await field('#appearance-theme', 'dark'); await capture('video-result-dark'); await field('#appearance-theme', 'light');
    await click('#media-tab'); await click('[data-gallery-kind=video]');
    await wait(() => evaluate("document.querySelectorAll('#gallery-grid .gallery-audio').length===1&&document.querySelector('#gallery-grid').getAttribute('aria-busy')==='false'"), 'video gallery');
    await check('video gallery does not fetch an image or autoplay', "document.querySelector('#gallery-filters').hidden&&!document.querySelector('#gallery-grid img')&&document.querySelector('#gallery-grid video').hidden&&document.querySelector('#output-video').paused");
    await click('[data-gallery-play="' + id + '"]'); await wait(() => evaluate("document.querySelector('#gallery-grid video').videoWidth===320"), 'gallery video decode');
    await click('[data-gallery-kind=image]'); await check('changing gallery category releases its video', "!document.querySelector('#gallery-grid video[src]')");
    await click('#connections-tab'); await wait(() => evaluate("!document.querySelector('#connection-new').disabled"), 'connection catalog read');
    await click('#connection-new'); await field('#connection-name', 'Video only');
    await click('#connection-media input[value=video]'); await click('#connection-image-options input[value=image-edit]');
    await click('#connection-scopes input[value=create]'); await click('#connection-scopes input[value=execute]');
    await check('user selects video and its real tools without image or audio grants', "document.querySelector('#connection-media input[value=video]').checked&&!document.querySelector('#connection-media input[value=image]').checked&&document.querySelector('#connection-tools input[value=iris_core_create_video]').checked&&document.querySelector('#connection-tools input[value=iris_core_video]').checked&&!document.querySelector('#connection-tools input[value=iris_core_audio]')");
    await click('#connection-save'); await wait(() => evaluate("document.querySelector('#connection-state').textContent==='尚未使用'"), 'video connection saved');
    assert.equal(fixture.calls.submit.length, 1); await click('#media-tab');
    await click('#gallery-new'); await click('[data-creation-mode=video]'); await field('#model', VIDEO_MODEL); await field('#edit-prompt', 'Lost video creation response');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/videos', requestStage: 'Response' }] });
    await click('#start-edit'); await wait(() => pausedResponses.length > 0, 'held video creation response');
    await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionClosed' }); await cdp('Fetch.disable');
    await status('已保存，尚未开始'); assert.equal(fixture.calls.submit.length, 1);
    const recovered = await readRun(await evaluate('location.hash.slice(1)')); assert.equal(recovered.task, null);
    result.checks.push('lost video creation response recovers one saved intent without provider submission');
    await click('#new-run'); await click('[data-creation-mode=video]'); await field('#model', VIDEO_MODEL); await field('#edit-prompt', 'STOP VIDEO');
    await click('#start-edit'); await wait(() => fixture.calls.submit.length === 2, 'controlled in-flight video');
    await wait(() => evaluate("document.querySelector('#stop-operation').getClientRects().length>0&&!document.querySelector('#stop-operation').disabled"), 'video local stop');
    await measure('video-local-stop-390'); await capture('video-local-stop-before');
    await click('#stop-operation'); await status('需要核对原任务');
    assert.equal((await readRun(await evaluate('location.hash.slice(1)'))).task.acceptance, 'unknown'); assert.equal(fixture.calls.cancel.length, 0);
    result.checks.push('in-flight local stop preserves unknown acceptance and does not cancel provider or resubmit');
    await click('#disconnect'); await check('logout pauses all media, releases URLs and clears video draft', "window.testBlobs.size===0&&[...document.querySelectorAll('audio,video')].every(n=>n.paused&&!n.hasAttribute('src'))&&!document.querySelector('#video-duration').value&&!document.querySelector('#edit-prompt').value");
    session = await restart(root, config, fixture, { ...serviceModes, allowExecution: false }); await login();
    await evaluate(`location.hash=${JSON.stringify('#' + id)}`); await status('视频已就绪');
    await wait(() => evaluate("document.querySelector('#output-video').videoWidth===320"), 'read-only video decode');
    await check('read-only service plays and downloads saved video but cannot generate', "!document.querySelector('#video-result').hidden&&!document.querySelector('#download').disabled&&document.querySelector('#start-edit').disabled&&document.querySelector('[data-creation-mode=video]').disabled");
    assert.equal(fixture.calls.submit.length, 2); assert.equal(fixture.calls.poll.length, 1);
    result.runId = id; result.taskId = original.task.id; result.status = 'passed'; save();
  } finally { await cdp('Fetch.disable'); await app.dispose(); save(); }
}
