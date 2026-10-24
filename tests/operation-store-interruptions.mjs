import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { inspectExecutionRoot, operationId, readOperation } from '../lib/operation-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

if (process.platform === 'win32') console.log('SKIP Operation POSIX SIGKILL windows; store and CLI tests still run');
else {
  const { root } = useTempDshHome('iris-operation-interruptions');
  const child = fileURLToPath(new URL('./fixtures/operation-store-crash-child.mjs', import.meta.url));
  const stages = ['init-before', 'init-after', 'accept-before', 'accept-after', 'start-before', 'start-after',
    'cancel-before', 'cancel-after', 'finish-before', 'finish-after'];
  const tree = root => Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(name => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    return [name, stat.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : stat.isDirectory() ? 'directory' : fs.readlinkSync(file)];
  }));
  for (const stage of stages) {
    const dataRoot = path.join(root, stage), fixture = imageFlowFixture(dataRoot);
    let app = createApplicationRuntime({ dataRoot, ...fixture });
    await app.execute('flow.init', {});
    const input = {};
    if (!stage.startsWith('init-')) {
      await app.execute('execution.init', {});
      const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
      let facts = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'Operation crash fixture' });
      if (stage.startsWith('finish-')) facts = await app.execute('flow.continue', { run_id: facts.run.id });
      input.accept = { key: crypto.randomUUID(), runId: facts.run.id, expectedRunRevision: facts.run.revision, ownerInstanceId: crypto.randomUUID() };
      input.id = operationId(inspectExecutionRoot(dataRoot), input.accept.key);
      if (!stage.startsWith('accept-')) await app.execute('operation.accept', input.accept);
      if (stage.startsWith('finish-')) await app.execute('operation.transition', { id: input.id, expectedRevision: 1, state: 'running' });
    }
    await app.dispose();
    const beforeEvents = readFlowEvents(dataRoot), inputFile = path.join(root, stage + '.json');
    fs.writeFileSync(inputFile, JSON.stringify(input), { mode: 0o600 });
    const result = spawnSync(process.execPath, [child, stage, dataRoot, inputFile], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
    assert.equal(result.signal, 'SIGKILL', stage + ': ' + result.stderr); assert(result.stdout.includes('CHECKPOINT ' + stage));
    const lease = inspectCoreWriterLease(dataRoot); assert.equal(lease.status, 'present');
    app = createApplicationRuntime({ dataRoot });
    await assert.rejects(app.execute('artifact.import', { image_bytes: FLOW_SOURCE }), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
    await app.dispose();
    assert.equal(inspectCoreWriterLease(dataRoot).pid, lease.pid);
    recoverCoreWriterLease(dataRoot, { confirmStalePid: lease.pid });
    app = createApplicationRuntime({ dataRoot });
    try {
      if (stage === 'init-before') {
        const before = tree(dataRoot);
        await assert.rejects(app.execute('execution.init', {}), { code: 'IRIS_CREATION_STORE_INVALID' });
        assert.deepEqual(tree(dataRoot), before, 'partial v1 initialization is retained, never repaired or removed');
      } else if (stage === 'init-after') {
        const marker = inspectExecutionRoot(dataRoot), before = tree(dataRoot);
        assert.deepEqual((await app.execute('execution.init', {})).root, marker);
        assert.equal((await app.execute('operation.list', {})).total, 0); assert.deepEqual(tree(dataRoot), before);
      } else {
        const original = readOperation(dataRoot, input.id);
        if (stage === 'accept-before') assert.equal(original, null);
        else {
          const expected = stage.startsWith('accept-') || stage === 'start-before' || stage === 'cancel-before' ? 'queued'
            : stage === 'cancel-after' ? 'canceled' : stage === 'finish-after' ? 'succeeded' : 'running';
          assert.equal(original.state, expected, stage);
          const before = tree(dataRoot);
          assert.equal((await app.execute('operation.inspect', { id: input.id })).operation.state, expected);
          await app.execute('operation.list', {});
          assert.deepEqual(tree(dataRoot), before, 'startup/read never dispatches or rewrites an interrupted operation');
        }
        const replay = await app.execute('operation.accept', { ...input.accept, ownerInstanceId: crypto.randomUUID() });
        assert.equal(replay.operation.id, input.id); assert.equal(replay.idempotentReplay, Boolean(original));
        if (original) assert.deepEqual(readOperation(dataRoot, input.id), original);
      }
    } finally { await app.dispose(); }
    assert.deepEqual(readFlowEvents(dataRoot), beforeEvents, stage + ' never submits or observes during store recovery');
    assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
    console.log('PASS Operation SIGKILL ' + stage + ': complete old/new record, original identity, explicit stale recovery, no automatic execution');
  }
  console.log('PASS 10 Operation process-interruption windows with lstat-based snapshots');
}
