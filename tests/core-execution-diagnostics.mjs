import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { createDshServiceBridge } from '../lib/dsh-service-bridge.js';
import { createConnectionPair, readConnectionGrants } from '../lib/core-connections.js';
import { readAllOperations } from '../lib/operation-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-core-execution-diagnostics'), dataRoot = path.join(root, 'core');
const scopes = ['read', 'create', 'execute', 'stop'], tools = new Map(), requests = [], clients = [];
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const entered = defer(), release = defer();
const fixture = imageFlowFixture(dataRoot, { beforeSubmit: async () => { entered.resolve(); await release.promise; } });
const setup = createApplicationRuntime({ dataRoot, ...fixture }), originalFetch = globalThis.fetch;
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
const read = file => JSON.parse(fs.readFileSync(file));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let api, bridge, origin;
async function failure(action, code, status) {
  let error;
  try { await action(); } catch (caught) { error = caught; }
  assert(error, 'request must be rejected'); assert.equal(error.code, code); assert.equal(error.status, status);
  return error;
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('fixture did not enter its controlled wait')), 8000); })]); }
  finally { clearTimeout(timer); }
}
async function terminal(client, id) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const result = (await client.operation(id)).operation;
    if (!['queued', 'running'].includes(result.state)) { assert.equal(result.state, 'succeeded'); return result; }
    await delay(5);
  }
  assert.fail('controlled Operation did not finish');
}
async function connect(pair, requestedScopes = ['read']) {
  const client = createCoreServiceClient({ connectionFile: pair.clientFile, requestedScopes }); clients.push(client);
  await client.connect(); return client;
}
globalThis.fetch = async (url, options) => {
  const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
  assert.equal(target.origin, origin, 'all HTTP must stay in the isolated Core');
  const response = await originalFetch(url, options);
  if (target.pathname.startsWith('/api/v0/')) {
    const row = { method: options?.method || 'GET', route: target.pathname, status: response.status };
    if (!response.ok) row.error = (await response.clone().json()).error;
    requests.push(row);
  }
  return response;
};
try {
  await setup.execute('flow.init', {}); await setup.execute('execution.init', {});
  const artifact = (await setup.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const flows = [];
  for (const prompt of ['hold first execution', 'preserve second execution UUID']) flows.push((await setup.execute('flow.create', {
    source_artifact_id: artifact.id, model_ref: FLOW_MODEL, prompt })).run);
  await setup.dispose();
  const pairs = ['full', 'reader', 'native'].map(label => createConnectionPair({ dataRoot, directory: path.join(root, label),
    origin: 'http://127.0.0.1:1', label, harnessKind: label === 'native' ? 'dsh' : 'generic', scopes: label === 'reader' ? ['read'] : scopes }));
  const grantsFile = path.join(root, 'grants.json');
  write(grantsFile, { schemaVersion: 0, grants: pairs.flatMap(pair => readConnectionGrants(pair.serverFile)) });
  api = createLocalReadApi({ dataRoot, allowExecution: true, allowMcp: true, connectionsFile: grantsFile, executionPorts: fixture });
  origin = (await api.start()).origin;
  for (const pair of pairs) write(pair.clientFile, { ...read(pair.clientFile), origin });
  const client = await connect(pairs[0], scopes), reader = await connect(pairs[1]);
  bridge = createDshServiceBridge({ connectionFile: pairs[2].clientFile, requestedScopes: scopes,
    getHost: () => ({ ports: { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } } }) });
  await bridge.start();
  const mcp = httpMcpClient(origin, read(pairs[0].clientFile).accessToken); await mcp.initialize();
  const first = { key: crypto.randomUUID(), runId: flows[0].id, expectedRevision: flows[0].revision };
  const second = { key: crypto.randomUUID(), runId: flows[1].id, expectedRevision: flows[1].revision };
  const accepted = await client.continueRun(first); await bounded(entered.promise);
  const refused = await failure(() => client.continueRun(second), 'IRIS_API_ROOT_BUSY', 409);
  const native = await failure(() => tools.get('iris_core_continue').execute(second), 'IRIS_API_ROOT_BUSY', 409);
  const mcpError = await mcp.call('iris_core_continue', second);
  assert(mcpError.isError); assert.equal(mcpError.structuredContent.error.code, 'IRIS_API_ROOT_BUSY');
  const missing = await failure(() => client.lookup(second.key), 'IRIS_OPERATION_NOT_FOUND', 404);
  const denied = await failure(() => reader.continueRun(second), 'IRIS_CONNECTION_CAPABILITY_DENIED', 403);
  assert.equal(readAllOperations(dataRoot).length, 1);
  const laterPosts = () => requests.filter(row => row.method === 'POST' && row.route === '/api/v0/runs/' + second.runId + '/continue');
  assert.equal(laterPosts().length, 4, 'each explicit direct/DSH/MCP/denied invocation sends once; no automatic retry');
  assert.deepEqual(laterPosts().map(row => [row.status, row.error.code]), [
    [409, 'IRIS_API_ROOT_BUSY'], [409, 'IRIS_API_ROOT_BUSY'], [409, 'IRIS_API_ROOT_BUSY'], [403, 'IRIS_CONNECTION_CAPABILITY_DENIED']
  ]);
  release.resolve(); await terminal(client, accepted.operation.id);
  assert.equal((await client.lookup(first.key)).operation.id, accepted.operation.id);
  assert.equal((await client.run(second.runId)).task, null); assert.equal(fixture.calls.submit.length, 1);
  assert.equal(laterPosts().length, 4, 'finishing the first operation cannot automatically dispatch the refused one');
  assert.equal(refused.diagnostic.stage, 'tool'); assert.equal(denied.diagnostic.stage, 'authorization');
  assert.match(native.message, /IRIS_API_ROOT_BUSY/); assert.match(native.message, /HTTP 409/);
  assert.match(native.message, /data root.*busy/i); assert.match(native.message, /writer or its lease/i); assert.match(native.message, /original request UUID/i);
  assert.match(native.message, /never.*automatically/i); assert(native.message.includes(native.requestId));
  assert.match(mcpError.structuredContent.error.message, /data root.*busy/i);
  assert.match(mcpError.structuredContent.error.action, /original request UUID/i);
  assert.deepEqual(mcpError.structuredContent.error.recovery, { key: second.key, runId: second.runId });
  assert.match(missing.diagnostic.message, /no saved Operation/i);
  assert.match(missing.diagnostic.action, /uncertain/i);
  assert.match(denied.message, /IRIS_CONNECTION_CAPABILITY_DENIED/);
  assert.doesNotMatch(denied.diagnostic.message, /active writer/i);

  // Only this explicit call executes the originally refused input, using its original key/revision.
  const next = (await tools.get('iris_core_continue').execute(second)).value; await terminal(client, next.operation.id);
  assert.equal((await client.lookup(second.key)).operation.id, next.operation.id);
  const pending = await client.run(second.runId);
  assert.equal(pending.status, 'running'); assert.equal(pending.output, null, 'a succeeded finite submit can leave an asynchronous Task running');
  const observed = await client.continueRun({ key: crypto.randomUUID(), runId: second.runId, expectedRevision: pending.revision });
  await terminal(client, observed.operation.id);
  const saved = await Promise.all([client.run(first.runId), client.run(second.runId)]);
  assert.equal(saved[1].task.id, pending.task.id, 'explicit observation keeps the original asynchronous Task');
  assert(saved.every(run => run.task.attemptCount === 1)); assert.equal(fixture.calls.submit.length, 2);
  assert.equal(fixture.calls.poll.length, 1);
  const mediaHashes = await Promise.all(saved.map(async run => hash((await client.image(run.output.artifactId)).bytes)));
  const operations = [accepted.operation.id, next.operation.id];
  await bridge.dispose(); assert.equal(tools.size, 0);
  await client.dispose(); await reader.dispose(); await api.dispose();

  // A read grant cannot make Operation routes appear when the Core execution service is disabled.
  api = createLocalReadApi({ dataRoot, connectionsFile: pairs[1].serverFile });
  await api.start({ port: Number(new URL(origin).port) });
  const disabled = await connect(pairs[1]);
  await failure(() => disabled.lookup(first.key), 'IRIS_API_INPUT_INVALID', 400);
  await disabled.dispose(); await api.dispose();

  api = createLocalReadApi({ dataRoot, allowExecution: true, allowMcp: true, connectionsFile: pairs[1].serverFile, executionPorts: fixture });
  await api.start({ port: Number(new URL(origin).port) });
  const restored = await connect(pairs[1]);
  assert.deepEqual(restored.snapshot().scopes, ['read']);
  const readMcp = httpMcpClient(origin, read(pairs[1].clientFile).accessToken); await readMcp.initialize();
  const readTools = (await readMcp.request('tools/list')).tools.map(tool => tool.name);
  assert(readTools.includes('iris_core_lookup')); assert(!readTools.includes('iris_core_continue'));
  for (const [index, input] of [first, second].entries()) {
    assert.equal((await restored.lookup(input.key)).operation.id, operations[index]);
    assert.equal((await readMcp.call('iris_core_lookup', { key: input.key })).structuredContent.operation.id, operations[index]);
    const run = await restored.run(input.runId);
    assert.equal(run.task.id, saved[index].task.id); assert.equal(run.task.attemptCount, 1);
    assert.equal(run.output.artifactId, saved[index].output.artifactId);
    assert.equal(hash((await restored.image(run.output.artifactId)).bytes), mediaHashes[index]);
  }
  await failure(() => restored.continueRun(second), 'IRIS_CONNECTION_CAPABILITY_DENIED', 403);
  assert.equal(readAllOperations(dataRoot).length, 3); assert.equal(fixture.calls.submit.length, 2);
  console.log(JSON.stringify({ ok: true, checks: [
    'controlled serial HTTP409/root-busy, HTTP404/no accepted Operation and HTTP403/grant denial remain distinct',
    'native DSH bridge messages preserve safe code/status/request ID and recovery action; official HTTP MCP preserves diagnosis and original references',
    'no automatic resubmission; explicit original-key submission and asynchronous observation preserve one Attempt per Task',
    'read-only connection recovers original Operations/Tasks/artifact bytes only with Core execution service retained'
  ], controlledProviderSubmissions: 2, realProviderRequests: 0 }, null, 2));
} finally {
  release.resolve();
  try {
    await bridge?.dispose();
    for (const client of clients.reverse()) if (client.snapshot().state !== 'closed') await client.dispose();
    await api?.dispose(); await setup.dispose();
  } finally { globalThis.fetch = originalFetch; }
}
