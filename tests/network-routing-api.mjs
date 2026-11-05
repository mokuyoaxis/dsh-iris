import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { useTempDshHome } from './test-env.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { executeNetworkConfigCommand } from '../lib/network-config-service.js';
import { wrapProviderCatalog, encodeProviderConfig } from '../lib/provider-config-format.js';
import { readFlowRun } from '../lib/flow-store.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const { root } = useTempDshHome('iris-network-api');
const dataRoot = path.join(root, 'core'), file = path.join(root, 'providers.json'), network = path.join(root, 'network.json');
const config = executeNetworkConfigCommand(network, 'routing.init');
const requirement = { schemaVersion: 1, configId: config.configId, catalogId: crypto.randomUUID() };
fs.writeFileSync(file, JSON.stringify(encodeProviderConfig(wrapProviderCatalog({ providers: [{ id: 'p', mediaProtocol: 'openai-chat-images',
  apiKey: 'synthetic-key', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'image', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': ['p::image'] } }, requirement))), { mode: 0o600 });
const app = createApplicationRuntime({ dataRoot }); const servers = [];
const nativeFetch = globalThis.fetch; let submitted = 0;
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return nativeFetch(input, options);
  assert.equal(url.href, 'https://fixture.invalid/v1/chat/completions'); submitted++;
  return Response.json({ choices: [{ message: { content: '![fixture](data:image/png;base64,' + FAKE_PNG.toString('base64') + ')' } }] });
};
const start = async options => {
  const api = createLocalReadApi({ dataRoot, providerConfigPath: file, ...options }); servers.push(api);
  return { api, ...await api.start() };
};
const query = async (session, endpoint, input) => {
  const response = await nativeFetch(session.origin + endpoint, { method: input === undefined ? 'GET' : 'POST', headers: {
    Authorization: 'Bearer ' + session.accessToken, ...(input !== undefined ? { 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' } : {}) },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
  return { status: response.status, value: await response.json() };
};
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FAKE_PNG })).artifact;
  await app.dispose();
  assert.throws(() => createLocalReadApi({ dataRoot, providerConfigPath: file, providerRegistry: {}, networkConfigPath: network }), { code: 'IRIS_API_CONFIG_INVALID' });
  const creator = await start({ allowLocalWrites: true });
  const created = await query(creator, '/api/v0/runs', { modelRef: 'p::image', sourceArtifactId: source.id, prompt: 'fixture edit' });
  assert.equal(created.status, 201, JSON.stringify(created.value)); const runId = created.value.flow.id;
  assert.deepEqual(readFlowRun(dataRoot, runId).networkRequirement, requirement);
  assert.equal(submitted, 0); assert.equal(listCoreTasks(dataRoot).total, 0);
  await creator.api.dispose();
  const execution = await start({ allowExecution: true, networkConfigPath: network });
  const accepted = await query(execution, '/api/v0/runs/' + runId + '/continue', { expectedRevision: created.value.flow.revision });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
  const deadline = performance.now() + 10000;
  let task;
  while (performance.now() < deadline) {
    task = listCoreTasks(dataRoot).tasks[0];
    if (task?.deliveryState === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(task?.semanticsVersion, 3); assert.equal(task?.deliveryState, 'ready');
  assert.deepEqual(task.networkRequirement, requirement); assert.equal(task.networkRoutes[0].route, 'inherit'); assert.equal(submitted, 1);
  await execution.api.dispose();
  const reader = await start({});
  const history = await query(reader, '/api/v0/runs/' + runId);
  assert.equal(history.status, 200); assert.equal(history.value.task.id, task.id); assert.equal(submitted, 1);
  console.log('PASS actual API persists network intent before Task, executes through owned manager, closes cleanly and reads original history without network context');
} finally { globalThis.fetch = nativeFetch; for (const api of servers) await api.dispose(); await app.dispose(); }
