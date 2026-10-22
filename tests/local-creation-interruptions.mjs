import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { listCoreArtifacts } from '../lib/core-artifacts.js';
import { inspectCreationRoot, creationRequestId, readCreationRequest, listCreationRequests } from '../lib/creation-request-store.js';
import { planCoreDeletion, planCoreCleanup } from '../lib/core-maintenance.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

if (process.platform === 'win32') console.log('SKIP local creation POSIX SIGKILL windows; ordinary Core/API/CLI tests still run');
else {
  const { root } = useTempDshHome('iris-creation-crash');
  const child = fileURLToPath(new URL('./fixtures/local-creation-crash-child.mjs', import.meta.url));
  const stages = ['image-intent-before', 'image-intent', 'image-object', 'image-manifest', 'image-record', 'image-success',
    'flow-intent-before', 'flow-intent', 'flow-run', 'flow-run-advanced', 'flow-success', 'init-before', 'init-after'];
  for (const stage of stages) {
    const dataRoot = path.join(root, stage), fixture = imageFlowFixture(dataRoot);
    let app = createApplicationRuntime({ dataRoot, ...fixture });
    await app.execute('flow.init', {});
    let sourceId;
    if (!stage.startsWith('init-')) {
      await app.execute('creation.init', {});
      if (stage.startsWith('flow-')) sourceId = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact.id;
    }
    await app.dispose();
    const requestKey = crypto.randomUUID(), inputFile = path.join(root, stage + '-input.json');
    fs.writeFileSync(inputFile, JSON.stringify({ key: requestKey, sourceId }), { mode: 0o600 });
    const killed = spawnSync(process.execPath, [child, stage, dataRoot, inputFile], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
    assert.equal(killed.signal, 'SIGKILL', stage + ': ' + killed.stderr);
    assert(killed.stdout.includes('CHECKPOINT ' + stage), stage);
    const lease = inspectCoreWriterLease(dataRoot); assert.equal(lease.status, 'present');
    app = createApplicationRuntime({ dataRoot, ...fixture });
    await assert.rejects(app.execute('creation.init', {}), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
    await app.dispose();
    assert.equal(inspectCoreWriterLease(dataRoot).pid, lease.pid);
    recoverCoreWriterLease(dataRoot, { confirmStalePid: lease.pid });
    app = createApplicationRuntime({ dataRoot, ...fixture });
    try {
      if (stage === 'init-before') {
        await assert.rejects(app.execute('creation.init', {}), { code: 'IRIS_CREATION_STORE_INVALID' });
        assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
      } else if (stage === 'init-after') {
        const original = inspectCreationRoot(dataRoot);
        assert.deepEqual((await app.execute('creation.init', {})).root, original);
      } else {
        const marker = inspectCreationRoot(dataRoot), kind = stage.startsWith('image-') ? 'image-import' : 'flow-create';
        const id = creationRequestId(marker, kind, requestKey), saved = readCreationRequest(dataRoot, id);
        assert.equal(Boolean(saved), !stage.endsWith('intent-before'), stage);
        if (kind === 'flow-create' && saved?.state === 'prepared') {
          assert.equal(planCoreDeletion(dataRoot, { artifact_ids: [sourceId] }).allowed, false, stage);
        }
        if (kind === 'image-import' && saved?.state === 'prepared') {
          assert(!planCoreCleanup(dataRoot, { older_than_ms: 60000 }).candidates.some(item => item.path.includes(saved.intent.artifactId)), stage);
        }
        let advanced;
        if (stage === 'flow-run-advanced') {
          advanced = await app.execute('flow.continue', { run_id: saved.intent.runId });
          advanced = await app.execute('flow.select', { run_id: saved.intent.runId, artifact_id: advanced.run.output.artifactId });
        }
        const beforeReplayEvents = readFlowEvents(dataRoot);
        const input = kind === 'image-import' ? { key: requestKey, bytes: FLOW_SOURCE, mediaType: 'image/png' }
          : { key: requestKey, value: { sourceArtifactId: sourceId, modelRef: FLOW_MODEL, prompt: 'Crash-safe local creation' } };
        const resumed = await app.execute(kind === 'image-import' ? 'creation.image' : 'creation.flow', input);
        assert.equal(resumed.idempotentReplay, Boolean(saved), stage);
        const completed = readCreationRequest(dataRoot, id);
        assert.equal(completed.state, 'succeeded');
        if (saved) assert.deepEqual(completed.intent, saved.intent, stage);
        const repeated = await app.execute(kind === 'image-import' ? 'creation.image' : 'creation.flow', input);
        if (kind === 'image-import') {
          assert.equal(resumed.artifact.id, completed.intent.artifactId); assert.equal(repeated.artifact.id, resumed.artifact.id);
        } else {
          assert.equal(resumed.flow.run.id, completed.intent.runId); assert.equal(repeated.flow.run.id, resumed.flow.run.id);
          assert.equal(resumed.flow.run.edit.taskId, completed.intent.taskId);
          assert.equal(resumed.flow.run.compare.artifactId, completed.intent.comparisonArtifactId);
          if (advanced) assert.deepEqual(resumed.flow.run, advanced.run, 'unfinished creation replay never resets an advanced Run');
        }
        assert.equal(listCoreArtifacts(dataRoot).total, advanced ? 3 : 1, stage);
        assert.equal(listCoreTasks(dataRoot).total, advanced ? 1 : 0, stage);
        assert.deepEqual(readFlowEvents(dataRoot), beforeReplayEvents, 'local creation replay must not call any Provider');
        assert.equal(listCreationRequests(dataRoot).length, 1, stage);
      }
    } finally { await app.dispose(); }
    assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
    console.log('PASS local creation SIGKILL ' + stage + ': retained identity, explicit stale lease recovery, no generation');
  }
  console.log('PASS 13 local creation process interruption windows; no automatic startup replay, advanced Runs retained, partial initialization fails explicitly');
}
