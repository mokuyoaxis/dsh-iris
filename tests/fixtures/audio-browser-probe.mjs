import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { AUDIO_WAV, TRANSCRIPT, SPEECH_MODEL, TRANSCRIBE_MODEL, audioFlowFixture } from './audio-flow-fixture.mjs';

/** Real browser, HTTP, Core files and playable PCM. Only the remote provider is controlled. */
export async function verifyAudioBrowser({ out, tokenFile, cdp, evaluate, click, wait, chooseToken, report, save,
  dimensions, measure, capture, downloads, pausedResponses, restart }) {
  const result = report.audio = { status: 'running', checks: [], realProvider: false, actualPaidCalls: 0 };
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const root = path.join(out, 'audio-core'), config = path.join(out, 'audio-providers.json'), source = path.join(out, 'source.wav');
  fs.writeFileSync(source, AUDIO_WAV, { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'audio-fixture', enabled: true, apiKey: 'LOCAL_FIXTURE_NOT_A_REAL_KEY',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
    models: [{ id: 'speech', capabilities: ['tts'] }, { id: 'transcribe', capabilities: ['transcribe'] }] }],
    assignments: { tts: [SPEECH_MODEL], transcribe: [TRANSCRIBE_MODEL] } }), { mode: 0o600 });
  const app = createApplicationRuntime({ dataRoot: root }), fixture = audioFlowFixture();
  let session, tokenSequence = 0;
  const field = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const status = title => wait(() => evaluate(`!document.querySelector('#viewer').getAttribute('aria-busy').includes('true')&&!document.querySelector('#run-view').hidden&&document.querySelector('#status-title').textContent===${JSON.stringify(title)}`), title);
  const readRun = async id => { const response = await fetch(session.origin + '/api/v0/runs/' + id, { headers: { Authorization: 'Bearer ' + session.accessToken } }); assert.equal(response.status, 200); return response.json(); };
  const posts = () => report.requests.filter(request => request.method === 'POST' && request.url.startsWith(session.origin + '/api/v0/'));
  async function login() {
    const file = path.join(out, 'audio-owner-' + ++tokenSequence); writeLocalApiTokenFile(file, session.accessToken, root);
    const documentTime = await evaluate('performance.timeOrigin'); await cdp('Page.reload');
    await wait(() => evaluate(`performance.timeOrigin!==${documentTime}&&Boolean(document.querySelector('#token-file')&&document.documentElement.dataset.theme)`), 'new audio document');
    if (!await evaluate(`sessionStorage.getItem('iris.workbench.session.v0')===${JSON.stringify(session.accessToken)}`)) {
      await wait(() => evaluate("!document.querySelector('#connection').hidden"), 'audio login'); await chooseToken(file);
    }
    await wait(() => evaluate("document.body.classList.contains('connected')&&document.querySelector('#model-summary').textContent==='2 个候选'"), 'audio catalog loaded');
  }
  async function upload() {
    const document = await cdp('DOM.getDocument'), input = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#audio-file' });
    await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [source] });
  }
  async function downloaded(extension, expected) {
    await click('#download');
    let filename; await wait(() => { filename = fs.readdirSync(downloads).find(name => name.endsWith('.' + extension)); return filename; }, 'real ' + extension + ' download');
    assert.deepEqual(fs.readFileSync(path.join(downloads, filename)), expected); return filename;
  }
  try {
    await chooseToken(tokenFile);
    await wait(() => evaluate("document.body.classList.contains('connected')"), 'old-root login');
    await check('existing image root does not offer audio creation or gallery tabs', "[...document.querySelectorAll('[data-creation-mode=tts],[data-creation-mode=transcribe],#gallery-types')].every(n=>n.hidden)");
    await app.execute('flow.init', {}); await app.execute('execution.init', { audio: true }); await app.dispose();
    session = await restart(root, config, fixture, { allowConnectionManagement: true, connectionStore: path.join(out, 'audio-connections'), allowMcp: true }); report.requestRootVersion = 3;
    await dimensions(1366, 960); await login(); await click('#new-run'); await click('[data-creation-mode="tts"]');
    await check('speech has its own model choice and text, with image/ComfyUI inputs removed', "document.querySelector('#studio-title').textContent==='让文字，有声音。'&&document.querySelector('#source-input').hidden&&document.querySelector('#audio-source-input').hidden&&document.querySelector('#advanced-settings').hidden&&document.querySelector('#comfy-creation').hidden&&!document.querySelector('#speech-options').hidden&&document.querySelector('#model').options.length===2&&document.querySelector('#edit-prompt').maxLength===20000");
    await field('#model', SPEECH_MODEL); await field('#edit-prompt', '鸢尾花，让文字有声音。'); await evaluate("document.querySelector('#speech-options').open=true"); await field('#speech-voice', 'Cherry');
    await click('#start-edit'); await evaluate("document.querySelector('#start-edit').click()"); await status('语音已就绪');
    await wait(() => evaluate("document.querySelector('#output-audio').readyState>=1&&document.querySelector('#output-audio').duration>0"), 'WAV decoded by Chromium');
    const speechId = await evaluate('location.hash.slice(1)'), speech = await readRun(speechId);
    assert.equal(speech.input.voice, 'Cherry'); assert.equal(fixture.calls.submit.length, 1);
    await check('ready speech is playable and downloadable without image selection', "!document.querySelector('#audio-result').hidden&&document.querySelector('#image-pair').hidden&&document.querySelector('#overlay-view').hidden&&document.querySelector('#reuse-selected').hidden&&!document.querySelector('#download').disabled&&document.querySelector('#start-edit').disabled");
    await cdp('Runtime.evaluate', { expression: "document.querySelector('#output-audio').play()", awaitPromise: true, userGesture: true });
    await check('browser accepts actual playback', "!document.querySelector('#output-audio').paused||document.querySelector('#output-audio').ended");
    result.speechDownload = await downloaded('wav', AUDIO_WAV); await capture('audio-speech-result');
    const beforeReload = posts().length; await login(); await status('语音已就绪');
    assert.equal(posts().length, beforeReload); assert.equal((await readRun(speechId)).task.id, speech.task.id); assert.equal(fixture.calls.submit.length, 1);
    result.checks.push('refresh retains tab login, original speech Run/Task and zero provider replays');
    await click('#media-tab'); await click('[data-gallery-kind="speech"]');
    await wait(() => evaluate("document.querySelectorAll('#gallery-grid .gallery-audio').length===1&&!document.querySelector('#gallery-grid').getAttribute('aria-busy').includes('true')"), 'speech gallery');
    await check('speech gallery uses audio cards and no image selection filter', "document.querySelector('#gallery-filters').hidden&&document.querySelectorAll('#gallery-grid img').length===0&&document.querySelector('#gallery-grid audio').hidden");
    await click('[data-gallery-play="' + speechId + '"]'); await wait(() => evaluate("document.querySelector('#gallery-grid audio').duration>0"), 'gallery playable audio');
    await click('[data-gallery-kind="transcribe"]'); await check('changing category releases gallery playback', "document.querySelectorAll('#gallery-grid audio[src]').length===0");
    await click('#gallery-new'); await click('[data-creation-mode="transcribe"]'); await upload(); await field('#model', TRANSCRIBE_MODEL);
    await check('transcription accepts audio with no hidden prompt or size requirement', "document.querySelector('#edit-prompt').hidden&&!document.querySelector('#edit-prompt').required&&document.querySelector('#advanced-settings').hidden&&!document.querySelector('#audio-source-input').hidden&&!document.querySelector('#start-edit').disabled");
    await click('#start-edit'); await status('原任务进行中');
    const transcribeId = await evaluate('location.hash.slice(1)'), original = await readRun(transcribeId);
    assert.equal(fixture.calls.submit.length, 2); assert.equal(fixture.preparation.length, 1);
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'explicit transcription observation'); await click('#start-edit'); await status('转写已完成');
    await wait(() => evaluate("!document.querySelector('#transcript-result').hidden&&document.querySelector('#source-audio').duration>0"), 'original audio and transcript');
    assert.equal(await evaluate("document.querySelector('#transcript-result').textContent"), TRANSCRIPT.toString());
    assert.equal((await readRun(transcribeId)).task.id, original.task.id);
    await check('transcript is literal text and cannot create markup', "!document.querySelector('#transcript-result script')&&!document.querySelector('#audio-source-result').hidden&&document.querySelector('#audio-output-result').hidden&&document.querySelector('#download').textContent==='下载文字'");
    result.transcriptDownload = await downloaded('txt', TRANSCRIPT);
    for (const width of [1366, 390, 320]) { await dimensions(width, 960); await measure('audio-transcript-' + width); await capture('audio-transcript-' + width); }
    await dimensions(1366, 960); await field('#appearance-theme', 'dark'); await capture('audio-transcript-dark'); await field('#appearance-theme', 'light');
    const readsOnly = posts().length; await login(); await status('转写已完成');
    assert.equal(posts().length, readsOnly); assert.equal(fixture.calls.poll.length, 1); assert.equal(fixture.preparation.length, 1);
    result.checks.push('transcription requires one explicit observation, keeps its Task, decodes text safely and downloads original UTF-8 bytes');
    await click('#connections-tab'); await click('#connection-new'); await field('#connection-name', '音频工作区');
    await click('#connection-media input[value="tts"]'); await click('#connection-media input[value="transcribe"]');
    await click('#connection-image-options input[value="image-generate"]');
    await check('changing an image subfeature preserves both explicitly selected audio groups', "['tts','transcribe'].every(id=>document.querySelector('#connection-media input[value='+id+']').checked)&&document.querySelector('#connection-image-options input[value=image-generate]').checked");
    await click('#connection-image-options input[value="image-edit"]'); await click('#connection-image-options input[value="image-generate"]');
    await click('#connection-scopes input[value="create"]'); await click('#connection-scopes input[value="execute"]');
    await check('audio-only selection removes image tools without dropping speech or transcription', "!document.querySelector('#connection-media input[value=image]').checked&&document.querySelector('#connection-tools input[value=iris_core_create_speech]').checked&&document.querySelector('#connection-tools input[value=iris_core_create_transcription]').checked&&!document.querySelector('#connection-tools input[value=iris_core_image]')");
    await click('#connection-save'); await wait(() => evaluate("document.querySelector('#connection-state').textContent==='尚未使用'&&!document.querySelector('#connection-view-delivery').hidden"), 'audio connection saved');
    await check('connection overview labels actual audio groups', "document.querySelector('#connections-list .service-endpoint').textContent==='语音 · 转写'");
    await click('#connection-skill-details>summary'); await click('#connection-skill-generate');
    await wait(() => evaluate("!document.querySelector('#connection-skill-result').hidden"), 'audio Skill rendered');
    await check('downloadable connection Skill contains actual audio instructions only', "document.querySelector('#connection-skill-preview').value.includes('Voice and transcription · 语音合成与音频转写')&&!document.querySelector('#connection-skill-preview').value.includes('undefined')&&!document.querySelector('#connection-skill-preview').value.includes('iris_core_create_run')");
    await capture('audio-connection-skill'); await click('#studio-tab');
    await click('#new-run'); await click('[data-creation-mode="tts"]'); await field('#model', SPEECH_MODEL); await field('#edit-prompt', '丢失创建回包，不自动合成。');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/speeches', requestStage: 'Response' }] });
    await click('#start-edit'); await wait(() => pausedResponses.length > 0, 'held speech intent response');
    await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionClosed' }); await cdp('Fetch.disable');
    await status('已保存，尚未开始'); assert.equal(fixture.calls.submit.length, 2);
    const recoveredId = await evaluate('location.hash.slice(1)'); assert.equal((await readRun(recoveredId)).task, null);
    result.checks.push('a lost speech creation response recovers the single committed intent without submitting it');
    await click('#disconnect'); await check('logout pauses players, releases all media URLs and clears private draft fields', "window.testBlobs.size===0&&[...document.querySelectorAll('audio')].every(n=>n.paused&&!n.hasAttribute('src'))&&!document.querySelector('#speech-voice').value&&!document.querySelector('#edit-prompt').value");
    session = await restart(root, config, fixture, { allowExecution: false, allowSelection: false }); await login();
    await evaluate(`location.hash=${JSON.stringify('#' + transcribeId)}`); await status('转写已完成');
    await check('read-only service plays saved audio and text while execution stays disabled', "!document.querySelector('#audio-result').hidden&&document.querySelector('#start-edit').disabled&&document.querySelector('[data-creation-mode=tts]').disabled&&!document.querySelector('#download').disabled");
    assert.equal(fixture.calls.submit.length, 2); assert.equal(fixture.calls.poll.length, 1); assert.equal(fixture.preparation.length, 1);
    result.speechRunId = speechId; result.transcriptionRunId = transcribeId; result.originalTaskId = original.task.id;
    result.checks.push('desktop, 390/320px, light/dark and read-only audio states verified in Chromium');
    result.status = 'passed';
  } finally { await cdp('Fetch.disable'); await app.dispose(); save(); }
}
