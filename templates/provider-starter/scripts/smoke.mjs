import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createEnvironment, credentialEnv, syntheticKey } from './environment.mjs';
import { setup } from './setup.mjs';
import { runCore } from './core-cli.mjs';
import { mcpProbe } from './mcp-probe.mjs';
import { PNG } from './fixture.mjs';

const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === '--proxy-url', 'Usage: node scripts/smoke.mjs [--proxy-url http://127.0.0.1:PORT]');
const env = await createEnvironment({ proxyUrl: args[1] }), checks = [];
const parsed = result => { assert(!result.isError, JSON.stringify(result)); return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text); };
const postCount = () => env.fixture.requests.filter(item => item.method === 'POST').length;
const prefix = '/api/v0/provider-management/';
async function continuation(runId) {
  const view = await env.http('/api/v0/runs/' + runId);
  const accepted = await env.http('/api/v0/runs/' + runId + '/continue', { key: crypto.randomUUID(), value: { expectedRevision: view.revision } }, 202);
  return env.terminal(accepted.operation.id);
}
async function noCredentialFiles(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await noCredentialFiles(file);
    else { const bytes = await readFile(file); assert(!bytes.includes(Buffer.from(syntheticKey)), 'synthetic provider credential persisted: ' + item.name); }
  }
}
try {
  const original = await readFile(env.prepared.providerConfigPath);
  const options = { directory: env.prepared.directory, endpoint: env.fixture.origin, credentialEnv };
  await assert.rejects(setup(options), { code: 'EEXIST' });
  await assert.rejects(setup({ ...options, directory: path.resolve('private-demo') }), /outside the plugin project/);
  assert.deepEqual(await readFile(env.prepared.providerConfigPath), original);
  const originalConfig = JSON.parse(original).catalog ?? JSON.parse(original);
  assert.equal(originalConfig.providers[0].apiKey, undefined);
  assert.deepEqual(originalConfig.providers[0].models, []);
  checks.push('new-directory setup rejects overwrite and package-local data; stores only the environment name with no enabled model pool');

  await env.start({ key: '' });
  let settings = await env.http(prefix + 'settings');
  await env.http(prefix + 'discover', { value: { providerId: 'wan-reference', expectedRevision: settings.revision } }, 409);
  assert.equal(env.fixture.requests.length, 0);
  await env.stop(); await env.start();
  settings = await env.http(prefix + 'settings');
  assert(settings.protocols.some(item => item.id === 'example.wan-image.images'));
  const discovered = await env.http(prefix + 'discover', { value: { providerId: 'wan-reference', expectedRevision: settings.revision } });
  assert.equal(discovered.persisted, false); assert.deepEqual(discovered.models.map(item => item.id), ['wan2.6-t2i']);
  assert.equal(env.fixture.requests.filter(item => item.path.startsWith('/api/v1/models')).length, 2);
  assert.deepEqual(await readFile(env.prepared.providerConfigPath), original);
  checks.push('actual Core CLI exposes the contributed protocol; missing credentials make zero requests; complete two-page directory is read without silently applying it');

  const record = settings.providers[0];
  const provider = Object.fromEntries(['id', 'name', 'baseUrl', 'mediaBaseUrl', 'mediaProtocol', 'enabled', 'auth'].map(field => [field, record[field]]));
  provider.models = discovered.models;
  settings = await env.http(prefix + 'save', { value: { expectedRevision: settings.revision, provider, credential: { action: 'keep' },
    assignments: { 'image-gen': { mode: 'manual', models: ['wan-reference::wan2.6-t2i'] } } } });
  const none = await env.connection([]), unselected = await mcpProbe(await env.exported(none));
  assert(!(await unselected.request('tools/list', {})).tools.some(item => item.name === 'iris_core_create_generation'));
  const connection = await env.connection(); let client = await mcpProbe(await env.exported(connection));
  let names = (await client.request('tools/list', {})).tools.map(item => item.name);
  assert(names.includes('iris_core_create_generation')); assert(!names.includes('iris_core_plugin_call')); assert(!names.includes('iris_core_create_video'));
  checks.push('user explicitly applies the discovered model and manual pool; selecting image generation controls ordinary MCP media tools without a separate Provider tool whitelist');

  const flows = [];
  for (let i = 0; i < 2; i++) flows.push(parsed(await client.call('iris_core_create_generation', {
    key: crypto.randomUUID(), modelRef: 'wan-reference::wan2.6-t2i', prompt: 'controlled local Provider starter ' + i
  })).flow);
  assert.equal(postCount(), 0);
  const requests = flows.map(flow => ({ key: crypto.randomUUID(), runId: flow.id, expectedRevision: flow.revision }));
  env.fixture.holdSubmits();
  const accepted = await Promise.all(requests.map(value => client.call('iris_core_continue', value).then(parsed)));
  const deadline = performance.now() + 5000;
  while (postCount() < 2 && performance.now() < deadline) await delay(10);
  env.fixture.releaseSubmits();
  for (const value of accepted) assert.equal((await env.terminal(value.operation.id)).state, 'succeeded');
  assert.equal(postCount(), 2); assert.equal(env.fixture.peak, 2);
  const submitted = env.fixture.requests.filter(item => item.method === 'POST');
  assert(submitted.every(item => item.async === 'enable' && JSON.parse(item.body).parameters.n === 1));
  await env.stop();
  const tasks = [];
  for (const flow of flows) {
    const view = await runCore(env.prepared.dataRoot, 'flow', 'inspect', flow.id);
    const task = (await runCore(env.prepared.dataRoot, 'task', 'inspect', view.task.id)).task;
    assert.equal(task.acceptance, 'accepted'); assert(env.fixture.tasks.has(task.remoteTaskId));
    assert.equal(task.pluginDependency.pluginVersion, '0.1.0'); assert.equal(task.pluginDependency.contributionId, 'example.wan-image.images');
    assert.deepEqual(task.pluginDependency, task.attempts[0].pluginDependency); tasks.push(task.id);
    if (args.length) { assert.equal(task.semanticsVersion, 3); assert(task.networkRoutes.some(route => route.operation === 'submit' && route.nodeId === 'fixture-net')); }
  }
  checks.push('two real local HTTP submissions overlap under Core scheduling; public CLI reads accepted Task/Attempt with exact plugin identity and original remote IDs');

  for (const selection of [{ present: false }, { version: '0.1.1' }]) {
    await env.start(selection); const before = env.fixture.requests.length;
    for (const flow of flows) {
      const view = await env.http('/api/v0/runs/' + flow.id); assert(tasks.includes(view.task.id));
      const result = await continuation(flow.id); assert.equal(result.state, 'failed', JSON.stringify(result));
    }
    assert.equal(env.fixture.requests.length, before, 'missing/mismatched plugin must not contact any upstream');
    await env.stop();
  }
  checks.push('absent or differently versioned plugin keeps saved history readable and blocks continuation before any upstream request');

  env.fixture.ready = true;
  const rotated = syntheticKey + '-rotated'; await env.start({ key: rotated }); client = await mcpProbe(await env.exported(connection));
  for (let i = 0; i < flows.length; i++) {
    const view = parsed(await client.call('iris_core_run', { runId: flows[i].id }));
    const operation = parsed(await client.call('iris_core_continue', { key: crypto.randomUUID(), runId: view.id, expectedRevision: view.revision })).operation;
    assert.equal((await env.terminal(operation.id)).state, 'succeeded');
    const delivered = parsed(await client.call('iris_core_run', { runId: view.id }));
    assert.equal(delivered.task.id, tasks[i]); assert.equal(delivered.task.attemptCount, 1); assert.equal(delivered.task.deliveryState, 'ready');
    const image = (await client.call('iris_core_image', { artifactId: delivered.output.artifactId })).content.find(item => item.type === 'image');
    assert.deepEqual(Buffer.from(image.data, 'base64'), PNG);
  }
  assert.equal(postCount(), 2);
  const polls = env.fixture.requests.filter(item => item.path.startsWith('/api/v1/tasks/'));
  assert(polls.length >= 2 && polls.every(item => item.authorization === 'Bearer ' + rotated));
  assert(env.fixture.requests.filter(item => item.cdn).every(item => item.authorization === undefined));
  checks.push('restoring the exact plugin after restart uses the rotated environment value to poll original remote tasks and follow credential-free CDN redirects; no repeated POST');

  env.fixture.mode = 'missing-id';
  const ambiguous = (await env.http('/api/v0/generations', { key: crypto.randomUUID(), value: {
    modelRef: 'wan-reference::wan2.6-t2i', prompt: 'controlled ambiguous response'
  } }, 201)).flow;
  await continuation(ambiguous.id);
  let ambiguousView = await env.http('/api/v0/runs/' + ambiguous.id);
  assert.equal(ambiguousView.task.acceptance, 'unknown'); assert.equal(ambiguousView.task.attemptCount, 1);
  const ambiguousTask = ambiguousView.task.id, count = postCount(); assert.equal(count, 3);
  await env.stop(); env.fixture.mode = 'normal'; await env.start({ key: rotated });
  const requestCount = env.fixture.requests.length; await continuation(ambiguous.id);
  ambiguousView = await env.http('/api/v0/runs/' + ambiguous.id);
  assert.equal(ambiguousView.task.id, ambiguousTask); assert.equal(ambiguousView.task.acceptance, 'unknown');
  assert.equal(env.fixture.requests.length, requestCount); assert.equal(postCount(), count);
  checks.push('a submission without remote identity persists unknown acceptance; restart and explicit continuation neither retry POST nor invent a poll ID');

  await env.reduce(connection); client = await mcpProbe(await env.exported(connection));
  names = (await client.request('tools/list', {})).tools.map(item => item.name);
  assert(!names.includes('iris_core_continue')); assert(!names.includes('iris_core_create_generation'));
  assert.equal(parsed(await client.call('iris_core_run', { runId: flows[0].id })).task.deliveryState, 'ready');
  await assert.rejects(client.call('iris_core_continue', requests[0]), /Tool iris_core_continue not found/);
  assert.equal(postCount(), count); checks.push('reducing connection authority removes and rejects new execution while retaining authorized original history');
  await env.stop(); await noCredentialFiles(env.prepared.directory); assert.deepEqual(env.fixture.errors, []);
  checks.push('normal CLI SIGTERM completes across restarts; provider credentials are absent from Core records, provider configuration and backups');
  console.log(JSON.stringify({ ok: true, work: env.work, checks, taskIds: tasks, paidCalls: 0, submits: postCount(), peakHttp: env.fixture.peak,
    proxy: args.length ? 'explicit-loopback-CONNECT' : 'inherit' }, null, 2));
} finally { await env.close(); }
