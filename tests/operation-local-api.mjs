import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { readAllOperations } from '../lib/operation-store.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-operation-http'), dataRoot = path.join(root, 'core');
const app = createApplicationRuntime({ dataRoot, ...imageFlowFixture(dataRoot) }), servers = [];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).map(name => {
  const file = path.join(dataRoot, name), stat = fs.lstatSync(file);
  return [name, stat.isFile() ? sha(fs.readFileSync(file)) : stat.isDirectory() ? 'directory' : fs.readlinkSync(file)];
}));
async function start(options) {
  const api = createLocalReadApi({ dataRoot, ...options }); servers.push(api); return { api, ...await api.start() };
}
async function get(session, route) {
  const response = await fetch(session.origin + route, { headers: { Authorization: 'Bearer ' + session.accessToken } });
  return { status: response.status, value: await response.json() };
}
async function post(session, route, key, body, type = 'application/json') {
  const response = await fetch(session.origin + route, { method: 'POST', headers: {
    Authorization: 'Bearer ' + session.accessToken, 'Idempotency-Key': key, 'Content-Type': type }, body });
  return { status: response.status, value: await response.json() };
}
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const flow = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'Read-only v1 test' });
  const operation = (await app.execute('operation.accept', { key: crypto.randomUUID(), runId: flow.run.id,
    expectedRunRevision: 1, ownerInstanceId: crypto.randomUUID() })).operation;
  const before = tree(), reader = await start({ serveWorkbench: true });
  assert.equal((await fetch(reader.origin + '/')).status, 200);
  const info = await get(reader, '/api/v0/session'); assert.equal(info.value.readOnly, true);
  assert(!info.value.operations.some(name => /operation|continue|cancel/.test(name)));
  assert.equal((await get(reader, '/api/v0/runs/' + flow.run.id)).value.status, 'not_started');
  assert.equal((await get(reader, '/api/v0/operations/' + operation.id)).status, 404);
  assert.equal((await post(reader, '/api/v0/runs/' + flow.run.id + '/continue', crypto.randomUUID(), '{}')).status, 405);
  assert.deepEqual(tree(), before); await reader.api.dispose();

  const providerConfigPath = path.join(root, 'providers.json');
  fs.writeFileSync(providerConfigPath, JSON.stringify({ providers: [{ id: 'api', enabled: true, name: 'fixture',
    baseUrl: 'https://no-network.fixture.invalid/v1', apiKey: 'PRIVATE_API_KEY', mediaProtocol: 'openai-chat-images',
    models: [{ id: 'edit', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': ['api::edit'] } }), { mode: 0o600 });
  let writer = await start({ allowLocalWrites: true, providerConfigPath });
  const uploadKey = crypto.randomUUID(), flowKey = crypto.randomUUID();
  const image = await post(writer, '/api/v0/images', uploadKey, FLOW_SOURCE, 'image/png'); assert.equal(image.status, 201);
  const value = JSON.stringify({ sourceArtifactId: image.value.artifact.artifactId, modelRef: 'api::edit', prompt: 'Create only; no execution' });
  const created = await post(writer, '/api/v0/runs', flowKey, value); assert.equal(created.status, 201); assert.equal(created.value.flow.task, null);
  assert.equal((await post(writer, '/api/v0/runs/' + created.value.flow.id + '/continue', crypto.randomUUID(), '{}')).status, 404);
  await writer.api.dispose(); writer = await start({ allowLocalWrites: true, providerConfigPath });
  const replay = await post(writer, '/api/v0/runs', flowKey, value);
  assert.equal(replay.status, 200); assert.equal(replay.value.flow.id, created.value.flow.id);
  assert.equal((await post(writer, '/api/v0/images', uploadKey, FLOW_SOURCE, 'image/png')).status, 200);
  assert.equal(readAllOperations(dataRoot).length, 1); assert.equal(listCoreTasks(dataRoot).total, 0);
  assert.deepEqual(readFlowEvents(dataRoot), []);

  const operationFile = path.join(dataRoot, 'creation-requests/v1/operations', operation.id + '.json');
  const original = fs.readFileSync(operationFile); fs.writeFileSync(operationFile, 'CORRUPT_OPERATION_FIXTURE');
  const corrupted = tree();
  const refused = await post(writer, '/api/v0/images', crypto.randomUUID(), FLOW_SOURCE, 'image/png');
  assert.equal(refused.status, 409); assert.equal(refused.value.error.code, 'IRIS_API_RECORD_CONFLICT');
  assert.deepEqual(tree(), corrupted, 'rejected v1 writes leave even hard-link records unchanged');
  assert.equal((await get(writer, '/api/v0/runs/' + flow.run.id)).status, 200, 'independent history reader does not repair the Operation store');
  assert.deepEqual(tree(), corrupted);
  fs.writeFileSync(operationFile, original);
  assert.equal(readAllOperations(dataRoot)[0].state, 'queued');
  console.log('Operation HTTP compatibility: v1 read-only workbench, zero-generation uploads/create/restart replay, no execution routes and corrupt-record writer gate OK');
} finally { for (const server of servers) await server.dispose(); await app.dispose(); }
