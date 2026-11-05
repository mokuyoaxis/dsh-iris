import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { prepareFlowCreation, commitFlowCreation, updateFlowRun } from '../lib/flow-store.js';
import { claimFlowTask, beginCoreAttempt, recordCoreAttemptResult, listCoreTasks } from '../lib/core-tasks.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { videoFlowFixture, VIDEO_BINDING, VIDEO_MP4 } from './fixtures/video-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-video-family-recovery'), dataRoot = path.join(root, 'core');
const fixture = videoFlowFixture(), legacyModel = 'video-fixture::wan2.6-i2v';
const app = createApplicationRuntime({ dataRoot, ...fixture,
  resolveTaskAdapter(task, options) { return task.modelRef === legacyModel ? fixture.adapter : fixture.resolveTaskAdapter(task, options); } });
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { video: true });
  for (const family of ['i2v', 'r2v', 's2v']) {
    await assert.rejects(app.execute('creation.video', { key: crypto.randomUUID(),
      value: { modelRef: 'video-fixture::wan2.6-' + family, prompt: 'new wrong family' } }), { code: 'IRIS_VIDEO_FLOW_INPUT_INVALID' });
  }
  assert.equal(fixture.calls.submit.length, 0); assert.equal(listCoreTasks(dataRoot).total, 0);
  const legacyRun = () => commitFlowCreation(dataRoot, prepareFlowCreation({ recipe: 'video-generate/v0',
    input: { model_ref: legacyModel, prompt: 'historical text-only input' }, providerBinding: VIDEO_BINDING }));
  // These records use the exact previously accepted persisted shape, without a schema migration.
  const waiting = legacyRun();
  assert.equal((await app.execute('flow.inspect', { run_id: waiting.id })).run.inputDigest, waiting.inputDigest);
  await assert.rejects(app.execute('flow.continue', { run_id: waiting.id }), { code: 'IRIS_VIDEO_FLOW_INPUT_INVALID' });
  assert.equal(listCoreTasks(dataRoot).total, 0, 'an old unsubmitted intent may be read, but cannot start the wrong family');
  let accepted = legacyRun();
  const task = claimFlowTask(dataRoot, accepted.id);
  accepted = updateFlowRun(dataRoot, accepted, { video: { ...accepted.video, claimed: true } });
  const attempt = beginCoreAttempt(dataRoot, task.id, { providerId: 'video-fixture', model: legacyModel, providerBinding: VIDEO_BINDING });
  recordCoreAttemptResult(dataRoot, task.id, { ...attempt, acceptance: 'accepted', resultKind: 'accepted', remoteTaskId: 'original-video-task' });
  const resumed = await app.execute('flow.continue', { run_id: accepted.id });
  assert.equal(resumed.status, 'ready'); assert.equal(resumed.task.id, task.id); assert.equal(resumed.task.attempts.length, 1);
  assert.equal(resumed.run.inputDigest, accepted.inputDigest); assert.equal(resumed.run.input.model_ref, legacyModel);
  assert.equal(fixture.calls.submit.length, 0); assert.equal(fixture.calls.poll.length, 1);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, resumed.run.output.artifactId).bytes, VIDEO_MP4);
  assert.equal(listCoreTasks(dataRoot).total, 1);
  console.log('PASS video families: new/mismatched pending flows rejected before dispatch, historical accepted Flow remains readable and recovers original Task bytes with zero resubmission');
} finally { await app.dispose(); }
