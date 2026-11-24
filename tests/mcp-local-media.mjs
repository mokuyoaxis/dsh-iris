import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { LEGACY_BRIDGE_TOOLS_V0 } from '../lib/core-bridge-selection.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { ffmpegAvailable } from '../lib/media-probe.js';
import { createVisionProviderAdapter } from '../lib/vision-provider-adapter.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { VIDEO_MODEL, VIDEO_MP4, videoFlowFixture } from './fixtures/video-flow-fixture.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-local-media');
const uuid = () => crypto.randomUUID();
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(block => block.type === 'text').text); };

const children = [];
const apis = [];
const apps = [];

async function makePng(width, height, fillFn) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fillFn(x, y);
      const o = (y * width + x) * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

try {
  // === Part 1: Standalone local-media on a v1 root (allowLocalWrites only, NO execution, NO provider config) ===
  const v1Root = path.join(root, 'v1-core');
  const v1Store = path.join(root, 'v1-connections');
  const v1App = createApplicationRuntime({ dataRoot: v1Root });
  apps.push(v1App);
  await v1App.execute('flow.init', {});
  await v1App.execute('execution.init', {});

  const v1Api = createLocalReadApi({
    dataRoot: v1Root, allowLocalWrites: true, allowExecution: false,
    allowMcp: true, allowConnectionManagement: true, connectionStore: v1Store
  });
  apis.push(v1Api);
  const v1Session = await v1Api.start();

  const manageV1 = async (route, value) => {
    const response = await fetch(v1Session.origin + '/api/v0/connection-management' + route, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + v1Session.accessToken, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    assert(response.ok, route + ' HTTP ' + response.status);
    return response.json();
  };

  const standaloneKey = uuid();
  await manageV1('/connections', {
    key: standaloneKey, label: 'Standalone local-media', scopes: ['read', 'create'], capabilities: ['local-media']
  });
  const standaloneHttpCfg = (await manageV1('/connections/' + standaloneKey + '/export', { transport: 'http', format: 'entry' })).configuration;
  const standaloneStdioCfg = (await manageV1('/connections/' + standaloneKey + '/export', { transport: 'stdio', format: 'entry' })).configuration;
  const standaloneSkill = await manageV1('/connections/' + standaloneKey + '/skill', {});
  assert(standaloneSkill.preview.includes('Local media inspection · 本地媒体检视'));
  assert(standaloneSkill.preview.includes('iris_core_crop'));
  assert(!standaloneSkill.preview.includes('iris_core_continue'));

  const standaloneHttp = httpMcpClient(v1Session.origin, standaloneHttpCfg.headers.Authorization.slice(7), { version: '2026-07-28', name: 'local-media-http' });
  await standaloneHttp.initialize();
  const standaloneStdio = stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read,create', { version: '2025-11-25', name: 'local-media-stdio', launch: standaloneStdioCfg });
  children.push(standaloneStdio);
  await standaloneStdio.initialize();

  // Verify exact tool set (8 tools, zero flow/billing tools) & annotations.
  const expectedStandalone = ['iris_core_connection', 'iris_core_connections', 'iris_core_crop', 'iris_core_image', 'iris_core_import_image', 'iris_core_mux_video_audio', 'iris_core_pixel_diff', 'iris_core_video_frames'];
  for (const listed of [(await standaloneHttp.request('tools/list')).tools, (await standaloneStdio.request('tools/list')).tools]) {
    assert.deepEqual(listed.map(t => t.name).sort(), expectedStandalone);
    for (const name of ['iris_core_crop', 'iris_core_mux_video_audio', 'iris_core_pixel_diff', 'iris_core_video_frames']) {
      const tool = listed.find(t => t.name === name);
      assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, name + ' annotations');
    }
    const imp = listed.find(t => t.name === 'iris_core_import_image');
    assert.deepEqual(imp.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  }

  // Import two synthetic PNGs (64x48): A = all red, B = left half red / right half blue.
  const pngA = await makePng(64, 48, () => [255, 0, 0]);
  const pngB = await makePng(64, 48, (x) => x < 32 ? [255, 0, 0] : [0, 0, 255]);
  const impA = parse(await standaloneHttp.call('iris_core_import_image', { key: uuid(), imageBase64: pngA.toString('base64'), mediaType: 'image/png' }));
  const impB = parse(await standaloneStdio.call('iris_core_import_image', { key: uuid(), imageBase64: pngB.toString('base64'), mediaType: 'image/png' }));
  const idA = impA.artifact.artifactId, idB = impB.artifact.artifactId;

  // Crop a 20x16 patch from the blue right half of B via HTTP MCP.
  const cropped = parse(await standaloneHttp.call('iris_core_crop', { artifactId: idB, left: 36, top: 10, width: 20, height: 16 }));
  assert.equal(cropped.artifact.mediaType, 'image/png');
  assert.equal(cropped.artifact.width, 20);
  assert.equal(cropped.artifact.height, 16);
  assert.equal(cropped.artifact.sourceArtifactId, idB);
  assert(!JSON.stringify(cropped).includes(root));

  // Read back cropped PNG via iris_core_image and verify actual pixels are pure blue.
  const cropImg = await standaloneHttp.call('iris_core_image', { artifactId: cropped.artifact.artifactId });
  const cropBuf = Buffer.from(cropImg.content.find(b => b.type === 'image').data, 'base64');
  assert.deepEqual(cropBuf, readCoreArtifactBytes(v1Root, cropped.artifact.artifactId).bytes);
  const cropRaw = await sharp(cropBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(cropRaw.info.width, 20);
  assert.equal(cropRaw.info.height, 16);
  assert.deepEqual([cropRaw.data[0], cropRaw.data[1], cropRaw.data[2]], [0, 0, 255]);

  // Chained crop (crop on a crop) via stdio MCP.
  const subCrop = parse(await standaloneStdio.call('iris_core_crop', { artifactId: cropped.artifact.artifactId, left: 4, top: 4, width: 8, height: 6 }));
  assert.equal(subCrop.artifact.width, 8);
  assert.equal(subCrop.artifact.height, 6);

  // Pixel diff between A and B: exactly half of pixels differ.
  const diffed = parse(await standaloneStdio.call('iris_core_pixel_diff', { imageAArtifactId: idA, imageBArtifactId: idB, grid: 4, topRegions: 2 }));
  assert.equal(diffed.metrics.width, 64);
  assert.equal(diffed.metrics.height, 48);
  assert.equal(diffed.metrics.ratio, 0.5);
  assert.equal(diffed.metrics.worstRegions.length, 2);
  assert.equal(diffed.artifact.mediaType, 'image/png');
  assert.deepEqual(diffed.artifact.sourceArtifactIds, [idA, idB]);
  assert(!JSON.stringify(diffed).includes(root));
  const heatImg = await standaloneHttp.call('iris_core_image', { artifactId: diffed.artifact.artifactId });
  assert.equal(heatImg.content.find(b => b.type === 'image').mimeType, 'image/png');

  // Diamond DAG provenance: two crops from the SAME source image -> pixel_diff -> reading heatmap MUST succeed (common ancestor is not a cycle!).
  const cropLeft = parse(await standaloneHttp.call('iris_core_crop', { artifactId: idB, left: 0, top: 0, width: 20, height: 16 }));
  const cropRight = parse(await standaloneHttp.call('iris_core_crop', { artifactId: idB, left: 36, top: 10, width: 20, height: 16 }));
  const diamondDiff = parse(await standaloneHttp.call('iris_core_pixel_diff', { imageAArtifactId: cropLeft.artifact.artifactId, imageBArtifactId: cropRight.artifact.artifactId }));
  const diamondHeat = await standaloneHttp.call('iris_core_image', { artifactId: diamondDiff.artifact.artifactId });
  assert.equal(diamondHeat.isError, undefined, 'common ancestor diamond diff must be readable');
  assert.equal(diamondHeat.content.find(b => b.type === 'image').mimeType, 'image/png');
  // Direct ancestor + descendant diff (crop vs its own parent) also readable.
  const sameSizeCrop = parse(await standaloneHttp.call('iris_core_crop', { artifactId: idB, left: 0, top: 0, width: 64, height: 48 }));
  const ancestorDiff = parse(await standaloneHttp.call('iris_core_pixel_diff', { imageAArtifactId: sameSizeCrop.artifact.artifactId, imageBArtifactId: idB }));
  const ancestorHeat = await standaloneHttp.call('iris_core_image', { artifactId: ancestorDiff.artifact.artifactId });
  assert.equal(ancestorHeat.isError, undefined);
  assert.equal(ancestorHeat.content.find(b => b.type === 'image').mimeType, 'image/png');

  // Out-of-bounds crop & forbidden host-path arguments rejected cleanly.
  const oob = await standaloneHttp.call('iris_core_crop', { artifactId: idB, left: 60, top: 0, width: 10, height: 10 });
  assert.equal(oob.isError, true);
  assert.equal(oob.structuredContent.error.code, 'IRIS_API_INPUT_INVALID');
  const hostPathAttempt = await standaloneHttp.call('iris_core_crop', { image_path: '/etc/passwd', left: 0, top: 0, width: 10, height: 10 });
  assert.equal(hostPathAttempt.isError, true);

  // Passing an image artifact to iris_core_video_frames fails cleanly with 415 (never invokes ffmpeg).
  const wrongTypeFrames = await standaloneHttp.call('iris_core_video_frames', { artifactId: idA, maxFrames: 2 });
  assert.equal(wrongTypeFrames.isError, true);
  assert.equal(wrongTypeFrames.structuredContent.error.code, 'IRIS_API_MEDIA_UNSUPPORTED');

  // Read-only connection cannot call local-media writes even when local-media capability is granted.
  const readOnlyKey = uuid();
  await manageV1('/connections', { key: readOnlyKey, label: 'Read-only local-media', scopes: ['read'], capabilities: ['local-media'] });
  const readOnlyToken = (await manageV1('/connections/' + readOnlyKey + '/export', { transport: 'http', format: 'entry' })).configuration.headers.Authorization.slice(7);
  const readOnlyClient = httpMcpClient(v1Session.origin, readOnlyToken, { version: '2026-07-28' });
  await readOnlyClient.initialize();
  assert.deepEqual((await readOnlyClient.request('tools/list')).tools.map(t => t.name).sort(), ['iris_core_connection', 'iris_core_connections', 'iris_core_image']);
  await assert.rejects(readOnlyClient.call('iris_core_crop', { artifactId: idA, left: 0, top: 0, width: 4, height: 4 }), { rpcCode: -32602 });

  // Read-only Core (allowLocalWrites: false) rejects POST /api/v0/local-media/crop with 405.
  await standaloneStdio.close();
  await v1Api.dispose();
  const roCore = createLocalReadApi({ dataRoot: v1Root, allowLocalWrites: false });
  apis.push(roCore);
  const roSession = await roCore.start();
  const roResp = await fetch(roSession.origin + '/api/v0/local-media/crop', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + roSession.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ artifactId: idA, left: 0, top: 0, width: 4, height: 4 })
  });
  assert.equal(roResp.status, 405);
  await roResp.arrayBuffer();
  await roCore.dispose();

  // === Part 2: v5 multimodal closed loop & strict transitive capability isolation ===
  const v5Root = path.join(root, 'v5-core');
  const v5Store = path.join(root, 'v5-connections');
  const imgFixture = imageFlowFixture(v5Root);
  const visionAdapter = createVisionProviderAdapter(
    { id: 'vision-fixture', type: 'openai', baseUrl: 'https://vision.invalid/v1', apiKey: 'CONTROLLED_KEY' },
    {
      fetchPort: async () => new Response(
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'frame ok' }, finish_reason: null }] })
        + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
  );
  let sampleVideoBytes = null;
  if (ffmpegAvailable()) {
    const mp4Path = path.join(root, 'synthetic.mp4');
    const gen = spawnSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=96x64:rate=8',
      '-pix_fmt', 'yuv420p', '-y', mp4Path
    ], { encoding: 'utf8', shell: false });
    assert.equal(gen.status, 0, gen.stderr);
    sampleVideoBytes = fs.readFileSync(mp4Path);
  }
  const videoFixture = videoFlowFixture({ bytes: sampleVideoBytes || VIDEO_MP4 });
  const v5Ports = {
    resolveImageCandidates: imgFixture.resolveImageCandidates,
    resolveVisionCandidates: () => [{ adapter: visionAdapter, model: 'vision-fixture::vision', providerBinding: 'sha256:' + 'a'.repeat(64), selectionReason: 'explicit' }],
    resolveVideoCandidates: videoFixture.resolveVideoCandidates,
    resolveTaskAdapter: task => task.providerId === 'vision-fixture' || task.provider === 'vision-fixture' ? visionAdapter
      : task.providerId === 'video-fixture' || task.modelRef === VIDEO_MODEL ? videoFixture.resolveTaskAdapter(task) : imgFixture.resolveTaskAdapter(task)
  };
  const v5App = createApplicationRuntime({ dataRoot: v5Root, ...v5Ports });
  apps.push(v5App);
  await v5App.execute('flow.init', {});
  await v5App.execute('execution.init', { vision: true });

  // Create bound artifacts across 3 capabilities: image-edit, vision, video-generate.
  const editSrc = (await v5App.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const editRun = (await v5App.execute('flow.create', { source_artifact_id: editSrc.id, model_ref: FLOW_MODEL, prompt: 'Bound edit' })).run;
  const editDone = await v5App.execute('flow.continue', { run_id: editRun.id });
  const editOutId = editDone.run.output.artifactId;

  const visSrc = (await v5App.execute('artifact.import', { image_bytes: pngA })).artifact;
  await v5App.execute('creation.vision', { key: uuid(), value: { sourceArtifactId: visSrc.id, modelRef: 'vision-fixture::vision', question: 'Check' } });

  const vidRun = (await v5App.execute('creation.video', { key: uuid(), value: { modelRef: VIDEO_MODEL, prompt: 'Synthetic test video' } })).flow.run;
  await v5App.execute('flow.continue', { run_id: vidRun.id });
  const vidDone = await v5App.execute('flow.continue', { run_id: vidRun.id });
  const vidOutId = vidDone.run.output.artifactId;

  const legacyPair = createConnectionPair({
    dataRoot: v5Root, directory: path.join(root, 'v5-legacy'), origin: 'http://127.0.0.1:1',
    label: 'Legacy v0', scopes: ['read', 'create'], capabilities: ['image-edit'], tools: [...LEGACY_BRIDGE_TOOLS_V0]
  });

  const v5Api = createLocalReadApi({
    dataRoot: v5Root, allowExecution: true, allowMcp: true, executionPorts: v5Ports,
    allowConnectionManagement: true, connectionStore: v5Store, connectionsFile: legacyPair.serverFile
  });
  apis.push(v5Api);
  const v5Session = await v5Api.start();

  const manageV5 = async (route, value) => {
    const response = await fetch(v5Session.origin + '/api/v0/connection-management' + route, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + v5Session.accessToken, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    assert(response.ok, route + ' HTTP ' + response.status);
    return response.json();
  };
  const connectV5 = async (label, capabilities, scopes = ['read', 'create']) => {
    const id = uuid();
    await manageV5('/connections', { key: id, label, scopes, capabilities });
    const httpCfg = (await manageV5('/connections/' + id + '/export', { transport: 'http', format: 'entry' })).configuration;
    const stdioCfg = (await manageV5('/connections/' + id + '/export', { transport: 'stdio', format: 'entry' })).configuration;
    const httpClient = httpMcpClient(v5Session.origin, httpCfg.headers.Authorization.slice(7), { version: '2026-07-28', name: label });
    await httpClient.initialize();
    return { id, httpClient, stdioCfg };
  };

  const editLocal = await connectV5('edit-local', ['image-edit', 'local-media']);
  const visionLocal = await connectV5('vision-local', ['vision', 'local-media']);
  const combinedLocal = await connectV5('combined-local', ['image-edit', 'vision', 'local-media']);
  const videoVisionLocal = await connectV5('video-vision-local', ['video-generate', 'vision', 'local-media']);

  // Edit connection crops its own image-edit output and reads the derived crop.
  const editCrop = parse(await editLocal.httpClient.call('iris_core_crop', { artifactId: editOutId, left: 0, top: 0, width: 16, height: 16 }));
  const editCropRead = await editLocal.httpClient.call('iris_core_image', { artifactId: editCrop.artifact.artifactId });
  assert.equal(editCropRead.content.find(b => b.type === 'image').mimeType, 'image/png');

  // Transitive provenance isolation: vision-only connection (NO image-edit) CANNOT crop editOutId OR read editCrop!
  const deniedCrop = await visionLocal.httpClient.call('iris_core_crop', { artifactId: editOutId, left: 0, top: 0, width: 16, height: 16 });
  assert.equal(deniedCrop.isError, true);
  assert.equal(deniedCrop.structuredContent.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');
  const deniedReadDerived = await visionLocal.httpClient.call('iris_core_image', { artifactId: editCrop.artifact.artifactId });
  assert.equal(deniedReadDerived.isError, true);
  assert.equal(deniedReadDerived.structuredContent.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');

  // Bound diamond DAG provenance: two crops from editOutId -> pixel_diff -> editLocal reads OK, visionLocal still denied!
  const editCrop2 = parse(await editLocal.httpClient.call('iris_core_crop', { artifactId: editOutId, left: 4, top: 4, width: 16, height: 16 }));
  const editDiamondDiff = parse(await editLocal.httpClient.call('iris_core_pixel_diff', { imageAArtifactId: editCrop.artifact.artifactId, imageBArtifactId: editCrop2.artifact.artifactId }));
  const editDiamondOk = await editLocal.httpClient.call('iris_core_image', { artifactId: editDiamondDiff.artifact.artifactId });
  assert.equal(editDiamondOk.isError, undefined, 'authorized connection must read bound diamond heatmap');
  assert.equal(editDiamondOk.content.find(b => b.type === 'image').mimeType, 'image/png');
  const editDiamondDenied = await visionLocal.httpClient.call('iris_core_image', { artifactId: editDiamondDiff.artifact.artifactId });
  assert.equal(editDiamondDenied.isError, true);
  assert.equal(editDiamondDenied.structuredContent.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');

  // Multi-parent diff provenance isolation: heatmap derived from (image-edit, vision) requires BOTH capabilities!
  const crossDiff = parse(await combinedLocal.httpClient.call('iris_core_pixel_diff', { imageAArtifactId: editOutId, imageBArtifactId: visSrc.id }));
  const crossHeatOk = await combinedLocal.httpClient.call('iris_core_image', { artifactId: crossDiff.artifact.artifactId });
  assert.equal(crossHeatOk.content.find(b => b.type === 'image').mimeType, 'image/png');
  const crossHeatDeniedEdit = await editLocal.httpClient.call('iris_core_image', { artifactId: crossDiff.artifact.artifactId });
  assert.equal(crossHeatDeniedEdit.isError, true);
  assert.equal(crossHeatDeniedEdit.structuredContent.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');
  const crossHeatDeniedVision = await visionLocal.httpClient.call('iris_core_image', { artifactId: crossDiff.artifact.artifactId });
  assert.equal(crossHeatDeniedVision.isError, true);
  assert.equal(crossHeatDeniedVision.structuredContent.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');

  // Video artifact rejected by iris_core_crop (415) and unauthorized connection denied (403).
  const cropVideo = await videoVisionLocal.httpClient.call('iris_core_crop', { artifactId: vidOutId, left: 0, top: 0, width: 16, height: 16 });
  assert.equal(cropVideo.isError, true);
  assert.equal(cropVideo.structuredContent.error.code, 'IRIS_API_MEDIA_UNSUPPORTED');
  const unauthFrames = await editLocal.httpClient.call('iris_core_video_frames', { artifactId: vidOutId, maxFrames: 2 });
  assert.equal(unauthFrames.isError, true);
  assert.equal(unauthFrames.structuredContent.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');

  // Legacy frozen connection never gets local-media tools.
  const legacyClient = httpMcpClient(v5Session.origin, JSON.parse(fs.readFileSync(legacyPair.clientFile, 'utf8')).accessToken, { version: '2026-07-28' });
  await legacyClient.initialize();
  assert(!(await legacyClient.request('tools/list')).tools.some(t => ['iris_core_crop', 'iris_core_mux_video_audio', 'iris_core_pixel_diff', 'iris_core_video_frames'].includes(t.name)));

  // Real ffmpeg video frame extraction -> image read -> vision Run creation closed loop (both HTTP and stdio).
  if (ffmpegAvailable()) {
    const extracted = parse(await videoVisionLocal.httpClient.call('iris_core_video_frames', {
      artifactId: vidOutId, maxFrames: 3, targetWidth: 48, format: 'png'
    }));
    assert.equal(extracted.sourceArtifactId, vidOutId);
    assert.equal(extracted.media.width, 96);
    assert.equal(extracted.media.height, 64);
    assert.equal(extracted.frames.length, 3);
    assert(!JSON.stringify(extracted).includes(root));
    const frame1 = extracted.frames[0];
    assert.equal(frame1.frameIndex, 1);
    assert.equal(frame1.mediaType, 'image/png');
    assert.equal(frame1.width, 48);
    assert.equal(frame1.height, 32);

    // Authorized connection reads frame1 bytes via iris_core_image.
    const frameRead = await videoVisionLocal.httpClient.call('iris_core_image', { artifactId: frame1.artifactId });
    assert.deepEqual(Buffer.from(frameRead.content.find(b => b.type === 'image').data, 'base64'), readCoreArtifactBytes(v5Root, frame1.artifactId).bytes);

    // Unauthorized connection (NO video-generate) CANNOT read derived video frame!
    const deniedFrame = await editLocal.httpClient.call('iris_core_image', { artifactId: frame1.artifactId });
    assert.equal(deniedFrame.isError, true);
    assert.equal(deniedFrame.structuredContent.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');

    // Feed derived frame directly into iris_core_create_vision (video -> frames -> vision loop!).
    const visionFromFrame = parse(await videoVisionLocal.httpClient.call('iris_core_create_vision', {
      key: uuid(), sourceArtifactId: frame1.artifactId, modelRef: 'vision-fixture::vision', question: 'Describe this video frame'
    }));
    assert.equal(visionFromFrame.flow.recipe, 'vision/v0');
    assert.equal(visionFromFrame.flow.source.artifactId, frame1.artifactId);

    // Also verify video_frames over stdio transport (JPEG default).
    const vvStdio = stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read,create', { version: '2025-11-25', launch: videoVisionLocal.stdioCfg });
    children.push(vvStdio);
    await vvStdio.initialize();
    const stdioFrames = parse(await vvStdio.call('iris_core_video_frames', { artifactId: vidOutId, maxFrames: 2, targetWidth: 32, quality: 80 }));
    assert.equal(stdioFrames.frames.length, 2);
    assert.equal(stdioFrames.frames[0].mediaType, 'image/jpeg');
    assert.equal((await vvStdio.close()).status, 0);
  }

  console.log('PASS MCP P1 local-media (v1 standalone crop/diff, stdio+HTTP parity, zero billing, transitive provenance isolation, video frames -> vision closed loop, read-only & legacy gates)');
} finally {
  for (const child of children.reverse()) await child.kill();
  for (const api of apis.reverse()) await api.dispose();
  for (const app of apps.reverse()) await app.dispose();
}
