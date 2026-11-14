import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createVisionProviderAdapter } from '../lib/vision-provider-adapter.js';
import { createReadClient } from '../lib/web/transport.js';
import { createMediaClient } from '../lib/web/media-client.js';
import { RECOVERY_STORAGE_KEY } from '../lib/web/recovery.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-web-vision-creation'), dataRoot = path.join(root, 'core');
const modelRef = 'vision-web::vision', nativeFetch = globalThis.fetch, requests = [], saved = new Map();
const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
let modelPosts = 0, lose, api, session, current;
const adapter = createVisionProviderAdapter({ id: 'vision-web', type: 'openai', baseUrl: 'https://controlled.invalid/v1', apiKey: 'SYNTHETIC_WEB_KEY' }, {
  fetchPort: async () => { modelPosts++; return new Response('data: {"choices":[{"index":0,"delta":{"content":"已保存的识别文字"},"finish_reason":null}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
});
const ports = { resolveVisionCandidates: () => [{ adapter, model: modelRef, providerBinding: 'sha256:' + 'f'.repeat(64), selectionReason: 'explicit' }], resolveTaskAdapter: () => adapter };
const config = path.join(root, 'providers.json');
fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'vision-web', type: 'openai', baseUrl: 'https://controlled.invalid/v1', apiKey: 'SYNTHETIC_WEB_KEY',
  models: [{ id: 'vision', capabilities: ['vision'] }] }], assignments: { vision: [modelRef] } }), { mode: 0o600 });
const initializer = createApplicationRuntime({ dataRoot });
async function start({ execution = true, writes = false } = {}) {
  api = createLocalReadApi({ dataRoot, providerConfigPath: config, allowExecution: execution, allowLocalWrites: writes, serveWorkbench: true, executionPorts: ports });
  session = await api.start();
}
async function connect() {
  const client = createReadClient(session.accessToken), info = await client.get('/api/v0/session');
  return { client, info, media: createMediaClient({ client, session: info, origin: session.origin, getStorage: () => storage }) };
}
function close() { current?.media.close(); current?.client.close(); }
const postCount = () => requests.filter(r => r.method === 'POST').length;
async function terminal(id) {
  for (let i = 0; i < 200; i++) {
    const result = await current.client.getOperation(id);
    if (!['queued', 'running'].includes(result.operation.state)) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Controlled vision Operation did not finish');
}
try {
  await initializer.execute('flow.init', {}); await initializer.execute('execution.init', { vision: true }); await initializer.dispose();
  await start();
  globalThis.fetch = async (resource, options = {}) => {
    assert(typeof resource === 'string' && resource.startsWith('/api/v0/'), 'Web transport stays on the current Core');
    requests.push({ path: resource, method: options.method || 'GET' });
    const response = await nativeFetch(session.origin + resource, options);
    if (lose === resource && options.method === 'POST' && response.ok) { lose = null; await response.arrayBuffer(); throw new TypeError('fixture lost committed creation response'); }
    return response;
  };
  current = await connect(); assert.equal(current.info.vision, true);
  assert(current.info.operations.includes('visions.create')); assert(current.info.operations.includes('ocrs.create'));
  const image = new Blob([await sharp({ create: { width: 100, height: 250, channels: 3, background: 'white' } }).png().toBuffer()], { type: 'image/png' });
  const source = (await current.media.uploadImage(image)).artifact.artifactId;
  const runs = [];
  for (const [kind, method, route, input] of [
    ['vision-create', 'createVision', '/api/v0/visions', { modelRef, sourceArtifactId: source, question: 'PRIVATE_QUESTION 图中写了什么？' }],
    ['ocr-create', 'createOcr', '/api/v0/ocrs', { modelRef, sourceArtifactId: source, chunkHeight: 100, overlap: 0, maxInvocations: 1, maxDimension: 2048 }]
  ]) {
    const before = modelPosts; lose = route;
    await assert.rejects(current.media[method](input), TypeError);
    assert.equal(modelPosts, before, 'Saving a draft never invokes the model');
    const action = current.media.snapshot().actions.find(a => a.kind === kind);
    assert(action && action.artifactId === source);
    assert(!saved.get(RECOVERY_STORAGE_KEY).includes('PRIVATE_QUESTION'), 'Recovery storage contains identities, not questions');
    assert(!saved.get(RECOVERY_STORAGE_KEY).includes('maxInvocations'), 'Recovery storage does not persist draft parameters');
    const post = postCount();
    assert.throws(() => current.media.retry(action.id, { ...input, sourceArtifactId: 'artifact_' + 'a'.repeat(24) }), TypeError);
    assert.equal(postCount(), post);
    close(); current = await connect();
    await current.media.recover(); assert.equal(postCount(), post); assert.equal(modelPosts, before);
    assert.equal(current.media.snapshot().actions.length, 0, 'Committed draft is found by the original key');
    const lookup = await current.client.lookupCreation(kind, action.key), run = await current.client.getRun(lookup.result.runId);
    assert.equal(run.status, 'not_started'); assert.equal(run.recipe, kind === 'vision-create' ? 'vision/v0' : 'ocr/v0');
    const first = current.media.continueRun(run.id, run.revision), duplicate = current.media.continueRun(run.id, run.revision);
    assert.equal(first, duplicate, 'Repeated execution clicks share one original Operation');
    const accepted = await first; await terminal(accepted.operation.id);
    const complete = await current.client.getRun(run.id); runs.push(complete);
    assert.equal(complete.task.attemptCount, 1); assert.equal(modelPosts, before + 1);
    assert.equal(complete.status, kind === 'vision-create' ? 'ready' : 'needs_attention');
    if (kind === 'ocr-create') { assert.equal(complete.ocr.status, 'partial'); assert.equal(complete.ocr.successfulChunks, 1); assert.equal(complete.ocr.skippedChunks, 2); }
  }
  const post = postCount();
  for (const value of [{ question: '' }, { question: 'a'.repeat(8193) }, { question: 'ok', url: 'https://untrusted.invalid/image' }]) {
    assert.throws(() => current.media.createVision({ modelRef, sourceArtifactId: source, ...value }), TypeError);
  }
  for (const value of [{ maxInvocations: 33 }, { maxDimension: 4097 }, { maxInvocations: 0 }, { overlap: -1 }, { chunkHeight: 0 }, { question: 'not an OCR setting' }]) {
    assert.throws(() => current.media.createOcr({ modelRef, sourceArtifactId: source, ...value }), TypeError);
  }
  assert.equal(postCount(), post, 'Invalid form input is rejected before HTTP');
  close(); await api.dispose(); api = undefined; await start(); current = await connect();
  for (const original of runs) {
    const same = await current.client.getRun(original.id);
    assert.equal(same.task.id, original.task.id); assert.equal(same.output.artifactId, original.output.artifactId);
    assert.equal(same.report?.artifactId, original.report?.artifactId);
  }
  await current.media.recover(); assert.equal(modelPosts, 2, 'Restart and reads never invoke the model');
  close(); await api.dispose(); api = undefined; await start({ execution: false, writes: true }); current = await connect();
  const draftOnly = await current.media.createVision({ modelRef, sourceArtifactId: source, question: '只保存任务，不执行' });
  assert.equal(draftOnly.flow.status, 'not_started'); assert.equal(draftOnly.flow.task, null);
  assert.throws(() => current.media.continueRun(draftOnly.flow.id, draftOnly.flow.revision), { code: 'IRIS_WEB_CAPABILITY_UNAVAILABLE' });
  assert.equal(modelPosts, 2, 'Create-only service saves a draft without granting execution');
  close(); await api.dispose(); api = undefined; await start({ execution: false }); current = await connect();
  const readonlyPosts = postCount();
  assert.throws(() => current.media.createVision({ modelRef, sourceArtifactId: source, question: 'read only' }), { code: 'IRIS_WEB_CAPABILITY_UNAVAILABLE' });
  assert.throws(() => current.media.createOcr({ modelRef, sourceArtifactId: source }), { code: 'IRIS_WEB_CAPABILITY_UNAVAILABLE' });
  assert.equal(postCount(), readonlyPosts); assert.equal(modelPosts, 2);
  console.log('PASS Web vision/OCR transport, identity-only recovery, saved drafts without inference, explicit original Operation, partial OCR, validation, restart and read-only gates; zero real provider calls');
} finally { close(); await api?.dispose(); await initializer.dispose(); globalThis.fetch = nativeFetch; }
