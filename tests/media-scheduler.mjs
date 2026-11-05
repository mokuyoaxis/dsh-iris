import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createMediaScheduler } from '../lib/media-scheduler.js';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { checkedSchedulingPolicy } from '../lib/scheduling-policy.js';

const policy = { schemaVersion: 1, httpConcurrency: 2, requestsPerSecond: 3, remoteLimit: 4, queueTimeoutMs: 5000 };
assert.throws(() => checkedSchedulingPolicy({ ...policy, httpConcurrency: 5 }), { code: 'IRIS_SCHEDULER_CONFIG_INVALID' });
assert.throws(() => checkedSchedulingPolicy({ ...policy, unknown: true }), { code: 'IRIS_SCHEDULER_CONFIG_INVALID' });
assert.throws(() => checkedSchedulingPolicy({ schemaVersion: 2 }), { code: 'IRIS_SCHEDULER_CONFIG_INVALID' });
let canceledResponseClosed = false;
const starts = [], server = http.createServer((req, res) => {
  starts.push({ path: req.url, at: performance.now() });
  if (req.url === '/redirect') { res.writeHead(302, { location: '/final' }); res.end(); return; }
  if (req.url === '/429') { res.writeHead(429, { 'retry-after': '1' }); res.end('cooldown'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.write('hello');
  // Keep this body open: normal completion must not make cancellation pass.
  if (req.url === '/cancel') { res.once('close', () => { canceledResponseClosed = true; }); return; }
  const timer = setTimeout(() => res.end(' world'), req.url === '/slow' ? 250 : 25);
  res.once('close', () => clearTimeout(timer));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const scheduler = createMediaScheduler(policy), manager = createProviderNetworkManager({ scheduler });
try {
  const client = manager.resolveProviderNetwork({ providerId: 'fixture', modelRef: 'fixture::a' });
  const result = await client.run(fetch => Promise.all(['/slow', '/slow', '/redirect', '/four', '/five'].map(async endpoint => {
    const response = await fetch(url + endpoint); return response.text();
  })), { operation: 'discover' });
  assert.deepEqual(result, Array(5).fill('hello world'));
  assert.equal(scheduler.snapshot().requestsStarted, 6, 'redirect dispatch is included');
  assert.equal(scheduler.snapshot().httpActive, 0, 'body completion releases permits');
  assert(starts.find(x => x.path === '/redirect').at - starts[0].at >= 200, 'response headers do not release a slow body slot');
  for (let i = 3; i < starts.length; i++) assert(starts[i].at - starts[i - 3].at >= 960, 'rolling actual request starts obey RPS (40ms server receipt tolerance)');
  const before429 = performance.now();
  await client.run(async fetch => { const response = await fetch(url + '/429'); await response.text(); });
  await client.run(async fetch => { const response = await fetch(url + '/after429'); await response.text(); });
  assert(starts.find(x => x.path === '/after429').at - starts.find(x => x.path === '/429').at >= 960);
  assert(performance.now() - before429 >= 960);
  const bounded = createMediaScheduler({ ...policy, httpConcurrency: 1, requestsPerSecond: 100, queueTimeoutMs: 60 });
  const boundedManager = createProviderNetworkManager({ scheduler: bounded });
  try {
    const network = boundedManager.resolveProviderNetwork({ providerId: 'bounded', modelRef: 'bounded::a' });
    const first = network.run(async fetch => { const response = await fetch(url + '/slow'); return response.text(); });
    while (bounded.snapshot().httpActive !== 1) await delay(2);
    await assert.rejects(network.run(fetch => fetch(url + '/must-not-send')), error => error.code === 'IRIS_SCHEDULER_QUEUE_TIMEOUT'
      && error.acceptance === 'not_accepted' && error.stage === 'prepare');
    assert(!starts.some(item => item.path === '/must-not-send'), 'queue timeout never reaches the remote server');
    const abort = new AbortController();
    const queued = network.run(fetch => fetch(url + '/must-not-send-aborted', { signal: abort.signal }));
    const rejected = assert.rejects(queued, error => error.acceptance === 'not_accepted');
    abort.abort(); await rejected; await first;
    assert.equal(bounded.snapshot().httpQueued, 0); assert.equal(bounded.snapshot().httpActive, 0);
  } finally { await boundedManager.dispose(); bounded.dispose(); }
  const four = createMediaScheduler({ ...policy, httpConcurrency: 4, requestsPerSecond: 100 });
  const fourManager = createProviderNetworkManager({ scheduler: four });
  try {
    const network = fourManager.resolveProviderNetwork({ providerId: 'four', modelRef: 'four::image' });
    let peak = 0;
    await Promise.all(Array.from({ length: 5 }, () => network.run(async fetch => {
      const response = await fetch(url + '/slow'); peak = Math.max(peak, four.snapshot().httpActive); return response.text();
    })));
    assert.equal(peak, 4, 'actual HTTP exercises the supported global maximum');
    assert.equal(four.snapshot().httpActive, 0);
    await network.run(async fetch => { const response = await fetch(url + '/cancel'); await response.body.cancel(); });
    const cancelDeadline = performance.now() + policy.queueTimeoutMs;
    while ((!canceledResponseClosed || four.snapshot().httpActive) && performance.now() < cancelDeadline) await delay(2);
    assert(canceledResponseClosed, 'body cancellation closes the deliberately unfinished server response');
    assert.equal(four.snapshot().httpActive, 0, 'body cancellation releases the HTTP permit');
  } finally { await fourManager.dispose(); four.dispose(); }
  console.log('Media scheduler: strict policy, real HTTP body concurrency, redirects, rolling dispatch RPS and 429 cooldown OK');
} finally {
  await manager.dispose(); scheduler.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

const scoped = createMediaScheduler({ ...policy, httpConcurrency: 4, requestsPerSecond: 100, providers: [
  { providerId: 'p', httpConcurrency: 1, models: [{ modelId: 'a', requestsPerSecond: 1 }] }
] });
const dispatches = [], activeByProvider = new Map(); let peakP = 0;
function scopedCall(providerId, model) {
  return new Promise((resolve, reject) => {
    const transport = { dispatch(options, handler) {
      dispatches.push({ model, providerId, at: performance.now() });
      activeByProvider.set(providerId, (activeByProvider.get(providerId) || 0) + 1);
      peakP = Math.max(peakP, activeByProvider.get('p') || 0);
      handler.onConnect(reject);
      setTimeout(() => { activeByProvider.set(providerId, activeByProvider.get(providerId) - 1); handler.onComplete([]); }, 40);
      return true;
    } };
    scoped.dispatcher(transport, { providerId, modelRef: `${providerId}::${model}` }).dispatch({ method: 'GET', path: '/' }, {
      onConnect() {}, onHeaders() {}, onData() {}, onError: reject, onComplete: resolve
    });
  });
}
try {
  await Promise.all([scopedCall('p', 'a'), scopedCall('p', 'a'), scopedCall('p', 'b'), scopedCall('q', 'a')]);
  assert.equal(peakP, 1);
  const a = dispatches.filter(x => x.providerId === 'p' && x.model === 'a');
  assert(a[1].at - a[0].at >= 990);
  assert(dispatches.find(x => x.providerId === 'q').at < a[1].at);
  assert.equal(scoped.snapshot().requestsStarted, 4);
  console.log('Media scheduler scopes: provider concurrency, exact-model rate and unrelated provider progress OK');
} finally { scoped.dispose(); }
