import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { configuredImagePorts } from '../lib/configured-image-runtime.js';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { createMediaScheduler } from '../lib/media-scheduler.js';
import { wrapProviderCatalog, encodeProviderConfig } from '../lib/provider-config-format.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-vision-network'), dataRoot = path.join(root, 'core');
const file = path.join(root, 'providers.json'), networkFile = path.join(root, 'network.json');
const configId = crypto.randomUUID(), catalogId = crypto.randomUUID(), requirement = { schemaVersion: 1, configId, catalogId };
let release, entered, hold = true, posts = 0, connects = 0, currentNetwork;
const sockets = new Set(), track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
const provider = http.createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume exact outbound body */ }
  assert.equal(request.url, '/v1/chat/completions'); posts++;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'saved text' }, finish_reason: null }] }) + '\n\n');
  if (hold) { entered(); await new Promise(resolve => { release = resolve; }); }
  response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
});
provider.on('connection', track); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const authority = '127.0.0.1:' + provider.address().port;
const proxy = http.createServer((_request, response) => { response.writeHead(405); response.end(); });
proxy.on('connection', track);
proxy.on('connect', (request, socket, head) => {
  assert.equal(request.url, authority); connects++;
  const upstream = track(net.connect(provider.address().port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  }));
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const config = { schemaVersion: 2, configId, generation: 1, nodes: [{ id: 'local', protocol: 'http', host: '127.0.0.1', port: proxy.address().port }],
  pools: [{ id: 'selected', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'local' }] }], bindings: [{ catalogId, providerId: 'p', poolId: 'selected' }] };
fs.writeFileSync(networkFile, JSON.stringify(config), { mode: 0o600 });
fs.writeFileSync(file, JSON.stringify(encodeProviderConfig(wrapProviderCatalog({ providers: [{ id: 'p', type: 'openai',
  apiKey: 'PRIVATE_VISION_NETWORK_KEY', baseUrl: 'http://' + authority + '/v1', models: [{ id: 'vision', capabilities: ['vision'] }] }],
  assignments: { vision: ['p::vision'] } }, requirement))), { mode: 0o600 });
const scheduler = createMediaScheduler({ schemaVersion: 1, httpConcurrency: 1, requestsPerSecond: 2, remoteLimit: 4, queueTimeoutMs: 5000 });
const manager = createProviderNetworkManager({ networkConfigPath: networkFile, scheduler });
const ports = configuredImagePorts(file, undefined, { deferCooling: true, resolveProviderNetwork: input => currentNetwork = manager.resolveProviderNetwork(input) });
const app = createApplicationRuntime({ dataRoot, scheduler, ...ports });
const originalFetch = globalThis.fetch; let inherited = 0;
globalThis.fetch = () => { inherited++; throw new Error('no inherited network fallback'); };
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { vision: true });
  const source = (await app.execute('artifact.import', { image_bytes: await sharp({ create: { width: 100, height: 250, channels: 3, background: 'white' } }).png().toBuffer() })).artifact;
  const input = { sourceArtifactId: source.id, modelRef: 'p::vision' };
  const created = await app.execute('creation.vision', { key: crypto.randomUUID(), value: { ...input, question: 'describe' } });
  const receiving = new Promise(resolve => { entered = resolve; });
  const pending = app.execute('flow.continue', { run_id: created.flow.run.id }); await receiving;
  assert.equal(posts, 1); assert.equal(scheduler.snapshot().httpActive, 1); assert.equal(currentNetwork.snapshot().activeOperations, 1);
  release(); const facts = await pending;
  assert.equal(facts.status, 'ready'); assert.equal(scheduler.snapshot().httpActive, 0);
  assert.equal(facts.task.networkRoutes[0].route, 'proxy'); assert.equal(facts.task.networkRoutes[0].nodeId, 'local');
  hold = false;
  const ocr = await app.execute('creation.ocr', { key: crypto.randomUUID(), value: { ...input, chunkHeight: 100, overlap: 0 } });
  const done = await app.execute('flow.continue', { run_id: ocr.flow.run.id });
  const report = JSON.parse(readCoreArtifactBytes(dataRoot, done.run.report.artifactId).bytes);
  assert.equal(report.invocations, 3); assert.equal(posts, 4); assert.equal(scheduler.snapshot().requestsStarted, 4);
  assert.equal(done.task.networkRoutes.reduce((sum, route) => sum + route.requestCount, 0), 3);
  assert(connects >= 2); assert.equal(inherited, 0);
  await app.dispose();
  // Advance only the model deadline, without waiting 120 wall-clock seconds.
  // Cooling admission must observe the same operation signal, before any POST.
  const nativeTimeout = globalThis.setTimeout, nativeNow = performance.now.bind(performance);
  const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let offset = 0, deadlineTimer;
  const deadlineScheduler = { ...scheduler, async beforeSubmit(runtime, rootPath, context) {
    const waiting = scheduler.beforeSubmit(runtime, rootPath, context, () => Date.now() + 20000);
    assert(deadlineTimer); offset = 120001; deadlineTimer(); return waiting;
  } };
  const deadlineApp = createApplicationRuntime({ dataRoot, scheduler: deadlineScheduler, ...ports });
  try {
    const draft = await deadlineApp.execute('creation.vision', { key: crypto.randomUUID(), value: { ...input, question: 'deadline while queued' } });
    Object.defineProperty(performance, 'now', { configurable: true, value: () => nativeNow() + offset });
    globalThis.setTimeout = (callback, milliseconds, ...args) => {
      if (milliseconds >= 119000 && milliseconds <= 120000) deadlineTimer = callback;
      return nativeTimeout(callback, milliseconds, ...args);
    };
    await assert.rejects(deadlineApp.execute('flow.continue', { run_id: draft.flow.run.id }), { code: 'IRIS_MODEL_TIMEOUT' });
    assert.equal(posts, 4); assert.equal(scheduler.snapshot().requestsStarted, 4);
  } finally {
    globalThis.setTimeout = nativeTimeout;
    if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor); else delete performance.now;
    await deadlineApp.dispose();
  }
  const unavailable = structuredClone(config); unavailable.generation++; unavailable.pools[0].candidates = [];
  fs.writeFileSync(networkFile, JSON.stringify(unavailable));
  const blockedApp = createApplicationRuntime({ dataRoot, ...ports });
  try {
    await assert.rejects(blockedApp.execute('creation.vision', { key: crypto.randomUUID(), value: { ...input, question: 'blocked' } }), { code: 'IRIS_NETWORK_POOL_UNAVAILABLE' });
    assert.equal(posts, 4); assert.equal(inherited, 0);
  } finally { await blockedApp.dispose(); }
  console.log('PASS actual CONNECT+SSE, full-body network/HTTP ownership, per-chunk dispatch accounting and explicit-pool zero fallback');
} finally {
  globalThis.fetch = originalFetch; release?.(); await app.dispose(); await manager.dispose(); scheduler.dispose();
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => provider.close(resolve))]);
}
