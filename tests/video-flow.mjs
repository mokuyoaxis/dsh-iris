import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner } from '../lib/operation-runner.js';
import { readOperation } from '../lib/operation-store.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { normalizeVideoFlowInput } from '../lib/video-flow-input.js';
import { VIDEO_MODEL, VIDEO_MP4, VIDEO_WEBM, videoFlowFixture } from './fixtures/video-flow-fixture.mjs';
import { AUDIO_WAV, SPEECH_MODEL, audioFlowFixture } from './fixtures/audio-flow-fixture.mjs';
import { FLOW_SOURCE, FLOW_MODEL, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-video-flow'), apps = [], runners = [], uuid = () => crypto.randomUUID();
async function setup(name, fixture = videoFlowFixture(), version = 4) {
  const dataRoot = path.join(root, name), app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {});
  if (version === 0) await app.execute('creation.init', {});
  else await app.execute('execution.init', version === 4 ? { video: true } : version === 3 ? { audio: true } : version === 2 ? { imageGeneration: true } : {});
  return { dataRoot, app, fixture };
}
const input = { modelRef: VIDEO_MODEL, prompt: '  Iris in the wind  ', size: '320x180', duration: 1.5 };
try {
  for (const value of [{ ...input, duration: '2' }, { ...input, duration: 0 }, { ...input, duration: 61 }, { ...input, duration: NaN },
    { ...input, firstFramePath: '/private/frame.png' }, { ...input, audioPath: '/private/audio.wav' }, { ...input, workflowParameters: {} }]) {
    await assert.rejects(async () => {
      const sample = await setup(uuid()); await sample.app.execute('creation.video', { key: uuid(), value });
    });
  }
  assert.throws(() => normalizeVideoFlowInput({ model_ref: 'video-fixture::wan-s2v', prompt: 'no' }));
  const sample = await setup('normal'), key = uuid();
  const created = await sample.app.execute('creation.video', { key, value: input });
  assert.equal(created.flow.run.schemaVersion, 4); assert.equal(created.flow.run.recipe, 'video-generate/v0');
  assert.equal(created.flow.run.input.prompt, input.prompt.trim()); assert.equal(created.flow.status, 'not_started');
  assert.equal(sample.fixture.calls.submit.length, 0);
  assert.equal((await sample.app.execute('creation.video', { key, value: input })).flow.run.id, created.flow.run.id);
  await assert.rejects(sample.app.execute('creation.video', { key, value: { ...input, duration: 3 } }), { code: 'IRIS_CREATION_KEY_CONFLICT' });
  const accepted = await sample.app.execute('flow.continue', { run_id: created.flow.run.id });
  assert.equal(accepted.status, 'running'); assert.equal(accepted.task.capability, 'video');
  assert.equal(accepted.task.id, created.flow.run.video.taskId); assert.equal(accepted.task.flowBinding.stepId, 'video');
  assert.equal(sample.fixture.calls.submit.length, 1);
  await sample.app.dispose();
  const reopened = createApplicationRuntime({ dataRoot: sample.dataRoot, ...sample.fixture }); apps.push(reopened);
  const complete = await reopened.execute('flow.continue', { run_id: created.flow.run.id });
  assert.equal(complete.status, 'ready'); assert.equal(complete.task.id, accepted.task.id);
  assert.deepEqual(readCoreArtifactBytes(sample.dataRoot, complete.run.output.artifactId).bytes, VIDEO_MP4);
  await reopened.execute('flow.continue', { run_id: created.flow.run.id });
  assert.equal(sample.fixture.calls.submit.length, 1); assert.equal(sample.fixture.calls.poll.length, 1);
  const output = path.join(root, 'original.mp4');
  await reopened.execute('flow.export', { run_id: complete.run.id, output_path: output });
  assert.deepEqual(fs.readFileSync(output), VIDEO_MP4);
  await assert.rejects(reopened.execute('flow.select', { run_id: complete.run.id, artifact_id: complete.run.output.artifactId }), { code: 'IRIS_FLOW_SELECTION_INVALID' });
  const audio = audioFlowFixture(), audioApp = createApplicationRuntime({ dataRoot: sample.dataRoot, ...audio }); apps.push(audioApp);
  const speech = await audioApp.execute('creation.speech', { key: uuid(), value: { modelRef: SPEECH_MODEL, text: '仍可合成语音' } });
  const spoken = await audioApp.execute('flow.continue', { run_id: speech.flow.run.id });
  assert.deepEqual(readCoreArtifactBytes(sample.dataRoot, spoken.run.output.artifactId).bytes, AUDIO_WAV);
  const images = imageFlowFixture(sample.dataRoot), imageApp = createApplicationRuntime({ dataRoot: sample.dataRoot, ...images }); apps.push(imageApp);
  const source = await imageApp.execute('creation.image', { key: uuid(), bytes: FLOW_SOURCE, mediaType: 'image/png' });
  const edit = await imageApp.execute('creation.flow', { key: uuid(), value: { modelRef: FLOW_MODEL, sourceArtifactId: source.artifact.id, prompt: 'Keep the image flow' } });
  assert.equal((await imageApp.execute('flow.continue', { run_id: edit.flow.run.id })).status, 'awaiting_selection');
  const generation = await imageApp.execute('creation.generate', { key: uuid(), value: { modelRef: FLOW_MODEL, prompt: 'Generate in v4' } });
  assert.equal((await imageApp.execute('flow.continue', { run_id: generation.flow.run.id })).status, 'running');
  assert.equal((await imageApp.execute('flow.continue', { run_id: generation.flow.run.id })).status, 'awaiting_selection');
  for (const version of [0, 1, 2, 3]) {
    const old = await setup('v' + version, videoFlowFixture(), version);
    const before = fs.readdirSync(old.dataRoot, { recursive: true }).sort();
    await assert.rejects(old.app.execute('creation.video', { key: uuid(), value: input }), { code: 'IRIS_FLOW_VIDEO_ROOT_REQUIRED' });
    await assert.rejects(old.app.execute('execution.init', { video: true }), { code: 'IRIS_CREATION_ROOT_VERSION_CONFLICT' });
    assert.deepEqual(fs.readdirSync(old.dataRoot, { recursive: true }).sort(), before);
  }
  const unknown = await setup('unknown', videoFlowFixture({ unknown: true }));
  const uncertain = await unknown.app.execute('creation.video', { key: uuid(), value: input });
  const lost = await unknown.app.execute('flow.continue', { run_id: uncertain.flow.run.id });
  assert.equal(lost.task.acceptance, 'unknown');
  await unknown.app.execute('flow.continue', { run_id: uncertain.flow.run.id }); assert.equal(unknown.fixture.calls.submit.length, 1);
  const unsupported = await setup('unsupported', videoFlowFixture({ mediaType: 'image/png', bytes: Buffer.from('wrong output type') }));
  const wrong = await unsupported.app.execute('creation.video', { key: uuid(), value: input });
  await unsupported.app.execute('flow.continue', { run_id: wrong.flow.run.id });
  const invalidDelivery = await unsupported.app.execute('flow.continue', { run_id: wrong.flow.run.id });
  assert.equal(invalidDelivery.status, 'delivery_failed');
  const preserved = await unsupported.app.execute('flow.inspect', { run_id: wrong.flow.run.id });
  assert.equal(preserved.task.remoteTaskId, 'original-video-task'); assert.equal(preserved.run.output, undefined);
  assert.equal(unsupported.fixture.calls.submit.length, 1, 'invalid delivery retains the original provider task');
  const webm = await setup('webm', videoFlowFixture({ mediaType: 'video/webm', bytes: VIDEO_WEBM }));
  const webmIntent = await webm.app.execute('creation.video', { key: uuid(), value: input });
  await webm.app.execute('flow.continue', { run_id: webmIntent.flow.run.id });
  const webmOutput = await webm.app.execute('flow.continue', { run_id: webmIntent.flow.run.id });
  assert.equal(webmOutput.status, 'ready');
  const webmBytes = readCoreArtifactBytes(webm.dataRoot, webmOutput.run.output.artifactId);
  assert.equal(webmBytes.artifact.mediaType, 'video/webm'); assert.deepEqual(webmBytes.bytes, VIDEO_WEBM);
  let entered; const sent = new Promise(resolve => { entered = resolve; });
  const stopping = await setup('stop', videoFlowFixture({ beforeSubmit: (_input, { signal }) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(Object.assign(new Error('local stop'), { name: 'AbortError' })), { once: true });
  }) }));
  const draft = await stopping.app.execute('creation.video', { key: uuid(), value: input });
  const runner = createOperationRunner({ dataRoot: stopping.dataRoot, application: stopping.app, ...stopping.fixture }); runners.push(runner);
  await runner.start();
  const command = { key: uuid(), runId: draft.flow.run.id, expectedRunRevision: draft.flow.run.revision };
  const queued = await runner.submit(command); await sent;
  assert.equal((await runner.submit(command)).operation.id, queued.operation.id);
  const stopped = await runner.stop(queued.operation.id);
  assert.equal(stopped.operation.state, 'canceled'); assert.equal(stopped.remoteCancellation, 'not_requested');
  const stoppedRun = await stopping.app.execute('flow.inspect', { run_id: draft.flow.run.id });
  assert.equal(stoppedRun.task.acceptance, 'unknown'); assert.equal(stopping.fixture.calls.cancel.length, 0);
  await runner.submit({ ...command, key: uuid(), expectedRunRevision: stoppedRun.run.revision }); await runner.idle();
  assert.equal(stopping.fixture.calls.submit.length, 1);
  assert.equal(readOperation(stopping.dataRoot, queued.operation.id).state, 'canceled');
  const cliRoot = path.join(root, 'cli'), cli = args => spawnSync(process.execPath, ['bin/dsh-iris.js', ...args], { encoding: 'utf8', timeout: 30000 });
  let result = cli(['flow', 'init', '--data-root', cliRoot]); assert.equal(result.status, 0, result.stderr);
  result = cli(['execution', 'init', '--data-root', cliRoot, '--video']); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cliRoot, 'creation-requests/v4/root.json'))).schemaVersion, 4);
  console.log('video flow: intent idempotency, asynchronous original Task/restart, byte export, parameters, old-root gates, unknown acceptance and local stop OK');
} finally { for (const runner of runners.reverse()) await runner.dispose(); for (const app of apps.reverse()) await app.dispose(); }
