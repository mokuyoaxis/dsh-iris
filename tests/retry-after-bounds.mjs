import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { retryAfterDelay, recordModelRateLimit } from '../lib/provider-health.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createTrackedProviderAdapter } from '../lib/configured-image-runtime.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-retry-after-bounds'), now = Date.parse('2026-11-04T00:00:00.000Z');
const max = 2_147_483_647;
for (const [value, expected] of [['120', 120000], ['0', 1000], ['0.5', 1000], ['', 60000], ['invalid', 60000], ['-1', 60000],
  ['Infinity', 60000], [new Date(now + 90000).toUTCString(), 90000], [new Date(now - 1000).toUTCString(), 60000],
  ['100000000000000', max], ['1e308', max], [new Date(8.64e15).toISOString(), max]]) {
  assert.equal(retryAfterDelay(value, now), expected, String(value));
}
for (const [value, expected] of [[Number.MAX_VALUE, max], [max + 1, max], [NaN, 60000], [Infinity, 60000], [-1, 60000], [0, 1000]]) {
  const provider = {};
  assert(recordModelRateLimit(provider, 'image', { httpStatus: 429, at: new Date(now).toISOString(), retryAfterMs: value }));
  assert.equal(Date.parse(provider.health.rateLimits[0].until) - now, expected);
}
const edge = {};
recordModelRateLimit(edge, 'image', { httpStatus: 429, at: new Date(8.64e15).toISOString(), retryAfterMs: max });
assert.equal(edge.health.rateLimits[0].until, new Date(8.64e15).toISOString());
const unexpected = new Error('fixture unexpected string conversion');
assert.throws(() => retryAfterDelay({ toString() { throw unexpected; } }), error => error === unexpected, 'unexpected programming errors must remain visible');

const requests = [];
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks)); requests.push(body.model);
  if (body.model === 'primary') {
    response.writeHead(429, { 'content-type': 'application/json', 'Retry-After': '100000000000000' });
    response.end(JSON.stringify({ error: { code: 'Throttling.ConcurrentRequests', message: 'fixture concurrent limit' } }));
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ b64_json: FAKE_PNG.toString('base64') }] }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = path.join(root, 'providers.json'), dataRoot = path.join(root, 'core');
const providers = ['primary', 'backup'].map(id => ({ id, apiKey: 'fixture-' + id, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
  mediaProtocol: 'openai-images', models: [{ id, capabilities: ['image-gen'] }] }));
fs.writeFileSync(config, JSON.stringify({ providers, assignments: { 'image-gen': providers.map(provider => provider.id + '::' + provider.id) } }), { mode: 0o600 });
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
try {
  const result = await createProviderTaskRunner(runtime).submit({ capability: 'image', providerInput: { prompt: 'fixture only' },
    candidates: providers.map(provider => ({ adapter: createTrackedProviderAdapter(provider, config, undefined, undefined,
      { modelRef: provider.id + '::' + provider.id }), model: provider.id + '::' + provider.id })) });
  assert.equal(result.task.deliveryState, 'ready'); assert.equal(result.task.attempts.length, 2);
  const first = result.task.attempts[0];
  assert.equal(first.acceptance, 'not_accepted'); assert.equal(first.error.httpStatus, 429);
  assert.equal(first.error.category, 'rate_limit'); assert.equal(first.error.providerCode, 'Throttling.ConcurrentRequests');
  assert.deepEqual(requests, ['primary', 'backup']);
  const saved = JSON.parse(fs.readFileSync(config));
  const limit = saved.providers[0].health.rateLimits[0];
  assert.equal(Date.parse(limit.until) - Date.parse(limit.at), max);
  console.log('PASS Retry-After bounds: normal/zero/date/overflow/invalid durations, safe date boundary, visible unexpected errors and actual Core 429 classification/cooldown without masking or request replay');
} finally { await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
