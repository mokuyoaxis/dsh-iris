import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCorePluginRegistry, createCorePluginHost, definePlugin } from '@mokuyoaxis/dsh-iris/plugins';
import { loadCorePluginFixture } from './fixtures/core-plugin-fixture.mjs';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const { fixturePlugin } = await loadCorePluginFixture();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-plugin-operations-')), checks = [], hosts = [], registries = [];
const registry = async (plugins) => { const value = await createCorePluginRegistry({ plugins, coreVersion: '0.3.0-alpha.1' }); registries.push(value); return value; };
const host = options => { const value = createCorePluginHost(options); hosts.push(value); return value; };
const image = FAKE_PNG.toString('base64');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }

try {
  const r = await registry([fixturePlugin()]);
  const dataRoot = path.join(root, 'core'), h = host({ dataRoot, registry: r, allowedOperations: ['example.media.list', 'example.media.import'] });
  const none = host({ dataRoot, registry: r });
  assert.equal(fs.existsSync(dataRoot), false);
  await assert.rejects(none.call('example.media.import', { image }), { code: 'IRIS_PLUGIN_OPERATION_DENIED' });
  await assert.rejects(h.call('example.media.import', { image, extra: 'forbidden' }), { code: 'IRIS_PLUGIN_INPUT_INVALID' });
  await assert.rejects(h.call('example.media.list', { limit: '2' }), { code: 'IRIS_PLUGIN_INPUT_INVALID' });
  await assert.rejects(h.call('example.media.import', { image }, { dependency: r.dependency('operations', 'example.media.list') }), { code: 'IRIS_PLUGIN_DEPENDENCY_MISMATCH' });
  assert.equal(fs.existsSync(dataRoot), false);
  const imported = await h.call('example.media.import', { image });
  assert.match(imported.value.artifactId, /^artifact_/);
  assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  assert.equal((await h.call('example.media.list', {})).value.total, 1);
  const pin = JSON.parse(JSON.stringify(imported.dependency));
  assert.equal((await h.call('example.media.import', { image }, { dependency: pin })).dependency.pluginVersion, '1.0.0');
  const upgraded = await registry([fixturePlugin({ version: '1.0.1' })]);
  const uh = host({ dataRoot, registry: upgraded, allowedOperations: ['example.media.import'] });
  await assert.rejects(uh.call('example.media.import', { image }, { dependency: pin }), { code: 'IRIS_PLUGIN_DEPENDENCY_MISMATCH' });
  checks.push('explicit grants and strict schema precede storage; real Core commands own artifact persistence and writer leases');

  const entered = deferred(), release = deferred(), events = [];
  const p = fixturePlugin({ disposed: () => events.push('disposed') });
  const custom = definePlugin({ manifest: p.manifest, activate: ctx => {
    const implementation = p.activate(ctx);
    return { ...implementation, operations: { ...implementation.operations, import: async (input, context) => {
      events.push('write'); entered.resolve(); await release.promise;
      assert.equal(context.signal.aborted, false);
      assert.deepEqual(Object.keys(context).sort(), ['core', 'dependency', 'signal']);
      assert.deepEqual(Object.keys(context.core), ['execute']);
      return implementation.operations.import(input, context);
    } } };
  } });
  const qr = await registry([custom]), qh = host({ dataRoot, registry: qr, allowedOperations: ['example.media.list', 'example.media.import'] });
  const first = qh.call('example.media.import', { image }); await entered.promise;
  const cancelled = new AbortController();
  const skipped = qh.call('example.media.import', { image }, { signal: cancelled.signal });
  const rejected = assert.rejects(skipped, { code: 'IRIS_APP_ABORTED' });
  const last = qh.call('example.media.import', { image });
  assert.equal(qh.snapshot().queuedWrites, 2);
  assert.equal((await qh.call('example.media.list', {})).value.total, 2, 'reader does not wait behind active writer');
  cancelled.abort(); await rejected;
  const closing = qr.dispose(); assert.equal(qr.dispose(), closing);
  await assert.rejects(qh.call('example.media.list', {}), { code: 'IRIS_PLUGIN_CLOSED' });
  assert(!events.includes('disposed'));
  release.resolve(); await first; await last; await closing;
  assert.deepEqual(events, ['write', 'write', 'disposed']);
  assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  checks.push('FIFO writes, parallel readers, queued cancellation and registry disposal cover every reserved call');

  const denied = await registry([fixturePlugin({ operation: async (_input, ctx) => {
    await ctx.core.execute('artifact.import', { image_bytes: FAKE_PNG }); return {};
  } })]);
  const dh = host({ dataRoot, registry: denied, allowedOperations: ['example.media.list'] });
  await assert.rejects(dh.call('example.media.list', {}), { code: 'IRIS_PLUGIN_OPERATION_DENIED' });
  const unawaited = await registry([fixturePlugin({ operation: (_input, ctx) => {
    void ctx.core.execute('artifact.import', { image_bytes: FAKE_PNG }); return {};
  } })]);
  const unawaitedHost = host({ dataRoot, registry: unawaited, allowedOperations: ['example.media.list'] });
  await assert.rejects(unawaitedHost.call('example.media.list', {}), { code: 'IRIS_PLUGIN_OPERATION_DENIED' });
  checks.push('a read contribution cannot write or issue an undeclared Core command');

  const waiting = deferred(), stopped = deferred(); let lateContext;
  const stopping = await registry([fixturePlugin({ operation: async (_input, ctx) => {
    lateContext = ctx; waiting.resolve();
    await new Promise(resolve => { ctx.signal.addEventListener('abort', resolve, { once: true }); });
    stopped.resolve(); return {};
  } })]);
  const sh = host({ dataRoot, registry: stopping, allowedOperations: ['example.media.list'] });
  const running = sh.call('example.media.list', {}), failed = assert.rejects(running, { name: 'AbortError' });
  await waiting.promise; await sh.dispose(); await stopped.promise; await failed;
  await assert.rejects(lateContext.core.execute('artifact.list', {}), { name: 'AbortError' });
  checks.push('Core shutdown aborts the operation context, waits for it, and prevents saved-context reuse');

  // The operation must declare the issued read command; a Core failure cannot be hidden as success.
  const source = fixturePlugin(), manifest = structuredClone(source.manifest); manifest.contributions.operations[0].commands = ['artifact.inspect'];
  const ff = await registry([definePlugin({ manifest, activate: ctx => {
    const implementation = source.activate(ctx); return { ...implementation, operations: { ...implementation.operations,
      list: async (_input, context) => { void context.core.execute('artifact.inspect', { artifact_id: 'invalid' }); return {}; }
    } };
  } })]);
  const fh = host({ dataRoot, registry: ff, allowedOperations: ['example.media.list'] });
  await assert.rejects(fh.call('example.media.list', {}));
  assert.equal(fh.snapshot().activeReaders, 0);
  checks.push('unawaited Core calls are drained and their failure cannot release a lease early or report success');

  // Existing application surface remains usable with no plugin assembly.
  const app = createApplicationRuntime({ dataRoot });
  try { assert.equal((await app.execute('artifact.list', {})).total, 4); } finally { await app.dispose(); }
  console.log(JSON.stringify({ ok: true, checks, root }, null, 2));
} finally {
  for (const value of hosts) await value.dispose();
  for (const value of registries) await value.dispose();
}
