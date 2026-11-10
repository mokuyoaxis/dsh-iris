import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { readOperation, readAllOperations } from '../lib/operation-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { createRootBusyFixture } from './fixtures/root-busy-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-operation-root-busy');
async function check(scheduled, action) {
  const dataRoot = path.join(root, (scheduled ? 'scheduled-' : 'serial-') + action), fixture = imageFlowFixture(dataRoot);
  const setup = createApplicationRuntime({ dataRoot, ...fixture }), apis = [];
  let current, holder;
  async function start(port) {
    const api = createLocalReadApi({ dataRoot, allowExecution: true, executionPorts: fixture,
      ...(scheduled ? { scheduling: { schemaVersion: 1, requestsPerSecond: 100, remoteLimit: 4 } } : {}) });
    apis.push(api); current = { api, ...await api.start(port === undefined ? {} : { port }) };
  }
  async function request(endpoint, input, key) {
    const response = await fetch(current.origin + '/api/v0/' + endpoint, { method: input === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + current.accessToken,
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, ...await response.json() };
  }
  async function until(check) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) { const result = await check(); if (result) return result; await delay(10); }
    assert.fail('root-busy API checkpoint missing: ' + JSON.stringify(readAllOperations(dataRoot)));
  }
  try {
    await setup.execute('flow.init', {}); await setup.execute('execution.init', {});
    const source = (await setup.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
    const flow = await setup.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'root writer fixture' });
    await setup.dispose(); await start();
    holder = await createRootBusyFixture(dataRoot); holder.arm();
    const key = crypto.randomUUID(), endpoint = 'runs/' + flow.run.id + '/continue', input = { expectedRevision: flow.run.revision };
    const accepted = await request(endpoint, input, key); assert.equal(accepted.status, 202);
    const id = accepted.operation.id;
    assert.equal(inspectCoreWriterLease(dataRoot).pid, holder.pid);
    const waiting = await until(async () => {
      const result = await request('operations/' + id);
      assert.equal(result.status, 200);
      return result.operation.scheduling?.phase === 'root_busy' && result.operation;
    });
    assert.equal(waiting.state, 'queued');
    const saved = JSON.stringify(readOperation(dataRoot, id));
    const lookup = await request('operations?key=' + key);
    assert.equal(lookup.operation.id, id); assert.deepEqual(lookup.operation.scheduling, { phase: 'root_busy' });
    assert.equal(JSON.stringify(readOperation(dataRoot, id)), saved, 'wait reasons are not persisted');
    assert.equal(fixture.calls.submit.length, 0);
    const repeated = await request(endpoint, input, key);
    assert.equal(repeated.status, 200); assert.equal(repeated.operation.id, id); assert.equal(repeated.idempotentReplay, true);
    await delay(30);
    assert.equal(fixture.calls.submit.length, 0);
    if (action === 'cancel') {
      const stop = await request('operations/' + id + '/cancel', {});
      assert.equal(stop.status, 409); assert.equal(stop.error.code, 'IRIS_API_ROOT_BUSY');
      assert.equal(readOperation(dataRoot, id).state, 'queued');
    }
    await holder.release();
    await delay(30);
    assert.equal(fixture.calls.submit.length, 0, 'lease release never dispatches automatically');
    assert.equal((await request('operations/' + id)).operation.scheduling.phase, 'root_busy');
    if (action === 'replay') {
      const replay = await request(endpoint, input, key);
      assert.equal(replay.idempotentReplay, true); assert.equal(replay.operation.id, id);
      const done = await until(async () => {
        const result = await request('operations/' + id);
        return result.operation.state === 'succeeded' && result.operation;
      });
      assert.equal(done.scheduling, undefined);
      assert.equal(fixture.calls.submit.length, 1);
    } else if (action === 'cancel') {
      const stop = await request('operations/' + id + '/cancel', {});
      assert.equal(stop.status, 200); assert.equal(stop.operation.state, 'canceled');
      assert.equal(stop.remoteCancellation, 'not_requested');
      assert.equal((await request('operations/' + id)).operation.scheduling, undefined);
      assert.equal((await request('operations/' + id + '/cancel', {})).operation.revision, stop.operation.revision);
      assert.equal(fixture.calls.submit.length, 0);
    } else {
      const port = Number(new URL(current.origin).port); await current.api.dispose(); await start(port);
      const restarted = await request('operations/' + id);
      assert.equal(restarted.operation.state, 'interrupted'); assert.equal(restarted.operation.scheduling, undefined);
      const replay = await request(endpoint, input, key);
      assert.equal(replay.operation.id, id); assert.equal(replay.operation.state, 'interrupted');
      assert.equal(fixture.calls.submit.length, 0);
    }
    assert.equal(readAllOperations(dataRoot).length, 1);
  } finally {
    await holder?.release();
    for (const api of apis.reverse()) await api.dispose();
    await setup.dispose();
  }
}
for (const scheduled of [false, true]) for (const action of ['replay', 'cancel', 'restart']) await check(scheduled, action);
console.log('Root-busy Operations: independent writer process, serial/scheduled detail and lookup, ephemeral reason, original-Key replay, cancel retry and restart without generation OK');
