import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readCoreArtifactBytes } from '../../lib/core-artifacts.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { ffmpegAvailable } from '../../lib/media-probe.js';
import { SUMMARY_MODEL, SUMMARY_TEXT, summaryWorkbenchFixture } from './summary-workbench-fixture.mjs';

export async function verifySummaryBrowser({ out, cdp, evaluate, click, wait, chooseToken, readyRun, report, save,
  dimensions, measure, capture, downloads, pausedResponses, restart }) {
  assert(ffmpegAvailable(), 'the focused Chromium scenario requires actual ffmpeg and ffprobe');
  const { dataRoot, config, ports, visionRequests, videoRunId } = await summaryWorkbenchFixture(out);
  const recoveryKey = 'iris.workbench.recovery.v0';
  const transcript = '已有字幕：风吹过花朵。', question = '总结视频中发生的动作。';
  let session = await restart(dataRoot, config, ports);
  report.requestRootVersion = 5;
  const read = async route => {
    const response = await fetch(session.origin + '/api/v0/' + route, { headers: { Authorization: 'Bearer ' + session.accessToken } });
    assert(response.ok, String(response.status));
    return response.json();
  };
  const field = (selector, value) => evaluate('(()=>{const n=document.querySelector(' + JSON.stringify(selector)
    + ');n.value=' + JSON.stringify(value) + ";n.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const waitFor = (label, expression) => wait(() => evaluate(expression), label);
  function mark(text) { report.checks.push(text); save(); }
  const postCount = suffix => report.requests.filter(request => request.method === 'POST' && new URL(request.url).pathname.endsWith(suffix)).length;
  async function login(label) {
    const token = path.join(out, 'summary-token-' + label);
    writeLocalApiTokenFile(token, session.accessToken, dataRoot);
    await cdp('Page.navigate', { url: session.origin + '/#' + videoRunId });
    const at = await evaluate('performance.timeOrigin');
    await cdp('Page.reload');
    await waitFor('summary login ' + label, 'performance.timeOrigin!==' + at + "&&Boolean(document.querySelector('#connection')?.hidden===false)");
    await chooseToken(token);
    await readyRun(videoRunId);
  }
  try {
    await login('write');
    await click('#video-frames > summary');
    await field('#frame-limit', '3'); await field('#frame-width', '96'); await field('#frame-format', 'png');
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = out;
      await click('#extract-frames');
      await waitFor('missing-host-tool message', "document.querySelector('#frame-status').textContent.includes('ffmpeg 和 ffprobe')");
      assert.equal(await evaluate("document.querySelector('#frame-results').childElementCount"), 0);
    } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
    mark('missing tools show an in-panel message with zero model calls');
    await click('#extract-frames');
    await waitFor('three decoded thumbnails', "document.querySelectorAll('#frame-results .frame-preview:not(:disabled)').length===3&&[...document.querySelectorAll('#frame-results img')].every(img=>img.naturalWidth===96)");
    assert.equal(await evaluate("document.querySelector('#frame-status').textContent"), '已选 3 / 3 帧');
    const ids = await evaluate("[...document.querySelectorAll('#frame-results a')].map(n=>n.download.slice(5,-4))");
    const captions = await evaluate("[...document.querySelectorAll('#frame-results .frame-preview span')].map(n=>n.textContent)");
    assert.match(captions[0], /第 1 帧 · 0 秒/);
    assert.match(captions[2], /第 3 帧 · [0-9.]+ 秒/);
    await click('#frame-results li:first-child .frame-preview');
    assert(await evaluate("document.querySelector('#image-dialog').open&&document.querySelector('#image-dialog-title').textContent.includes('第 1 帧')"));
    await click('#close-image-dialog');
    await click('#frame-results li:first-child a');
    const framePath = path.join(downloads, 'iris-' + ids[0] + '.png');
    await wait(() => fs.existsSync(framePath) && fs.readFileSync(framePath).equals(readCoreArtifactBytes(dataRoot, ids[0]).bytes), 'exact PNG download');
    await click('#frame-results li:nth-child(2) input[type=checkbox]');
    assert.equal(await evaluate("document.querySelector('#frame-status').textContent"), '已选 2 / 3 帧');
    for (const width of [1366, 320]) {
      await dimensions(width, 920);
      assert(await evaluate("(()=>{const list=document.querySelector('#frame-results');return list.scrollHeight===list.clientHeight})()"));
      await measure('video-frames-' + width); await capture('video-frames-' + width);
    }
    assert.equal(visionRequests.length, 0);
    mark('actual ffmpeg frames keep order and timestamps, preview and download exact bytes, with responsive selection');

    await click('#summarize-frames');
    await waitFor('summary draft', "document.querySelector('#summary-frame-count').textContent==='2 帧'&&document.querySelector('#start-edit').textContent==='保存摘要任务'");
    assert.equal(await evaluate('window.testBlobs.size'), 0);
    await field('#model', SUMMARY_MODEL); await field('#edit-prompt', question); await field('#summary-transcript', transcript);
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/summaries', requestStage: 'Response' }] });
    await click('#start-edit');
    await wait(() => pausedResponses.length > 0, 'held committed summary response');
    const persisted = 'sessionStorage.getItem(' + JSON.stringify(recoveryKey) + ')';
    const action = await evaluate('JSON.parse(' + persisted + ').actions[0]');
    assert.deepEqual(Object.keys(action).sort(), ['id', 'key', 'kind']);
    assert.equal(action.kind, 'summarize-create');
    const lookup = await read('creation-requests?' + new URLSearchParams({ kind: action.kind, key: action.key }));
    const runId = lookup.result.runId;
    assert.equal(visionRequests.length, 0);
    await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionClosed' });
    await cdp('Fetch.disable');
    await readyRun(runId);
    const saved = await read('runs/' + runId);
    assert.equal(saved.task, null);
    assert.deepEqual(saved.input, { modelRef: SUMMARY_MODEL, frameArtifactIds: [ids[0], ids[2]], question, transcript });
    assert(await evaluate("document.querySelector('#summary-frame-count').textContent==='2 帧'&&document.querySelector('#start-edit').textContent==='开始摘要'"));
    assert.equal(await evaluate(persisted), null);
    const beforeRefresh = postCount('/api/v0/summaries');
    const loadTime = await evaluate('performance.timeOrigin');
    await cdp('Page.reload');
    await waitFor('new summary document', 'performance.timeOrigin!==' + loadTime);
    await readyRun(runId);
    assert.equal(postCount('/api/v0/summaries'), beforeRefresh);
    assert.equal(visionRequests.length, 0);
    mark('lost creation response recovers the original UUID and selected frames without resubmission on reload');

    await click('#start-edit');
    await waitFor('saved plain-text summary', "document.querySelector('#status-title').textContent==='摘要结果已保存'&&document.querySelector('#vision-text-result').textContent===" + JSON.stringify(SUMMARY_TEXT));
    assert.equal(await evaluate("document.querySelector('#vision-text-result').children.length"), 0);
    assert.equal(visionRequests.length, 1);
    assert.match(visionRequests[0].url, /\/chat\/completions$/);
    assert(JSON.stringify(visionRequests[0].body).includes(transcript));
    assert.equal(report.requests.filter(request => request.method === 'POST' && new URL(request.url).pathname.startsWith('/api/v0/transcriptions')).length, 0);
    await click('#download');
    await wait(() => fs.readdirSync(downloads).some(file => file.endsWith('.txt') && fs.readFileSync(path.join(downloads, file), 'utf8') === SUMMARY_TEXT), 'exact UTF-8 summary download');
    await measure('summary-result-320'); await capture('summary-result-320');
    mark('explicit summary runs one controlled vision POST, no ASR and preserves literal text');

    session = await restart(dataRoot, config, ports, { allowExecution: false });
    await login('readonly');
    assert(await evaluate("document.querySelector('#video-frames').hidden&&!document.querySelector('#output-video').hidden"));
    mark('read-only mode can play the video and has no extraction controls');
  } finally { await cdp('Fetch.disable'); save(); }
}
