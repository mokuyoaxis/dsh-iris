import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { useTempDshHome } from './test-env.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';

const { root } = useTempDshHome('iris-transcribe-prepare-cli');
const fixture = new URL('./fixtures/media-cli-fetch.mjs', import.meta.url).href;
const configFile = path.join(root, 'providers.json'), audioPath = path.join(root, 'audio.wav');
const model = 'qwen-audio-3.0-asr-flash-filetrans';
fs.writeFileSync(audioPath, FAKE_WAV);
fs.writeFileSync(configFile, JSON.stringify({ providers: ['a', 'b'].map(id => ({ id, apiKey: 'fixture-' + id,
  mediaProtocol: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  models: [{ id: model, capabilities: ['transcribe'] }] })), assignments: { transcribe: ['a::' + model, 'b::' + model] } }), { mode: 0o600 });
function setup(name, extraEnv = {}) {
  const dataRoot = path.join(root, name), eventsFile = path.join(root, name + '.jsonl');
  return { dataRoot, eventsFile,
    args: ['--import', fixture, 'bin/dsh-iris.js', 'run', 'transcribe', '--data-root', dataRoot,
      '--provider-config', configFile, '--input', JSON.stringify({ audio_path: audioPath })],
    options: { encoding: 'utf8', timeout: 20000, env: { ...process.env, IRIS_ASYNC_FIXTURE_STATE: path.join(root, name + '-state.json'),
      IRIS_MEDIA_FIXTURE_ROOT: dataRoot, IRIS_MEDIA_FIXTURE_EVENTS: eventsFile, ...extraEnv } } };
}
const events = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
if (process.platform !== 'win32') {
  const unsafe = setup('unsafe-config');
  fs.chmodSync(configFile, 0o644);
  try {
    const rejected = spawnSync(process.execPath, unsafe.args, unsafe.options);
    assert.equal(rejected.status, 1, rejected.stderr); assert.match(rejected.stderr, /IRIS_PROVIDER_CONFIG_PERMISSIONS/);
    assert.deepEqual(events(unsafe.eventsFile), []); assert.equal(fs.existsSync(unsafe.dataRoot), false);
  } finally { fs.chmodSync(configFile, 0o600); }
}
const busy = setup('busy'), owner = createCoreRuntime({ dataRoot: busy.dataRoot, mode: 'writer' });
owner.start();
try {
  const rejected = spawnSync(process.execPath, busy.args, busy.options);
  assert.equal(rejected.status, 1, rejected.stderr); assert.match(rejected.stderr, /IRIS_CORE_DATA_ROOT_BUSY/);
  assert.deepEqual(events(busy.eventsFile), [], 'busy root must reject before upload policy or bytes leave the process');
  assert.equal(listCoreTasks(busy.dataRoot).total, 0);
} finally { await owner.dispose(); }

const failover = setup('failover', { IRIS_MEDIA_FIXTURE_REJECT_PROVIDER: 'a' });
const result = spawnSync(process.execPath, failover.args, failover.options);
assert.equal(result.status, 0, result.stderr);
const submitted = JSON.parse(result.stdout).task;
assert.equal(submitted.acceptance, 'accepted'); assert.equal(submitted.attempts.length, 2);
assert.equal(submitted.attempts[0].acceptance, 'not_accepted'); assert.equal(submitted.attempts[1].acceptance, 'accepted');
const log = events(failover.eventsFile);
assert.deepEqual(log.map(item => [item.kind, item.providerId]), [['policy', 'a'], ['policy', 'b'], ['file', 'b'], ['submit', 'b']]);
assert(log.every(item => item.taskId === submitted.id));
assert.equal(log[0].attemptId, submitted.attempts[0].id); assert.equal(log[1].attemptId, submitted.attempts[1].id);
const saved = fs.readFileSync(path.join(failover.dataRoot, 'task-store/v0/tasks', submitted.id + '.json'), 'utf8');
assert(!saved.includes('oss://') && !saved.includes(audioPath) && !saved.includes('fixture-a') && !saved.includes('fixture-b'));

const allRejected = setup('all-rejected', { IRIS_MEDIA_FIXTURE_REJECT_PROVIDER: 'a,b' });
const rejected = spawnSync(process.execPath, allRejected.args, allRejected.options);
assert.equal(rejected.status, 0, rejected.stderr);
const failed = JSON.parse(rejected.stdout).task;
assert.equal(failed.outcome, 'failed'); assert.equal(failed.acceptance, 'not_accepted'); assert.equal(failed.attempts.length, 2);
assert(failed.attempts.every(attempt => attempt.acceptance === 'not_accepted'));
assert.deepEqual(events(allRejected.eventsFile).map(item => item.kind), ['policy', 'policy'], 'all failed uploads retain evidence and never submit generation');

if (process.platform === 'win32') console.log('SKIP POSIX SIGINT upload cancellation; Windows not validated');
else for (const phase of ['policy', 'file']) {
  const scenario = setup('cancel-' + phase, { IRIS_MEDIA_FIXTURE_PAUSE: phase });
  const child = spawn(process.execPath, scenario.args, { ...scenario.options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  let finished = false; void closed.then(() => { finished = true; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const deadline = Date.now() + 8000;
    while (!events(scenario.eventsFile).some(item => item.kind === phase) && !finished && Date.now() < deadline) await delay(10);
    assert(events(scenario.eventsFile).some(item => item.kind === phase), stderr);
    child.kill('SIGINT');
    assert.deepEqual(await closed, { code: 130, signal: null }, stderr);
    const task = listCoreTasks(scenario.dataRoot).tasks[0];
    assert.equal(task.acceptance, 'not_accepted'); assert.equal(task.outcome, 'failed'); assert.equal(task.attempts.length, 1);
    assert.equal(task.lastError.category, 'aborted');
    assert(events(scenario.eventsFile).some(item => item.kind === 'aborted'));
    assert(!events(scenario.eventsFile).some(item => item.kind === 'submit'));
    assert.equal(fs.existsSync(path.join(scenario.dataRoot, '.iris-runtime-writer-v0')), false, 'cooperative cancellation drains the writer lease');
  } finally { clearTimeout(timeout); if (!finished) { child.kill('SIGKILL'); await closed; } }
}
console.log('PASS transcribe CLI preparation: root-busy zero upload, durable per-account Attempts, safe failover and SIGINT in both upload stages without generation');
