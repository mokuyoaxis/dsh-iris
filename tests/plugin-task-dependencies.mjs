import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCorePluginRegistry } from '@mokuyoaxis/dsh-iris/plugins';
import { loadCorePluginFixture } from './fixtures/core-plugin-fixture.mjs';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { configuredImagePorts } from '../lib/configured-image-runtime.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';
import { providerTaskBinding } from '../lib/provider-catalog.js';
import { createProviderRegistry } from '../lib/provider-extensions.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';

const { fixturePlugin } = await loadCorePluginFixture();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-plugin-task-')), dataRoot = path.join(root, 'core');
const config = path.join(root, 'providers.json'), calls = [], apps = [], registries = [], checks = [];
const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* Consume the controlled request. */ }
  calls.push({ method: req.method, path: req.url }); res.setHeader('content-type', 'application/json');
  if (req.url === '/submit' && req.method === 'POST') res.end(JSON.stringify({ kind: 'accepted', remoteTaskId: 'original-remote' }));
  else if (req.url === '/tasks/original-remote') res.end(JSON.stringify({ kind: 'succeeded', artifacts: [
    { kind: 'inline-base64', data: FAKE_PNG.toString('base64'), mediaType: 'image/png' }
  ] }));
  else res.writeHead(404).end();
});
const create = async (definition) => {
  const registry = await createCorePluginRegistry({ plugins: definition ? [definition] : [] }); registries.push(registry);
  const app = createApplicationRuntime({ dataRoot, ...configuredImagePorts(config, registry.providers) }); apps.push(app);
  return { registry, app };
};
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'external', auth: 'none', enabled: true,
    baseUrl: 'http://127.0.0.1:' + server.address().port, mediaProtocol: 'example.media.images',
    models: [{ id: 'image', capabilities: ['image-gen'], imageProtocol: 'example.media.images' }]
  }], assignments: { 'image-gen': { mode: 'auto', models: [] } } }), { mode: 0o600 });
  const first = await create(fixturePlugin());
  assert.equal(calls.length, 0);
  const submitted = await first.app.generateImage({ prompt: 'controlled plugin persistence', model_ref: 'external::image' });
  const original = submitted.task;
  assert.equal(original.acceptance, 'accepted'); assert.equal(original.remoteTaskId, 'original-remote');
  assert.deepEqual(original.pluginDependency, first.registry.dependency('providers', 'example.media.images'));
  assert.deepEqual(original.attempts[0].pluginDependency, original.pluginDependency);
  assert.equal(original.pluginDependency.pluginVersion, '1.0.0');
  assert.equal(calls.length, 1);
  await first.app.dispose(); await first.registry.dispose();
  checks.push('Core persists exact plugin/contribution identity on Task and Attempt before the one upstream submit');

  const reader = createApplicationRuntime({ dataRoot }); apps.push(reader);
  const historical = await reader.execute('task.inspect', { task_id: original.id });
  assert.deepEqual(historical.task.pluginDependency, original.pluginDependency); assert.equal(calls.length, 1);
  const absent = await create();
  await assert.rejects(absent.app.execute('task.observe', { task_id: original.id }));
  assert.equal(calls.length, 1);
  checks.push('history and original dependency metadata remain readable without the plugin; missing plugin makes no remote call');

  const taskFile = path.join(dataRoot, 'task-store', 'v0', 'tasks', original.id + '.json'), bytes = fs.readFileSync(taskFile);
  try {
    const corrupt = JSON.parse(bytes); corrupt.pluginDependency.pluginVersion = '9.0.0';
    fs.writeFileSync(taskFile, JSON.stringify(corrupt));
    await assert.rejects(reader.execute('task.inspect', { task_id: original.id }), { code: 'IRIS_TASK_INVALID' });
  } finally { fs.writeFileSync(taskFile, bytes); }
  checks.push('Task and Attempt dependency disagreement is rejected as corrupt persisted evidence');

  for (const definition of [fixturePlugin({ version: '1.0.1' }), fixturePlugin({ providerVersion: '1.0.1' })]) {
    const upgraded = await create(definition);
    await assert.rejects(upgraded.app.execute('task.observe', { task_id: original.id }), { code: 'IRIS_PLUGIN_DEPENDENCY_MISMATCH' });
    assert.equal(calls.length, 1);
    // The lower-level runner must enforce the same dependency even if a caller skips catalogue resolution.
    const provider = JSON.parse(fs.readFileSync(config, 'utf8')).providers[0];
    const adapter = upgraded.registry.providers.createAdapter('example.media.images', provider);
    await assert.rejects(upgraded.app.run('writer', runtime => createProviderTaskRunner(runtime).observe(original.id, adapter)), { code: 'IRIS_PLUGIN_DEPENDENCY_MISMATCH' });
    await upgraded.app.dispose(); await upgraded.registry.dispose();
  }
  checks.push('both plugin and contribution upgrades block catalogue and direct-runner recovery before contacting the original provider');

  const restored = await create(fixturePlugin());
  const observed = await restored.app.execute('task.observe', { task_id: original.id });
  assert.equal(observed.task.id, original.id); assert.equal(observed.task.providerBinding, original.providerBinding);
  assert.equal(observed.task.remoteTaskId, original.remoteTaskId); assert.equal(observed.task.deliveryState, 'ready');
  assert.equal(calls.filter(item => item.path === '/submit').length, 1);
  assert.equal(calls.filter(item => item.path === '/tasks/original-remote').length, 1);
  assert.equal(observed.task.artifactIds.length, 1);
  checks.push('restoring the exact version observes the original remote Task and completes delivery without resubmission');

  const legacy = await createProviderRegistry();
  try {
    const provider = { auth: 'none', baseUrl: 'http://127.0.0.1:1234/v1', mediaProtocol: 'openai-images' };
    assert.equal(providerTaskBinding(provider, legacy), providerTaskBinding(provider));
    assert.equal(legacy.descriptor('openai-images').dependency, undefined);
  } finally { await legacy.dispose(); }
  checks.push('legacy providers retain their old binding and do not acquire guessed plugin metadata');
  console.log(JSON.stringify({ ok: true, checks, calls, root, paidCalls: 0 }, null, 2));
} finally {
  for (const app of apps) await app.dispose();
  for (const registry of registries) await registry.dispose();
  await new Promise(resolve => server.close(resolve));
}
