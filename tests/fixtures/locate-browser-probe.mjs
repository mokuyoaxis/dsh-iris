import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { readCoreArtifactBytes } from '../../lib/core-artifacts.js';
import { createVisionProviderAdapter } from '../../lib/vision-provider-adapter.js';

export async function verifyLocateBrowser({ out, cdp, evaluate, click, wait, chooseToken, readyRun, report, save, dimensions, measure, capture, restart }) {
  const root = path.join(out, 'locate-core'), config = path.join(out, 'locate-providers.json');
  const provider = { id: 'locate-fixture', type: 'openai', baseUrl: 'https://locate.invalid/v1', apiKey: 'CONTROLLED_LOCATE_KEY' };
  const modelRef = 'locate-fixture::vision';
  const baseBox = { x1: 100, y1: 100, x2: 300, y2: 300 };
  let answer = baseBox, modelCalls = 0;
  const adapter = createVisionProviderAdapter(provider, {
    fetchPort: async () => {
      modelCalls++;
      if (answer === null) throw new Error('Controlled connection loss during submit');
      const message = { choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: null }] };
      const finish = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      return new Response('data: ' + JSON.stringify(message) + '\n\ndata: ' + JSON.stringify(finish) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    }
  });
  const ports = {
    resolveVisionCandidates: () => [{ adapter, model: modelRef, providerBinding: 'sha256:' + 'a'.repeat(64), selectionReason: 'explicit' }],
    resolveTaskAdapter: () => adapter
  };
  fs.writeFileSync(config, JSON.stringify({ providers: [{ ...provider, models: [{ id: 'vision', capabilities: ['vision'] }] }],
    assignments: { vision: [modelRef] } }), { mode: 0o600 });
  const block = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#ee4266' } }).png().toBuffer();
  const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#302a3d' } })
    .composite([{ input: block, left: 20, top: 10 }]).png().toBuffer();
  const inputFile = path.join(out, 'locate-input.png');
  fs.writeFileSync(inputFile, png, { mode: 0o600 });

  const app = createApplicationRuntime({ dataRoot: root, ...ports });
  async function seed(bytes, target, response) {
    const source = (await app.execute('artifact.import', { image_bytes: bytes })).artifact;
    const draft = await app.execute('flow.create', { recipe: 'locate/v0', model_ref: modelRef, target, source_artifact_id: source.id });
    answer = response;
    return app.execute('flow.continue', { run_id: draft.run.id });
  }
  let rotated, turned, unknown, missing;
  try {
    await app.execute('flow.init', {});
    await app.execute('execution.init', { vision: true });
    rotated = await seed(await sharp(png).withMetadata({ orientation: 6 }).jpeg({ quality: 98 }).toBuffer(),
      'W'.repeat(200), { x1: 700, y1: 100, x2: 900, y2: 300 });
    turned = await seed(await sharp(png).withMetadata({ orientation: 3 }).jpeg({ quality: 98 }).toBuffer(),
      '旋转图中的矩形', { x1: 700, y1: 700, x2: 900, y2: 900 });
    unknown = await seed(png, '连接中断样本', null);
    missing = await seed(png, '未找到目标样本', { found: false });
    assert.equal(unknown.task.acceptance, 'unknown');
  } finally { await app.dispose(); }

  const session = await restart(root, config, ports, {});
  report.requestRootVersion = 5;
  const token = path.join(out, 'locate-token'); writeLocalApiTokenFile(token, session.accessToken, root);
  const evalFn = (fn, ...args) => evaluate('(' + fn.toString() + ')(' + args.map(arg => JSON.stringify(arg)).join(',') + ')');
  const fields = values => evalFn(values => {
    for (const [selector, value] of Object.entries(values)) {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, values);
  const check = (name) => { report.checks.push(name); save(); };
  const overlayReady = () => wait(() => evaluate("Boolean(document.querySelector('#locate-overlay .locate-bbox-stroke'))"), 'locate overlay rendered');
  const sourceReady = () => wait(() => evaluate("!document.querySelector('#locate-stage-frame').hidden"), 'locate source rendered');
  const svgRect = selector => evalFn(selector => {
    const rect = document.querySelector(selector);
    return ['x', 'y', 'width', 'height'].map(attr => Number(rect.getAttribute(attr)));
  }, selector);
  async function openRun(run) {
    await cdp('Page.navigate', { url: session.origin + '/#' + run.id });
    await readyRun(run.id);
    await sourceReady();
  }
  async function assertOverlayGeometry(imageId, overlayId) {
    const offsets = await evalFn((imageId, overlayId) => {
      const image = document.getElementById(imageId), overlay = document.getElementById(overlayId);
      const rect = overlay.querySelector('.locate-bbox-stroke'), container = image.getBoundingClientRect();
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(attr => Number(rect.getAttribute(attr)));
      const scale = Math.min(container.width / image.naturalWidth, container.height / image.naturalHeight);
      const left = container.x + (container.width - image.naturalWidth * scale) / 2;
      const top = container.y + (container.height - image.naturalHeight * scale) / 2;
      const origin = new DOMPoint(x, y).matrixTransform(rect.getScreenCTM());
      const end = new DOMPoint(x + width, y + height).matrixTransform(rect.getScreenCTM());
      return [origin.x - (left + x * scale), origin.y - (top + y * scale),
        end.x - (left + (x + width) * scale), end.y - (top + (y + height) * scale)];
    }, imageId, overlayId);
    assert(offsets.every(offset => Math.abs(offset) <= 0.6), JSON.stringify(offsets));
  }

  await cdp('Page.navigate', { url: session.origin + '/' });
  await wait(() => evaluate("document.readyState==='complete'&&Boolean(document.querySelector('#token-file'))"), 'locate login');
  await chooseToken(token);
  await wait(() => evaluate("document.body.classList.contains('connected')"), 'locate session');
  await click('#studio-tab');
  await click('#new-run');
  await click('[data-creation-mode=locate]');
  await wait(() => evaluate("document.querySelector('#model').options.length>1"), 'locate model directory');
  await fields({ '#model': modelRef, '#edit-prompt': '红色矩形' });
  const dom = await cdp('DOM.getDocument');
  const input = await cdp('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#image-file' });
  await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [inputFile] });
  await wait(() => evaluate("!document.querySelector('#start-edit').disabled&&document.querySelector('#start-edit').textContent==='保存定位任务'"), 'locate draft ready');
  const beforeCreation = modelCalls;
  answer = baseBox;
  await click('#start-edit');
  await wait(() => evaluate("!document.querySelector('#start-edit').disabled&&document.querySelector('#start-edit').textContent==='开始定位'"), 'explicit locate action');
  const created = await evaluate('location.hash.slice(1)');
  await readyRun(created);
  await sourceReady();
  assert.equal(modelCalls, beforeCreation);
  await click('#start-edit');
  await overlayReady();
  assert.equal(modelCalls, beforeCreation + 1);
  assert.deepEqual(await svgRect('#locate-overlay .locate-bbox-stroke'), [20, 10, 40, 20]);
  await assertOverlayGeometry('locate-source-image', 'locate-overlay');
  await capture('locate-desktop');
  check('browser creates a saved locate draft, then explicitly calls the model once');

  await dimensions(320, 740);
  await measure('locate-mobile');
  await assertOverlayGeometry('locate-source-image', 'locate-overlay');
  await click('#appearance-open');
  await fields({ '#appearance-theme': 'dark' });
  await click('#appearance-close');
  await capture('locate-mobile-dark');
  check('PNG overlay matches the displayed image at desktop and narrow viewports');

  await openRun(turned.run);
  await overlayReady();
  assert.deepEqual(await svgRect('#locate-overlay .locate-bbox-stroke'), [140, 70, 40, 20]);
  await openRun(rotated.run);
  await overlayReady();
  assert.equal(await evaluate("document.querySelector('#locate-overlay').getAttribute('viewBox')"), '0 0 100 200');
  assert.deepEqual(await svgRect('#locate-overlay .locate-bbox-stroke'), [70, 20, 20, 40]);
  await assertOverlayGeometry('locate-source-image', 'locate-overlay');
  await click('#locate-stage-preview');
  await assertOverlayGeometry('expanded-image', 'expanded-overlay');
  assert.equal(await evalFn(() => {
    const heading = document.querySelector('#vision-result-heading'), dialog = document.querySelector('#image-dialog');
    return heading.scrollWidth <= heading.clientWidth && dialog.scrollWidth <= dialog.clientWidth;
  }), true, 'a long target wraps on the narrow workbench and in the preview dialog');
  await click('#close-image-dialog');
  check('EXIF orientations 3 and 6 project into the canvas and modal, and long targets wrap');

  await evalFn(() => { document.querySelector('#locate-crop-adjust').open = true; });
  await fields({ '#locate-crop-left': '174', '#locate-crop-width': '50' });
  assert.equal(await evaluate("document.querySelector('#locate-crop-width').value"), '26');
  assert.deepEqual(await svgRect('#locate-overlay .locate-crop-preview-stroke'), [70, 174, 20, 26]);
  await evalFn(() => {
    const originalFetch = window.fetch;
    const probe = window.cropPreviewProbe = { posts: [], reads: [], artifactId: null };
    window.restoreCropPreviewFetch = () => { window.fetch = originalFetch; };
    window.fetch = async (resource, init) => {
      const route = new URL(typeof resource === 'string' ? resource : resource.url, location.href).pathname;
      if (probe.artifactId && route === '/api/v0/artifacts/' + probe.artifactId + '/content') {
        probe.reads.push(probe.artifactId);
        if (probe.reads.length === 1) throw new TypeError('Controlled preview disconnect');
      }
      const response = await originalFetch(resource, init);
      if (route === '/api/v0/local-media/crop' && response.ok) {
        probe.posts.push(JSON.parse(init.body));
        probe.artifactId = (await response.clone().json()).artifact.artifactId;
      }
      return response;
    };
  });
  await click('#locate-crop-button');
  await wait(() => evaluate("!document.querySelector('#locate-crop-reload').hidden&&!document.querySelector('#locate-crop-reload').disabled"), 'saved crop may retry preview');
  const existing = await evaluate('window.cropPreviewProbe');
  assert.deepEqual(existing.posts, [{ artifactId: rotated.run.source.artifactId, left: 174, top: 10, width: 26, height: 20 }]);
  assert.equal(readCoreArtifactBytes(root, existing.artifactId).artifact.kind, 'crop');
  assert.equal(await evalFn(() => document.querySelector('#locate-crop-button').disabled
    && document.querySelector('#locate-crop-image').hidden
    && document.querySelector('#locate-crop-feedback').textContent.includes('已保存，预览读取失败')), true);
  await click('#refresh');
  await readyRun(rotated.run.id);
  await overlayReady();
  await wait(() => evaluate("!document.querySelector('#locate-crop-reload').hidden"), 'refresh retains the saved crop receipt');
  assert.deepEqual(await svgRect('#locate-overlay .locate-crop-preview-stroke'), [70, 174, 20, 26]);
  assert.equal(await evalFn(() => !document.querySelector('#locate-crop-button').hidden
    && document.querySelector('#locate-crop-button').disabled
    && document.querySelector('#locate-crop-button').textContent === '裁剪区域已保存'
    && document.querySelector('#locate-crop-left').value === '174'
    && document.querySelector('#locate-crop-width').value === '26'), true);
  await click('#locate-crop-reload');
  await wait(() => evaluate("document.querySelector('#locate-crop-image').naturalWidth===26"), 'preview of saved crop returned');
  const reloaded = await evaluate('window.cropPreviewProbe');
  assert.equal(reloaded.posts.length, 1);
  assert.deepEqual(reloaded.reads, [existing.artifactId, existing.artifactId]);
  await evaluate('window.restoreCropPreviewFetch()');
  await click('#locate-crop-use-ocr');
  assert.equal(await evaluate("document.querySelector('[data-creation-mode=ocr]').getAttribute('aria-pressed')"), 'true');
  assert.equal(modelCalls, beforeCreation + 1);
  check('EXIF crop sends raw pixels and a preview retry reads the same saved artifact after refresh');

  await openRun(unknown.run);
  assert.equal(await evalFn(() => {
    const note = document.querySelector('#vision-result-note').textContent;
    return note.includes('可能已经计费') && note === document.querySelector('#status-message').textContent
      && document.querySelector('#locate-retry-target').hidden;
  }), true, 'unknown acceptance uses the saved task warning and hides the new-run shortcut');
  await openRun(missing.run);
  assert.equal(await evalFn(() => !document.querySelector('#locate-retry-target').hidden
    && document.querySelector('#locate-crop-button').hidden
    && document.querySelector('#locate-overlay').hasAttribute('hidden')), true);
  assert.equal(modelCalls, beforeCreation + 1);
  check('unknown acceptance preserves the task warning and not-found allows a new draft');
}
