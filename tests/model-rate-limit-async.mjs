import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { modelRateLimit } from '../lib/provider-health.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';

const { root } = useTempDshHome('iris-model-rate-limit-async');
const runtime = createCoreRuntime({ dataRoot: path.join(root, 'poll-core'), mode: 'writer' });
runtime.start();
const provider = { id: 'poll-account', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1', mediaProtocol: 'dashscope' };
let submits = 0, polls = 0;
const adapter = createConfiguredProviderAdapter(provider, { modelId: 'wan2.2-t2i-flash', transport: {
  dashscopeImageMode() { return 'legacy-async'; },
  async submitImage() { submits++; return 'remote-fixed'; },
  async pollTask() {
    polls++;
    if (polls === 1) throw Object.assign(new Error('Too many requests'), { status: 429, retryAfterMs: 120000 });
    return { done: true, ok: true, urls: [] };
  }
} });
try {
  const runner = createProviderTaskRunner(runtime);
  const submitted = await runner.submit({ capability: 'image', candidates: [{ adapter, model: 'poll-account::wan2.2-t2i-flash' }], providerInput: { prompt: 'fixture' } });
  const limited = await runner.observe(submitted.task.id, adapter);
  assert.equal(limited.remoteTaskId, 'remote-fixed'); assert.equal(limited.acceptance, 'accepted');
  assert.equal(limited.outcome, 'unknown'); assert(modelRateLimit(provider, 'wan2.2-t2i-flash'));
  const rejected = await invokeProviderOperation(adapter, 'submit', { capability: 'image', model: 'wan2.2-t2i-flash', input: { prompt: 'new' } });
  assert.equal(rejected.kind, 'not_accepted'); assert.equal(submits, 1);
  const completed = await runner.observe(submitted.task.id, adapter);
  assert.equal(completed.outcome, 'succeeded'); assert.equal(completed.attempts.length, 1);
  assert.equal(submits, 1); assert.equal(polls, 2, '限流后仍观察原 Task，不创建新的远端任务');
} finally { await runtime.dispose(); }

const file = path.join(root, 'providers.json'), state = path.join(root, 'state.json');
const dataRoot = path.join(root, 'probe-core');
const models = [{ id: 'wan2.2-t2v-plus', capabilities: ['video-gen'] }, { id: 'paraformer-v2', capabilities: ['transcribe'] }];
fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'async-account', apiKey: 'fixture-private-secret',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope', models,
  health: { version: 1, observations: [], rateLimits: models.map(model => ({ modelId: model.id,
    at: new Date().toISOString(), httpStatus: 429, category: 'quota', reason: 'budget', source: 'task' })) }
}], assignments: {} }), { mode: 0o600 });
fs.writeFileSync(state, JSON.stringify({ submit: 0, poll: 0, download: 0, tasks: {} }));
const cli = (args, input) => {
  const output = spawnSync(process.execPath, ['--import', new URL('./fixtures/headless-async-fetch.mjs', import.meta.url).href,
    'bin/dsh-iris.js', ...args, '--provider-config', file, '--data-root', dataRoot], {
    env: { ...process.env, IRIS_ASYNC_FIXTURE_STATE: state }, input, encoding: 'utf8', timeout: 30000
  });
  assert.equal(output.status, 0, output.stderr);
  return JSON.parse(output.stdout);
};
assert.equal(cli(['models', 'test', 'async-account::wan2.2-t2v-plus', '--capability', 'video-gen']).skipped, true);
assert.equal(JSON.parse(fs.readFileSync(state)).submit, 0, '没有素材时不能提交视频探针');
const video = cli(['models', 'test', 'async-account::wan2.2-t2v-plus', '--capability', 'video-gen', '--input', '{"prompt":"fixture"}']);
assert.equal(video.passed, true); assert(video.taskId);
const audio = cli(['models', 'test', 'async-account::paraformer-v2', '--capability', 'transcribe', '--input', '-'], '{"audio_url":"https://fixture.invalid/input.wav"}');
assert.equal(audio.passed, true); assert(audio.taskId);
const saved = JSON.parse(fs.readFileSync(file));
assert.equal(saved.providers[0].health.rateLimits, undefined, '真实素材实测成功可解除视频与转写的停用');
assert.equal(JSON.parse(fs.readFileSync(state)).submit, 2, '每次显式实测只提交指定模型一次');
console.log('PASS 已受理任务 429 后仍可观察且不重提；CLI 视频/转写真实素材与 stdin 实测恢复');
