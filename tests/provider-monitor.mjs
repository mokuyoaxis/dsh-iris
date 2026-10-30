import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createProviderMonitor } from '../lib/provider-monitor.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-provider-monitor'), configPath = path.join(root, 'providers.json');
const timers = new Set(), calls = []; let pendingResponse;
const upstream = http.createServer((request, response) => { calls.push(request.method); if (calls.length === 2) pendingResponse = response;
  else { response.setHeader('Content-Type', 'application/json'); response.end('{"data":[]}'); } });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const catalog = { providers: [{ id: 'one', enabled: true, auth: 'none', mediaProtocol: 'openai-images', baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1', models: [] }] };
fs.writeFileSync(configPath, JSON.stringify(catalog), { mode: 0o600 }); const original = fs.readFileSync(configPath);
const monitor = createProviderMonitor({ configPath, setTimer(callback, ms) { const timer = { callback, ms }; timers.add(timer); return timer; }, clearTimer(timer) { timers.delete(timer); } });
try {
  assert.equal(monitor.snapshot()[0].enabled, false); assert.equal(calls.length, 0);
  monitor.configure({ providerId: 'one', enabled: true, intervalSeconds: 60 }); assert.equal(timers.size, 1);
  const tick = [...timers][0]; assert.equal(tick.ms, 60000); timers.delete(tick); await tick.callback();
  assert.deepEqual(calls, ['GET']); assert.equal(monitor.snapshot()[0].last.ok, true); assert.equal(timers.size, 1);
  const next = [...timers][0]; timers.delete(next); const checking = next.callback();
  for (let n = 0; n < 200 && !pendingResponse; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(pendingResponse);
  monitor.configure({ providerId: 'one', enabled: true, intervalSeconds: 300 });
  await checking;
  assert.equal(timers.size, 1, 'changing the interval while checking cannot install a second timer');
  assert.equal([...timers][0].ms, 300000);
  const changed = structuredClone(catalog); changed.providers[0].baseUrl += '/changed';
  fs.writeFileSync(configPath, JSON.stringify(changed));
  assert.equal(monitor.snapshot()[0].enabled, false, 'endpoint changes stop old keepalive');
  assert.equal(monitor.snapshot()[0].last, null, 'old connection evidence is invalidated'); assert.equal(timers.size, 0);
  fs.writeFileSync(configPath, original);
  monitor.configure({ providerId: 'one', enabled: true, intervalSeconds: 900 });
  await monitor.dispose(); assert.equal(timers.size, 0);
  assert.deepEqual(fs.readFileSync(configPath), original); assert(calls.every(method => method === 'GET'));
  assert.throws(() => monitor.snapshot(), { code: 'IRIS_PROVIDER_MONITOR_CLOSED' });
  console.log('provider monitor: explicit read-only scheduling, no config writes, in-flight reconfiguration/abort, endpoint invalidation and disposal OK');
} finally { await monitor.dispose(); pendingResponse?.end('{}'); await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); }
