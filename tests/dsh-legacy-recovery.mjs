import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useTempDshHome } from './test-env.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const { root } = useTempDshHome('iris-dsh-legacy-recovery');
const store = await import('../lib/config.js');
const tasks = await import('../lib/tasks.js');
const { apply } = await import('../lib/index.js');
const reference = { provider: 'workbuddy', settingsNs: 'llm-pi-ai' };
const shared = store.upsert({ name: 'Shared fixture', dshProvider: reference, mediaProtocol: 'openai-images' });
const manual = store.upsert({ name: 'Manual fixture', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiKey: 'fixture-manual-key', mediaProtocol: 'dashscope' });
let key = 'fixture-startup-key', available = true, resolveGate, enteredResolve, credentialReads = 0;
const services = {
  tools: { register: () => () => {} },
  llm: {
    listProviders: () => [{ id: 'workbuddy' }],
    listConfigurableProviders: () => [{ ...reference, settingsPath: ['providers', 'workbuddy'] }]
  },
  settings: { describe: () => [{ ns: reference.settingsNs, value: { providers: {
    workbuddy: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'FIXTURE_KEY' }
  } } }] },
  credentials: {
    describe: async () => ({ configured: available }),
    resolve: async () => {
      credentialReads++;
      enteredResolve?.();
      await resolveGate;
      return { value: key };
    }
  }
};
function context() {
  const provided = new Map(), disposers = [];
  return {
    get: name => provided.get(name) || services[name],
    provide: (name, value) => provided.set(name, value),
    inject() {},
    effect(fn) { disposers.push(fn()); return () => {}; },
    async close() { for (const dispose of [...disposers].reverse()) await dispose?.(); }
  };
}
function seed(provider, name, v2 = false) {
  if (!v2) {
    const task = tasks.create({ cap: 'image', providerId: provider.id, model: 'wan2.2-t2i-flash', protocol: 'dashscope', prompt: name });
    return tasks.update(task.id, { remoteTaskId: name });
  }
  const task = tasks.createV2({ cap: 'image', prompt: name });
  const attempt = tasks.beginAttempt(task.id, { providerId: provider.id,
    model: provider.id + '::wan2.2-t2i-flash', protocol: 'dashscope' });
  return tasks.recordAttemptResult(task.id, { ...attempt, acceptance: 'accepted', resultKind: 'accepted', remoteTaskId: name });
}
async function until(predicate, label, details) {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert(predicate(), label + (details ? '\n' + JSON.stringify(details()) : ''));
}
const originalFetch = globalThis.fetch, contexts = [], requests = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  requests.push({ path: url.pathname, method: options.method || 'GET' });
  assert.equal(options.method || 'GET', 'GET', 'startup recovery must never submit generation');
  if (url.pathname.includes('/tasks/')) {
    assert.equal(new Headers(options.headers).get('authorization'),
      'Bearer ' + (url.hostname === 'dashscope-intl.aliyuncs.com' ? 'fixture-manual-key' : key));
    return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://artifact.fixture.invalid/result.png' }] } });
  }
  assert.equal(url.href, 'https://artifact.fixture.invalid/result.png');
  return new Response(FAKE_PNG, { headers: { 'content-type': 'image/png' } });
};
async function start() {
  tasks.resetCache();
  const ctx = context(); contexts.push(ctx);
  await apply(ctx);
  await until(() => ctx.get('irisRuntime').snapshot().operations === 0, 'startup setup must settle');
  return ctx;
}
try {
  const configFile = path.join(root, 'iris/v1/providers.json');
  const configured = fs.readFileSync(configFile, 'utf8');
  const initial = [seed(shared, 'remote-v1'), seed(shared, 'remote-v2', true), seed(manual, 'remote-manual')];
  let ctx = await start();
  await until(() => initial.every(task => tasks.get(task.id).status === 'succeeded'), 'v1/v2 references and manual provider must recover',
    () => ({ tasks: initial.map(task => tasks.get(task.id)), requests }));
  assert.deepEqual(requests.filter(item => item.path.includes('/tasks/')).map(item => item.path.split('/').at(-1)).sort(),
    initial.map(task => task.remoteTaskId).sort());
  for (const original of initial) {
    const recovered = tasks.get(original.id);
    assert.equal(recovered.remoteTaskId, original.remoteTaskId);
    assert.equal(recovered.providerId, original.providerId);
    assert.deepEqual(recovered.attempts, original.attempts);
    assert.equal(tasks.isV2Task(recovered), tasks.isV2Task(original), 'no legacy format migration');
  }
  await ctx.close();

  available = false;
  const suspended = [seed(shared, 'remote-unavailable-v1'), seed(shared, 'remote-unavailable-v2', true)];
  const beforeUnavailable = requests.length;
  ctx = await start();
  for (const original of suspended) {
    const recovered = tasks.get(original.id);
    assert.equal(recovered.status, 'running', 'temporary missing connection is not a remote failure');
    assert.equal(recovered.remoteTaskId, original.remoteTaskId);
    assert.match(recovered.error, /不可用/);
    if (tasks.isV2Task(recovered)) {
      assert.equal(recovered.acceptance, 'accepted');
      assert.equal(recovered.outcome, 'none');
      assert.equal(recovered.watchState, 'suspended');
    }
  }
  assert.equal(requests.length, beforeUnavailable);
  await ctx.close();
  available = true; key = 'fixture-rotated-key';
  ctx = await start();
  await until(() => suspended.every(task => tasks.get(task.id).status === 'succeeded'), 'restored connection must observe original tasks');
  for (const original of suspended) {
    const recovered = tasks.get(original.id);
    assert.equal(recovered.remoteTaskId, original.remoteTaskId);
    assert.equal(recovered.providerId, original.providerId);
    assert.deepEqual(recovered.attempts, original.attempts);
    assert.equal(recovered.error, undefined, 'successful recovery must clear the stale connection error');
  }
  assert.equal(requests.filter(item => item.path.includes('/tasks/')).length, 5);
  assert.equal(fs.readFileSync(configFile, 'utf8'), configured, 'resolved endpoint and credentials must not be persisted');
  assert.equal(fs.existsSync(path.join(root, 'iris/v1/core-v0')), false, 'legacy recovery must not create or migrate a Core root');
  await ctx.close();

  const readsBeforeIdle = credentialReads;
  ctx = await start();
  assert.equal(credentialReads, readsBeforeIdle, 'idle startup must not resolve credentials without a pending remote task');
  assert.equal(requests.length, 10, 'completed tasks must not be observed again');
  await ctx.close();

  // Closing while the Host credential lookup is pending must drain it and forbid late timers.
  const pending = seed(shared, 'remote-close-before-resolve');
  const beforePending = JSON.stringify(tasks.all());
  const callsBeforeClose = requests.length;
  let release, enter;
  resolveGate = new Promise(resolve => { release = resolve; });
  const entering = new Promise(resolve => { enter = resolve; }); enteredResolve = enter;
  ctx = context(); contexts.push(ctx);
  await apply(ctx);
  await Promise.race([entering, delay(1000)]);
  assert(ctx.get('irisRuntime').snapshot().operations > 0, 'startup connection lookup must belong to the runtime');
  let closed = false;
  const closing = ctx.close().then(() => { closed = true; });
  await delay(20);
  assert.equal(closed, false, 'unload must drain owned startup resolution');
  release(); await closing;
  assert.equal(ctx.get('irisRuntime').snapshot().state, 'closed');
  assert.equal(JSON.stringify(tasks.all()), beforePending);
  await delay(550);
  assert.equal(requests.length, callsBeforeClose, 'no late poll after close');
  assert.equal(tasks.get(pending.id).remoteTaskId, pending.remoteTaskId);
  console.log('PASS DSH legacy startup: v1/v2 shared and manual connections, temporary outage/rotation, original remote IDs, zero generation, no credential persistence or late takeover');
} finally {
  for (const ctx of contexts) await ctx.close();
  tasks.stopWatchAll();
  globalThis.fetch = originalFetch;
}
