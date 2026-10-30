import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner } from '../lib/operation-runner.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { AUDIO_WAV, SPEECH_MODEL, audioFlowFixture } from './fixtures/audio-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-audio-recovery'), apps = [], runners = [], rename = fs.renameSync;
const uuid = () => crypto.randomUUID();
async function setup(name, fixture) {
  const dataRoot = path.join(root, name), app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', { audio: true });
  const intent = await app.execute('creation.speech', { key: uuid(), value: { modelRef: SPEECH_MODEL, text: '原任务恢复。' } });
  return { dataRoot, app, intent };
}
try {
  let entered;
  const submitted = new Promise(resolve => { entered = resolve; });
  const fixture = audioFlowFixture({ beforeSubmit(input) {
    entered(); return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(Object.assign(new Error('controlled interruption'), { name: 'AbortError' })), { once: true }));
  } });
  const stopped = await setup('stop', fixture), runner = createOperationRunner({ dataRoot: stopped.dataRoot, application: stopped.app, ...fixture }); runners.push(runner);
  await runner.start();
  const original = { key: uuid(), runId: stopped.intent.flow.run.id, expectedRunRevision: 1 }, accepted = await runner.submit(original);
  await submitted;
  const stop = await runner.stop(accepted.operation.id);
  assert.equal(stop.localStopped, true); assert.equal(stop.remoteCancellation, 'not_requested'); assert.equal(fixture.calls.cancel.length, 0);
  const uncertain = await stopped.app.execute('flow.inspect', { run_id: original.runId });
  assert.equal(uncertain.task.acceptance, 'unknown'); assert.equal(uncertain.status, 'needs_attention');
  assert.equal((await runner.submit(original)).operation.id, accepted.operation.id);
  await runner.submit({ key: uuid(), runId: original.runId, expectedRunRevision: uncertain.run.revision }); await runner.idle();
  assert.equal(fixture.calls.submit.length, 1, 'explicit continue after local stop cannot resubmit unknown acceptance');
  assert.equal((await stopped.app.execute('flow.inspect', { run_id: original.runId })).task.id, uncertain.task.id);
  await runner.dispose();

  const cachedFixture = audioFlowFixture(), cached = await setup('delivery', cachedFixture);
  let intercepted = false;
  fs.renameSync = (from, to) => {
    if (String(to).includes('/artifact-store/v0/records/') && String(to).endsWith('.json')) { intercepted = true; throw Object.assign(new Error('controlled artifact publication failure'), { code: 'EIO' }); }
    return rename(from, to);
  };
  const failed = await cached.app.execute('flow.continue', { run_id: cached.intent.flow.run.id }); fs.renameSync = rename;
  assert.equal(intercepted, true); assert.equal(failed.status, 'delivery_failed'); assert.equal(failed.task.outcome, 'succeeded'); assert.equal(cachedFixture.calls.submit.length, 1);
  await cached.app.dispose();
  // No resolver survives this restart: repair must use the original private result cache.
  const reopened = createApplicationRuntime({ dataRoot: cached.dataRoot }); apps.push(reopened);
  const restored = await reopened.execute('flow.continue', { run_id: failed.run.id });
  assert.equal(restored.status, 'ready'); assert.equal(restored.task.id, failed.task.id); assert.equal(restored.task.attempts.length, 1);
  assert.deepEqual(readCoreArtifactBytes(cached.dataRoot, restored.run.output.artifactId).bytes, AUDIO_WAV);
  assert.equal(cachedFixture.calls.submit.length, 1); assert.equal(cachedFixture.calls.poll.length, 0); assert.equal(cachedFixture.calls.download.length, 0);
  console.log('audio recovery: stopping local waiting preserves unknown acceptance, same Operation/Task replay, restart repairs cached audio without any provider or duplicate submit OK');
} finally { fs.renameSync = rename; for (const runner of runners) await runner.dispose(); for (const app of apps) await app.dispose(); }
