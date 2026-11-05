import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { useTempDshHome } from './test-env.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createDshRuntime } from '../lib/dsh-core-adapter.js';
import { createCommandService } from '../lib/command-service.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { beginCoreAttempt, createCoreTask, recordCoreAttemptResult, listCoreTasks } from '../lib/core-tasks.js';
import { FAKE_PNG, FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';
import { videoTaskCandidates, videoModelSupportsMode } from '../lib/video-input.js';
import { normalizeVideoFlowInput } from '../lib/video-flow-input.js';

const { root } = useTempDshHome('iris-video-retry-modes'), dataRoot = path.join(root, 'core');
const store = await import('../lib/config.js');
const { serveApi } = await import('../lib/api.js');
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
const provider = { id: 'a', apiKey: 'fixture-video-key', mediaProtocol: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
const adapter = createConfiguredProviderAdapter(provider);
const old = createCoreTask(dataRoot, { capability: 'video' });
const attempt = beginCoreAttempt(dataRoot, old.id, { providerId: 'a', model: 'a::wan2.6-i2v' });
recordCoreAttemptResult(dataRoot, old.id, { ...attempt, acceptance: 'unknown', resultKind: 'acceptance_unknown',
  error: { safeMessage: 'fixture interrupted', acceptance: 'unknown' } });
const oldFile = path.join(dataRoot, 'task-store/v0/tasks', old.id + '.json'), before = fs.readFileSync(oldFile);
const frame = path.join(root, 'frame.png'), audio = path.join(root, 'audio.wav');
fs.writeFileSync(frame, FAKE_PNG); fs.writeFileSync(audio, FAKE_WAV);
const requests = [], nativeFetch = globalThis.fetch;
let resolverCalls = 0, dsh, server;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes('/uploads?')) {
    requests.push({ kind: 'policy' });
    return Response.json({ data: { upload_dir: 'fixture', upload_host: 'https://upload.invalid',
      oss_access_key_id: 'fixture', signature: 'fixture', policy: 'fixture', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } });
  }
  if (url === 'https://upload.invalid') { requests.push({ kind: 'file' }); return new Response(''); }
  assert(url.startsWith('https://dashscope.aliyuncs.com/api/v1/services/'), 'no external request outside mocked endpoints');
  const body = JSON.parse(init.body); requests.push({ kind: 'submit', body });
  assert(!Object.hasOwn(body.input, 'video_mode'));
  return Response.json({ output: { task_id: 'remote-new-' + requests.length } });
};
const commands = createCommandService(runtime, { resolveTaskCandidates: async ({ modelRef, signal }) => {
  signal.throwIfAborted(); resolverCalls++;
  return [{ adapter, model: modelRef || 'a::wan2.6-t2v' }];
} });
const retry = (providerInput, modelRef) => commands.execute('task.retry', {
  task_id: old.id, provider_input: providerInput, model_ref: modelRef, confirm_billing: true
});
try {
  const count = listCoreTasks(dataRoot).total;
  for (const input of [
    { prompt: 'lost media' }, { video_mode: 'bad', prompt: 'invalid' },
    { video_mode: 'i2v', prompt: 'missing frame' }, { video_mode: 's2v', prompt: 'missing both' },
    { video_mode: 't2v', prompt: 'conflicting', img_data_url: 'data:image/png;base64,' + FAKE_PNG.toString('base64') },
    { video_mode: 's2v', prompt: 'missing audio', first_frame_path: frame }
  ]) await assert.rejects(retry(input), error => error.code === 'IRIS_COMMAND_INPUT_INVALID');
  assert.equal(resolverCalls, 0); assert.equal(requests.length, 0); assert.equal(listCoreTasks(dataRoot).total, count);
  for (const [input, modelRef] of [
    [{ video_mode: 't2v', prompt: 'wrong family' }, 'a::wan2.6-i2v'],
    [{ video_mode: 'i2v', prompt: 'wrong family', first_frame_path: frame }, 'a::wan2.6-t2v']
  ]) await assert.rejects(retry(input, modelRef), /没有与 .* 输入匹配/);
  assert.equal(requests.length, 0); assert.equal(listCoreTasks(dataRoot).total, count, 'mismatched families stop before upload or Task creation');
  const mixed = ['wan2.6-t2v', 'wan2.6-i2v', 'wan2.2-s2v', 'wan2.6-r2v'].map(model => ({ adapter, model: 'a::' + model }));
  assert.deepEqual(videoTaskCandidates(mixed, { videoMode: 'i2v' }).map(value => value.model), ['a::wan2.6-i2v']);
  assert.deepEqual(videoTaskCandidates(mixed, { videoMode: 't2v' }).map(value => value.model), ['a::wan2.6-t2v']);
  assert.throws(() => normalizeVideoFlowInput({ model_ref: 'a::wan2.2-s2v', prompt: 'unsupported stored shape' }), { code: 'IRIS_VIDEO_FLOW_INPUT_INVALID' });
  assert.equal(normalizeVideoFlowInput({ model_ref: 'a::wan2.6-i2v', prompt: 'historical input' }).model_ref, 'a::wan2.6-i2v', 'record normalization must keep historical fields readable; new Flow admission is tested separately');
  assert(videoModelSupportsMode('compatible-video-v1', 't2v')); assert(videoModelSupportsMode('compatible-video-v1', 'i2v'));
  for (const [input, modelRef, expectedImage] of [
    [{ video_mode: 't2v', prompt: 'explicit t2v' }, 'a::wan2.6-t2v', false],
    [{ video_mode: 'i2v', prompt: 'explicit i2v', first_frame_path: frame }, 'a::wan2.6-i2v', true],
    [{ video_mode: 's2v', first_frame_path: frame, audio_path: audio, resolution: '480P' }, 'a::wan2.2-s2v', true]
  ]) {
    const result = await retry(input, modelRef);
    assert.equal(result.task.retriedFrom, old.id); assert.equal(result.task.attempts.length, 1);
    assert.equal(result.task.acceptance, 'accepted');
    const sent = requests.filter(item => item.kind === 'submit').at(-1).body;
    const imageUrl = input.video_mode === 's2v' ? sent.input.image_url : sent.input.img_url;
    assert.equal(Boolean(imageUrl), expectedImage);
    assert.equal(Boolean(sent.input.audio_url), input.video_mode === 's2v');
    if (input.video_mode === 's2v') { assert(imageUrl.startsWith('oss://')); assert(sent.input.audio_url.startsWith('oss://')); }
  }
  assert.equal(requests.filter(item => item.kind === 'submit').length, 3);
  assert.equal(requests.filter(item => item.kind === 'file').length, 2);
  assert.deepEqual(fs.readFileSync(oldFile), before);
  await runtime.dispose();

  const saved = store.upsert({ ...provider, name: 'DSH video fixture', models: [{ id: 'wan2.6-t2v', capabilities: ['video-gen'] }] });
  store.setAssignmentOrder('video-gen', [saved.id + '::wan2.6-t2v']);
  dsh = createDshRuntime({ dataRoot });
  server = http.createServer((req, res) => serveApi(req, res, undefined, dsh));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/iris/api/core/task/' + old.id + '/retry';
  const post = body => nativeFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'explicit API retry', confirmBilling: true, ...body }) });
  const beforeApi = requests.length;
  const tasksBeforeApi = listCoreTasks(dataRoot).total;
  for (const body of [{}, { video_mode: 'i2v' }, { video_mode: 's2v' },
    { video_mode: 't2v', img_data_url: 'data:image/png;base64,' + FAKE_PNG.toString('base64') },
    { video_mode: 's2v', first_frame_path: frame, audio_path: audio }]) {
    const response = await post(body); assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'IRIS_COMMAND_INPUT_INVALID');
  }
  assert.equal(requests.length, beforeApi, 'DSH must reject missing media instead of silently converting to t2v');
  assert.equal(listCoreTasks(dataRoot).total, tasksBeforeApi, 'rejected DSH video retries create no Task');
  const accepted = await post({ video_mode: 't2v' }); assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).retriedFrom, old.id);
  assert.equal(requests.filter(item => item.kind === 'submit').length, 4);
  assert.deepEqual(fs.readFileSync(oldFile), before);
  console.log('PASS video retry: explicit modes, missing/mismatched media rejected before resolver or new Task, real t2v/i2v/s2v payloads, DSH HTTP gate and unchanged original facts');
} finally {
  await runtime.dispose();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await dsh?.dispose();
  globalThis.fetch = nativeFetch;
}
