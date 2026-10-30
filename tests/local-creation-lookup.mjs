import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { creationRequestId, inspectCreationRoot } from '../lib/creation-request-store.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-creation-lookup');
const apps = [], servers = [], clients = [], dataRoot = path.join(root, 'core');
const fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).filter(name => fs.lstatSync(path.join(directory, name)).isFile())
    .map(name => [name, sha(fs.readFileSync(path.join(directory, name)))]));
}
async function start(dataRoot, options = {}) {
  const api = createLocalReadApi({ dataRoot, ...options }); servers.push(api); return { api, ...await api.start() };
}
async function get(session, route, options = {}) {
  const response = await fetch(session.origin + route, { ...options, headers: { Authorization: 'Bearer ' + session.accessToken, ...options.headers } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, headers: response.headers, value: bytes.length ? JSON.parse(bytes) : null };
}
const route = (kind, key) => '/api/v0/creation-requests?' + new URLSearchParams({ kind, key });

try {
  await app.execute('flow.init', {});
  const plain = tree(dataRoot), noRequests = await start(dataRoot);
  assert.deepEqual(await app.execute('creation.root', {}), { contractVersion: 0, rootId: null });
  const emptySession = (await get(noRequests, '/api/v0/session')).value;
  assert.equal(emptySession.rootId, null); assert(!emptySession.operations.includes('creation.lookup'));
  assert.equal((await get(noRequests, route('image-import', crypto.randomUUID()))).status, 404);
  assert.equal((await get(noRequests, route('image-import', 'invalid'))).status, 400);
  assert.deepEqual(tree(dataRoot), plain, 'reading identity or missing requests must not initialize a container');
  await noRequests.api.dispose();

  const marker = (await app.execute('creation.init', {})).root;
  const imageKey = crypto.randomUUID(), imageInput = { key: imageKey, bytes: FLOW_SOURCE, mediaType: 'image/png' };
  const imported = await app.execute('creation.image', imageInput);
  const flowKey = crypto.randomUUID(), value = { sourceArtifactId: imported.artifact.id, modelRef: FLOW_MODEL, prompt: 'PRIVATE_LOOKUP_PROMPT' };
  const created = await app.execute('creation.flow', { key: flowKey, value });
  const completed = await app.execute('flow.continue', { run_id: created.flow.run.id });
  await app.execute('flow.select', { run_id: created.flow.run.id, artifact_id: completed.run.output.artifactId });
  const prepared = [];
  for (const kind of ['image-import', 'flow-create']) for (const stage of ['intent', 'result']) {
    const key = crypto.randomUUID(), input = kind === 'image-import' ? { ...imageInput, key } : { key, value };
    const recordFile = path.join(fs.realpathSync.native(dataRoot), 'creation-requests/v0/requests', creationRequestId(marker, kind, key) + '.json');
    const rename = fs.renameSync;
    if (stage === 'result') fs.renameSync = (from, to) => {
      if (to === recordFile) throw Object.assign(new Error('fixture receipt failure'), { code: 'EIO' });
      return rename(from, to);
    };
    try {
      await assert.rejects(app.execute(kind === 'image-import' ? 'creation.image' : 'creation.flow', input,
        stage === 'intent' ? { onPrepared: () => { throw new Error('fixture stopped after intent'); } } : undefined));
    } finally { fs.renameSync = rename; }
    const saved = JSON.parse(fs.readFileSync(recordFile, 'utf8')); assert.equal(saved.state, 'prepared');
    prepared.push({ kind, stage, key, recordFile, saved });
  }

  const session = await start(dataRoot, { serveWorkbench: true }), before = tree(dataRoot), events = readFlowEvents(dataRoot);
  const info = (await get(session, '/api/v0/session')).value;
  assert.equal(info.rootId, marker.rootId); assert(info.operations.includes('creation.lookup')); assert.equal(info.readOnly, true);
  assert(!info.operations.includes('images.create') && !info.operations.includes('runs.continue'));
  for (const [kind, key, result] of [['image-import', imageKey, { artifactId: imported.artifact.id }], ['flow-create', flowKey, { runId: created.flow.run.id }]]) {
    const queried = await get(session, route(kind, key));
    assert.equal(queried.status, 200); assert.deepEqual(queried.value, { contractVersion: 0, kind, state: 'succeeded', result });
    for (const privateValue of ['PRIVATE_LOOKUP_PROMPT', dataRoot, 'providerBinding', 'intent', 'taskId', key]) assert(!queried.bytes.includes(privateValue));
    assert.equal(queried.headers.get('cache-control'), 'no-store');
    const head = await get(session, route(kind, key), { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
  }
  for (const item of prepared) {
    const queried = (await get(session, route(item.kind, item.key))).value;
    assert.equal(queried.state, 'prepared');
    assert.deepEqual(queried.result, item.stage === 'intent' ? null : item.kind === 'image-import'
      ? { artifactId: item.saved.intent.artifactId } : { runId: item.saved.intent.runId });
    assert.equal(JSON.parse(fs.readFileSync(item.recordFile)).state, 'prepared', 'lookup never completes the receipt');
  }
  const lease = createCoreRuntime({ dataRoot, mode: 'writer' }); lease.start();
  try {
    const leased = tree(dataRoot);
    assert.equal((await get(session, route('flow-create', flowKey))).status, 200, 'reader remains usable alongside a writer');
    assert.equal((await app.execute('creation.lookup', { kind: 'image-import', key: imageKey })).result.artifactId, imported.artifact.id);
    assert.deepEqual(tree(dataRoot), leased);
  } finally { await lease.dispose(); }

  for (const query of ['kind=image-import', 'key=' + imageKey, 'kind=unknown&key=' + imageKey,
    'kind=image-import&key=wrong', 'kind=image-import&key=' + imageKey + '&key=' + imageKey,
    'kind=image-import&key=' + imageKey + '&path=/private/file', 'kind=image-import&kind=flow-create&key=' + imageKey]) {
    assert.equal((await get(session, '/api/v0/creation-requests?' + query)).status, 400);
  }
  assert.equal((await get(session, route('image-import', flowKey))).status, 404, 'request namespaces cannot cross kinds');
  assert.equal((await get(session, route('image-import', crypto.randomUUID()))).status, 404);
  assert.equal((await get(session, route('image-import', imageKey), { method: 'POST', body: '{}' })).status, 405);
  for (const headers of [{ Origin: 'null' }, { Origin: 'https://outside.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await get(session, route('image-import', imageKey), { headers })).status, 403);
  }
  assert.equal((await get(session, route('image-import', imageKey), { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } })).status, 401);
  assert.deepEqual(tree(dataRoot), before); assert.deepEqual(readFlowEvents(dataRoot), events);

  const requestFile = path.join(dataRoot, 'creation-requests/v0/requests', creationRequestId(marker, 'image-import', imageKey) + '.json');
  const savedRequest = fs.readFileSync(requestFile); fs.writeFileSync(requestFile, '{BROKEN');
  try { assert.equal((await get(session, route('image-import', imageKey))).status, 409); assert.equal(fs.readFileSync(requestFile, 'utf8'), '{BROKEN'); }
  finally { fs.writeFileSync(requestFile, savedRequest); }
  const flowRequestFile = path.join(dataRoot, 'creation-requests/v0/requests', creationRequestId(marker, 'flow-create', flowKey) + '.json');
  const wrongKind = { ...JSON.parse(fs.readFileSync(flowRequestFile)), id: creationRequestId(marker, 'image-import', imageKey) };
  fs.writeFileSync(requestFile, JSON.stringify(wrongKind));
  try { assert.equal((await get(session, route('image-import', imageKey))).status, 409, 'a valid record copied across kinds is still a conflict'); }
  finally { fs.writeFileSync(requestFile, savedRequest); }
  const runFile = path.join(dataRoot, 'flow-store/v0/runs', created.flow.run.id + '.json'), heldRun = runFile + '.held';
  fs.renameSync(runFile, heldRun);
  try {
    const result = await get(session, route('flow-create', flowKey)); assert.equal(result.status, 409);
    assert.equal(result.value.error.code, 'IRIS_API_RESULT_UNAVAILABLE'); assert(!fs.existsSync(runFile));
  } finally { fs.renameSync(heldRun, runFile); }
  const object = path.join(dataRoot, 'artifact-store/v0/objects', imported.artifact.id + '.png'), held = object + '.held';
  fs.renameSync(object, held);
  try {
    const result = await get(session, route('image-import', imageKey));
    assert.equal(result.status, 409); assert.equal(result.value.error.code, 'IRIS_API_RECORD_CONFLICT'); assert(!fs.existsSync(object));
  } finally { fs.renameSync(held, object); }
  const markerFile = path.join(dataRoot, 'creation-requests/v0/root.json'), markerBytes = fs.readFileSync(markerFile);
  fs.writeFileSync(markerFile, 'BROKEN');
  try { assert.equal((await get(session, '/api/v0/session')).status, 409); }
  finally { fs.writeFileSync(markerFile, markerBytes); }

  const saved = tree(dataRoot), oldToken = session.accessToken;
  await session.api.dispose();
  const restarted = await start(dataRoot), secondInfo = (await get(restarted, '/api/v0/session')).value;
  assert.equal(secondInfo.rootId, marker.rootId); assert.notEqual(secondInfo.instanceId, info.instanceId);
  assert.equal((await get(restarted, route('flow-create', flowKey))).value.result.runId, created.flow.run.id);
  assert.equal((await get(restarted, '/api/v0/session', { headers: { Authorization: 'Bearer ' + oldToken } })).status, 401);
  assert.deepEqual(tree(dataRoot), saved); assert.deepEqual(readFlowEvents(dataRoot), events);

  const otherRoot = path.join(root, 'other'), otherFixture = imageFlowFixture(otherRoot);
  const other = createApplicationRuntime({ dataRoot: otherRoot, ...otherFixture }); apps.push(other);
  await other.execute('flow.init', {}); await other.execute('execution.init', {});
  const otherImage = await other.execute('creation.image', imageInput), otherMarker = inspectCreationRoot(otherRoot);
  assert.notEqual(otherMarker.rootId, marker.rootId); assert.notEqual(otherImage.artifact.id, imported.artifact.id);
  const pair = createConnectionPair({ dataRoot: otherRoot, directory: path.join(root, 'pair'), origin: 'http://127.0.0.1:1',
    label: 'full grants', scopes: ['read', 'create', 'execute', 'stop'] });
  const connected = await start(otherRoot, { allowExecution: true, executionPorts: otherFixture, connectionsFile: pair.serverFile });
  const connection = { ...JSON.parse(fs.readFileSync(pair.clientFile)), origin: connected.origin };
  const client = createCoreServiceClient({ connection, requestedScopes: ['read', 'create', 'execute', 'stop'] }); clients.push(client);
  const hello = await client.connect();
  const headers = { Authorization: 'Bearer ' + connection.accessToken, 'Iris-Connection-Id': connection.connectionId, 'Iris-Runtime-Id': hello.instance.runtimeInstanceId };
  const clientSession = (await get(connected, '/api/v0/session', { headers })).value;
  assert(!clientSession.operations.includes('creation.lookup')); assert(!Object.hasOwn(clientSession, 'rootId'));
  assert.equal((await get(connected, route('image-import', imageKey), { headers })).status, 403);
  assert.equal((await get(connected, '/api/v0/session')).value.rootId, otherMarker.rootId);
  assert.deepEqual((await get(connected, route('image-import', imageKey))).value.result, { artifactId: otherImage.artifact.id });
  assert.equal(otherFixture.calls.submit.length, 0);
  console.log('PASS creation lookup: stable root identity, owner-only read API, v0/v1, prepared intent/result, advanced Flow, missing/corrupt targets, restart, root changes, zero writes and Provider calls');
} finally {
  for (const client of clients) if (client.snapshot().state === 'open') await client.dispose();
  for (const api of servers) await api.dispose();
  for (const app of apps) await app.dispose();
}
