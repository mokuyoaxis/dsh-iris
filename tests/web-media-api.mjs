import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createReadClient } from '../lib/web/transport.js';
import { createMediaClient } from '../lib/web/media-client.js';
import { RECOVERY_STORAGE_KEY } from '../lib/web/recovery.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-web-media'), dataRoot = path.join(root, 'core');
const fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
const services = [], clients = [], mediaClients = [], apps = [app], requests = [], saved = new Map();
const disk = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
const nativeFetch = globalThis.fetch;
let session, lose = null, rejectBefore = false;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tree = directory => Object.fromEntries(fs.readdirSync(directory, { recursive: true })
  .filter(name => fs.lstatSync(path.join(directory, name)).isFile()).map(name => [name, sha(fs.readFileSync(path.join(directory, name)))]));
async function start(directory, ports, port) {
  const api = createLocalReadApi({ dataRoot: directory, serveWorkbench: true, allowExecution: true, allowSelection: true, executionPorts: ports });
  services.push(api); return { api, ...await api.start(port ? { port } : {}) };
}
async function connect(storage = disk) {
  const client = createReadClient(session.accessToken); clients.push(client);
  const info = await client.get('/api/v0/session');
  const media = createMediaClient({ client, session: info, origin: session.origin, getStorage: () => storage }); mediaClients.push(media);
  return { client, media, info };
}
const posts = () => requests.filter(item => item.method === 'POST');
async function reload(previous) { previous.media.close(); previous.client.close(); return connect(); }
async function terminal(client, id) {
  for (let index = 0; index < 200; index++) {
    const value = await client.getOperation(id);
    if (!['queued', 'running'].includes(value.operation.state)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('fixture Operation did not finish');
}

try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  session = await start(dataRoot, fixture);
  globalThis.fetch = async (resource, options) => {
    requests.push({ pathname: resource, method: options.method, key: options.headers['Idempotency-Key'], body: options.body });
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert(!resource.includes(session.accessToken));
    if (rejectBefore && options.method === 'POST') { rejectBefore = false; throw new TypeError('fixture network before send'); }
    const response = await nativeFetch(session.origin + resource, options);
    if (lose === resource && options.method === 'POST' && response.ok) { lose = null; await response.arrayBuffer(); throw new TypeError('fixture lost committed response'); }
    return response;
  };
  let current = await connect(); const rootId = current.info.rootId;
  assert(rootId && current.info.operations.includes('creation.lookup'));
  const image = new Blob([FLOW_SOURCE], { type: 'image/png' });
  lose = '/api/v0/images';
  const uploading = current.media.uploadImage(image);
  assert.equal(current.media.uploadImage(image), uploading);
  await assert.rejects(uploading, /lost committed/);
  assert.equal(posts().length, 1); assert.equal(fixture.calls.submit.length, 0);
  const uploadAction = current.media.snapshot().actions[0], uploadedBytes = tree(dataRoot);
  current = await reload(current); const beforeGet = posts().length;
  const imported = (await current.media.recover())[0]; assert.equal(imported.status, 'confirmed');
  const artifactId = imported.result.result.artifactId;
  assert.deepEqual(tree(dataRoot), uploadedBytes); assert.equal(posts().length, beforeGet); assert.equal(saved.size, 0);
  const value = { sourceArtifactId: artifactId, modelRef: FLOW_MODEL, prompt: 'PRIVATE_ORIGINAL_PROMPT' };
  lose = '/api/v0/runs'; const creating = current.media.createRun(value);
  assert.equal(current.media.createRun({ ...value }), creating); value.prompt = 'MUTATED_AFTER_CLICK';
  await assert.rejects(creating, /lost committed/);
  const createAction = current.media.snapshot().actions[0], raw = saved.get(RECOVERY_STORAGE_KEY);
  for (const secret of [session.accessToken, 'PRIVATE_ORIGINAL_PROMPT', 'MUTATED_AFTER_CLICK', 'data:image', dataRoot]) assert(!raw.includes(secret));
  assert.equal(Object.hasOwn(JSON.parse(raw).actions[0], 'prompt'), false);
  const posted = JSON.parse(posts().at(-1).body); assert.equal(posted.prompt, 'PRIVATE_ORIGINAL_PROMPT');
  const createdBytes = tree(dataRoot); current = await reload(current);
  const recoveredFlow = (await current.media.recover())[0]; assert.equal(recoveredFlow.status, 'confirmed');
  const runId = recoveredFlow.result.result.runId;
  let view = await current.client.getRun(runId); assert.equal(view.status, 'not_started'); assert.equal(view.task, null);
  assert.equal(view.input.prompt, 'PRIVATE_ORIGINAL_PROMPT'); assert.deepEqual(tree(dataRoot), createdBytes);
  assert.equal(fixture.calls.submit.length, 0, 'finding a committed Run never starts its first execution');
  assert.notEqual(createAction.key, uploadAction.key);

  lose = '/api/v0/runs/' + runId + '/continue';
  const continuing = current.media.continueRun(runId, view.revision);
  assert.equal(current.media.continueRun(runId, view.revision), continuing);
  await assert.rejects(continuing, /lost committed/);
  const continueAction = current.media.snapshot().actions[0]; assert.notEqual(continueAction.key, createAction.key);
  assert(!continueAction.operationId, 'an unknown response must be found by the original Key');
  lose = '/api/v0/runs/' + runId + '/continue';
  await assert.rejects(current.media.retry(continueAction.id), /lost committed/);
  assert.equal(posts().at(-1).key, continueAction.key, 'explicit continuation replay keeps the accepted Operation identity');
  current = await reload(current); const accepted = (await current.media.recover())[0];
  assert(['active', 'confirmed'].includes(accepted.status)); const operationId = accepted.result.operation.id;
  assert.equal(accepted.result.operation.runId, runId); await terminal(current.client, operationId);
  const count = posts().length; await current.media.recover(); assert.equal(posts().length, count);
  assert.equal(current.media.snapshot().actions.length, 0); assert.equal(fixture.calls.submit.length, 1);
  view = await current.client.getRun(runId); assert.equal(view.status, 'awaiting_selection');
  lose = '/api/v0/runs/' + runId + '/selection';
  await assert.rejects(current.media.selectRun(runId, artifactId, view.revision), /lost committed/);
  const selectionBytes = tree(dataRoot); current = await reload(current);
  const selection = (await current.media.recover())[0]; assert.equal(selection.status, 'current'); assert.equal(selection.matches, true);
  assert.equal(selection.result.selection.artifactId, artifactId); assert.deepEqual(tree(dataRoot), selectionBytes);
  const downloaded = await current.client.get('/api/v0/runs/' + runId + '/download', { binary: true });
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), FLOW_SOURCE);
  await assert.rejects(current.media.selectRun(runId, view.output.artifactId, view.revision), error => error.status === 409);
  const stale = (await current.media.recover())[0]; assert.equal(stale.status, 'current'); assert.equal(stale.matches, false);
  assert.equal(stale.result.selection.artifactId, artifactId, 'a stale choice never overrides the current revision');

  // A failure before send remains unknown; explicit replay uses the same identity and original bytes.
  rejectBefore = true; await assert.rejects(current.media.uploadImage(image), /before send/);
  const unsent = current.media.snapshot().actions[0]; assert.equal((await current.media.recover())[0].status, 'not_found');
  assert.throws(() => current.media.uploadImage(image), { code: 'IRIS_WEB_RECOVERY_REQUIRED' });
  await current.media.retry(unsent.id, image); assert.equal(posts().at(-1).key, unsent.key);
  assert.equal(current.media.snapshot().actions.length, 0);

  // A host restart changes Token/instanceId while preserving the data-root identity and original request.
  lose = '/api/v0/images'; await assert.rejects(current.media.uploadImage(image), /lost committed/);
  const beforeRestart = current.media.snapshot().actions[0], old = session, previousInstance = current.info.instanceId;
  const port = Number(new URL(old.origin).port); await old.api.dispose(); session = await start(dataRoot, imageFlowFixture(dataRoot), port);
  const oldRead = await current.media.recover(); assert.equal(oldRead[0].status, 'unavailable');
  assert.deepEqual(current.media.snapshot().actions, [beforeRestart]);
  current = await reload(current); assert.equal(current.info.rootId, rootId); assert.notEqual(current.info.instanceId, previousInstance);
  assert.equal((await current.media.recover())[0].status, 'confirmed');
  assert.equal(readFlowEvents(dataRoot).filter(item => item.kind === 'submit').length, 1);

  // Same origin, different root: discard only the old browser identities, never replay them into the new root.
  rejectBefore = true; await assert.rejects(current.media.uploadImage(image), /before send/);
  const otherRoot = path.join(root, 'other'), otherFixture = imageFlowFixture(otherRoot), other = createApplicationRuntime({ dataRoot: otherRoot, ...otherFixture }); apps.push(other);
  await other.execute('flow.init', {}); await other.execute('execution.init', {});
  await session.api.dispose(); session = await start(otherRoot, otherFixture, port);
  current = await reload(current); const beforeOther = tree(otherRoot);
  assert.notEqual(current.info.rootId, rootId); assert.equal(current.media.snapshot().notice, 'root_changed');
  assert.deepEqual(await current.media.recover(), []); assert.deepEqual(tree(otherRoot), beforeOther); assert.equal(otherFixture.calls.submit.length, 0);

  // Stop a genuinely active controlled call; stopping is local and does not assert remote cancellation.
  await session.api.dispose();
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const stoppingFixture = imageFlowFixture(otherRoot, { beforeSubmit: (_input, { signal }) => new Promise((resolve, reject) => {
    entered(); if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const source = (await other.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const stopRun = (await other.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'Stop fixture before send' })).run;
  session = await start(otherRoot, stoppingFixture, port); current = await reload(current);
  const running = await current.media.continueRun(stopRun.id, stopRun.revision); await started;
  assert.equal(current.media.snapshot().actions.length, 1);
  const stopping = current.media.stopOperation(running.operation.id);
  assert.equal(current.media.stopOperation(running.operation.id), stopping);
  const stopped = await stopping; assert.equal(stopped.operation.state, 'canceled'); assert.equal(stopped.remoteCancellation, 'not_requested');
  assert.equal(current.media.snapshot().actions.length, 0); assert.equal(stoppingFixture.calls.submit.length, 1);
  assert.equal(readFlowEvents(otherRoot).length, 0, 'the controlled fixture was interrupted before its send marker');
  assert.equal(saved.size, 0);
  console.log('PASS Web media/API: real HTTP/Core upload-create-execute-select-stop, lost responses, independent Keys, immutable click input, zero-generation GET recovery, stale choice, explicit original replay, Token restart and same-origin root isolation');
} finally {
  for (const media of mediaClients) media.close(); for (const client of clients) client.close();
  globalThis.fetch = nativeFetch;
  for (const service of services) await service.dispose(); for (const application of apps) await application.dispose();
}
