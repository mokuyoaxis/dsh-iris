import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { inspectCoreTask, listCoreTasks } from '../lib/core-tasks.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { normalizeGenerationInput } from '../lib/generation-input.js';
import { videoTaskCandidates } from '../lib/video-input.js';

const repo = fileURLToPath(new URL('../', import.meta.url)), work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-s2v-core-'));
const frame = path.join(work, 'frame.png'), audio = path.join(work, 'voice.wav');
fs.writeFileSync(frame, 'fixture image'); fs.writeFileSync(audio, 'fixture audio');
const normalized = normalizeGenerationInput('video', { first_frame_path: frame, audio_path: audio, resolution: '480P' }, { allowVideoPaths: true });
const runtime = createCoreRuntime({ dataRoot: path.join(work, 'runner'), mode: 'writer' }); runtime.start();
let scenario = 'fallback', uploads = [], submits = [];
const adapters = ['one', 'two'].map(id => createConfiguredProviderAdapter({ id, apiKey: 'fixture',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope' }, { transport: {
    async uploadTempFile(input) {
      const task = listCoreTasks(path.join(work, 'runner')).tasks[0];
      assert(task.attempts.length > 0 && task.attempts.at(-1).providerId === id, '上传前 Attempt 必须落盘');
      uploads.push({ id, name: path.basename(input.filePath) });
      if (scenario === 'fallback' && id === 'one') throw Object.assign(new Error('denied'), { httpStatus: 403 });
      return 'oss://' + id + '/' + path.basename(input.filePath);
    },
    async submitVideo(input) {
      submits.push(input); assert.equal(input.resolution, '480P');
      if (scenario === 'unknown') throw new TypeError('response lost');
      return 'remote-s2v';
    }
  } }));
const candidates = () => videoTaskCandidates(adapters.map(adapter => ({ adapter, model: adapter.id + '::wan2.2-s2v' })), normalized);
try {
  const first = await createProviderTaskRunner(runtime).submit({ capability: 'video', candidates: candidates(), providerInput: normalized.providerInput });
  assert.equal(first.task.acceptance, 'accepted'); assert.equal(first.task.providerId, 'two'); assert.equal(first.task.attempts.length, 2);
  assert.deepEqual(uploads.map(x => x.id + '/' + x.name), ['one/frame.png', 'two/frame.png', 'two/voice.wav']);
  assert.equal(submits.length, 1); assert.equal(submits[0].audioUrl, 'oss://two/voice.wav');
  assert(first.task.attempts[0].error.stage === 'upload');
  const taskBytes = fs.readFileSync(path.join(work, 'runner/task-store/v0/tasks', first.taskId + '.json'), 'utf8');
  assert(!taskBytes.includes(work) && !taskBytes.includes('oss://') && !taskBytes.includes('fixture audio'));
  scenario = 'unknown'; uploads = []; submits = [];
  const unknown = await createProviderTaskRunner(runtime).submit({ capability: 'video', candidates: candidates(), providerInput: normalized.providerInput });
  assert.equal(unknown.task.acceptance, 'unknown'); assert.equal(unknown.task.attempts.length, 1);
  assert.equal(submits.length, 1); assert.equal(uploads.length, 2);
  assert.throws(() => videoTaskCandidates([{ adapter: adapters[0], model: 'one::wan2.6-t2v' }], normalized), /s2v/);
  await runtime.dispose();

  const canceledRuntime = createCoreRuntime({ dataRoot: path.join(work, 'canceled'), mode: 'writer' }); canceledRuntime.start();
  let uploadSignal, callsAfterCancel = 0;
  const cancelAdapter = createConfiguredProviderAdapter({ id: 'cancel', apiKey: 'fixture', mediaProtocol: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, { transport: {
    async uploadTempFile({ signal }) { uploadSignal = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
    async submitVideo() { callsAfterCancel++; throw new Error('不应提交'); }
  } });
  const cancellation = createProviderTaskRunner(canceledRuntime).submit({ capability: 'video',
    candidates: videoTaskCandidates([{ adapter: cancelAdapter, model: 'cancel::wan2.2-s2v' }, { adapter: adapters[1], model: 'two::wan2.2-s2v' }], normalized), providerInput: normalized.providerInput });
  while (!uploadSignal) await new Promise(resolve => setTimeout(resolve, 1));
  const disposal = canceledRuntime.dispose(); const canceled = await cancellation; await disposal;
  assert(uploadSignal.aborted); assert.equal(canceled.task.attempts.length, 1); assert.equal(canceled.task.acceptance, 'not_accepted');
  assert.equal(callsAfterCancel, 0); assert.equal(canceled.task.attempts[0].error.category, 'aborted');

  const config = path.join(work, 'providers.json'), stateFile = path.join(work, 'state.json'), dataRoot = path.join(work, 'cli');
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'cli', enabled: true, apiKey: 'fixture',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [
      { id: 'wan2.6-t2v', capabilities: ['video-gen'] }, { id: 'wan2.2-s2v', capabilities: ['video-gen'] }
    ] }] }), { mode: 0o600 });
  const cli = (args, code = 0) => {
    const run = spawnSync(process.execPath, ['--import', new URL('./fixtures/headless-async-fetch.mjs', import.meta.url).href,
      path.join(repo, 'bin/dsh-iris.js'), ...args], { cwd: work, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, IRIS_ASYNC_FIXTURE_STATE: stateFile, DSH_HOME: path.join(work, 'unused-dsh') } });
    assert.equal(run.status, code, run.stderr); return run.stdout ? JSON.parse(run.stdout) : null;
  };
  const rootArgs = ['--data-root', dataRoot], providerArgs = ['--provider-config', config];
  const submitted = cli(['run', 'video', ...rootArgs, ...providerArgs, '--input', JSON.stringify({ first_frame_path: frame, audio_path: audio })]);
  assert.equal(submitted.task.modelRef, 'cli::wan2.2-s2v'); assert.equal(submitted.task.attempts.length, 1);
  let state = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(state.uploadPolicy, 2); assert.equal(state.uploadFile, 2); assert.equal(state.submit, 1);
  assert(state.lastRequest.input.image_url.startsWith('oss://') && state.lastRequest.input.audio_url.startsWith('oss://'));
  assert.equal(state.lastRequest.parameters.resolution, '480P');
  let observed;
  for (let i = 0; i < 3; i++) observed = cli(['task', 'observe', submitted.taskId, ...rootArgs, ...providerArgs]);
  assert.equal(observed.task.deliveryState, 'ready'); assert.equal(observed.task.artifactIds.length, 1);
  const inspected = cli(['artifact', 'inspect', observed.task.artifactIds[0], ...rootArgs]);
  assert.equal(inspected.artifact.mediaType, 'video/mp4');
  state = JSON.parse(fs.readFileSync(stateFile)); assert.equal(state.submit, 1); assert.equal(state.uploadFile, 2);
  assert(!fs.existsSync(path.join(work, 'unused-dsh')));
  console.log('ALL OK —— Core/CLI S2V：写前 Attempt、每候选上传、明确拒绝回退、受理未知停止、跨进程观察与 mp4 Artifact');
} finally { await runtime.dispose(); fs.rmSync(work, { recursive: true, force: true }); }
