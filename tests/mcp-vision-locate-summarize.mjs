import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { LEGACY_BRIDGE_TOOLS_V0 } from '../lib/core-bridge-selection.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { planCoreDeletion } from '../lib/core-maintenance.js';
import { ffmpegAvailable } from '../lib/media-probe.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { VIDEO_MODEL, VIDEO_MP4, videoFlowFixture } from './fixtures/video-flow-fixture.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-vision-locate-summarize');
const uuid = () => crypto.randomUUID();
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(block => block.type === 'text').text); };

const children = [], apis = [], apps = [];
let visionServer;

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

const providerCalls = [];
let nextVisionAnswer = null;

visionServer = http.createServer(async (request, response) => {
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.method, 'POST');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks));
  assert.equal(payload.model, 'vision');
  assert.equal(payload.stream, true);
  const content = payload.messages[0].content;
  const textPart = content.find(item => item.type === 'text')?.text || '';
  const imagePart = content.find(item => item.type === 'image_url')?.image_url?.url || '';
  let imageMeta = null;
  if (imagePart.startsWith('data:image/')) {
    const base64 = imagePart.slice(imagePart.indexOf(',') + 1);
    imageMeta = await sharp(Buffer.from(base64, 'base64')).metadata();
  }
  providerCalls.push({ text: textPart, imageMeta });
  const answer = typeof nextVisionAnswer === 'function' ? nextVisionAnswer({ text: textPart, imageMeta })
    : (nextVisionAnswer ?? '默认视觉回复');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })
    + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + '\n\ndata: [DONE]\n\n'
  );
});
await new Promise(resolve => visionServer.listen(0, '127.0.0.1', resolve));

const providerConfigPath = path.join(root, 'providers.json');
fs.writeFileSync(providerConfigPath, JSON.stringify({
  providers: [{
    id: 'vision-fixture', enabled: true, type: 'openai', apiKey: 'PRIVATE_LOCATE_SUMMARIZE_KEY',
    baseUrl: 'http://127.0.0.1:' + visionServer.address().port + '/v1',
    models: [{ id: 'vision', capabilities: ['vision'] }]
  }],
  assignments: { vision: ['vision-fixture::vision'] }
}), { mode: 0o600 });

try {
  // === 1. v4 root rejects /api/v0/locates and /api/v0/summaries with 409 ===
  const v4Root = path.join(root, 'v4-core');
  const v4App = createApplicationRuntime({ dataRoot: v4Root });
  apps.push(v4App);
  await v4App.execute('flow.init', {});
  await v4App.execute('execution.init', { video: true });
  const v4Api = createLocalReadApi({ dataRoot: v4Root, providerConfigPath, allowLocalWrites: true });
  apis.push(v4Api);
  const v4Session = await v4Api.start();
  for (const [route, body] of [
    ['/api/v0/locates', { sourceArtifactId: 'artifact_' + 'a'.repeat(24), modelRef: 'vision-fixture::vision', target: 'box' }],
    ['/api/v0/summaries', { frameArtifactIds: ['artifact_' + 'a'.repeat(24)], modelRef: 'vision-fixture::vision' }]
  ]) {
    const resp = await fetch(v4Session.origin + route, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + v4Session.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
      body: JSON.stringify(body)
    });
    assert.equal(resp.status, 409, route + ' must require v5 root');
    assert.equal((await resp.json()).error.code, 'IRIS_FLOW_VISION_ROOT_REQUIRED');
  }
  await v4Api.dispose();

  // === 2. Initialize v5 Core with real ffmpeg video fixture + controlled HTTP vision server ===
  const v5Root = path.join(root, 'v5-core');
  const v5Store = path.join(root, 'v5-connections');
  let sampleVideoBytes = null;
  if (ffmpegAvailable()) {
    const mp4Path = path.join(root, 'synthetic.mp4');
    const gen = spawnSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1.2:size=96x64:rate=8',
      '-pix_fmt', 'yuv420p', '-y', mp4Path
    ], { encoding: 'utf8', shell: false });
    assert.equal(gen.status, 0, gen.stderr);
    sampleVideoBytes = fs.readFileSync(mp4Path);
  }
  const videoFixture = videoFlowFixture({ bytes: sampleVideoBytes || VIDEO_MP4 });
  const { configuredImagePorts } = await import('../lib/configured-image-runtime.js');
  const { createProviderRegistry } = await import('../lib/provider-extensions.js');
  const providerRegistry = await createProviderRegistry();
  const visionPorts = configuredImagePorts(providerConfigPath, providerRegistry);
  const combinedPorts = {
    ...visionPorts,
    resolveVideoCandidates: videoFixture.resolveVideoCandidates,
    resolveTaskAdapter: task => (task.providerId === 'video-fixture' || task.modelRef === VIDEO_MODEL)
      ? videoFixture.resolveTaskAdapter(task) : visionPorts.resolveTaskAdapter(task)
  };

  const v5App = createApplicationRuntime({ dataRoot: v5Root, ...combinedPorts });
  apps.push(v5App);
  await v5App.execute('flow.init', {});
  await v5App.execute('execution.init', { vision: true });

  // Create one real video output in v5 root so we can test video-frames -> summarize isolation & closed loop.
  const vidRun = (await v5App.execute('creation.video', { key: uuid(), value: { modelRef: VIDEO_MODEL, prompt: 'Test video for summary' } })).flow.run;
  await v5App.execute('flow.continue', { run_id: vidRun.id });
  const vidDone = await v5App.execute('flow.continue', { run_id: vidRun.id });
  const vidArtifactId = vidDone.run.output.artifactId;

  const legacyPair = createConnectionPair({
    dataRoot: v5Root, directory: path.join(root, 'legacy-pair'), origin: 'http://127.0.0.1:1',
    label: 'Legacy v0', scopes: ['read', 'create'], capabilities: ['image-edit'], tools: [...LEGACY_BRIDGE_TOOLS_V0]
  });

  const apiOptions = {
    dataRoot: v5Root, providerConfigPath, allowExecution: true, allowMcp: true, executionPorts: combinedPorts,
    allowConnectionManagement: true, connectionStore: v5Store, connectionsFile: legacyPair.serverFile
  };
  let api = createLocalReadApi(apiOptions);
  apis.push(api);
  let session = await api.start();

  const ownerFetch = async (route, value, key) => {
    const resp = await fetch(session.origin + route, {
      method: value === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + session.accessToken,
        ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {})
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    return resp;
  };
  const ownerJson = async (route, value, key) => {
    const resp = await ownerFetch(route, value, key);
    const body = await resp.json();
    assert(resp.ok, `${route} HTTP ${resp.status}: ${JSON.stringify(body)}`);
    return body;
  };

  const createMcpClients = async (label, capabilities, scopes = ['read', 'create', 'execute', 'stop']) => {
    const id = uuid();
    await ownerJson('/api/v0/connection-management/connections', { key: id, label, scopes, capabilities });
    const httpCfg = (await ownerJson('/api/v0/connection-management/connections/' + id + '/export', { transport: 'http', format: 'entry' })).configuration;
    const stdioCfg = (await ownerJson('/api/v0/connection-management/connections/' + id + '/export', { transport: 'stdio', format: 'entry' })).configuration;
    const skill = await ownerJson('/api/v0/connection-management/connections/' + id + '/skill', {});
    const httpClient = httpMcpClient(session.origin, httpCfg.headers.Authorization.slice(7), { version: '2026-07-28', name: label + '-http' });
    await httpClient.initialize();
    const stdioClient = stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', scopes.join(','), { version: '2025-11-25', name: label + '-stdio', launch: stdioCfg });
    children.push(stdioClient);
    await stdioClient.initialize();
    return { id, http: httpClient, stdio: stdioClient, skill };
  };

  const waitOperation = async (client, operationId) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = parse(await client.call('iris_core_operation', { operationId, waitMs: 4000 }));
      if (!['queued', 'running'].includes(result.operation.state)) return result.operation;
    }
    throw new Error('Operation timed out: ' + operationId);
  };

  // Verify catalog exposes both new v5 groups under media: 'vision'.
  const catalog = await ownerJson('/api/v0/connection-management/catalog');
  assert.equal(catalog.groups.length, 10);
  assert.deepEqual(catalog.media.find(m => m.id === 'vision').capabilities, ['vision', 'ocr', 'vision-locate', 'media-summarize']);

  const locateOnly = await createMcpClients('Locate only', ['vision-locate']);
  const locateCrop = await createMcpClients('Locate+Crop', ['vision-locate', 'local-media']);
  const summarizeOnly = await createMcpClients('Summarize only', ['media-summarize']);
  const summarizeVideo = await createMcpClients('Summarize+Video', ['media-summarize', 'video-generate', 'local-media']);
  const visionOnly = await createMcpClients('Vision only', ['vision']);
  const legacyToken = JSON.parse(fs.readFileSync(legacyPair.clientFile, 'utf8')).accessToken;
  const legacyClient = httpMcpClient(session.origin, legacyToken, { version: '2026-07-28', name: 'legacy' });
  await legacyClient.initialize();

  // === 3. Tool registration, annotations & skill checks ===
  const locateTools = (await locateOnly.http.request('tools/list')).tools;
  const locateToolNames = locateTools.map(t => t.name).sort();
  assert(locateToolNames.includes('iris_core_create_locate'));
  assert(locateToolNames.includes('iris_core_locate_result'));
  assert(locateToolNames.includes('iris_core_vision_models'));
  assert(!locateToolNames.includes('iris_core_create_vision'));
  assert(!locateToolNames.includes('iris_core_create_summarize'));
  assert(!locateToolNames.includes('iris_core_vision_text'));
  assert.deepEqual(locateTools.find(t => t.name === 'iris_core_create_locate').annotations,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(locateTools.find(t => t.name === 'iris_core_locate_result').annotations,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert(locateOnly.skill.preview.includes('iris_core_create_locate'));
  assert(locateOnly.skill.preview.includes('iris_core_locate_result'));

  const sumTools = (await summarizeOnly.http.request('tools/list')).tools;
  const sumToolNames = sumTools.map(t => t.name).sort();
  assert(sumToolNames.includes('iris_core_create_summarize'));
  assert(sumToolNames.includes('iris_core_vision_text'));
  assert(!sumToolNames.includes('iris_core_create_locate'));
  assert(!sumToolNames.includes('iris_core_locate_result'));
  assert.deepEqual(sumTools.find(t => t.name === 'iris_core_create_summarize').annotations,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert(summarizeOnly.skill.preview.includes('iris_core_create_summarize'));

  assert(!(await legacyClient.request('tools/list')).tools.some(t => /locate|summarize/.test(t.name)));

  // === 4. vision-locate end-to-end + closed loop into iris_core_crop ===
  // 160x80 white image with a pure green rectangle at x=[80..140), y=[20..60).
  const scenePng = await makePng(160, 80, (x, y) => (x >= 80 && x < 140 && y >= 20 && y < 60) ? [0, 255, 0] : [255, 255, 255]);
  const sceneArt = parse(await locateCrop.http.call('iris_core_import_image', {
    key: uuid(), imageBase64: scenePng.toString('base64'), mediaType: 'image/png'
  })).artifact;

  const locateKey = uuid();
  const locateDraft = parse(await locateCrop.http.call('iris_core_create_locate', {
    key: locateKey, sourceArtifactId: sceneArt.artifactId, modelRef: 'vision-fixture::vision', target: '绿色矩形区域'
  }));
  assert.equal(locateDraft.flow.status, 'not_started');
  assert.equal(locateDraft.flow.recipe, 'locate/v0');
  assert.equal(providerCalls.length, 0, 'create_locate never invokes vision model');

  // Idempotent replay via stdio MCP returns the exact same flow.
  const locateReplay = parse(await locateCrop.stdio.call('iris_core_create_locate', {
    key: locateKey, sourceArtifactId: sceneArt.artifactId, modelRef: 'vision-fixture::vision', target: '绿色矩形区域'
  }));
  assert.equal(locateReplay.flow.id, locateDraft.flow.id);
  assert.equal(providerCalls.length, 0);

  // Reusing key with different target produces conflict.
  const locateConflict = await locateCrop.http.call('iris_core_create_locate', {
    key: locateKey, sourceArtifactId: sceneArt.artifactId, modelRef: 'vision-fixture::vision', target: '其他目标'
  });
  assert.equal(locateConflict.isError, true);

  // Execute locate/v0: model responds in 0-1000 normalized coordinates -> mapped to exact pixels (80, 20, 140, 60).
  nextVisionAnswer = '{"x1":500,"y1":250,"x2":875,"y2":750}';
  const locOp = parse(await locateCrop.http.call('iris_core_continue', {
    key: uuid(), runId: locateDraft.flow.id, expectedRevision: locateDraft.flow.revision
  })).operation;
  assert.equal((await waitOperation(locateCrop.http, locOp.id)).state, 'succeeded');
  assert.equal(providerCalls.length, 1);
  assert(providerCalls[0].text.includes('0–1000'), 'locate prompt uses normalized 0-1000 coordinates');

  const locateRun = parse(await locateCrop.http.call('iris_core_run', { runId: locateDraft.flow.id }));
  assert.equal(locateRun.status, 'ready');
  assert.equal(locateRun.recipe, 'locate/v0');
  assert.equal(locateRun.input.target, '绿色矩形区域');
  assert.deepEqual(locateRun.locate, {
    target: '绿色矩形区域', width: 160, height: 80, found: true,
    bbox: { x1: 80, y1: 20, x2: 140, y2: 60, left: 80, top: 20, width: 60, height: 40 }
  });

  // Read structured pixel coordinates via both HTTP and stdio MCP.
  const locJsonHttp = parse(await locateCrop.http.call('iris_core_locate_result', { artifactId: locateRun.output.artifactId }));
  const locJsonStdio = parse(await locateCrop.stdio.call('iris_core_locate_result', { artifactId: locateRun.output.artifactId }));
  assert.deepEqual(locJsonHttp.bbox, { x1: 80, y1: 20, x2: 140, y2: 60, left: 80, top: 20, width: 60, height: 40 });
  assert.equal(locJsonHttp.found, true);
  assert.deepEqual(locJsonStdio.bbox, locJsonHttp.bbox);
  assert(!JSON.stringify([locateRun, locJsonHttp]).includes('PRIVATE_'));
  assert(!JSON.stringify([locateRun, locJsonHttp]).includes(root));

  // Direct closed-loop handoff: bbox.{left,top,width,height} -> iris_core_crop -> verify pure green pixels!
  const cropped = parse(await locateCrop.http.call('iris_core_crop', {
    artifactId: sceneArt.artifactId,
    left: locJsonHttp.bbox.left, top: locJsonHttp.bbox.top, width: locJsonHttp.bbox.width, height: locJsonHttp.bbox.height
  }));
  assert.equal(cropped.artifact.width, 60);
  assert.equal(cropped.artifact.height, 40);
  const cropRaw = await sharp(readCoreArtifactBytes(v5Root, cropped.artifact.artifactId).bytes).removeAlpha().raw().toBuffer();
  assert.deepEqual([cropRaw[0], cropRaw[1], cropRaw[2]], [0, 255, 0], 'cropped region matches located green box');

  // Download endpoint serves .json attachment for locate/v0.
  const dlLocate = await ownerFetch('/api/v0/runs/' + locateRun.id + '/download');
  assert.equal(dlLocate.status, 200);
  assert.equal(dlLocate.headers.get('content-type'), 'application/json');
  assert.match(dlLocate.headers.get('content-disposition'), /^attachment; filename="iris-artifact_[a-f0-9]{24}\.json"$/);
  assert.equal(JSON.parse(await dlLocate.text()).found, true);

  // found: false locate run.
  nextVisionAnswer = '{"found":false}';
  const notFoundDraft = parse(await locateOnly.stdio.call('iris_core_create_locate', {
    key: uuid(), sourceArtifactId: sceneArt.artifactId, modelRef: 'vision-fixture::vision', target: '不存在的红色三角'
  }));
  const notFoundOp = parse(await locateOnly.http.call('iris_core_continue', {
    key: uuid(), runId: notFoundDraft.flow.id, expectedRevision: notFoundDraft.flow.revision
  })).operation;
  assert.equal((await waitOperation(locateOnly.http, notFoundOp.id)).state, 'succeeded');
  const notFoundRun = parse(await locateOnly.http.call('iris_core_run', { runId: notFoundDraft.flow.id }));
  assert.equal(notFoundRun.status, 'ready');
  assert.equal(notFoundRun.locate.found, false);
  assert.equal(notFoundRun.locate.bbox, undefined);
  assert.equal(parse(await locateOnly.stdio.call('iris_core_locate_result', { artifactId: notFoundRun.output.artifactId })).found, false);

  // Invalid / out-of-bounds bbox from model fails cleanly without corrupt JSON delivery.
  nextVisionAnswer = '{"x1":1200,"y1":10,"x2":1500,"y2":100}';
  const badDraft = parse(await locateOnly.http.call('iris_core_create_locate', {
    key: uuid(), sourceArtifactId: sceneArt.artifactId, modelRef: 'vision-fixture::vision', target: '越界目标'
  }));
  const badOp = parse(await locateOnly.http.call('iris_core_continue', {
    key: uuid(), runId: badDraft.flow.id, expectedRevision: badDraft.flow.revision
  })).operation;
  assert.equal((await waitOperation(locateOnly.http, badOp.id)).state, 'succeeded');
  const badRun = parse(await locateOnly.http.call('iris_core_run', { runId: badDraft.flow.id }));
  assert.equal(badRun.status, 'needs_attention');
  assert.equal(badRun.output, null);
  assert.equal(badRun.task.errorSummary?.category, 'protocol');

  // Strict capability isolation for vision-locate.
  assert.equal((await visionOnly.http.call('iris_core_run', { runId: locateRun.id })).isError, true);
  assert.equal((await summarizeOnly.http.call('iris_core_run', { runId: locateRun.id })).isError, true);
  assert.equal((await visionOnly.http.call('iris_core_vision_text', { artifactId: locateRun.output.artifactId })).isError, true);
  assert.equal((await legacyClient.call('iris_core_run', { runId: locateRun.id })).isError, true);
  const locateRunsList = parse(await locateOnly.http.call('iris_core_runs', { kind: 'locate' }));
  assert.equal(locateRunsList.total, 3);
  assert(locateRunsList.runs.every(r => r.recipe === 'locate/v0'));

  // === 5. media-summarize end-to-end: video frames -> contact sheet + transcript -> summary ===
  let videoFrameIds = [];
  if (ffmpegAvailable()) {
    const extracted = parse(await summarizeVideo.http.call('iris_core_video_frames', { artifactId: vidArtifactId, maxFrames: 3 }));
    assert.equal(extracted.frames.length, 3);
    videoFrameIds = extracted.frames.map(f => f.artifactId);

    // Per-frame capability isolation: summarizeOnly (WITHOUT video-generate) MUST be denied summarizing video-derived frames!
    const deniedVideoFrames = await summarizeOnly.http.call('iris_core_create_summarize', {
      key: uuid(), frameArtifactIds: videoFrameIds, modelRef: 'vision-fixture::vision', question: '未授权尝试'
    });
    assert.equal(deniedVideoFrames.isError, true);
    assert.equal(deniedVideoFrames.structuredContent.error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');

    // Authorized summarizeVideo passes reversed frame order; Core sorts video-frame inputs chronologically.
    const sumKey = uuid();
    const sumDraft = parse(await summarizeVideo.http.call('iris_core_create_summarize', {
      key: sumKey,
      frameArtifactIds: [videoFrameIds[2], videoFrameIds[0], videoFrameIds[1]],
      modelRef: 'vision-fixture::vision',
      question: '请用一句话概括画面与口播内容',
      transcript: '测试旁白：这段合成测试视频展示了彩色测试条。'
    }));
    assert.equal(sumDraft.flow.status, 'not_started');
    assert.equal(sumDraft.flow.recipe, 'summarize/v0');
    assert.equal(sumDraft.flow.sources.length, 3);

    const callsBeforeSum = providerCalls.length;
    // Idempotent replay via stdio MCP.
    const sumReplay = parse(await summarizeVideo.stdio.call('iris_core_create_summarize', {
      key: sumKey,
      frameArtifactIds: [videoFrameIds[2], videoFrameIds[0], videoFrameIds[1]],
      modelRef: 'vision-fixture::vision',
      question: '请用一句话概括画面与口播内容',
      transcript: '测试旁白：这段合成测试视频展示了彩色测试条。'
    }));
    assert.equal(sumReplay.flow.id, sumDraft.flow.id);
    assert.equal(providerCalls.length, callsBeforeSum);

    nextVisionAnswer = '视频由 3 帧彩色测试条画面组成，旁白说明这是一段合成测试视频。';
    const sumOp = parse(await summarizeVideo.http.call('iris_core_continue', {
      key: uuid(), runId: sumDraft.flow.id, expectedRevision: sumDraft.flow.revision
    })).operation;
    assert.equal((await waitOperation(summarizeVideo.http, sumOp.id)).state, 'succeeded');
    assert.equal(providerCalls.length, callsBeforeSum + 1, 'contact sheet uses a single vision call');
    const sumCall = providerCalls.at(-1);
    assert(sumCall.text.includes('请用一句话概括画面与口播内容'));
    assert(sumCall.text.includes('测试旁白：这段合成测试视频展示了彩色测试条。'));
    assert(sumCall.imageMeta.width > 96 * 2, 'contact sheet tiles multiple frames horizontally: ' + sumCall.imageMeta.width);

    const sumRun = parse(await summarizeVideo.http.call('iris_core_run', { runId: sumDraft.flow.id }));
    assert.equal(sumRun.status, 'ready');
    assert.equal(sumRun.recipe, 'summarize/v0');
    assert.equal(sumRun.sources.length, 3);
    assert.equal(sumRun.input.frameArtifactIds.length, 3);
    assert.equal(sumRun.input.transcript, '测试旁白：这段合成测试视频展示了彩色测试条。');

    const sumTextHttp = parse(await summarizeVideo.http.call('iris_core_vision_text', { artifactId: sumRun.output.artifactId }));
    const sumTextStdio = parse(await summarizeVideo.stdio.call('iris_core_vision_text', { artifactId: sumRun.output.artifactId }));
    assert.match(sumTextHttp.text, /彩色测试条/);
    assert.equal(sumTextStdio.text, sumTextHttp.text);
    assert.equal((await visionOnly.http.call('iris_core_vision_text', { artifactId: sumRun.output.artifactId })).isError, true);
    assert.equal((await locateOnly.http.call('iris_core_run', { runId: sumRun.id })).isError, true);
  }

  // Static PNG frames (no video-frame metadata, default question, no transcript) via summarizeOnly.
  const staticA = parse(await summarizeOnly.http.call('iris_core_import_image', {
    key: uuid(), imageBase64: (await makePng(80, 60, () => [200, 40, 40])).toString('base64'), mediaType: 'image/png'
  })).artifact;
  const staticB = parse(await summarizeOnly.stdio.call('iris_core_import_image', {
    key: uuid(), imageBase64: (await makePng(80, 60, () => [40, 40, 200])).toString('base64'), mediaType: 'image/png'
  })).artifact;
  const staticSumDraft = parse(await summarizeOnly.stdio.call('iris_core_create_summarize', {
    key: uuid(), frameArtifactIds: [staticA.artifactId, staticB.artifactId], modelRef: 'vision-fixture::vision'
  }));
  nextVisionAnswer = '先红后蓝的两帧静态图变化。';
  const staticSumOp = parse(await summarizeOnly.http.call('iris_core_continue', {
    key: uuid(), runId: staticSumDraft.flow.id, expectedRevision: staticSumDraft.flow.revision
  })).operation;
  assert.equal((await waitOperation(summarizeOnly.http, staticSumOp.id)).state, 'succeeded');
  const staticSumRun = parse(await summarizeOnly.http.call('iris_core_run', { runId: staticSumDraft.flow.id }));
  assert.equal(staticSumRun.status, 'ready');
  assert.match(parse(await summarizeOnly.http.call('iris_core_vision_text', { artifactId: staticSumRun.output.artifactId })).text, /先红后蓝/);
  // Static images bound to summarize/v0 are now isolated from unrelated capabilities.
  assert.equal((await visionOnly.http.call('iris_core_image', { artifactId: staticA.artifactId })).isError, true);
  assert.equal((await summarizeOnly.http.call('iris_core_image', { artifactId: staticA.artifactId })).isError, undefined);

  // Validation rejections for summarize/v0 (empty, duplicates, >20, non-image artifact, host path).
  for (const invalidArgs of [
    { key: uuid(), frameArtifactIds: [], modelRef: 'vision-fixture::vision' },
    { key: uuid(), frameArtifactIds: [staticA.artifactId, staticA.artifactId], modelRef: 'vision-fixture::vision' },
    { key: uuid(), frameArtifactIds: Array.from({ length: 21 }, (_, i) => 'artifact_' + String(i).padStart(24, '0')), modelRef: 'vision-fixture::vision' },
    { key: uuid(), frameArtifactIds: [vidArtifactId], modelRef: 'vision-fixture::vision' },
    { key: uuid(), frameArtifactIds: [staticA.artifactId], modelRef: 'vision-fixture::vision', videoPath: '/etc/passwd' }
  ]) {
    const res = await summarizeVideo.http.call('iris_core_create_summarize', invalidArgs);
    assert.equal(res.isError, true, 'must reject invalid summarize args: ' + JSON.stringify(invalidArgs));
  }

  // iris_core_runs kind=summarize filter.
  const sumRunsList = parse(await summarizeVideo.http.call('iris_core_runs', { kind: 'summarize' }));
  assert.equal(sumRunsList.total, ffmpegAvailable() ? 2 : 1);
  assert(sumRunsList.runs.every(r => r.recipe === 'summarize/v0'));

  // flowReferences deletion protection covers summarize/v0 multi-source frames!
  const deletePlan = planCoreDeletion(v5Root, { artifact_ids: [staticA.artifactId, staticB.artifactId] });
  assert.equal(deletePlan.allowed, false, 'referenced summary source frames must be blocked from deletion');
  assert(deletePlan.blockers.some(b => b.id === staticA.artifactId && b.reason === 'flow_artifact_reference'));
  assert(deletePlan.blockers.some(b => b.id === staticB.artifactId && b.reason === 'flow_artifact_reference'));

  // === 6. Restart Core: durable facts survive with zero extra provider calls ===
  const callsBeforeRestart = providerCalls.length;
  for (const c of children) await c.close();
  children.length = 0;
  await api.dispose();
  api = createLocalReadApi(apiOptions);
  apis.push(api);
  session = await api.start();
  const persistedLocate = await ownerJson('/api/v0/runs/' + locateRun.id);
  assert.deepEqual(persistedLocate.locate.bbox, locateRun.locate.bbox);
  const persistedSum = await ownerJson('/api/v0/runs/' + staticSumRun.id);
  assert.equal(persistedSum.sources.length, 2);
  assert.equal(providerCalls.length, callsBeforeRestart, 'restart never re-invokes vision provider');

  await providerRegistry.dispose();
  console.log('PASS MCP vision-locate (bbox -> crop closed loop, found=false, invalid bbox, JSON download) & media-summarize (video frames contact sheet + transcript, static frames, per-frame isolation, delete protection, HTTP/stdio, restart)');
} finally {
  for (const child of children) await child.kill();
  for (const service of apis) await service.dispose();
  for (const application of apps) await application.dispose();
  await new Promise(resolve => visionServer.close(resolve));
}
