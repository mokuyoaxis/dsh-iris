import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner, inspectExecutionLease } from '../lib/operation-runner.js';
import { readOperation, operationId, inspectExecutionRoot } from '../lib/operation-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-runner-failures'), apps = [], runners = [], failed = new Set();
const key = () => crypto.randomUUID(), link = fs.linkSync, rename = fs.renameSync, unlink = fs.unlinkSync;
async function setup(name, options) {
  const dataRoot = path.join(root, name), fixture = imageFlowFixture(dataRoot, options), app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const flow = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'failure fixture' });
  const runner = createOperationRunner({ dataRoot, application: app, ...fixture }); runners.push(runner); await runner.start();
  return { dataRoot, app, fixture, flow, runner, input: { key: key(), runId: flow.run.id, expectedRunRevision: 1 } };
}
try {
  const rejected = await setup('accept');
  fs.linkSync = (from, to) => {
    if (String(to).includes(path.sep + 'operations' + path.sep)) throw Object.assign(new Error('injected accept failure'), { code: 'EIO' });
    return link(from, to);
  };
  await assert.rejects(rejected.runner.submit(rejected.input), { code: 'EIO' }); fs.linkSync = link;
  const id = operationId(inspectExecutionRoot(rejected.dataRoot), rejected.input.key);
  assert.equal(readOperation(rejected.dataRoot, id), null); assert.deepEqual(readFlowEvents(rejected.dataRoot), []);
  const retried = await rejected.runner.submit(rejected.input); await rejected.runner.idle();
  assert.equal(retried.operation.id, id); assert.equal(readFlowEvents(rejected.dataRoot).filter(event => event.kind === 'submit').length, 1);
  await rejected.runner.dispose();

  const terminal = await setup('terminal');
  fs.renameSync = (from, to) => {
    if (String(to).includes(path.sep + 'operations' + path.sep) && JSON.parse(fs.readFileSync(from, 'utf8')).state === 'succeeded') {
      throw Object.assign(new Error('injected terminal failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  const accepted = await terminal.runner.submit(terminal.input);
  await assert.rejects(terminal.runner.idle(), { code: 'EIO' }); fs.renameSync = rename; failed.add(terminal.runner);
  assert.equal(terminal.runner.snapshot().failed, true); assert.equal(terminal.runner.snapshot().executionEnabled, false);
  assert.equal(readOperation(terminal.dataRoot, accepted.operation.id).state, 'running');
  const result = await terminal.app.execute('flow.inspect', { run_id: terminal.flow.run.id });
  assert.equal(result.task.deliveryState, 'ready'); assert.equal(result.task.attempts.length, 1);
  await assert.rejects(terminal.runner.submit({ ...terminal.input, key: key() }), { code: 'IRIS_EXECUTION_UNAVAILABLE' });
  await assert.rejects(terminal.runner.dispose(), { code: 'EIO' });
  assert.equal(inspectExecutionLease(terminal.dataRoot).ownerStatus, 'alive', 'failed persistence retains ownership evidence');

  const release = await setup('release');
  fs.unlinkSync = file => {
    if (String(file).endsWith(path.join('runner', '.iris-runtime-writer-v0.owner.json'))) throw Object.assign(new Error('injected release failure'), { code: 'EACCES' });
    return unlink(file);
  };
  await assert.rejects(release.runner.dispose(), { code: 'IRIS_CORE_LEASE_INVALID' }); fs.unlinkSync = unlink; failed.add(release.runner);
  assert.equal(inspectExecutionLease(release.dataRoot).ownerStatus, 'alive');
  assert.equal(inspectExecutionLease(release.dataRoot).phase, 'pending');
  const competing = createOperationRunner({ dataRoot: release.dataRoot, ...release.fixture });
  await assert.rejects(competing.start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });

  let entered; const sent = new Promise(resolve => { entered = resolve; });
  const shutdown = await setup('shutdown', { afterSend: ({ signal }) => new Promise((_resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(Object.assign(new Error('interrupted'), { name: 'AbortError' })), { once: true });
  }) });
  const running = await shutdown.runner.submit(shutdown.input); await sent; await shutdown.runner.dispose();
  assert.equal(readOperation(shutdown.dataRoot, running.operation.id).state, 'interrupted');
  assert.equal((await shutdown.app.execute('flow.inspect', { run_id: shutdown.flow.run.id })).task.acceptance, 'unknown');
  assert.equal(inspectExecutionLease(shutdown.dataRoot).status, 'absent');
  console.log('Operation runner failures: atomic accept rejection, terminal persistence failure, retained failed-release lease and graceful interruption preserve original Task facts');
} finally {
  fs.linkSync = link; fs.renameSync = rename; fs.unlinkSync = unlink;
  for (const runner of runners.reverse()) if (!failed.has(runner)) await runner.dispose();
  for (const app of apps.reverse()) await app.dispose();
}
