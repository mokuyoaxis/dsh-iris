import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCommandService } from '../lib/command-service.js';
import { inspectCoreTask } from '../lib/core-tasks.js';
import { audioFlowFixture, AUDIO_WAV, TRANSCRIBE_MODEL } from './fixtures/audio-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-flow-transcribe-retry'), dataRoot = path.join(root, 'core');
const fixture = audioFlowFixture({ failPreparation: true });
const app = createApplicationRuntime({ dataRoot, ...fixture });
let runtime;
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { audio: true });
  const imported = await app.execute('creation.audio', { key: crypto.randomUUID(), bytes: AUDIO_WAV, mediaType: 'audio/wav' });
  const created = await app.execute('creation.transcribe', { key: crypto.randomUUID(),
    value: { modelRef: TRANSCRIBE_MODEL, sourceArtifactId: imported.artifact.id } });
  const failed = await app.execute('flow.continue', { run_id: created.flow.run.id });
  assert.equal(failed.task.capability, 'transcribe'); assert.equal(failed.task.sourceArtifactId, imported.artifact.id);
  assert.equal(failed.task.acceptance, 'not_accepted'); assert.equal(fixture.calls.submit.length, 0);
  const taskFile = path.join(dataRoot, 'task-store/v0/tasks', failed.task.id + '.json'), oldBytes = fs.readFileSync(taskFile);
  await app.dispose();
  runtime = createCoreRuntime({ dataRoot }); runtime.start();
  const commands = createCommandService(runtime, {
    resolveTaskCandidates: input => fixture.resolveAudioCandidates({ ...input, modelRef: input.modelRef || TRANSCRIBE_MODEL }) });
  await assert.rejects(commands.execute('task.retry', { task_id: failed.task.id, provider_input: { audio_url: 'https://audio.fixture.invalid/new.wav' } }),
    { code: 'IRIS_COMMAND_BILLING_CONFIRM_REQUIRED' });
  const retried = await commands.execute('task.retry', { task_id: failed.task.id, confirm_billing: true,
    provider_input: { audio_url: 'https://audio.fixture.invalid/new.wav' } });
  assert.notEqual(retried.task.id, failed.task.id); assert.equal(retried.task.retriedFrom, failed.task.id);
  assert.equal(retried.task.acceptance, 'accepted'); assert.equal(retried.task.attempts.length, 1);
  assert.equal(fixture.calls.submit.length, 1); assert.equal(fixture.preparation.length, 1, 'explicit new audio URL does not reupload the original source');
  assert.deepEqual(fs.readFileSync(taskFile), oldBytes);
  assert.equal(inspectCoreTask(dataRoot, retried.task.id).retriedFrom, failed.task.id);
  console.log('PASS real transcribe Flow failed upload → explicit billed retry: new Task, original source/Task preserved, one submit and no reupload');
} finally { await runtime?.dispose(); await app.dispose(); }
