import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMediaScheduler } from '../lib/media-scheduler.js';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { createNetworkProxyFixture } from './fixtures/network-proxy-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-scheduling-proxy'), fixture = await createNetworkProxyFixture(root);
const scheduler = createMediaScheduler({ schemaVersion: 1, httpConcurrency: 1, requestsPerSecond: 100 });
const file = path.join(root, 'network.json'), requirement = { schemaVersion: 1, configId: crypto.randomUUID(), catalogId: crypto.randomUUID() };
const a = await fixture.createProxy({ tag: 'a', tls: true }), b = await fixture.createProxy({ tag: 'b' });
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, configId: requirement.configId, generation: 1,
  nodes: [{ id: 'a', protocol: 'https', host: '127.0.0.1', port: a.port }, { id: 'b', protocol: 'http', host: '127.0.0.1', port: b.port }],
  pools: [{ id: 'ordered', mode: 'ordered', candidates: [{ kind: 'node', nodeId: 'a' }, { kind: 'node', nodeId: 'b' }] }],
  bindings: [{ catalogId: requirement.catalogId, providerId: 'p', poolId: 'ordered' }] }), { mode: 0o600 });
const nativeFetch = globalThis.fetch;
void globalThis.Request;
const { getGlobalDispatcher } = await import('undici'), originalDispatcher = getGlobalDispatcher();
const manager = createProviderNetworkManager({ networkConfigPath: file, scheduler, tls: { ca: fixture.ca }, proxyTls: { ca: fixture.ca } });
try {
  const client = manager.resolveProviderNetwork({ providerId: 'p', modelRef: 'p::image', networkRequirement: requirement });
  const redirected = await client.run(async fetch => (await fetch(fixture.httpOrigin + '/cdn/redirect')).arrayBuffer(), { operation: 'download' });
  assert.deepEqual(Buffer.from(redirected), fixture.media); assert.equal(scheduler.snapshot().requestsStarted, 2);
  let ready;
  const headers = new Promise(resolve => { ready = resolve; });
  const slow = client.run(async fetch => { const response = await fetch(fixture.httpOrigin + '/slow-body'); ready(); return response.text(); }, { operation: 'download' });
  await headers;
  const queued = client.run(async fetch => (await fetch(fixture.httpOrigin + '/queued')).text(), { operation: 'discover' });
  await delay(30); assert(!fixture.requests.some(row => row.path === '/queued')); assert.equal(scheduler.snapshot().httpActive, 1);
  fixture.release('/slow-body'); assert.equal(await slow, 'first-last'); await queued;
  await assert.rejects(client.run(fetch => fetch(fixture.httpOrigin + '/received-then-reset', { method: 'POST', body: 'synthetic fixture' }), { operation: 'submit' }), { code: 'IRIS_NETWORK_TRANSPORT' });
  assert.equal(fixture.requests.filter(row => row.path === '/received-then-reset').length, 1); assert.equal(b.connects.length, 0);
  assert.equal(getGlobalDispatcher(), originalDispatcher); assert.equal(globalThis.fetch, nativeFetch);
  assert.equal(scheduler.snapshot().httpActive, 0); assert.deepEqual(fixture.errors, []);
  const modelScheduler = createMediaScheduler({ schemaVersion: 1, httpConcurrency: 1, requestsPerSecond: 100, queueTimeoutMs: 150,
    providers: [{ providerId: 'p', models: [{ modelId: 'a', requestsPerSecond: 1 }] }] });
  const modelManager = createProviderNetworkManager({ networkConfigPath: file, scheduler: modelScheduler, tls: { ca: fixture.ca }, proxyTls: { ca: fixture.ca } });
  try {
    const first = modelManager.resolveProviderNetwork({ providerId: 'p', modelRef: 'p::a', networkRequirement: requirement });
    const second = modelManager.resolveProviderNetwork({ providerId: 'p', modelRef: 'p::b', networkRequirement: requirement });
    await first.run(async fetch => (await fetch(fixture.httpOrigin + '/model-a')).text(), { operation: 'discover' });
    await second.run(async fetch => (await fetch(fixture.httpOrigin + '/model-b')).text(), { operation: 'discover' });
    await assert.rejects(first.run(fetch => fetch(fixture.httpOrigin + '/model-a-must-wait'), { operation: 'discover' }), { code: 'IRIS_SCHEDULER_QUEUE_TIMEOUT' });
    assert(!fixture.requests.some(row => row.path === '/model-a-must-wait'));
    assert.equal(modelScheduler.snapshot().requestsStarted, 2, 'cached routed clients retain the exact model for taskless probes');
  } finally { await modelManager.dispose(); modelScheduler.dispose(); }
  console.log('Scheduling proxy: actual TLS CONNECT, HTTP-to-HTTPS redirect hops, full body slots, queued progress, no POST replay and unchanged host dispatcher OK');
} finally { await fixture.close(); await manager.dispose(); scheduler.dispose(); }
