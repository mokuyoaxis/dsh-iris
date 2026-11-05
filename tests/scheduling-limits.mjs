import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner } from '../lib/operation-runner.js';
import { loadCorePluginRegistry } from '../lib/plugins.js';
import { readOperation } from '../lib/operation-store.js';
import crypto from 'node:crypto';
import { createFakeLifecycleProvider, FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-scheduling-limits'), apps = [];
const policy = { schemaVersion: 1, requestsPerSecond: 100, remoteLimit: 10, queueTimeoutMs: 3000 };
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); } assert.fail('fixture condition missing'); }
const p = createFakeLifecycleProvider({ id: 'p', cancelSteps: [{ kind: 'canceled' }, { kind: 'canceled' }] });
const q = createFakeLifecycleProvider({ id: 'q' });
const app = createApplicationRuntime({ dataRoot: path.join(root, 'scopes'), scheduling: { ...policy,
  providers: [{ providerId: 'p', remoteLimit: 2, models: [{ modelId: 'a', remoteLimit: 1 }] }] },
  resolveImageCandidates: ({ modelRef }) => [{ model: modelRef, adapter: modelRef.startsWith('p::') ? p.adapter : q.adapter }],
  resolveTaskAdapter: task => task.providerId === 'p' ? p.adapter : q.adapter }); apps.push(app);
const generate = model_ref => app.generateImage({ model_ref, prompt: 'remote capacity fixture' });
let release, runner, registry;
try {
  const a = await generate('p::a'), anotherA = generate('p::a');
  await until(() => app.snapshot().waitingWrites === 1);
  const b = await generate('p::b'), c = generate('p::c');
  await until(() => app.snapshot().waitingWrites === 2);
  const other = await generate('q::a'); assert.equal(other.task.acceptance, 'accepted');
  assert.equal(p.calls.submit.length, 2); assert.equal(q.calls.submit.length, 1);
  assert.equal((await app.execute('task.list', {})).total, 3, 'model/provider capacity wait must not manufacture Tasks');
  await app.execute('task.cancel', { task_id: a.taskId }); await app.execute('task.cancel', { task_id: b.taskId });
  const final = await Promise.all([anotherA, c]); assert(final.every(value => value.task.acceptance === 'accepted'));
  assert.equal(p.calls.submit.length, 4); assert.equal(app.scheduler.snapshot(path.join(root, 'scopes')).remoteOutstanding, 3);

  const bounded = createApplicationRuntime({ dataRoot: path.join(root, 'bounded'), scheduling: { ...policy, queueLimit: 8, queueTimeoutMs: 100 } }); apps.push(bounded);
  const gate = new Promise(resolve => { release = resolve; });
  const first = bounded.run('writer', async () => { await gate; });
  await until(() => bounded.snapshot().managedWrites === 1);
  let unintended = 0;
  const pending = Array.from({ length: 7 }, () => bounded.run('writer', () => { unintended++; }));
  const settled = Promise.allSettled(pending);
  await assert.rejects(bounded.run('writer', () => { unintended++; }), { code: 'IRIS_SCHEDULER_QUEUE_FULL' });
  assert((await settled).every(result => result.status === 'rejected' && result.reason.code === 'IRIS_SCHEDULER_QUEUE_TIMEOUT'));
  assert.equal(unintended, 0); release(); await first; await bounded.dispose();
  const stalled = createApplicationRuntime({ dataRoot: path.join(root, 'late-timer'), scheduling: { ...policy, queueTimeoutMs: 40 } }); apps.push(stalled);
  let unblock;
  const pause = new Promise(resolve => { unblock = resolve; });
  const blocking = stalled.run('writer', async () => { await pause; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80); });
  const expired = assert.rejects(stalled.run('writer', () => { assert.fail('expired job was admitted before its delayed timer'); }), { code: 'IRIS_SCHEDULER_QUEUE_TIMEOUT' });
  unblock(); await blocking; await expired;
  registry = await loadCorePluginRegistry({ entries: [path.resolve('plugins/contact-sheet/index.mjs')] });
  const pluginRoot = path.join(root, 'plugin'), pluginApp = createApplicationRuntime({ dataRoot: pluginRoot, scheduling: policy }); apps.push(pluginApp);
  await pluginApp.execute('flow.init', {}); await pluginApp.execute('execution.init', {});
  const source = (await pluginApp.execute('artifact.import', { image_bytes: FAKE_PNG })).artifact;
  const operationId = 'community.contact-sheet.create';
  runner = createOperationRunner({ dataRoot: pluginRoot, application: pluginApp, pluginRegistry: registry, allowedOperations: [operationId] }); await runner.start();
  const request = { key: crypto.randomUUID(), operationId, dependency: registry.dependency('operations', operationId),
    input: { artifactIds: [source.id], columns: 1, cellSize: 128 } };
  const duplicates = await Promise.all([runner.submit(request), runner.submit(request)]);
  assert.deepEqual(duplicates.map(value => value.idempotentReplay).sort(), [false, true]);
  assert.equal(duplicates[0].operation.id, duplicates[1].operation.id); await runner.idle();
  const result = readOperation(pluginRoot, duplicates[0].operation.id);
  assert.equal(result.state, 'succeeded'); assert.equal(result.result.artifactIds.length, 1);
  assert.equal((await pluginApp.execute('artifact.list', {})).total, 2);
  console.log('Scheduling limits: exact-model and provider remote caps, unrelated provider progress, bounded write queue and finite unsent timeouts OK');
} finally { release?.(); await runner?.dispose(); for (const runtime of apps.reverse()) await runtime.dispose(); await registry?.dispose(); }
