import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner, inspectExecutionLease, recoverExecutionLease } from '../lib/operation-runner.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { operationId, inspectExecutionRoot, readOperation } from '../lib/operation-store.js';
import { readFlowRun } from '../lib/flow-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-runner-interruptions');
if (process.platform === 'win32') console.log('Runner SIGKILL windows require POSIX; not validated on Windows');
else {
  const checkpoints = ['runner-intent', 'accepted', 'started', 'sent', 'remote-accepted', 'delivered', 'finished', 'runner-release'];
  for (const checkpoint of checkpoints) {
    const dataRoot = path.join(root, checkpoint), requestKey = crypto.randomUUID(), ready = path.join(root, checkpoint + '.ready');
    const fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
    await app.execute('flow.init', {}); await app.execute('execution.init', {});
    const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
    const flow = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'crash fixture' });
    const child = spawn(process.execPath, ['tests/fixtures/operation-runner-crash-child.mjs', dataRoot, checkpoint, flow.run.id, requestKey, ready], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    let closed = false; const exit = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
    try {
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(ready) && !closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert(fs.existsSync(ready), checkpoint + ': checkpoint missing: ' + output);
      assert.equal(inspectExecutionLease(dataRoot).ownerStatus, 'alive');
      assert.throws(() => recoverExecutionLease(dataRoot, { confirmStalePid: child.pid }), { code: 'IRIS_CORE_LEASE_OWNER_ALIVE' });
      child.kill('SIGKILL'); assert.equal((await exit).signal, 'SIGKILL');
      const lease = inspectExecutionLease(dataRoot); assert.equal(lease.ownerStatus, 'missing');
      assert.throws(() => recoverExecutionLease(dataRoot, { confirmStalePid: child.pid + 1 }), { code: 'IRIS_CORE_LEASE_CONFIRMATION_MISMATCH' });
      recoverExecutionLease(dataRoot, { confirmStalePid: child.pid });
      const writer = inspectCoreWriterLease(dataRoot);
      if (writer.status === 'present') { assert.equal(writer.ownerStatus, 'missing'); recoverCoreWriterLease(dataRoot, { confirmStalePid: child.pid }); }
      const before = readFlowEvents(dataRoot), runner = createOperationRunner({ dataRoot, ...fixture });
      await runner.start();
      try {
        assert.deepEqual(readFlowEvents(dataRoot), before, checkpoint + ': startup must never call Provider');
        const id = operationId(inspectExecutionRoot(dataRoot), requestKey), record = readOperation(dataRoot, id);
        if (['runner-intent', 'runner-release'].includes(checkpoint)) assert.equal(record, null);
        else {
          assert.equal(record.state, checkpoint === 'finished' ? 'succeeded' : 'interrupted');
          const replay = await runner.submit({ key: requestKey, runId: flow.run.id, expectedRunRevision: 1 });
          assert(replay.idempotentReplay); assert.equal(replay.operation.id, id);
          assert.deepEqual(readFlowEvents(dataRoot), before, 'same key never starts an interrupted operation');
          const current = readFlowRun(dataRoot, flow.run.id);
          await runner.submit({ key: crypto.randomUUID(), runId: current.id, expectedRunRevision: current.revision }); await runner.idle();
          const after = readFlowEvents(dataRoot);
          assert.equal(after.filter(event => event.kind === 'submit').length, before.filter(event => event.kind === 'submit').length
            + (['accepted', 'started'].includes(checkpoint) ? 1 : 0), checkpoint + ': explicit resume uses original Task');
          if (checkpoint === 'remote-accepted') assert.equal(after.filter(event => event.kind === 'poll').length, 1);
          assert.equal(fixture.calls.submit.length, ['accepted', 'started'].includes(checkpoint) ? 1 : 0);
        }
      } finally { await runner.dispose(); }
    } finally { if (!closed) { child.kill('SIGKILL'); await exit; } await app.dispose(); }
  }
  console.log('Operation runner: 8 real SIGKILL windows, explicit runner/writer PID recovery, no automatic replay, original Task resume and retained lease audits OK');
}
