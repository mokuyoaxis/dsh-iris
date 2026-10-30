import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair, readConnectionGrants } from '../lib/core-connections.js';
import { loadProviderCatalog, imageCandidatesFromCatalog } from '../lib/provider-catalog.js';
import { FLOW_RESULT } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';
import { providerDependencies } from '../lib/provider-diagnostics.js';
import { createCoreTask, beginCoreAttempt, recordCoreAttemptResult, recordCoreWatchError, recordCorePollResult, failCoreDelivery, requestCoreCancel } from '../lib/core-tasks.js';

const { root } = useTempDshHome('iris-provider-workbench'), dataRoot = path.join(root, 'core'), file = path.join(root, 'providers.json');
const calls = [], checks = [], services = [], key = 'PRIVATE-provider-workbench-fixture'; let rejectDirectory = false;
const upstream = http.createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk;
  calls.push({ method: request.method, url: request.url }); response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET') { if (rejectDirectory) response.statusCode = 401; response.end(JSON.stringify(rejectDirectory ? { error: { message: key } } : { data: [{ id: 'a' }, { id: 'b' }] })); }
  else response.end(JSON.stringify({ data: [{ b64_json: FLOW_RESULT.toString('base64') }] }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const initial = { providers: [{ id: 'one', name: 'One', baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1', apiKey: key, mediaProtocol: 'openai-images',
  enabled: true, models: [{ id: 'a', capabilities: ['image-gen'] }, { id: 'b', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': { mode: 'auto', models: [] } } };
fs.writeFileSync(file, JSON.stringify(initial) + '\n', { mode: 0o600 });
const app = createApplicationRuntime({ dataRoot }); let api, session, grant;
const BASE = '/api/v0/provider-management/';
async function request(route, value, { expected = 200, token = session.accessToken, headers = {}, idempotencyKey } = {}) {
  const response = await fetch(session.origin + route, { method: value === undefined ? 'GET' : 'POST', headers: {
    Authorization: 'Bearer ' + token, ...(value === undefined ? {} : { Origin: session.origin, 'Content-Type': 'application/json' }),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); assert(!JSON.stringify(body).includes(key)); return body;
}
const settings = () => request(BASE + 'settings');
const mutate = async (action, value, expected = 200) => request(BASE + action, { expectedRevision: (await settings()).revision, ...value }, { expected });
try {
  const dependencyRoot = path.join(root, 'dependency-check'), blocked = [], finished = [];
  for (const state of ['active', 'acceptance-unknown', 'result-unknown', 'delivery-pending', 'delivery-failed', 'cancel-requested', 'failed', 'canceled']) {
    const task = createCoreTask(dependencyRoot, { capability: 'image' });
    const attempt = beginCoreAttempt(dependencyRoot, task.id, { providerId: 'one', model: 'one::a' });
    recordCoreAttemptResult(dependencyRoot, task.id, { ...attempt, acceptance: state === 'acceptance-unknown' ? 'unknown' : 'accepted',
      resultKind: state.startsWith('delivery-') ? 'completed' : state === 'acceptance-unknown' ? 'acceptance_unknown' : 'async',
      ...(state !== 'acceptance-unknown' && !state.startsWith('delivery-') ? { remoteTaskId: state } : {}) });
    if (state === 'result-unknown') recordCoreWatchError(dependencyRoot, task.id, new Error('network interrupted'));
    if (state === 'delivery-failed') failCoreDelivery(dependencyRoot, task.id, new Error('disk error'));
    if (state === 'cancel-requested') requestCoreCancel(dependencyRoot, task.id);
    if (['failed', 'canceled'].includes(state)) { recordCorePollResult(dependencyRoot, task.id, { kind: state }); finished.push(task.id); }
    else blocked.push(task.id);
  }
  const protectedTasks = providerDependencies(dependencyRoot, 'one');
  assert.deepEqual([...protectedTasks.blockingTasks].sort(), blocked.sort());
  assert(finished.every(id => !protectedTasks.blockingTasks.includes(id)));
  checks.push('active, acceptance/result unknown, pending/failed delivery and requested cancellation are protected; terminal failed/canceled history is retained without blocking');
  await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true }); await app.dispose();
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'grants'), origin: 'http://127.0.0.1:1', label: 'Denied provider management' });
  grant = readConnectionGrants(pair.serverFile)[0];
  const options = { dataRoot, providerConfigPath: file, serveWorkbench: true, allowProviderManagement: true, allowExecution: true, connectionsFile: pair.serverFile };
  api = createLocalReadApi(options); services.push(api); session = await api.start();
  const original = fs.readFileSync(file), facts = await request(BASE + 'diagnostics');
  assert.equal(facts.capabilities.length, 6); assert.equal(facts.capabilities[0].candidates.length, 2); assert.equal(calls.length, 0);
  assert(facts.monitors.every(item => !item.enabled));
  for (const value of [null, [], {}, { providerId: 'one', confirm: true }, { expectedRevision: facts.revision, providerId: null, confirm: true },
    { expectedRevision: facts.revision, providerId: 'one', confirm: true, extra: true }, { expectedRevision: facts.revision, providerId: 'one', confirm: false }]) {
    await request(BASE + 'remove', value, { expected: 400 });
  }
  for (const action of ['check', 'monitor', 'impact']) await request(BASE + action, { expectedRevision: 'stale', providerId: 'one',
    ...(action === 'monitor' ? { enabled: true, intervalSeconds: 60 } : {}) }, { expected: 409 });
  assert.equal(calls.length, 0); assert.deepEqual(fs.readFileSync(file), original);
  for (const action of ['diagnostics', 'check', 'monitor', 'impact', 'enabled', 'remove', 'policies']) {
    await request(BASE + action, action === 'diagnostics' ? undefined : {}, { expected: 403, token: grant.accessToken, headers: { 'Iris-Connection-Id': grant.connectionId } });
    await request(BASE + action, action === 'diagnostics' ? undefined : {}, { expected: 403, headers: { Origin: 'https://outside.invalid' } });
  }
  checks.push('local-only diagnostics and new management routes stay owner-only, same-origin and secret-free; reading never checks or generates');
  const connected = await mutate('check', { providerId: 'one' }); assert.equal(connected.ok, true); assert.equal(connected.modelCount, 2);
  assert.deepEqual(fs.readFileSync(file), original); assert(calls.every(call => call.method === 'GET'));
  assert.equal((await request(BASE + 'diagnostics')).capabilities[0].verified, 0);
  rejectDirectory = true; const failed = await mutate('check', { providerId: 'one' }); assert.equal(failed.ok, false); rejectDirectory = false;
  const enabledMonitor = await mutate('monitor', { providerId: 'one', enabled: true, intervalSeconds: 60 });
  assert.equal(enabledMonitor.monitors[0].enabled, true); assert.deepEqual(fs.readFileSync(file), original);
  await mutate('monitor', { providerId: 'one', enabled: true, intervalSeconds: 1 }, 400);
  await mutate('monitor', { providerId: 'one', enabled: false, intervalSeconds: 60 });
  checks.push('explicit connection checks use directory GETs only, keep media unverified and config bytes unchanged; keepalive is optional and bounded');
  const old = await settings(); const policies = await mutate('policies', { assignments: { 'image-gen': { mode: 'manual', models: ['one::b', 'one::a'] } } });
  assert.equal(policies.assignments['image-gen'].models[0], 'one::b');
  assert.deepEqual(imageCandidatesFromCatalog(loadProviderCatalog(file)).map(item => item.modelRef), ['one::b', 'one::a']);
  await request(BASE + 'policies', { expectedRevision: old.revision, assignments: {} }, { expected: 409 });
  await mutate('enabled', { providerId: 'one', enabled: false });
  assert((await request(BASE + 'diagnostics')).capabilities[0].models.every(model => model.reason === 'provider_disabled'));
  await mutate('enabled', { providerId: 'one', enabled: true });
  checks.push('independent pool saves use the actual routing order, stale revisions conflict, provider disable and restore retain configuration');
  const created = await request('/api/v0/generations', { modelRef: 'one::a', prompt: 'a red circle', size: '256x256' }, { expected: 201, idempotencyKey: crypto.randomUUID() });
  const impact = await mutate('impact', { providerId: 'one' }); assert.equal(impact.blockingRuns.length, 1);
  const beforeBlocked = fs.readFileSync(file); await mutate('remove', { providerId: 'one', confirm: true }, 409); assert.deepEqual(fs.readFileSync(file), beforeBlocked);
  const accepted = await request('/api/v0/runs/' + created.flow.id + '/continue', { expectedRevision: created.flow.revision }, { expected: 202, idempotencyKey: crypto.randomUUID() });
  let operation;
  for (let n = 0; n < 300; n++) { operation = (await request('/api/v0/operations/' + accepted.operation.id)).operation; if (!['queued', 'running'].includes(operation.state)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(operation.state, 'succeeded', JSON.stringify(operation));
  assert.equal((await request(BASE + 'diagnostics')).capabilities[0].verified, 1);
  checks.push('unstarted durable Runs prevent provider deletion; explicit real generation creates a Core Task/Operation and updates exact-model recent-success evidence');
  const done = await mutate('impact', { providerId: 'one' }); assert.equal(done.blockingRuns.length + done.blockingTasks.length, 0);
  const removed = await mutate('remove', { providerId: 'one', confirm: true }); assert.equal(removed.providers.length, 0);
  assert.equal(removed.assignments['image-gen'].mode, 'manual'); assert.deepEqual(removed.assignments['image-gen'].models, []);
  assert.equal((await request('/api/v0/runs/' + created.flow.id)).id, created.flow.id);
  assert(fs.readdirSync(root).some(name => name.includes('.backup-')));
  await api.dispose(); api = createLocalReadApi(options); services.push(api); session = await api.start();
  assert.deepEqual((await request(BASE + 'diagnostics')).monitors, []);
  checks.push('confirmed removal prunes only affected manual references with private backups, preserves original history/artifacts and does not persist monitoring');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  console.log(JSON.stringify({ ok: true, checks, actualPaidCalls: 0, work: root }));
} finally { await Promise.allSettled(services.map(service => service.dispose())); await app.dispose(); await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); }
