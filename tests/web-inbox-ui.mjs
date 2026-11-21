import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createVisionProviderAdapter } from '../lib/vision-provider-adapter.js';
import { createReadClient } from '../lib/web/transport.js';
import { presentFlow } from '../lib/web/flow-view.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-web-inbox-ui');
const uuid = () => crypto.randomUUID();
const nativeFetch = globalThis.fetch;

function makeWav(dataBytes = 1024) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

let api, client;
const apps = [];

try {
  // === 1. flow-view presentation for locate/v0 and summarize/v0 ===
  const locReady = presentFlow({ contractVersion: 0, recipe: 'locate/v0', status: 'ready' }, ['runs.continue']);
  assert.equal(locReady.title, '定位结果已保存');
  assert.equal(locReady.tone, 'success');
  const locMissing = presentFlow({ contractVersion: 0, recipe: 'locate/v0', status: 'ready', locate: { found: false } }, ['runs.continue']);
  assert.equal(locMissing.title, '未在图中找到目标');
  const sumReady = presentFlow({ contractVersion: 0, recipe: 'summarize/v0', status: 'ready' }, ['runs.continue']);
  assert.equal(sumReady.title, '摘要结果已保存');
  assert.equal(sumReady.tone, 'success');
  assert.equal(presentFlow({ contractVersion: 0, recipe: 'locate/v0', status: 'not_started' }, ['runs.continue']).title, '已保存，尚未开始');
  assert.equal(presentFlow({ contractVersion: 0, recipe: 'summarize/v0', status: 'not_started' }, ['runs.continue']).title, '已保存，尚未开始');

  // === 2. Set up v5 Core + inboxDir + controlled vision adapter ===
  const dataRoot = path.join(root, 'v5-core');
  const inboxDir = path.join(root, 'inbox-dir');
  fs.mkdirSync(inboxDir, { mode: 0o700 });
  const pngBytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 69, g: 49, b: 125 } } }).png().toBuffer();
  const wavBytes = makeWav(2048);
  fs.writeFileSync(path.join(inboxDir, 'iris-sample.png'), pngBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(inboxDir, 'voice-note.wav'), wavBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(inboxDir, 'ignore.txt'), 'not media', { mode: 0o600 });

  const modelRef = 'vision-web::vision';
  const config = path.join(root, 'providers.json');
  fs.writeFileSync(config, JSON.stringify({
    providers: [{ id: 'vision-web', type: 'openai', baseUrl: 'https://vision-web.invalid/v1', apiKey: 'SYNTHETIC_KEY',
      models: [{ id: 'vision', capabilities: ['vision'] }] }],
    assignments: { vision: [modelRef] }
  }), { mode: 0o600 });

  let modeAnswer = '{"x1":100,"y1":200,"x2":500,"y2":800}';
  const adapter = createVisionProviderAdapter(
    { id: 'vision-web', type: 'openai', baseUrl: 'https://vision-web.invalid/v1', apiKey: 'SYNTHETIC_KEY' },
    {
      fetchPort: async () => new Response(
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: modeAnswer }, finish_reason: null }] })
        + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
  );
  const ports = {
    resolveVisionCandidates: () => [{ adapter, model: modelRef, providerBinding: 'sha256:' + 'b'.repeat(64), selectionReason: 'explicit' }],
    resolveTaskAdapter: () => adapter
  };

  const app = createApplicationRuntime({ dataRoot, ...ports });
  apps.push(app);
  await app.execute('flow.init', {});
  await app.execute('execution.init', { vision: true });

  api = createLocalReadApi({ dataRoot, providerConfigPath: config, serveWorkbench: true, allowExecution: true, executionPorts: ports, inboxDir });
  const session = await api.start();

  // Verify served workbench HTML/CSS preserves Iris 6-color palette & mounts inbox / locate / summarize UI elements.
  const html = await (await nativeFetch(session.origin + '/')).text();
  assert(html.includes('id="overview-inbox"'));
  assert(html.includes('id="inbox-picker"'));
  assert(html.includes('data-gallery-kind="locate"'));
  assert(html.includes('data-gallery-kind="summarize"'));
  const css = await (await nativeFetch(session.origin + '/styles.css')).text();
  assert(css.includes('--iris-gradient:linear-gradient(105deg,#45317D,#6F69B8,#BB78AD,#E59B76,#ED9C91,#F0D09C)'),
    'Iris 6-color gradient token must remain intact');
  assert(css.includes('.overview-inbox') && css.includes('.inbox-picker'));

  globalThis.fetch = (resource, options = {}) => nativeFetch(session.origin + resource, options);
  client = createReadClient(session.accessToken);
  const info = await client.get('/api/v0/session');
  assert.equal(info.vision, true);
  assert.equal(info.inbox, true);
  assert(info.operations.includes('inbox.list'));
  assert(info.operations.includes('inbox.import'));
  assert(info.operations.includes('locates.create'));
  assert(info.operations.includes('summaries.create'));
  assert(info.operations.includes('locate.content'));

  // List & filter inbox via Web transport client (zero host path leakage).
  const allInbox = await client.listInbox({ limit: 50 });
  assert.deepEqual(allInbox.files.map(e => e.name).sort(), ['iris-sample.png', 'voice-note.wav']);
  assert(!JSON.stringify(allInbox).includes(inboxDir));
  assert.deepEqual((await client.listInbox({ kind: 'image' })).files.map(e => e.name), ['iris-sample.png']);
  assert.deepEqual((await client.listInbox({ kind: 'audio' })).files.map(e => e.name), ['voice-note.wav']);

  // Import image & audio via Web transport with idempotent replay; original files untouched.
  const imgKey = uuid();
  const imgImported = await client.importInboxFile('iris-sample.png', { key: imgKey });
  assert.equal(imgImported.artifact.mediaType, 'image/png');
  assert.equal(imgImported.artifact.width, 120);
  assert.equal((await client.importInboxFile('iris-sample.png', { key: imgKey })).artifact.artifactId, imgImported.artifact.artifactId);
  assert.deepEqual(fs.readFileSync(path.join(inboxDir, 'iris-sample.png')), pngBytes);

  const wavImported = await client.importInboxFile('voice-note.wav', { key: uuid() });
  assert.equal(wavImported.artifact.mediaType, 'audio/wav');
  assert.deepEqual(fs.readFileSync(path.join(inboxDir, 'voice-note.wav')), wavBytes);

  // Create & execute locate/v0 + summarize/v0 and verify Web read/lookup/download endpoints.
  const locKey = uuid();
  const locDraft = await (await nativeFetch(session.origin + '/api/v0/locates', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': locKey },
    body: JSON.stringify({ sourceArtifactId: imgImported.artifact.artifactId, modelRef, target: '紫色色块' })
  })).json();
  assert.equal((await client.lookupCreation('locate-create', locKey)).result.runId, locDraft.flow.id);
  await client.continueRun(locDraft.flow.id, locDraft.flow.revision, { key: uuid() });
  let locRun;
  for (let i = 0; i < 100; i++) {
    locRun = await client.getRun(locDraft.flow.id);
    if (locRun.status === 'ready') break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(locRun.status, 'ready');
  assert.equal(locRun.locate.found, true);
  const locJson = await client.get('/api/v0/artifacts/' + locRun.output.artifactId + '/locate-result');
  assert.equal(locJson.bbox.left, 12);
  const locDl = await client.get('/api/v0/runs/' + locRun.id + '/download', { download: true });
  assert.equal(locDl.blob.type, 'application/json');
  assert.match(locDl.filename, /^iris-artifact_[a-f0-9]{24}\.json$/);

  modeAnswer = '一张紫色矩形图摘要。';
  const sumKey = uuid();
  const sumDraft = await (await nativeFetch(session.origin + '/api/v0/summaries', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': sumKey },
    body: JSON.stringify({ frameArtifactIds: [imgImported.artifact.artifactId], modelRef, question: '简述画面' })
  })).json();
  assert.equal((await client.lookupCreation('summarize-create', sumKey)).result.runId, sumDraft.flow.id);
  await client.continueRun(sumDraft.flow.id, sumDraft.flow.revision, { key: uuid() });
  let sumRun;
  for (let i = 0; i < 100; i++) {
    sumRun = await client.getRun(sumDraft.flow.id);
    if (sumRun.status === 'ready') break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(sumRun.status, 'ready');
  assert.equal((await client.get('/api/v0/runs?kind=locate')).total, 1);
  assert.equal((await client.get('/api/v0/runs?kind=summarize')).total, 1);

  // Read-only workbench with inboxDir: session exposes inbox.list (browsing) but NOT inbox.import.
  client.close(); client = null;
  await api.dispose();
  api = createLocalReadApi({ dataRoot, providerConfigPath: config, serveWorkbench: true, allowExecution: false, allowLocalWrites: false, inboxDir });
  const roSession = await api.start();
  globalThis.fetch = (resource, options = {}) => nativeFetch(roSession.origin + resource, options);
  client = createReadClient(roSession.accessToken);
  const roInfo = await client.get('/api/v0/session');
  assert.equal(roInfo.inbox, true);
  assert(roInfo.operations.includes('inbox.list'));
  assert(!roInfo.operations.includes('inbox.import'));
  assert.equal((await client.listInbox()).files.length, 2);

  console.log('PASS Web inbox transport, palette preservation, read-only/writable inbox gates, and locate/summarize Web endpoints');
} finally {
  client?.close();
  globalThis.fetch = nativeFetch;
  await api?.dispose();
  for (const a of apps) await a.dispose();
}
