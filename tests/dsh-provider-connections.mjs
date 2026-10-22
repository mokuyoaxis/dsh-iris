import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
import { createDshHostAdapter } from '../lib/dsh-host-adapter.js';
import { DshProviderSourceError } from '../lib/dsh-provider-source.js';
import { withDshProviderConfig } from '../lib/dsh-provider-config.js';
import { withProviderConfigScope } from '../lib/provider-config-scope.js';

const { root } = useTempDshHome('iris-dsh-provider-connections');
const store = await import('../lib/config.js');
const { runAction } = await import('./fixtures/dsh-runtime-fixture.mjs');
const { providerForTaskFromCatalog } = await import('../lib/provider-catalog.js');
const { inspectProviderTaskForDsh, configureProviderHostForDsh, dshCoreDataRoot,
  resumeProviderTaskWatchesForDsh, stopProviderTaskWatchesForDsh } = await import('./fixtures/dsh-runtime-fixture.mjs');

let key = 'fixture-key-one';
let credentialReads = 0;
let active = ['workbuddy', 'oauth'];
let credentialError = false;
const profiles = { workbuddy: { baseURL: 'http://127.0.0.1:7863/v1', apiKeyEnv: 'WORKBUDDY_KEY' },
  oauth: { baseURL: 'https://oauth.fixture.invalid/v1' } };
const services = {
  llm: {
    listProviders: () => active.map(id => ({ id, name: id })),
    listConfigurableProviders: () => Object.keys(profiles).map(provider => ({ provider,
      settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], displayName: provider }))
  },
  settings: { describe(options) {
    assert.equal(options.redactSecrets, true);
    return [{ ns: 'llm-pi-ai', value: { providers: profiles } }];
  } },
  credentials: {
    async describe(ref) { return { configured: ref === 'WORKBUDDY_KEY' && Boolean(key) }; },
    async resolve(ref) {
      credentialReads++;
      if (credentialError) throw new Error('sensitive: ' + key);
      return ref === 'WORKBUDDY_KEY' && key ? { value: key, source: 'fixture' } : undefined;
    },
    async describeRecord(ref) { return { configured: ref === 'llm-pi-ai/oauth', kind: 'grant' }; },
    async readRecord() { throw new Error('OAuth payload must never be read'); }
  }
};
const host = () => createDshHostAdapter({ get: name => services[name] });
const releaseHost = configureProviderHostForDsh(host);
const reference = { provider: 'workbuddy', settingsNs: 'llm-pi-ai' };
const catalog = await runAction(host(), 'providers_host_connections');
assert.equal(catalog.connections.length, 2);
assert.equal(catalog.connections[0].available, true);
assert.equal(catalog.connections[1].available, false);
assert.match(catalog.connections[1].reason, /登录授权/);
assert.equal(credentialReads, 0, 'listing and configuration must not read credential values');
assert.ok(!JSON.stringify(catalog).includes(key));
assert.deepEqual((await runAction({}, 'providers_host_connections')).connections, []);

await assert.rejects(runAction(host(), 'providers_upsert', { dshProvider: reference, mediaProtocol: 'auto' }), /明确选择媒体协议/);
const saved = await runAction(host(), 'providers_upsert', { name: 'shared', dshProvider: reference,
  mediaProtocol: 'openai-images' });
const id = saved.providerId;
await runAction(host(), 'providers_add_model', { id, model_id: 'fixture-image', capabilities: ['image-gen'] });
const choices = await runAction(host(), 'assignments_get');
assert.equal(choices.poolByCapability['image-gen'].find(item => item.ref === id + '::fixture-image').unavailable, false,
  'a DSH reference must be available in functional assignments without a local key');
assert.equal(credentialReads, 0);
assert.equal(store.allProviders()[0].apiKey, undefined);
assert.equal(store.allProviders()[0].baseUrl, undefined);
assert.throws(() => store.upsert({ id, apiKey: 'must-not-store' }), /不保存密钥/);
assert.equal(store.pickAllFor('image-gen').length, 0, 'connecting must not grant a functional assignment');
await runAction(host(), 'assignments_set', { capability: 'image-gen', model_refs: [id + '::fixture-image'] });
assert.deepEqual((await runAction(host(), 'assignments_get')).order['image-gen'], [id + '::fixture-image']);
assert.equal(credentialReads, 0, 'functional configuration must not read credentials');
const filename = path.join(root, 'iris/v1/providers.json');
const stored = fs.readFileSync(filename, 'utf8');
assert.ok(!stored.includes(key) && !stored.includes('7863'));

const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).png().toBuffer();
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), authorization: new Headers(options.headers).get('authorization') });
  return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
};
try {
  const first = await runAction(host(), 'image', { prompt: 'fixture', model: id + '::fixture-image' });
  assert.equal(first.storage, 'core');
  const task = await inspectProviderTaskForDsh(first.taskId);
  assert.equal(task.outcome, 'succeeded');
  assert.equal(task.deliveryState, 'ready');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:7863/v1/images/generations');
  assert.equal(requests[0].authorization, 'Bearer fixture-key-one');
  assert.ok(!JSON.stringify(task).includes(key));

  key = 'fixture-key-two';
  await runAction(host(), 'image', { prompt: 'second fixture', model: id + '::fixture-image' });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].authorization, 'Bearer fixture-key-two', 'rotation must affect the next operation');
  const afterGeneration = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const { health, ...configuration } = afterGeneration.providers[0];
  assert.deepEqual(configuration, JSON.parse(stored).providers[0]);
  assert.deepEqual(afterGeneration.assignments, JSON.parse(stored).assignments);
  assert.equal(health.observations[0].lastSuccess.category, 'success');
  assert.ok(!JSON.stringify(afterGeneration).includes(key) && !JSON.stringify(afterGeneration).includes('7863'));
  assert.equal(store.allProviders()[0].apiKey, undefined);
  assert.equal(store.providers().length, 0, 'resolved configuration must not escape its operation');

  profiles.workbuddy.baseURL = 'http://127.0.0.1:7864/v1';
  await withDshProviderConfig(host(), () => {
    assert.throws(() => providerForTaskFromCatalog({ providers: store.runtimeProviders() }, task),
      error => error.code === 'IRIS_PROVIDER_TASK_BINDING_MISMATCH');
  });
  assert.equal(requests.length, 2, 'old task binding must reject endpoint drift before HTTP');
  await runAction(host(), 'image', { prompt: 'third fixture', model: id + '::fixture-image' });
  assert.equal(requests[2].url, 'http://127.0.0.1:7864/v1/images/generations');

  const visible = await runAction(host(), 'providers_list');
  assert.equal(visible.providers[0].apiKeyHint, '由 DSH 管理');
  assert.equal(visible.providers[0].baseUrl, 'http://127.0.0.1:7864/v1');
  assert.ok(!JSON.stringify(visible).includes(key));
  credentialError = true;
  await assert.rejects(host().ports.providerConnections.resolve(reference), error =>
    error instanceof DshProviderSourceError && !error.message.includes(key));
  credentialError = false;
  delete profiles.workbuddy.apiKeyEnv;
  services.credentials.describeRecord = async ref => ({ configured: true, kind: ref.endsWith('/oauth') ? 'grant' : 'api-key' });
  services.credentials.readRecord = async ref => {
    credentialReads++;
    assert.equal(ref, 'llm-pi-ai/workbuddy');
    return { kind: 'api-key', key };
  };
  const readsBeforeList = credentialReads;
  assert.equal((await runAction(host(), 'providers_host_connections')).connections[0].available, true);
  assert.equal(credentialReads, readsBeforeList, 'record enumeration must not read secrets');
  const recordConnection = await host().ports.providerConnections.resolve(reference);
  assert.equal(recordConnection.apiKey, key);
  assert.ok(!JSON.stringify(recordConnection).includes(key));
  profiles.workbuddy.headers = { 'x-custom-auth': 'not-for-Iris' };
  assert.equal((await runAction(host(), 'providers_host_connections')).connections[0].available, false);
  delete profiles.workbuddy.headers;
  active = [];
  assert.equal((await runAction(host(), 'providers_list')).providers[0].connection.available, false);
  const removed = await runAction(host(), 'assignments_get');
  assert.equal(removed.poolByCapability['image-gen'].find(item => item.ref === id + '::fixture-image').unavailable, true);
  assert.deepEqual(removed.order['image-gen'], [id + '::fixture-image'], 'source removal must preserve explicit assignments');
  await assert.rejects(runAction(host(), 'image', { prompt: 'must not submit', model: id + '::fixture-image' }), /指定模型/);
  assert.equal(requests.length, 3);

  // Background observations must resolve again, even when their timers inherited
  // the submission's async context. A changed endpoint never receives an old ID.
  active = ['workbuddy'];
  profiles.workbuddy.baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  store.upsert({ id, mediaProtocol: 'dashscope',
    models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }] });
  store.setAssignmentOrder('image-gen', [id + '::wan2.2-t2i-flash']);
  key = 'fixture-async-one';
  const calls = { submit: 0, poll: 0, download: 0 };
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    const auth = new Headers(options?.headers).get('authorization');
    if (url.endsWith('/services/aigc/text2image/image-synthesis')) {
      calls.submit++;
      assert.equal(auth, 'Bearer ' + key);
      return Response.json({ output: { task_id: 'async-' + calls.submit } });
    }
    if (url.endsWith('/tasks/async-1')) {
      calls.poll++;
      assert.equal(auth, calls.poll === 1 ? 'Bearer fixture-async-two' : 'Bearer fixture-async-three');
      if (calls.poll === 1) {
        key = 'fixture-async-three';
        return Response.json({ output: { task_status: 'RUNNING' } });
      }
      return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://artifact.fixture/image.png' }] } });
    }
    if (url === 'https://artifact.fixture/image.png') {
      calls.download++;
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
    throw new Error('Unexpected async fixture request: ' + url);
  };
  const pending = await runAction(host(), 'image', { prompt: 'async fixture', model: id + '::wan2.2-t2i-flash' });
  await stopProviderTaskWatchesForDsh();
  assert.equal(calls.poll, 0);
  key = 'fixture-async-two';
  assert.deepEqual(await resumeProviderTaskWatchesForDsh({ intervalMs: 10, maxWatchMs: 3000 }), [pending.taskId]);
  const deadline = Date.now() + 3000;
  let completed;
  while (Date.now() < deadline) {
    completed = await inspectProviderTaskForDsh(pending.taskId);
    if (completed.deliveryState === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(completed.outcome, 'succeeded');
  assert.equal(completed.deliveryState, 'ready');
  assert.equal(completed.attempts.length, 1);
  assert.deepEqual(calls, { submit: 1, poll: 2, download: 1 });

  const drifted = await runAction(host(), 'image', { prompt: 'async drift fixture', model: id + '::wan2.2-t2i-flash' });
  await stopProviderTaskWatchesForDsh();
  const taskFile = path.join(dshCoreDataRoot(), 'task-store/v0/tasks', drifted.taskId + '.json');
  const taskBefore = fs.readFileSync(taskFile, 'utf8');
  profiles.workbuddy.baseURL = 'https://dashscope-us-east-1.aliyuncs.com/compatible-mode/v1';
  assert.deepEqual(await resumeProviderTaskWatchesForDsh({ intervalMs: 10 }), []);
  assert.equal(calls.poll, 2, 'endpoint drift must stop resumed observations before HTTP');
  assert.equal(fs.readFileSync(taskFile, 'utf8'), taskBefore);
  profiles.workbuddy.baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  active = [];
  assert.deepEqual(await resumeProviderTaskWatchesForDsh({ intervalMs: 10 }), []);
  assert.deepEqual(calls, { submit: 2, poll: 2, download: 1 });
  assert.equal(fs.readFileSync(taskFile, 'utf8'), taskBefore, 'removed source must preserve accepted task facts');
} finally { await stopProviderTaskWatchesForDsh(); globalThis.fetch = originalFetch; releaseHost(); }

// Independent operations must not borrow one another's credentials.
const original = store.allProviders()[0];
await Promise.all(['scope-a', 'scope-b'].map(apiKey => withProviderConfigScope([{ ...original,
  baseUrl: 'http://scope.fixture.invalid/v1', apiKey }], async () => {
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(store.runtimeProviders()[0].apiKey, apiKey);
})));
assert.equal(store.allProviders()[0].apiKey, undefined);
console.log('ALL OK — DSH connection references: metadata privacy, explicit assignment, generation, rotation, async recovery, drift refusal, removal and concurrent isolation');
