import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { readWriterLease } from '../lib/core-writer-lease.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createDshRuntime } from '../lib/dsh-core-adapter.js';
import { beginCoreAttempt, createCoreTask, inspectCoreTask, recordCoreAttemptResult, recoverCoreTask } from '../lib/core-tasks.js';
import { deriveUserState } from '../lib/task-semantics.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';

const { root } = useTempDshHome('iris-core-rejection-recovery');
const instances = [];
function writer(name) {
  const runtime = createCoreRuntime({ dataRoot: path.join(root, name), mode: 'writer' });
  runtime.start(); instances.push(runtime); return runtime;
}
function gap(dataRoot, { attempts = 1, error = true, acceptance = 'not_accepted', capability = 'image' } = {}) {
  const task = createCoreTask(dataRoot, { capability });
  for (let i = 0; i < attempts; i++) {
    const attempt = beginCoreAttempt(dataRoot, task.id, { providerId: 'fixture-' + i, model: 'fixture-' + i + '::image' });
    recordCoreAttemptResult(dataRoot, task.id, { ...attempt, acceptance,
      resultKind: acceptance === 'unknown' ? 'acceptance_unknown' : acceptance,
      ...(acceptance === 'accepted' ? { remoteTaskId: 'original-remote' } : {}),
      ...(error ? { error: { safeMessage: 'fixture rejection ' + i, acceptance, category: 'authentication', httpStatus: 401, stage: 'submit' } } : {}) });
  }
  return inspectCoreTask(dataRoot, task.id);
}
function failed(before, after) {
  assert.equal(after.id, before.id);
  assert.equal(after.phase, 'terminal'); assert.equal(after.acceptance, 'not_accepted');
  assert.equal(after.outcome, 'failed'); assert.equal(deriveUserState(after), 'failed');
  assert.equal(after.deliveryState, 'none'); assert.equal(after.watchState, 'idle');
  assert.deepEqual(after.attempts, before.attempts);
  assert.equal(after.activeAttemptId, before.activeAttemptId);
  assert.equal(after.providerId, before.providerId); assert.equal(after.model, before.model);
  assert(after.finishedAt);
  if (before.lastError) assert.deepEqual(after.lastError, before.lastError);
}
try {
  const runtime = writer('direct');
  const dataRoot = path.join(root, 'direct');
  const runner = createProviderTaskRunner(runtime);
  const fake = createFakeLifecycleProvider({ id: 'unused-recovery-adapter' });
  for (const options of [{}, { attempts: 2 }, { error: false },
    ...['video', 'tts', 'music', 'transcribe'].map(capability => ({ capability }))]) {
    const before = gap(dataRoot, options);
    assert.equal(before.outcome, 'none');
    const after = await runner.recover(before.id, fake.adapter); failed(before, after);
    assert.deepEqual(await runner.recover(before.id, fake.adapter), after, 'repeated recovery must not change settled facts');
  }
  assert.equal(fake.calls.submit.length, 0); assert.equal(fake.calls.poll.length, 0);
  for (const acceptance of ['accepted', 'unknown']) {
    const before = gap(dataRoot, { acceptance });
    assert.deepEqual(recoverCoreTask(dataRoot, before.id), before, 'accepted/unknown facts must remain unchanged');
  }
  await runtime.dispose();

  // DSH startup must select this recovery case even with no available Provider.
  const startupRoot = path.join(root, 'dsh-startup');
  const pending = ['image', 'video', 'tts', 'music', 'transcribe'].map(capability => gap(startupRoot, { capability }));
  const dsh = createDshRuntime({ dataRoot: startupRoot }); instances.push(dsh);
  assert.deepEqual(await dsh.resumeProviderTaskWatchesForDsh(), []);
  for (const task of pending) failed(task, inspectCoreTask(startupRoot, task.id));
  assert.equal(dsh.snapshot().watchers, 0);
  await dsh.dispose();

  if (process.platform === 'win32') {
    console.log('SKIP real rejection SIGKILL fixture requires POSIX; Windows not validated');
  } else {
    const crashRoot = path.join(root, 'real-kill'), eventsFile = path.join(root, 'events.log');
    const child = spawnSync(process.execPath, ['tests/fixtures/core-rejection-crash-child.mjs', crashRoot, eventsFile],
      { encoding: 'utf8', timeout: 20000 });
    assert.match(child.stdout, /CHECKPOINT rejected-before-finalize/, child.stderr);
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const files = fs.readdirSync(path.join(crashRoot, 'task-store/v0/tasks')).filter(name => /^task_[a-f0-9]{24}\.json$/.test(name));
    assert.equal(files.length, 1);
    const before = inspectCoreTask(crashRoot, files[0].slice(0, -5));
    assert.equal(before.acceptance, 'not_accepted'); assert.equal(before.outcome, 'none');
    const lease = readWriterLease(crashRoot);
    recoverCoreWriterLease(crashRoot, { confirmStalePid: lease.owner.pid });
    const recoveredRuntime = writer('real-kill');
    const after = await createProviderTaskRunner(recoveredRuntime).recover(before.id, fake.adapter);
    failed(before, after);
    assert.equal(fs.readFileSync(eventsFile, 'utf8'), 'submit\n', 'strong-kill recovery must never replay submit');
    assert.equal(fake.calls.submit.length, 0); assert.equal(fake.calls.poll.length, 0);
    await recoveredRuntime.dispose();
  }
  console.log('PASS Core rejection recovery: one/two candidates, original errors/attempts, idempotence, accepted/unknown unchanged, DSH startup and real child SIGKILL without resubmission');
} finally {
  for (const runtime of instances) await runtime.dispose();
}
