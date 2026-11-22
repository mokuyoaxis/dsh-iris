import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { LOCAL_WEB_CSP } from '../lib/local-web-assets.js';
import { createVisionProviderAdapter } from '../lib/vision-provider-adapter.js';
import { createReadClient } from '../lib/web/transport.js';
import { createMediaClient } from '../lib/web/media-client.js';
import { clampCropRect, isSameCropRect, buildLocateOverlaySpec, renderLocateSvg } from '../lib/web/locate-overlay.js';
import { useTempDshHome } from './test-env.js';

function createMockSvgDocument() {
  const makeNode = (ns, tag) => {
    const attrs = new Map();
    const children = [];
    const node = {
      namespaceURI: ns,
      tagName: tag,
      hidden: false,
      attrs,
      children,
      ownerDocument: doc,
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name) ?? null; },
      removeAttribute(name) { attrs.delete(name); },
      append(...items) { children.push(...items); },
      replaceChildren(...items) { children.splice(0, children.length, ...items); }
    };
    return node;
  };
  const doc = { createElementNS: (ns, tag) => makeNode(ns, tag) };
  return { doc, makeSvg: () => makeNode('http://www.w3.org/2000/svg', 'svg') };
}

function walkNodes(node, visit) {
  visit(node);
  for (const child of node.children) walkNodes(child, visit);
}

// === 1. Pure SVG overlay math & CSP-safe DOM rendering unit tests ===
assert.throws(() => clampCropRect({ left: 0, top: 0, width: 10, height: 10 }, 0, 100), TypeError);
assert.throws(() => clampCropRect({ left: 0, top: 0, width: 10, height: 10 }, 100, -1), TypeError);
assert.deepEqual(clampCropRect({ left: -20, top: 999, width: 500, height: -3 }, 200, 100), { left: 0, top: 99, width: 200, height: 1 });
assert.deepEqual(clampCropRect({ left: 10.9, top: 20.1, width: 80.7, height: 60.4 }, 200, 100), { left: 10, top: 20, width: 80, height: 60 });
assert.deepEqual(clampCropRect({ left: 150, top: 80, width: 100, height: 50 }, 200, 100), { left: 150, top: 80, width: 50, height: 20 });
assert.equal(isSameCropRect({ left: 1, top: 2, width: 3, height: 4 }, { left: 1, top: 2, width: 3, height: 4 }), true);
assert.equal(isSameCropRect({ left: 1, top: 2, width: 3, height: 4 }, { left: 1, top: 2, width: 3, height: 5 }), false);
assert.equal(isSameCropRect(null, { left: 1, top: 2, width: 3, height: 4 }), false);

const sampleResult = { found: true, width: 200, height: 100, bbox: { left: 100, top: 20, width: 80, height: 60 } };
assert.deepEqual(buildLocateOverlaySpec({ imageWidth: 0, imageHeight: 100, result: sampleResult }), { visible: false, reason: 'no_image' });
assert.deepEqual(buildLocateOverlaySpec({ imageWidth: 200, imageHeight: 100, result: { found: false, width: 200, height: 100 } }), { visible: false, reason: 'not_found' });
assert.deepEqual(buildLocateOverlaySpec({ imageWidth: 199, imageHeight: 100, result: sampleResult }), { visible: false, reason: 'dimension_mismatch' });

const baseSpec = buildLocateOverlaySpec({ imageWidth: 200, imageHeight: 100, result: sampleResult, cropRect: { left: 100, top: 20, width: 80, height: 60 } });
assert.equal(baseSpec.visible, true);
assert.equal(baseSpec.reason, 'ok');
assert.equal(baseSpec.viewBox, '0 0 200 100');
assert.equal(baseSpec.customCrop, null);
assert.deepEqual(baseSpec.scrimRect, { left: 100, top: 20, width: 80, height: 60 });

const customSpec = buildLocateOverlaySpec({ imageWidth: 200, imageHeight: 100, result: sampleResult, cropRect: { left: 90, top: 10, width: 100, height: 80 }, showBox: true, showScrim: true });
assert.deepEqual(customSpec.customCrop, { left: 90, top: 10, width: 100, height: 80 });
assert.deepEqual(customSpec.scrimRect, { left: 90, top: 10, width: 100, height: 80 });

const rawBox = { left: 20, top: 10, width: 40, height: 30 };
const orientedBoxes = [
  [20, 10, 40, 30], [140, 10, 40, 30], [140, 60, 40, 30], [20, 60, 40, 30],
  [10, 20, 30, 40], [60, 20, 30, 40], [60, 140, 30, 40], [10, 140, 30, 40]
];
for (const [index, [left, top, width, height]] of orientedBoxes.entries()) {
  const orientation = index + 1;
  const imageWidth = orientation >= 5 ? 100 : 200;
  const imageHeight = orientation >= 5 ? 200 : 100;
  const result = { ...sampleResult, bbox: rawBox, input: { orientation } };
  const spec = buildLocateOverlaySpec({ imageWidth, imageHeight, result });
  assert.equal(spec.viewBox, `0 0 ${imageWidth} ${imageHeight}`);
  assert.deepEqual(spec.bbox, { left, top, width, height }, `EXIF orientation ${orientation}`);
  assert.deepEqual(spec.scrimRect, spec.bbox);
}
const rotatedCrop = buildLocateOverlaySpec({
  imageWidth: 100, imageHeight: 200, result: { ...sampleResult, bbox: rawBox, input: { orientation: 6 } },
  cropRect: { left: 150, top: 12, width: 64, height: 30 }
});
assert.deepEqual(rotatedCrop.customCrop, { left: 58, top: 150, width: 30, height: 50 });
assert.deepEqual(rotatedCrop.scrimRect, rotatedCrop.customCrop);

const noScrimSpec = buildLocateOverlaySpec({ imageWidth: 200, imageHeight: 100, result: sampleResult, showBox: true, showScrim: false });
assert.equal(noScrimSpec.visible, true);
assert.equal(noScrimSpec.scrimRect, null);

const hiddenBoxSpec = buildLocateOverlaySpec({ imageWidth: 200, imageHeight: 100, result: sampleResult, showBox: false, showScrim: true });
assert.equal(hiddenBoxSpec.visible, false);
assert.equal(hiddenBoxSpec.scrimRect, null);

const { makeSvg } = createMockSvgDocument();
const stageSvg = makeSvg(), dialogSvg = makeSvg();
stageSvg.setAttribute('hidden', ''); dialogSvg.setAttribute('hidden', '');
renderLocateSvg(stageSvg, customSpec, { maskId: 'locate-scrim-mask' });
renderLocateSvg(dialogSvg, baseSpec, { maskId: 'expanded-scrim-mask' });
assert.equal(stageSvg.hidden, false);
assert.equal(stageSvg.getAttribute('hidden'), null, 'SVGElement visibility must remove the hidden attribute');
assert.equal(dialogSvg.getAttribute('hidden'), null);
assert.equal(stageSvg.getAttribute('viewBox'), '0 0 200 100');
assert.equal(stageSvg.getAttribute('preserveAspectRatio'), 'xMidYMid meet');
walkNodes(stageSvg, node => {
  assert.equal(node.getAttribute('style'), null, 'Zero inline styles for strict style-src self CSP');
});
assert.equal(stageSvg.children[0].tagName, 'defs');
assert.equal(stageSvg.children[0].children[0].getAttribute('id'), 'locate-scrim-mask');
assert.equal(stageSvg.children[1].getAttribute('mask'), 'url(#locate-scrim-mask)');
assert.equal(dialogSvg.children[0].children[0].getAttribute('id'), 'expanded-scrim-mask');
assert.equal(dialogSvg.children[1].getAttribute('mask'), 'url(#expanded-scrim-mask)');
const bboxRect = stageSvg.children.find(n => n.getAttribute('class') === 'locate-bbox-stroke');
assert.equal(bboxRect.getAttribute('x'), '100');
assert.equal(bboxRect.getAttribute('y'), '20');
assert.equal(bboxRect.getAttribute('width'), '80');
assert.equal(bboxRect.getAttribute('height'), '60');
const previewRect = stageSvg.children.find(n => n.getAttribute('class') === 'locate-crop-preview-stroke');
assert.equal(previewRect.getAttribute('x'), '90');
assert.equal(previewRect.getAttribute('y'), '10');
assert.equal(previewRect.getAttribute('width'), '100');
assert.equal(previewRect.getAttribute('height'), '80');

renderLocateSvg(stageSvg, hiddenBoxSpec);
assert.equal(stageSvg.hidden, true);
assert.equal(stageSvg.getAttribute('hidden'), '', 'Hiding SVGElement must set the hidden attribute');
assert.equal(stageSvg.children.length, 0);
assert.equal(stageSvg.getAttribute('viewBox'), null);

// === 2. Real Local API + Served Assets + Locate + Zero-Billing Crop + Read-Only Gate ===
const { root } = useTempDshHome('iris-web-locate-ui');
const dataRoot = path.join(root, 'v5-core');
const nativeFetch = globalThis.fetch;
const modelRef = 'vision-web::vision';
const config = path.join(root, 'providers.json');
fs.writeFileSync(config, JSON.stringify({
  providers: [{ id: 'vision-web', type: 'openai', baseUrl: 'https://vision-web.invalid/v1', apiKey: 'SYNTHETIC_KEY',
    models: [{ id: 'vision', capabilities: ['vision'] }] }],
  assignments: { vision: [modelRef] }
}), { mode: 0o600 });

let modelCalls = 0;
let mockAnswer = '{"x1":500,"y1":200,"x2":900,"y2":800}';
const adapter = createVisionProviderAdapter(
  { id: 'vision-web', type: 'openai', baseUrl: 'https://vision-web.invalid/v1', apiKey: 'SYNTHETIC_KEY' },
  {
    fetchPort: async () => {
      modelCalls++;
      return new Response(
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: mockAnswer }, finish_reason: null }] })
        + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      );
    }
  }
);
const ports = {
  resolveVisionCandidates: () => [{ adapter, model: modelRef, providerBinding: 'sha256:' + 'c'.repeat(64), selectionReason: 'explicit' }],
  resolveTaskAdapter: () => adapter
};

const app = createApplicationRuntime({ dataRoot, ...ports });
let api, client, media;

async function waitOperation(operationId) {
  for (let i = 0; i < 200; i++) {
    const result = await client.getOperation(operationId);
    if (!['queued', 'running'].includes(result.operation.state)) return result.operation;
    await new Promise(r => setTimeout(r, 15));
  }
  throw new Error('Locate operation did not finish');
}

try {
  await app.execute('flow.init', {});
  await app.execute('execution.init', { vision: true });

  api = createLocalReadApi({ dataRoot, providerConfigPath: config, serveWorkbench: true, allowExecution: true, executionPorts: ports });
  const session = await api.start();

  // Verify served workbench HTML, CSS, JS module and strict CSP headers.
  const htmlRes = await nativeFetch(session.origin + '/');
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.headers.get('content-security-policy'), LOCAL_WEB_CSP);
  const html = await htmlRes.text();
  for (const token of [
    'data-creation-mode="locate"', 'id="locate-visual"', 'id="locate-overlay"',
    'id="locate-toggle-box"', 'id="locate-toggle-scrim"', 'id="locate-crop-button"',
    'id="locate-crop-adjust"', 'id="locate-crop-result"', 'id="locate-crop-reload"', 'id="locate-json-details"',
    'id="expanded-overlay"'
  ]) {
    assert(html.includes(token), `Workbench HTML missing ${token}`);
  }
  const overlayRes = await nativeFetch(session.origin + '/locate-overlay.js');
  assert.equal(overlayRes.status, 200);
  assert.match(overlayRes.headers.get('content-type') || '', /text\/javascript/);
  assert.equal(overlayRes.headers.get('content-security-policy'), LOCAL_WEB_CSP);

  const css = await (await nativeFetch(session.origin + '/styles.css')).text();
  assert(css.includes('--iris-gradient:linear-gradient(105deg,#45317D,#6F69B8,#BB78AD,#E59B76,#ED9C91,#F0D09C)'),
    'Iris 6-color palette must remain untouched');
  assert(css.includes('.locate-bbox-stroke') && css.includes('#E59B76'));
  assert(css.includes('.locate-crop-preview-stroke') && css.includes('.dialog-stage-frame'));

  // Create a 200x100 PNG with a distinct coral block at (100, 20, 80, 60).
  const coralBlock = await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 229, g: 155, b: 118 } } }).png().toBuffer();
  const testPng = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 48, g: 42, b: 61 } } })
    .composite([{ input: coralBlock, left: 100, top: 20 }])
    .png()
    .toBuffer();

  globalThis.fetch = (resource, options = {}) => nativeFetch(session.origin + resource, options);
  client = createReadClient(session.accessToken);
  const info = await client.get('/api/v0/session');
  assert(info.operations.includes('locates.create'));
  assert(info.operations.includes('local-media.crop'));
  const mem = new Map();
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  media = createMediaClient({ client, session: info, origin: session.origin, getStorage: () => storage });

  const uploaded = await media.uploadImage(new Blob([testPng], { type: 'image/png' }));
  const sourceId = uploaded.artifact.artifactId;

  // Step 1: save locate draft -> zero model calls.
  const draft = await media.createLocate({ modelRef, sourceArtifactId: sourceId, target: '右侧珊瑚色块' });
  assert.equal(draft.flow.status, 'not_started');
  assert.equal(modelCalls, 0);

  // Step 2: explicit execution -> exact bbox JSON.
  const firstOp = await media.continueRun(draft.flow.id, draft.flow.revision);
  await waitOperation(firstOp.operation.id);
  const finished = await client.getRun(draft.flow.id);
  assert.equal(finished.status, 'ready');
  assert.equal(modelCalls, 1);
  assert.equal(finished.locate.found, true);
  const locateJson = await client.get('/api/v0/artifacts/' + finished.output.artifactId + '/locate-result');
  assert.deepEqual(locateJson.bbox, { x1: 100, y1: 20, x2: 180, y2: 80, left: 100, top: 20, width: 80, height: 60 });

  // Client validation on cropImage before HTTP.
  for (const bad of [
    null, {}, { artifactId: 'bad', left: 0, top: 0, width: 10, height: 10 },
    { artifactId: sourceId, left: -1, top: 0, width: 10, height: 10 },
    { artifactId: sourceId, left: 0, top: 0, width: 0, height: 10 },
    { artifactId: sourceId, left: 0, top: 0, width: 10, height: 10, extra: true }
  ]) {
    assert.throws(() => client.cropImage(bad), TypeError);
  }

  // Zero-billing local crop using the located bbox -> exact pixel verification!
  const cropped = await client.cropImage({
    artifactId: sourceId,
    left: locateJson.bbox.left,
    top: locateJson.bbox.top,
    width: locateJson.bbox.width,
    height: locateJson.bbox.height
  });
  assert.equal(cropped.contractVersion, 0);
  assert.equal(cropped.artifact.width, 80);
  assert.equal(cropped.artifact.height, 60);
  assert.equal(modelCalls, 1, 'Local crop must incur zero model calls');
  const cropBlob = await client.get('/api/v0/artifacts/' + cropped.artifact.artifactId + '/content', { binary: true });
  const cropBuf = Buffer.from(await cropBlob.arrayBuffer());
  const cropMeta = await sharp(cropBuf).metadata();
  assert.equal(cropMeta.width, 80);
  assert.equal(cropMeta.height, 60);
  const { data: px } = await sharp(cropBuf).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([px[0], px[1], px[2]], [229, 155, 118], 'Cropped region matches the exact coral block pixels');

  // Nudged custom crop (+10px padding) -> still zero model calls!
  const nudgedRect = clampCropRect({ left: 90, top: 10, width: 100, height: 80 }, 200, 100);
  const nudged = await client.cropImage({ artifactId: sourceId, ...nudgedRect });
  assert.equal(nudged.artifact.width, 100);
  assert.equal(nudged.artifact.height, 80);
  assert.equal(modelCalls, 1);

  // found: false locate run.
  mockAnswer = '{"found":false}';
  const missDraft = await media.createLocate({ modelRef, sourceArtifactId: sourceId, target: '不存在的目标' });
  const missOp = await media.continueRun(missDraft.flow.id, missDraft.flow.revision);
  await waitOperation(missOp.operation.id);
  const missRun = await client.getRun(missDraft.flow.id);
  assert.equal(missRun.status, 'ready', JSON.stringify(missRun));
  assert.equal(missRun.locate.found, false);
  const missJson = await client.get('/api/v0/artifacts/' + missRun.output.artifactId + '/locate-result');
  assert.equal(missJson.found, false);
  assert.equal(buildLocateOverlaySpec({ imageWidth: 200, imageHeight: 100, result: missJson }).visible, false);

  // Read-only mode: hides write/crop capabilities while retaining locate & image read access.
  media.close(); media = null;
  client.close(); client = null;
  await api.dispose();
  api = createLocalReadApi({ dataRoot, providerConfigPath: config, serveWorkbench: true, allowExecution: false, allowLocalWrites: false });
  const roSession = await api.start();
  globalThis.fetch = (resource, options = {}) => nativeFetch(roSession.origin + resource, options);
  client = createReadClient(roSession.accessToken);
  const roInfo = await client.get('/api/v0/session');
  assert(!roInfo.operations.includes('locates.create'));
  assert(!roInfo.operations.includes('local-media.crop'));
  assert(roInfo.operations.includes('locate.content'));
  assert(roInfo.operations.includes('artifacts.content'));
  assert.equal((await client.get('/api/v0/artifacts/' + finished.output.artifactId + '/locate-result')).found, true);
  await assert.rejects(client.cropImage({ artifactId: sourceId, left: 0, top: 0, width: 20, height: 20 }), { status: 405 });

  console.log('PASS Web visual grounding SVG overlay math, strict CSP assets, Iris palette preservation, two-step locate creation, zero-billing pixel-exact crop, found:false and read-only gates');
} finally {
  media?.close();
  client?.close();
  globalThis.fetch = nativeFetch;
  await api?.dispose();
  await app.dispose();
}
