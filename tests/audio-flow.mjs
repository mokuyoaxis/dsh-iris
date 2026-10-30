import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { planCoreDeletion } from '../lib/core-maintenance.js';
import { AUDIO_WAV, TRANSCRIPT, SPEECH_MODEL, TRANSCRIBE_MODEL, audioFlowFixture } from './fixtures/audio-flow-fixture.mjs';
import { FLOW_SOURCE, FLOW_MODEL, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-audio-flow'), apps = [];
async function create(name, fixture, version = 3) {
  const dataRoot = path.join(root, name), app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', version === 3 ? { audio: true } : version === 2 ? { imageGeneration: true } : {});
  return { dataRoot, app };
}
const id = () => crypto.randomUUID();
try {
  const fixture = audioFlowFixture(), images = imageFlowFixture(path.join(root, 'audio'));
  const { dataRoot, app } = await create('audio', { ...fixture, resolveImageCandidates: images.resolveImageCandidates,
    resolveTaskAdapter: task => task.capability === 'image' ? images.resolveTaskAdapter(task) : fixture.resolveTaskAdapter(task) });
  const image = await app.execute('creation.image', { key: id(), bytes: FLOW_SOURCE, mediaType: 'image/png' });
  const edit = await app.execute('creation.flow', { key: id(), value: { modelRef: FLOW_MODEL, sourceArtifactId: image.artifact.id, prompt: '保持图片编辑。' } });
  const editResult = await app.execute('flow.continue', { run_id: edit.flow.run.id }); assert.equal(editResult.status, 'awaiting_selection'); assert(editResult.run.comparison);
  const generation = await app.execute('creation.generate', { key: id(), value: { modelRef: FLOW_MODEL, prompt: '音频根内继续生图。' } });
  const generating = await app.execute('flow.continue', { run_id: generation.flow.run.id }); assert.equal(generating.status, 'running');
  const generated = await app.execute('flow.continue', { run_id: generation.flow.run.id }); assert.equal(generated.status, 'awaiting_selection'); assert.equal(generated.run.recipe, 'image-generate/v0'); assert.equal(generated.task.id, generating.task.id);
  const input = { modelRef: SPEECH_MODEL, text: '  鸢尾花  ', voice: 'Cherry' }, key = id();
  const speech = await app.execute('creation.speech', { key, value: input });
  assert.equal(speech.flow.run.recipe, 'speech/v0'); assert.equal(speech.flow.status, 'not_started');
  assert.equal(speech.flow.run.input.text, '鸢尾花'); assert.equal(fixture.calls.submit.length, 0);
  assert.equal((await app.execute('creation.speech', { key, value: input })).flow.run.id, speech.flow.run.id);
  await assert.rejects(app.execute('creation.speech', { key, value: { ...input, text: 'changed' } }), { code: 'IRIS_CREATION_KEY_CONFLICT' });
  const completed = await app.execute('flow.continue', { run_id: speech.flow.run.id });
  assert.equal(completed.status, 'ready'); assert.equal(completed.task.flowBinding.stepId, 'speak');
  assert.equal(completed.task.id, speech.flow.run.speak.taskId); assert.equal(fixture.calls.submit.length, 1);
  assert.equal((await app.execute('flow.continue', { run_id: speech.flow.run.id })).task.id, completed.task.id);
  assert.equal(fixture.calls.submit.length, 1);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, completed.run.output.artifactId).bytes, AUDIO_WAV);
  await app.execute('flow.export', { run_id: completed.run.id, output_path: path.join(root, 'speech.wav') });
  assert.deepEqual(fs.readFileSync(path.join(root, 'speech.wav')), AUDIO_WAV);
  await assert.rejects(app.execute('flow.select', { run_id: completed.run.id, artifact_id: completed.run.output.artifactId }), { code: 'IRIS_FLOW_SELECTION_INVALID' });
  const sourceKey = id(), imported = await app.execute('creation.audio', { key: sourceKey, bytes: AUDIO_WAV, mediaType: 'audio/wav' });
  assert.equal(imported.artifact.kind, 'imported-audio');
  assert.equal((await app.execute('creation.audio', { key: sourceKey, bytes: AUDIO_WAV, mediaType: 'audio/wav' })).artifact.id, imported.artifact.id);
  await assert.rejects(app.execute('creation.audio', { key: id(), bytes: AUDIO_WAV, mediaType: 'audio/mpeg' }), { code: 'IRIS_AUDIO_INPUT_INVALID' });
  const transcription = await app.execute('creation.transcribe', { key: id(), value: { modelRef: TRANSCRIBE_MODEL, sourceArtifactId: imported.artifact.id } });
  assert.equal(fixture.preparation.length, 0, 'creating an intent never uploads');
  const accepted = await app.execute('flow.continue', { run_id: transcription.flow.run.id });
  assert.equal(accepted.status, 'running'); assert.equal(fixture.preparation.length, 1);
  assert.deepEqual(fixture.preparation[0].bytes, AUDIO_WAV);
  const transcribed = await app.execute('flow.continue', { run_id: transcription.flow.run.id });
  assert.equal(transcribed.status, 'ready'); assert.equal(fixture.calls.submit.length, 2); assert.equal(fixture.preparation.length, 1);
  assert.equal(transcribed.task.id, accepted.task.id); assert.equal(transcribed.task.flowBinding.stepId, 'transcribe');
  const output = readCoreArtifactBytes(dataRoot, transcribed.run.output.artifactId);
  assert.deepEqual(output.bytes, TRANSCRIPT); assert.equal(output.artifact.kind, 'transcript');
  assert(output.artifact.relations.some(edge => edge.artifactId === imported.artifact.id));
  assert.equal(planCoreDeletion(dataRoot, { artifact_ids: [imported.artifact.id, output.artifact.id], task_ids: [transcribed.task.id] }).allowed, false, 'saved audio Run protects source, output and original Task');
  await app.execute('flow.continue', { run_id: transcription.flow.run.id });
  assert.equal(fixture.calls.submit.length, 2); assert.equal(fixture.calls.poll.length, 1);
  for (const file of fs.readdirSync(dataRoot, { recursive: true }).filter(name => name.endsWith('.json'))) {
    assert(!fs.readFileSync(path.join(dataRoot, file), 'utf8').includes('NEVER_PERSIST_THIS'), 'temporary URL stays out of durable records');
  }
  for (const version of [1, 2]) {
    const old = await create('v' + version, fixture, version);
    await assert.rejects(old.app.execute('creation.speech', { key: id(), value: input }), { code: 'IRIS_FLOW_AUDIO_ROOT_REQUIRED' });
    await assert.rejects(old.app.execute('execution.init', { audio: true }), { code: 'IRIS_CREATION_ROOT_VERSION_CONFLICT' });
  }
  const uncertainFixture = audioFlowFixture({ unknown: true }), uncertain = await create('uncertain', uncertainFixture);
  const uncertainRun = await uncertain.app.execute('creation.speech', { key: id(), value: input });
  const unknown = await uncertain.app.execute('flow.continue', { run_id: uncertainRun.flow.run.id });
  assert.equal(unknown.status, 'needs_attention'); assert.equal(unknown.task.acceptance, 'unknown');
  await uncertain.app.execute('flow.continue', { run_id: uncertainRun.flow.run.id });
  assert.equal(uncertainFixture.calls.submit.length, 1, 'unknown acceptance is never resubmitted');
  const failedFixture = audioFlowFixture({ failPreparation: true }), failed = await create('prepare-failure', failedFixture);
  const audio = await failed.app.execute('creation.audio', { key: id(), bytes: AUDIO_WAV, mediaType: 'audio/wav' });
  const run = await failed.app.execute('creation.transcribe', { key: id(), value: { modelRef: TRANSCRIBE_MODEL, sourceArtifactId: audio.artifact.id } });
  const failure = await failed.app.execute('flow.continue', { run_id: run.flow.run.id });
  assert.equal(failure.task.attempts[0].acceptance, 'not_accepted'); assert.equal(failedFixture.calls.submit.length, 0);
  await failed.app.execute('flow.continue', { run_id: run.flow.run.id });
  assert.equal(failedFixture.preparation.length, 1, 'failed preparation does not silently retry');
  const cliRoot = path.join(root, 'actual-cli'), cli = args => spawnSync(process.execPath, ['bin/dsh-iris.js', ...args], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  const initialized = cli(['flow', 'init', '--data-root', cliRoot]); assert.equal(initialized.status, 0, initialized.stderr);
  const enabled = cli(['execution', 'init', '--data-root', cliRoot, '--audio']); assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cliRoot, 'creation-requests/v3/root.json'))).schemaVersion, 3);
  for (const extra of [['--audio', '--image-generation'], ['--audio', '--audio']]) {
    const invalid = cli(['execution', 'init', '--data-root', path.join(root, 'must-not-initialize'), ...extra]); assert.notEqual(invalid.status, 0); assert.equal(fs.existsSync(path.join(root, 'must-not-initialize')), false);
  }
  console.log('audio flow: durable speech/transcription, idempotency, upload timing, original task recovery, privacy and version gates OK');
} finally { for (const app of apps) await app.dispose(); }
