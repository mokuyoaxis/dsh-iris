import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { executeNetworkConfigCommand } from '../lib/network-config-service.js';
import { wrapProviderCatalog, encodeProviderConfig } from '../lib/provider-config-format.js';
import { readFlowRun } from '../lib/flow-store.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { readAllOperations } from '../lib/operation-store.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';
import { createTestStages } from './fixtures/test-stages.mjs';

const { root } = useTempDshHome('iris-scheduling-api'), dataRoot = path.join(root, 'core');
const file = path.join(root, 'providers.json'), network = path.join(root, 'network.json'), apis = [];
const key = () => crypto.randomUUID(), requests = [], pending = new Map();
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const model = requests.at(-1).model;
  pending.set(model, () => res.end(JSON.stringify({ choices: [{ message: { content: '![fixture](data:image/png;base64,' + FAKE_PNG.toString('base64') + ')' } }] })));
  res.setHeader('Content-Type', 'application/json');
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const initialized = executeNetworkConfigCommand(network, 'routing.init');
const requirement = { schemaVersion: 1, configId: initialized.configId, catalogId: key() };
fs.writeFileSync(file, JSON.stringify(encodeProviderConfig(wrapProviderCatalog({ providers: [{ id: 'p', mediaProtocol: 'openai-chat-images',
  apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: ['a', 'b', 'c'].map(id => ({ id, capabilities: ['image-gen'] })) }],
  assignments: { 'image-gen': ['p::a', 'p::b', 'p::c'] } }, requirement))), { mode: 0o600 });
const scheduling = { schemaVersion: 1, httpConcurrency: 2, requestsPerSecond: 100, remoteLimit: 1, queueTimeoutMs: 3000 };
const app = createApplicationRuntime({ dataRoot });
let current;
const stage = createTestStages('SCHEDULING_API', () => ({ dataRoot, modelsRequested: requests.map(value => value.model),
  pendingModels: [...pending.keys()], tasks: listCoreTasks(dataRoot).tasks,
  operations: readAllOperations(dataRoot), api: current?.api.snapshot() }));
async function start() {
  const api = createLocalReadApi({ dataRoot, providerConfigPath: file, networkConfigPath: network, allowExecution: true, scheduling }); apis.push(api);
  current = { api, ...await stage('start quota service', () => api.start(), 10000) }; return current;
}
async function request(endpoint, input, requestKey = key(), parentSignal) {
  return stage('request ' + (input === undefined ? 'GET ' : 'POST ') + endpoint, async signal => {
    const response = await fetch(current.origin + '/api/v0/' + endpoint, { method: input === undefined ? 'GET' : 'POST', headers: {
      Authorization: 'Bearer ' + current.accessToken, ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey })
    }, signal: parentSignal ? AbortSignal.any([signal, parentSignal]) : signal, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json();
    assert(response.ok, JSON.stringify(value)); return { status: response.status, value };
  });
}
async function until(label, check) {
  return stage('wait ' + label, async signal => {
    while (!signal.aborted) { const value = await check(signal); if (value) return value; await delay(10); }
    signal.throwIfAborted();
  }, 3000);
}
async function create(model) { return (await request('generations', { modelRef: `p::${model}`, prompt: 'scheduler API fixture' })).value.flow; }
async function submit(flow, requestKey = key()) { return request(`runs/${flow.id}/continue`, { expectedRevision: flow.revision }, requestKey); }
try {
  await stage('initialize quota root', async () => {
    await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true }); await app.dispose();
  }, 10000);
  // remoteLimit=1 admits only A; B must be accepted locally while A holds the network wait.
  await start();
  stage.mark('scenario', { name: 'remote quota and local stop' });
  const a = await create('a'), b = await create('b'), aKey = key();
  const duplicates = await Promise.all([submit(a, aKey), submit(a, aKey)]);
  assert.deepEqual(duplicates.map(item => item.status).sort(), [200, 202]);
  assert.equal(duplicates[0].value.operation.id, duplicates[1].value.operation.id);
  const aAccepted = duplicates.find(item => item.status === 202);
  await until('provider a received', () => pending.has('a'));
  const bAccepted = await submit(b); assert.equal(bAccepted.status, 202, 'network wait must not make new admission busy');
  await until('b awaits remote capacity', async signal => (await request(`operations/${bAccepted.value.operation.id}`, undefined, key(), signal)).value.operation.scheduling?.phase === 'remote_capacity');
  assert.equal(requests.length, 1);
  const session = (await request('session')).value;
  assert.equal(session.scheduling.remoteOutstanding, 1); assert.equal(session.scheduling.httpActive, 1);
  // Stopping A is local only: ambiguous acceptance continues to hold the remote quota.
  const stopped = (await request(`operations/${aAccepted.value.operation.id}/cancel`, {})).value;
  assert.equal(stopped.operation.state, 'canceled'); assert.equal(stopped.remoteCancellation, 'not_requested');
  assert.equal(listCoreTasks(dataRoot).tasks.find(task => task.modelRef === 'p::a').acceptance, 'unknown');
  await request(`operations/${bAccepted.value.operation.id}/cancel`, {});
  assert.equal(requests.length, 1); assert.equal(pending.has('b'), false);
  await stage('dispose quota service', () => current.api.dispose(), 10000); assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  await start();
  stage.mark('scenario', { name: 'original task after restart' });
  assert.equal((await submit(a, aKey)).value.idempotentReplay, true);
  const originalA = readFlowRun(dataRoot, a.id), observed = await submit({ id: a.id, revision: originalA.revision });
  await until('original operation observed', async signal => (await request(`operations/${observed.value.operation.id}`, undefined, key(), signal)).value.operation.state === 'succeeded');
  assert.equal(requests.length, 1, 'restart and explicit continuation of unknown acceptance must never POST again');
  assert.equal(listCoreTasks(dataRoot).tasks.find(task => task.modelRef === 'p::a').attempts.length, 1);
  await stage('dispose restarted service', () => current.api.dispose(), 10000);

  // A separate instance/root gives two HTTP submissions room to overlap and independently deliver.
  const secondRoot = path.join(root, 'parallel-core'), init = createApplicationRuntime({ dataRoot: secondRoot });
  await stage('initialize parallel root', async () => {
    await init.execute('flow.init', {}); await init.execute('execution.init', { imageGeneration: true }); await init.dispose();
  }, 10000);
  const parallel = createLocalReadApi({ dataRoot: secondRoot, providerConfigPath: file, networkConfigPath: network,
    allowExecution: true, scheduling: { ...scheduling, remoteLimit: 4 } }); apis.push(parallel);
  current = { api: parallel, ...await stage('start parallel service', () => parallel.start(), 10000) };
  stage.mark('scenario', { name: 'parallel delivery' });
  pending.clear(); const first = await create('b'), second = await create('c');
  const one = await submit(first), two = await submit(second);
  await until('parallel b and c received', () => pending.has('b') && pending.has('c'));
  assert.equal((await request('session')).value.scheduling.httpActive, 2);
  pending.get('b')(); pending.get('c')();
  for (const accepted of [one, two]) await until('parallel operation completed', async signal => (await request(`operations/${accepted.value.operation.id}`, undefined, key(), signal)).value.operation.state === 'succeeded');
  const tasks = listCoreTasks(secondRoot).tasks;
  assert.equal(tasks.length, 2); assert(tasks.every(task => task.semanticsVersion === 3 && task.attempts.length === 1 && task.deliveryState === 'ready'));
  for (const task of tasks) {
    assert.deepEqual(task.networkRequirement, requirement); assert.equal(task.networkRoutes[0].route, 'inherit');
    const artifact = readCoreArtifactBytes(secondRoot, task.artifactIds[0]); assert.equal(artifact.artifact.metadata.taskId, task.id); assert.deepEqual(artifact.bytes, FAKE_PNG);
  }
  assert.notEqual(tasks[0].artifactIds[0], tasks[1].artifactIds[0]);
  await stage('dispose parallel service', () => current.api.dispose(), 10000);
  const diagnostic = createLocalReadApi({ dataRoot, providerConfigPath: file, networkConfigPath: network, allowExecution: true,
    scheduling: { ...scheduling, queueTimeoutMs: 80 } }); apis.push(diagnostic);
  current = { api: diagnostic, ...await stage('start deadline service', () => diagnostic.start(), 10000) };
  stage.mark('scenario', { name: 'queue timeout without dispatch' });
  const errors = [], originalError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); originalError(...args); };
  try {
    const blocked = await create('c'), timed = await submit(blocked);
    const failed = await until('queue failure recorded', async signal => {
      const operation = (await request(`operations/${timed.value.operation.id}`, undefined, key(), signal)).value.operation;
      return operation.state === 'failed' && operation;
    });
    assert.equal(failed.failureCode, 'execution_failed');
    assert(errors.some(line => line.includes('"code":"IRIS_SCHEDULER_QUEUE_TIMEOUT"') && line.includes(failed.id)));
    assert.equal(listCoreTasks(dataRoot).tasks.find(task => task.flowBinding.runId === blocked.id).attempts.length, 0);
    assert.equal(requests.length, 3, 'a timed-out remote quota wait must never submit another request');
  } finally { console.error = originalError; }
  console.log('Scheduling API: real HTTP concurrent Operations, serialized route checkpoints, independent stop, durable quota/unknown identity, zero POST replay after restart and exact Core artifact bindings OK');
} finally {
  for (const finish of pending.values()) finish();
  for (const [index, api] of apis.reverse().entries()) await stage('cleanup API ' + index, () => api.dispose(), 10000);
  await stage('cleanup application', () => app.dispose(), 10000);
  provider.closeAllConnections(); await stage('close fixture provider', () => new Promise(resolve => provider.close(resolve)));
}
