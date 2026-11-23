import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { createCoreArtifact } from '../../lib/core-artifact-store.js';
import { readCoreArtifactBytes } from '../../lib/core-artifacts.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './image-flow-fixture.mjs';

export async function verifyLocalToolsBrowser({ out, executable, noSandbox, cdp, evaluate, click, wait, chooseToken, readyRun,
  report, save, dimensions, measure, capture, downloads, pausedResponses, restart }) {
  const root = path.join(out, 'local-tools-core');
  const fixture = imageFlowFixture(root);
  const app = createApplicationRuntime({ dataRoot: root, ...fixture });

  let sourceA, exif6Art, editRun1, editRun2;
  try {
    await app.execute('flow.init', {});
    await app.execute('execution.init', { vision: true });

    // Keep the original outside the first page, then add a contrasting EXIF-6 JPEG.
    const imported = { kind: 'import', mediaType: 'image/png', bytes: FLOW_SOURCE, metadata: { width: 48, height: 32 } };
    sourceA = await app.run('writer', runtime => runtime.run('execute', ({ dataRoot }) => {
      const original = createCoreArtifact(dataRoot, { ...imported, createdAt: '2000-01-01T00:00:00.000Z' });
      for (let i = 0; i < 50; i++) createCoreArtifact(dataRoot, { ...imported, createdAt: '2020-01-01T00:00:00.000Z' });
      return original;
    }));
    const redBlock = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#e63946' } }).png().toBuffer();
    const rawExifPng = await sharp({ create: { width: 120, height: 60, channels: 3, background: '#1d3557' } })
      .composite([{ input: redBlock, left: 70, top: 10 }])
      .png().toBuffer();
    const exif6Bytes = await sharp(rawExifPng).withMetadata({ orientation: 6 }).jpeg({ quality: 98 }).toBuffer();
    exif6Art = (await app.execute('artifact.import', { image_bytes: exif6Bytes })).artifact;

    // Seed Run 1 (image-edit on sourceA) -> output, then Run 2 consuming Run 1's output so lineage has upstream + downstream!
    const draft1 = await app.execute('flow.create', { source_artifact_id: sourceA.id, model_ref: FLOW_MODEL, prompt: 'local-tools seed run 1' });
    editRun1 = (await app.execute('flow.continue', { run_id: draft1.run.id })).run;
    const draft2 = await app.execute('flow.create', { source_artifact_id: editRun1.output.artifactId, model_ref: FLOW_MODEL, prompt: 'local-tools seed run 2' });
    editRun2 = draft2.run;
  } finally {
    await app.dispose();
  }

  const evalFn = (fn, ...args) => evaluate('(' + fn.toString() + ')(' + args.map(arg => JSON.stringify(arg)).join(',') + ')');
  const fields = values => evalFn(values => {
    for (const [selector, value] of Object.entries(values)) {
      const el = document.querySelector(selector);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, values);
  const waitFor = (label, expression, timeoutMs) => wait(() => evaluate(expression), label, timeoutMs);
  const mark = text => { report.checks.push(text); save(); };
  const postCount = route => report.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === route).length;
  const responsePattern = (session, route) => ({ urlPattern: session.origin + route, requestStage: 'Response' });
  const artifactContent = id => '/api/v0/artifacts/' + id + '/content';
  const svgRect = selector => evalFn(selector => {
    const rect = document.querySelector(selector);
    return ['x', 'y', 'width', 'height'].map(attr => Number(rect.getAttribute(attr)));
  }, selector);

  async function login(session, label, hash = '') {
    const token = path.join(out, 'local-tools-token-' + label);
    writeLocalApiTokenFile(token, session.accessToken, root);
    await cdp('Page.navigate', { url: session.origin + '/' + hash });
    const at = await evaluate('performance.timeOrigin');
    await cdp('Page.reload');
    await waitFor('login mount ' + label, 'performance.timeOrigin!==' + at + "&&document.querySelector('#connection')?.hidden===false");
    await chooseToken(token);
    await waitFor('connected ' + label, "document.body.classList.contains('connected')");
  }

  // --- Phase 1: Local writes enabled, NO browserExecutable (HTML render must stay gated) ---
  let session = await restart(root, { allowLocalWrites: true });
  report.requestRootVersion = 5;
  await login(session, 'rw-no-browser', '#' + editRun1.id);
  await readyRun(editRun1.id);

  // Verify B3 Run Lineage starts collapsed with ZERO lineage GET requests before expanding!
  const lineageRequestsBefore = report.requests.filter(r => new URL(r.url).pathname.endsWith('/lineage')).length;
  assert.equal(lineageRequestsBefore, 0, 'lineage must not fetch before user expands #run-lineage');
  assert.equal(await evaluate("!document.querySelector('#run-lineage').hidden&&!document.querySelector('#run-lineage').open"), true);

  // Open Local Tools via sidebar tab.
  await click('#tools-tab');
  await waitFor('first local tools page loaded', "document.querySelector('#tool-crop-select').options.length===51&&!document.querySelector('#tools-more').hidden");
  assert.equal(await evalFn(id => Boolean(document.querySelector(`#tool-crop-select option[value="${id}"]`)), sourceA.id), false);

  // --- Tool 1: Arbitrary EXIF-6 Crop ---
  await fields({ '#tool-crop-select': exif6Art.id });
  await waitFor('EXIF-6 crop image decoded', "!document.querySelector('#tool-crop-stage-frame').hidden&&document.querySelector('#tool-crop-image').naturalWidth===60&&document.querySelector('#tool-crop-image').naturalHeight===120");
  assert.equal(await evaluate("document.querySelector('#tool-crop-overlay').getAttribute('viewBox')"), '0 0 60 120');
  assert.equal(await evaluate("document.querySelector('#tool-crop-dimensions').textContent.includes('EXIF 方向 6')"), true);

  // Adjust crop rect to raw (left=70, top=10, width=30, height=20).
  // For EXIF 6 on raw 120x60: displayRect = (bottomMargin=60-10-20=30, left=70, width=height=20, height=width=30)!
  await fields({ '#tool-crop-left': '70', '#tool-crop-top': '10', '#tool-crop-width': '30', '#tool-crop-height': '20' });
  assert.deepEqual(await svgRect('#tool-crop-overlay .locate-crop-preview-stroke'), [30, 70, 20, 30]);

  // Zoom into lightbox and verify #expanded-overlay carries the exact same EXIF-6 rect!
  await click('#tool-crop-stage-preview');
  await waitFor('lightbox overlay rendered', "document.querySelector('#image-dialog').open&&Boolean(document.querySelector('#expanded-overlay .locate-crop-preview-stroke'))");
  assert.deepEqual(await svgRect('#expanded-overlay .locate-crop-preview-stroke'), [30, 70, 20, 30]);
  await click('#close-image-dialog');

  // Corrupt only the preview response after a successful crop, then recover the same saved artifact.
  const cropPosts = postCount('/api/v0/local-media/crop');
  await cdp('Fetch.enable', { patterns: [responsePattern(session, artifactContent('*'))] });
  await click('#tool-crop-submit');
  await wait(() => pausedResponses.length > 0, 'held crop preview response');
  await cdp('Fetch.fulfillRequest', { requestId: pausedResponses.shift(), responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: Buffer.from('unavailable preview').toString('base64') });
  await cdp('Fetch.disable');
  await waitFor('saved crop can retry an undecodable preview', "!document.querySelector('#tool-crop-reload').hidden&&!document.querySelector('#tool-crop-reload').disabled&&document.querySelector('#tool-crop-download').disabled&&document.querySelector('#tool-crop-feedback').classList.contains('error')");
  const cropMetaText = await evaluate("document.querySelector('#tool-crop-result-meta').textContent");
  const cropId = /(artifact_[a-f0-9]{24})/.exec(cropMetaText)?.[1];
  assert(cropId, 'crop result should display saved artifactId');
  await click('#tool-crop-reload');
  await waitFor('local crop result decoded', "!document.querySelector('#tool-crop-result-image').hidden&&document.querySelector('#tool-crop-result-image').naturalWidth===30&&document.querySelector('#tool-crop-result-image').naturalHeight===20");
  assert.equal(postCount('/api/v0/local-media/crop'), cropPosts + 1);
  assert.equal(await evaluate("document.querySelector('#tool-crop-result-meta').textContent"), cropMetaText);
  const crop = readCoreArtifactBytes(root, cropId);
  assert.equal(crop.artifact.kind, 'crop');
  const { data: pixels, info } = await sharp(crop.bytes).raw().toBuffer({ resolveWithObject: true });
  const center = (10 * info.width + 15) * info.channels;
  assert(pixels[center] > 180 && pixels[center + 1] < 100 && pixels[center + 2] < 140, 'raw selection must contain the red block');

  await click('#tool-crop-download');
  const cropDownloadPath = path.join(downloads, 'iris-' + cropId + '.png');
  await wait(() => fs.existsSync(cropDownloadPath) && fs.readFileSync(cropDownloadPath).equals(readCoreArtifactBytes(root, cropId).bytes), 'exact crop PNG download');

  // Inspect inline lineage for the newly cropped artifact -> parent is exif6Art!
  await click('#tool-crop-lineage');
  await waitFor('crop inline lineage loaded', `!document.querySelector('#tool-lineage-panel').hidden&&document.querySelector('#tool-lineage-body').textContent.includes(${JSON.stringify(exif6Art.id)})`);
  await capture('local-tools-crop-desktop');
  mark('EXIF-6 crop aligns canvas and lightbox, saves the selected pixels and retries a failed preview without another write');

  const previousObjectUrl = await evaluate("document.querySelector('#tool-crop-image').src");
  await click('#studio-tab');
  await click('#run-lineage > summary');
  const sourceCropButton = `#run-lineage-body [data-lineage-crop="${sourceA.id}"]`;
  await waitFor('original is shown in Run lineage', `Boolean(document.querySelector(${JSON.stringify(sourceCropButton)}))`);
  await click(sourceCropButton);
  await waitFor('direct handoff to an image outside the first page', `document.body.dataset.page==='tools'&&document.querySelector('#tool-crop-select').value===${JSON.stringify(sourceA.id)}&&!document.querySelector('#tool-crop-stage-frame').hidden&&document.querySelector('#tool-crop-image').naturalWidth===48`);
  assert.equal(await evalFn(url => window.testBlobs.has(url), previousObjectUrl), false);
  await click('#tools-refresh');
  await waitFor('refresh finished', "!document.querySelector('#tools-refresh').disabled");
  assert.equal(await evaluate("document.querySelector('#tool-crop-select').value"), sourceA.id);
  await click('#tools-more');
  await waitFor('older images are available in the diff picker', `Boolean(document.querySelector('#tool-diff-a option[value="${sourceA.id}"]'))&&document.querySelector('#tools-more').hidden`);
  mark('directory pagination and a direct lineage handoff load older images and keep the selected source through refresh');

  // --- Tool 2: Two-Image Pixel Diff Heatmap ---
  await click('[data-local-tool-tab="diff"]');
  await fields({ '#tool-diff-a': sourceA.id, '#tool-diff-b': editRun1.output.artifactId, '#tool-diff-grid': '4', '#tool-diff-regions-limit': '2' });
  await waitFor('diff thumbs decoded', "!document.querySelector('#tool-diff-preview-a').hidden&&!document.querySelector('#tool-diff-preview-b').hidden");
  await cdp('Fetch.enable', { patterns: [responsePattern(session, artifactContent(exif6Art.id))] });
  await fields({ '#tool-diff-a': exif6Art.id });
  await wait(() => pausedResponses.length > 0, 'held replacement diff source');
  assert.equal(await evaluate("document.querySelector('#tool-diff-preview-a').hidden&&document.querySelector('#tool-diff-submit').disabled"), true);
  await cdp('Fetch.continueRequest', { requestId: pausedResponses.shift() });
  await cdp('Fetch.disable');
  await waitFor('replacement diff source decoded', "!document.querySelector('#tool-diff-submit').disabled");
  await fields({ '#tool-diff-a': sourceA.id });
  await waitFor('original diff source decoded', "!document.querySelector('#tool-diff-submit').disabled");
  await click('#tool-diff-submit');
  await waitFor('diff heatmap decoded', "!document.querySelector('#tool-diff-result').hidden&&document.querySelector('#tool-diff-heatmap').naturalWidth===48&&document.querySelectorAll('#tool-diff-regions li').length===2");
  const diffSummary = await evaluate("document.querySelector('#tool-diff-summary').textContent");
  const diffId = /(artifact_[a-f0-9]{24})/.exec(diffSummary)?.[1];
  assert(diffId, 'diff summary should include heatmap artifactId');
  assert.equal(readCoreArtifactBytes(root, diffId).artifact.kind, 'pixel-diff');
  assert.equal(await evaluate("document.querySelector('#tool-diff-sources').textContent"), `来源图片 ${sourceA.id} · ${editRun1.output.artifactId}`);
  assert.equal(await evaluate("document.querySelector('#tool-diff-result').textContent.includes('不代表质量评分')"), true);
  await click('#tool-diff-download');
  const diffDownloadPath = path.join(downloads, 'iris-' + diffId + '.png');
  await wait(() => fs.existsSync(diffDownloadPath) && fs.readFileSync(diffDownloadPath).equals(readCoreArtifactBytes(root, diffId).bytes), 'exact heatmap PNG download');
  await capture('local-tools-diff-desktop');
  mark('two-image pixel diff generates heatmap PNG, worst regions and exact download with zero provider calls');

  // --- Tool 3 (Disabled Gate): HTML/SVG Render without --browser-executable ---
  const htmlPostsBefore = report.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === '/api/v0/html-render').length;
  await click('[data-local-tool-tab="html"]');
  assert.equal(await evaluate("!document.querySelector('#tool-html-unavailable').hidden&&document.querySelector('#tool-html-unavailable').textContent.includes('--browser-executable')&&document.querySelector('#tool-html-form').hidden"), true);
  assert.equal(report.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === '/api/v0/html-render').length, htmlPostsBefore);
  mark('HTML render tab stays strictly gated with opt-in guidance when --browser-executable is absent');

  // --- B3: Read-Only Run & Multi-Hop Artifact Lineage ---
  await click('#studio-tab');
  await waitFor('studio panel visible', "!document.querySelector('#workspace').hidden&&!document.querySelector('#run-view').hidden");
  await readyRun(editRun1.id);
  await click('#run-lineage-refresh');
  await waitFor('Run 1 lineage rendered', `document.querySelector('#run-lineage').open&&document.querySelector('#run-lineage-body').textContent.includes(${JSON.stringify(editRun2.id)})&&document.querySelector('#run-lineage-body').textContent.includes(${JSON.stringify(diffId)})`);

  // Drill into the diff heatmap artifact lineage from Run 1 -> verify both parent artifacts appear -> click back!
  const backButton = '#run-lineage-body [data-lineage-back="true"]';
  const downstreamButton = `#run-lineage-body [data-lineage-run="${editRun2.id}"]`;
  await click(`#run-lineage-body [data-lineage-artifact="${diffId}"]`);
  await waitFor('artifact drill-down rendered', `Boolean(document.querySelector(${JSON.stringify(backButton)}))&&document.querySelector('#run-lineage-body .lineage-artifact-header strong')?.textContent.endsWith(${JSON.stringify(diffId)})`);
  const parents = await evalFn(() => [...document.querySelectorAll('#run-lineage-body .lineage-group:first-of-type [data-lineage-artifact]')]
    .map(button => button.dataset.lineageArtifact));
  assert.deepEqual(new Set(parents), new Set([sourceA.id, editRun1.output.artifactId]));
  await click(backButton);
  await waitFor('back to Run 1 lineage', `!document.querySelector(${JSON.stringify(backButton)})&&Boolean(document.querySelector(${JSON.stringify(downstreamButton)}))`);

  // Jump directly to downstream Run 2 via lineage button and expand Run 2's lineage to verify upstream Run 1!
  await cdp('Fetch.enable', { patterns: [responsePattern(session, artifactContent(sourceA.id))] });
  await click(`#run-lineage-body [data-lineage-preview="${sourceA.id}"]`);
  await wait(() => pausedResponses.length > 0, 'held original Run lineage preview');
  const previewRequest = pausedResponses.shift();
  await click(downstreamButton);
  try { await cdp('Fetch.continueRequest', { requestId: previewRequest }); }
  catch (error) { assert.match(error.message, /Invalid [Ii]nterception[Ii]d/); }
  await cdp('Fetch.disable');
  await readyRun(editRun2.id);
  assert.equal(await evaluate("document.querySelector('#image-dialog').open"), false, 'a previous Run preview must stay closed after navigation');
  assert.equal(await evaluate("!document.querySelector('#run-lineage').open"), true, 'switching Runs collapses #run-lineage');
  await click('#run-lineage > summary');
  await waitFor('Run 2 upstream lineage rendered', `document.querySelector('#run-lineage-body').textContent.includes(${JSON.stringify(editRun1.id)})`);
  await capture('run-lineage-desktop');
  mark('Run lineage loads on expand, drills into artifact parents, and cancels the previous preview when switching Runs');

  await click('#disconnect');
  await waitFor('local tools and lineage cleared at logout', "!document.body.classList.contains('connected')&&window.testBlobs.size===0");
  assert.equal(await evalFn(() => ['#tool-crop-result-meta', '#tool-diff-summary', '#tool-diff-sources', '#tool-lineage-body', '#run-lineage-body']
    .every(selector => !document.querySelector(selector).textContent) && !document.querySelector('#tool-crop-width').value), true);
  mark('logout clears local tool receipts, selections and lineage along with all object URLs');

  // --- Phase 2: Restart WITH real Chromium --browser-executable -> verify real sandbox HTML render! ---
  session = await restart(root, { allowLocalWrites: true, browserExecutable: executable, browserNoSandbox: noSandbox });
  await login(session, 'rw-html-render');
  await click('#tools-tab');
  await click('[data-local-tool-tab="html"]');
  await waitFor('HTML render form enabled', "document.querySelector('#tool-html-unavailable').hidden&&!document.querySelector('#tool-html-form').hidden");

  const sampleHtml = '<!doctype html><html><body style="margin:0;padding:24px;background:#1d3557;color:#f1faee;font:700 28px sans-serif">Iris Sandbox PNG</body></html>';
  await fields({ '#tool-html-input': sampleHtml, '#tool-html-width': '360', '#tool-html-height': '200' });
  await evalFn(() => { document.querySelector('#tool-html-fullpage').checked = false; });
  await click('#tool-html-submit');
  await waitFor('real Chromium HTML PNG or render feedback', "(!document.querySelector('#tool-html-result').hidden&&!document.querySelector('#tool-html-preview').hidden)||document.querySelector('#tool-html-feedback').classList.contains('error')", 40000);
  const screenshotSize = await evalFn(() => {
    const image = document.querySelector('#tool-html-preview');
    return [image.naturalWidth, image.naturalHeight];
  });
  assert.deepEqual(screenshotSize, [360, 200], await evaluate("document.querySelector('#tool-html-feedback').textContent"));
  const htmlMetaText = await evaluate("document.querySelector('#tool-html-meta').textContent");
  const htmlArtId = /(artifact_[a-f0-9]{24})/.exec(htmlMetaText)?.[1];
  assert(htmlArtId, 'HTML render result should display artifactId');
  assert.equal(readCoreArtifactBytes(root, htmlArtId).artifact.kind, 'html-screenshot');

  // Verify responsive 320px layout on local tools panel without overflow!
  await dimensions(320, 844);
  await measure('local-tools-html-320');
  await capture('local-tools-html-320');
  await click('[data-local-tool-tab="crop"]');
  await measure('local-tools-crop-320');

  // Handoff HTML screenshot directly into Arbitrary Crop tool!
  await click('[data-local-tool-tab="html"]');
  await click('#tool-html-result [data-tool-handoff="crop"]');
  await waitFor('HTML screenshot handed off to crop tool', `document.querySelector('#tool-crop-select').value===${JSON.stringify(htmlArtId)}&&document.querySelector('#tool-crop-image').naturalWidth===360`);

  // Logout must clear HTML source textarea & revoke previews.
  await click('#disconnect');
  await waitFor('disconnected cleanly', "document.querySelector('#connection').hidden===false");
  assert.equal(await evaluate("document.querySelector('#tool-html-input').value"), '');
  assert.equal(await evaluate("!document.querySelector('#tool-html-meta').textContent&&window.testBlobs.size===0"), true);
  mark('real headless Chromium sandbox renders HTML to PNG, supports 320px layout, hands off to crop and clears textarea on logout');

  // --- Phase 3: Read-only mode hides write buttons while preserving crop EXIF preview & read-only lineage ---
  await dimensions(1366, 900);
  session = await restart(root, { allowLocalWrites: false, browserExecutable: executable, browserNoSandbox: noSandbox });
  await login(session, 'readonly', '#' + editRun1.id);
  await readyRun(editRun1.id);
  await click('#run-lineage > summary');
  await waitFor('read-only Run lineage works', `document.querySelector('#run-lineage-body').textContent.includes(${JSON.stringify(editRun2.id)})`);
  assert.equal(await evaluate("document.querySelectorAll('#run-lineage-body [data-lineage-crop]').length"), 0, 'read-only lineage hides crop write shortcuts');
  await click('#tools-tab');
  await waitFor('read-only local tools directory loaded', "document.querySelector('#tool-crop-select').options.length>3");
  await fields({ '#tool-crop-select': exif6Art.id });
  await waitFor('read-only EXIF crop preview works', "!document.querySelector('#tool-crop-stage-frame').hidden&&!document.querySelector('#tool-crop-readonly-note').hidden&&document.querySelector('#tool-crop-submit').hidden");
  await click('[data-local-tool-tab="diff"]');
  assert.equal(await evaluate("!document.querySelector('#tool-diff-readonly-note').hidden&&document.querySelector('#tool-diff-submit').hidden"), true);
  await click('[data-local-tool-tab="html"]');
  assert.equal(await evaluate("!document.querySelector('#tool-html-unavailable').hidden&&document.querySelector('#tool-html-unavailable').textContent.includes('只读模式')&&document.querySelector('#tool-html-form').hidden"), true);
  mark('read-only mode keeps EXIF preview and lineage available while hiding all write actions');
}
