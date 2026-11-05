import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';

const { root } = useTempDshHome('iris-media-flow-cli');
const dataRoot = path.join(root, 'core'), configFile = path.join(root, 'providers.json');
const stateFile = path.join(root, 'state.json'), eventsFile = path.join(root, 'events.jsonl');
const fixture = new URL('./fixtures/media-cli-fetch.mjs', import.meta.url).href;
const config = { providers: [{ id: 'a', apiKey: 'fixture-a', mediaProtocol: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [
    { id: 'qwen-tts-latest', capabilities: ['tts'] },
    { id: 'qwen-audio-3.0-asr-flash-filetrans', capabilities: ['transcribe'] },
    { id: 'wan2.6-t2v', capabilities: ['video-gen'] }
  ] }], assignments: { tts: ['a::qwen-tts-latest'], transcribe: ['a::qwen-audio-3.0-asr-flash-filetrans'],
    'video-gen': ['a::wan2.6-t2v'] } };
fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
let commands = 0;
function cli(args, expected = 0) {
  commands++;
  const result = spawnSync(process.execPath, ['--import', fixture, 'bin/dsh-iris.js', ...args, '--data-root', dataRoot],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, DSH_HOME: path.join(root, 'unused-dsh'),
      IRIS_ASYNC_FIXTURE_STATE: stateFile, IRIS_MEDIA_FIXTURE_ROOT: dataRoot, IRIS_MEDIA_FIXTURE_EVENTS: eventsFile } });
  assert.equal(result.signal, null, result.stderr); assert.equal(result.status, expected, result.stderr);
  return expected ? result : JSON.parse(result.stdout);
}
const state = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const remoteCount = () => (state().submit || 0) + (state().tts || 0);
cli(['flow', 'init']); cli(['execution', 'init', '--video']);
const app = createApplicationRuntime({ dataRoot });
let imported;
try {
  imported = await app.execute('creation.audio', { key: crypto.randomUUID(), bytes: FAKE_WAV, mediaType: 'audio/wav' });
} finally { await app.dispose(); }
for (const input of [
  { recipe: 'speech/v0', model_ref: 'a::qwen-tts-latest', text: 'isolated CLI speech', voice: 'Cherry' },
  { recipe: 'transcribe/v0', model_ref: 'a::qwen-audio-3.0-asr-flash-filetrans', source_artifact_id: imported.artifact.id },
  { recipe: 'video-generate/v0', model_ref: 'a::wan2.6-t2v', prompt: 'isolated CLI video', size: '832x480', duration: 5 }
]) {
  const before = remoteCount();
  const created = cli(['flow', 'create', '--provider-config', configFile, '--input', JSON.stringify(input)]);
  assert.equal(created.status, 'not_started'); assert.equal(created.task, null); assert.equal(remoteCount(), before);
  const runId = created.run.id, step = input.recipe === 'speech/v0' ? 'speak' : input.recipe === 'transcribe/v0' ? 'transcribe' : 'video';
  let current = cli(['flow', 'continue', runId, '--provider-config', configFile]);
  assert.equal(current.task.id, created.run[step].taskId); assert.equal(current.task.attempts.length, 1);
  const taskId = current.task.id;
  for (let count = 0; current.status === 'running' && count < 4; count++) {
    current = cli(['flow', 'continue', runId, '--provider-config', configFile]);
    assert.equal(current.task.id, taskId); assert.equal(current.task.attempts.length, 1);
  }
  assert.equal(current.status, 'ready'); assert.equal(remoteCount(), before + 1);
  assert.equal(cli(['flow', 'continue', runId, '--provider-config', path.join(root, 'missing.json')]).task.id, taskId);
  assert.equal(remoteCount(), before + 1, 'completed CLI flows never resolve a new candidate or replay submission');
}
assert.equal(state().uploadPolicy, 1); assert.equal(state().uploadFile, 1);
assert.equal(state().tts, 1); assert.equal(state().submit, 2);
const actual = JSON.parse(fs.readFileSync(configFile, 'utf8'));
assert.deepEqual({ ...actual, providers: actual.providers.map(({ health, ...provider }) => provider) }, config);
assert.equal(fs.existsSync(path.join(root, 'unused-dsh')), false);
for (const file of fs.readdirSync(path.join(dataRoot, 'task-store/v0/tasks'))) {
  const text = fs.readFileSync(path.join(dataRoot, 'task-store/v0/tasks', file), 'utf8');
  for (const forbidden of ['fixture-a', 'oss://', root, 'isolated CLI speech', 'isolated CLI video']) assert(!text.includes(forbidden));
}
console.log('PASS media Flow CLI: ' + commands + ' independent processes; speech/transcribe/video create without generation, first submit, original Task observation and completed offline continue');
