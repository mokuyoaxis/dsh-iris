import assert from 'node:assert/strict';
import { createLocalReadApi } from '../lib/local-api.js';
import { ffmpegAvailable } from '../lib/media-probe.js';
import { createMediaClient } from '../lib/web/media-client.js';
import { RECOVERY_STORAGE_KEY } from '../lib/web/recovery.js';
import { createReadClient } from '../lib/web/transport.js';
import { SUMMARY_MODEL, SUMMARY_TEXT, summaryWorkbenchFixture } from './fixtures/summary-workbench-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-web-summarize');
const fixture = await summaryWorkbenchFixture(root), { visionRequests, videoRunId, videoArtifactId } = fixture;
const nativeFetch = globalThis.fetch, requests = [], saved = new Map();
const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
const available = ffmpegAvailable();
let dropResponse = false, api, session, connection;

async function start({ allowExecution = false, allowLocalWrites = false } = {}) {
  api = createLocalReadApi({ dataRoot: fixture.dataRoot, providerConfigPath: fixture.config, executionPorts: fixture.ports,
    serveWorkbench: true, allowExecution, allowLocalWrites });
  session = await api.start();
}
async function connect() {
  const client = createReadClient(session.accessToken);
  const info = await client.get('/api/v0/session');
  connection = { client, info, media: createMediaClient({ client, session: info, origin: session.origin, getStorage: () => storage }) };
  return connection;
}
function disconnect() { connection?.media.close(); connection?.client.close(); }

try {
  await start({ allowExecution: true });
  globalThis.fetch = async (route, options = {}) => {
    assert(route.startsWith('/api/v0/'));
    requests.push({ path: route, method: options.method });
    const response = await nativeFetch(session.origin + route, options);
    if (dropResponse && route === '/api/v0/summaries' && response.ok) {
      dropResponse = false;
      await response.arrayBuffer();
      throw new TypeError('controlled loss of committed summary response');
    }
    return response;
  };
  let { client, info, media } = await connect();
  assert(info.operations.includes('local-media.frames') && info.operations.includes('summaries.create'));
  const video = await client.getRun(videoRunId);
  assert.equal(video.output.artifactId, videoArtifactId);
  const params = { artifactId: videoArtifactId, maxFrames: 3, targetWidth: 96, format: 'png' };
  let frameArtifactIds;
  if (available) {
    const frames = await client.extractFrames(params);
    assert.equal(frames.sourceArtifactId, videoArtifactId);
    assert.deepEqual(frames.frames.map(item => item.frameIndex), [1, 2, 3]);
    assert(frames.frames.every((item, index) => item.mediaType === 'image/png' && item.width === 96
      && (index === 0 || item.atSec > frames.frames[index - 1].atSec)));
    frameArtifactIds = [frames.frames[0].artifactId, frames.frames[2].artifactId];
    assert.equal((await client.get('/api/v0/artifacts/' + frameArtifactIds[0] + '/content', { binary: true })).type, 'image/png');
  } else {
    const { FLOW_SOURCE, FLOW_RESULT } = await import('./fixtures/image-flow-fixture.mjs');
    frameArtifactIds = [];
    for (const body of [FLOW_SOURCE, FLOW_RESULT]) {
      frameArtifactIds.push((await media.uploadImage(new Blob([body], { type: 'image/png' }))).artifact.artifactId);
    }
  }
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = root;
    await assert.rejects(client.extractFrames(params), { status: 503, code: 'IRIS_LOCAL_MEDIA_UNAVAILABLE' });
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
  assert.equal(visionRequests.length, 0);

  const value = { frameArtifactIds, modelRef: SUMMARY_MODEL, question: '私有测试问题：画面中有什么动作？', transcript: '私有测试字幕：一朵花在摇动。' };
  const initialRequests = requests.length;
  for (const change of [{ frameArtifactIds: [] }, { frameArtifactIds: [frameArtifactIds[0], frameArtifactIds[0]] },
    { question: 'x'.repeat(8193) }, { transcript: 'x'.repeat(6001) }, { asr: true }]) {
    assert.throws(() => media.createSummary({ ...value, ...change }), TypeError);
  }
  assert.equal(requests.length, initialRequests, 'invalid optional inputs never reach Core');

  dropResponse = true;
  await assert.rejects(media.createSummary(value), /controlled loss/);
  assert.equal(visionRequests.length, 0);
  const action = media.snapshot().actions[0];
  assert.equal(action.kind, 'summarize-create');
  assert.deepEqual(Object.keys(action).sort(), ['id', 'key', 'kind']);
  assert(!saved.get(RECOVERY_STORAGE_KEY).includes(frameArtifactIds[0]));
  assert(!saved.get(RECOVERY_STORAGE_KEY).includes('私有测试'));
  const requestCount = requests.length;
  disconnect(); ({ client, info, media } = await connect());
  const [found] = await media.recover();
  assert.equal(found.status, 'confirmed');
  assert.equal(found.action.key, action.key);
  assert.deepEqual(media.snapshot().actions, []);
  assert(requests.slice(requestCount).every(request => request.method === 'GET'));
  const draft = await client.getRun(found.result.result.runId);
  assert.equal(draft.recipe, 'summarize/v0');
  assert.equal(draft.status, 'not_started');
  assert.equal(draft.task, null);
  assert.deepEqual(draft.input, value);
  assert.deepEqual(draft.sources.map(source => source.artifactId), frameArtifactIds);
  assert.equal(visionRequests.length, 0);

  const accepted = media.continueRun(draft.id, draft.revision);
  assert.equal(media.continueRun(draft.id, draft.revision), accepted);
  const { operation } = await accepted;
  let record;
  for (let i = 0; i < 120; i++) {
    record = (await client.getOperation(operation.id)).operation;
    if (!['queued', 'running'].includes(record.state)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(record.state, 'succeeded');
  const completed = await client.getRun(draft.id);
  assert.equal(completed.task.attemptCount, 1);
  assert.deepEqual(visionRequests.map(({ method }) => method), ['POST']);
  assert.match(visionRequests[0].url, /\/chat\/completions$/);
  assert(JSON.stringify(visionRequests[0].body).includes(value.transcript));
  const text = await client.get('/api/v0/artifacts/' + completed.output.artifactId + '/vision-text', { binary: true });
  assert.equal(await text.text(), SUMMARY_TEXT);
  const download = await client.get('/api/v0/runs/' + draft.id + '/download', { download: true });
  assert.equal(await download.blob.text(), SUMMARY_TEXT);
  assert(download.filename.endsWith('.txt'));

  disconnect(); await api.dispose();
  await start({ allowLocalWrites: true }); ({ media } = await connect());
  const draftOnly = await media.createSummary({ frameArtifactIds, modelRef: SUMMARY_MODEL });
  assert.equal(draftOnly.flow.status, 'not_started');
  assert.equal(draftOnly.flow.task, null);
  assert.throws(() => media.continueRun(draftOnly.flow.id, draftOnly.flow.revision), { code: 'IRIS_WEB_CAPABILITY_UNAVAILABLE' });
  disconnect(); await api.dispose();
  await start(); ({ info, media } = await connect());
  assert(!info.operations.includes('summaries.create') && !info.operations.includes('local-media.frames'));
  assert.throws(() => media.createSummary(value), { code: 'IRIS_WEB_CAPABILITY_UNAVAILABLE' });
  assert.equal(visionRequests.length, 1);
  assert.equal(requests.filter(request => request.method === 'POST' && /transcript|transcri/.test(request.path)).length, 0);
  console.log('PASS Web video summary transport, missing ffmpeg, identity-only recovery, zero model calls until explicit execution, plain text and read-only gates');
} finally {
  disconnect();
  await api?.dispose();
  globalThis.fetch = nativeFetch;
}
