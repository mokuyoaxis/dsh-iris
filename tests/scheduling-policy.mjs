import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { checkedSchedulingPolicy, readSchedulingPolicy } from '../lib/scheduling-policy.js';
import { createMediaScheduler } from '../lib/media-scheduler.js';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { configuredImagePorts } from '../lib/configured-image-runtime.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { recordModelRateLimit } from '../lib/provider-health.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-scheduling-policy'), file = path.join(root, 'policy.json');
const policy = { schemaVersion: 1, httpConcurrency: 2, requestsPerSecond: 100, remoteLimit: 4, queueTimeoutMs: 3000 };
fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
assert.equal(readSchedulingPolicy(file).httpConcurrency, 2);
assert.throws(() => readSchedulingPolicy('relative.json'), { code: 'IRIS_SCHEDULER_CONFIG_INVALID' });
assert.throws(() => readSchedulingPolicy(path.join(root, 'missing')), { code: 'IRIS_SCHEDULER_CONFIG_IO' });
for (const extra of [{ httpConcurrency: null }, { queueLimit: null }, { providers: null }, { providers: [{ providerId: 'p', models: null }] },
  { providers: [{ providerId: 'p' }, { providerId: 'p' }] }, { providers: [{ providerId: 'p', models: [{ modelId: 'a' }, { modelId: 'a' }] }] }]) {
  assert.throws(() => checkedSchedulingPolicy({ ...policy, ...extra }), { code: 'IRIS_SCHEDULER_CONFIG_INVALID' });
}
if (process.platform !== 'win32') {
  fs.chmodSync(file, 0o644); assert.throws(() => readSchedulingPolicy(file), { code: 'IRIS_SCHEDULER_CONFIG_INVALID' }); fs.chmodSync(file, 0o600);
  const link = path.join(root, 'policy-link'); fs.symlinkSync(file, link);
  assert.throws(() => readSchedulingPolicy(link), { code: 'IRIS_SCHEDULER_CONFIG_IO' });
}
let sent = 0;
const upstream = http.createServer((req, res) => {
  req.resume(); req.once('end', () => { sent++; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '![fixture](data:image/png;base64,' + FAKE_PNG.toString('base64') + ')' } }] }));
  });
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const provider = { id: 'p', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'synthetic-fixture-key',
  mediaProtocol: 'openai-chat-images', models: [{ id: 'image', capabilities: ['image-gen'] }] };
recordModelRateLimit(provider, 'image', { httpStatus: 429, retryAfterMs: 1000 });
const providers = path.join(root, 'providers.json');
fs.writeFileSync(providers, JSON.stringify({ providers: [provider], assignments: { 'image-gen': ['p::image'] } }), { mode: 0o600 });
const scheduler = createMediaScheduler(policy), manager = createProviderNetworkManager({ scheduler });
const dataRoot = path.join(root, 'core'), ports = configuredImagePorts(providers, undefined,
  { deferCooling: true, resolveProviderNetwork: manager.resolveProviderNetwork });
const app = createApplicationRuntime({ dataRoot, scheduler, ...ports });
try {
  const result = app.generateImage({ model_ref: 'p::image', prompt: 'cooldown fixture' });
  await delay(50); assert.equal(sent, 0); assert.equal(listCoreTasks(dataRoot).total, 0);
  assert.equal((await result).task.deliveryState, 'ready'); assert.equal(sent, 1);
  assert.equal(listCoreTasks(dataRoot).total, 1);
  console.log('Scheduling policy: strict version/fields/private file and known model cooldown waits before Task creation OK');
} finally { await app.dispose(); await manager.dispose(); scheduler.dispose(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
