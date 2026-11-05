import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner, inspectExecutionLease, recoverExecutionLease } from '../lib/operation-runner.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { readAllOperations, readOperation } from '../lib/operation-store.js';
import { readFlowRun } from '../lib/flow-store.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-scheduling-recovery');
if (process.platform === 'win32') console.log('Concurrent SIGKILL recovery requires POSIX; Windows not validated');
else {
  const dataRoot = path.join(root, 'core'), ready = path.join(root, 'ready'), events = path.join(root, 'sent.jsonl');
  const fake = createFakeLifecycleProvider({ id: 'p' });
  const ports = { resolveImageCandidates: ({ modelRef }) => [{ adapter: fake.adapter, model: modelRef, providerBinding: 'sha256:' + 'a'.repeat(64) }], resolveTaskAdapter: () => fake.adapter };
  const app = createApplicationRuntime({ dataRoot, ...ports, scheduling: { schemaVersion: 1, requestsPerSecond: 100, remoteLimit: 4 } });
  await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true });
  const flows = [];
  for (const model of ['one', 'two']) {
    const created = await app.execute('flow.create', { model_ref: `p::${model}`, prompt: 'concurrent crash fixture' });
    flows.push({ key: crypto.randomUUID(), runId: created.run.id, expectedRunRevision: created.run.revision });
  }
  await app.dispose();
  const child = spawn(process.execPath, ['tests/fixtures/scheduling-crash-child.mjs', dataRoot, ready, events, JSON.stringify(flows)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false, output = '';
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  let recoveryApp, runner;
  try {
    const deadline = Date.now() + 15000;
    while (!closed && !fs.existsSync(ready) && Date.now() < deadline) await delay(10);
    assert(fs.existsSync(ready), output || 'concurrent crash checkpoint missing');
    const submitted = fs.readFileSync(events, 'utf8'); assert.equal(submitted.trim().split('\n').length, 2);
    assert.equal(inspectCoreWriterLease(dataRoot).pid, child.pid);
    assert.equal(readAllOperations(dataRoot).filter(operation => operation.state === 'running').length, 2);
    child.kill('SIGKILL'); assert.equal((await exit).signal, 'SIGKILL');
    assert.equal(inspectCoreWriterLease(dataRoot).ownerStatus, 'missing');
    recoverExecutionLease(dataRoot, { confirmStalePid: child.pid }); recoverCoreWriterLease(dataRoot, { confirmStalePid: child.pid });
    recoveryApp = createApplicationRuntime({ dataRoot, ...ports, scheduling: { schemaVersion: 1, requestsPerSecond: 100, remoteLimit: 4 } });
    runner = createOperationRunner({ dataRoot, application: recoveryApp, ...ports }); await runner.start();
    assert(readAllOperations(dataRoot).every(record => record.state === 'interrupted'));
    assert.equal(fake.calls.submit.length, 0);
    for (const flow of flows) {
      assert.equal((await runner.submit(flow)).idempotentReplay, true);
      const current = readFlowRun(dataRoot, flow.runId);
      const accepted = await runner.submit({ ...flow, key: crypto.randomUUID(), expectedRunRevision: current.revision });
      await runner.idle(); assert.equal(readOperation(dataRoot, accepted.operation.id).state, 'succeeded');
    }
    const tasks = listCoreTasks(dataRoot).tasks;
    assert.equal(tasks.length, 2); assert(tasks.every(task => task.attempts.length === 1 && task.acceptance === 'unknown'));
    assert.equal(recoveryApp.scheduler.snapshot(dataRoot).remoteOutstanding, 2);
    assert.equal(fake.calls.submit.length, 0); assert.equal(fs.readFileSync(events, 'utf8'), submitted);
    await runner.dispose(); await recoveryApp.dispose();
    assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent'); assert.equal(inspectExecutionLease(dataRoot).status, 'absent');
    console.log('Concurrent recovery: two running Operations, real child SIGKILL, confirmed leases, interrupted startup, original attempts, unknown remote quota and zero resubmission OK');
  } finally { if (!closed) { child.kill('SIGKILL'); await exit; } await runner?.dispose(); await recoveryApp?.dispose(); }
}
