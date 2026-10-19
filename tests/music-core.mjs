import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { musicCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding } from '../lib/provider-catalog.js';
import { musicArtifactsFromResponse } from '../lib/music-transport.js';
import { generateMusicTask } from '../lib/music-generation.js';
import { normalizeGenerationInput } from '../lib/generation-input.js';
import { inspectCoreTask, listCoreTasks } from '../lib/core-tasks.js';
import { inspectCoreArtifact, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { defineProviderAdapter } from '../lib/provider-adapter.js';
import { FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-music-core-'));
const dataRoot = path.join(base, 'core');
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
const catalog = { providers: [{ id: 'gateway', apiKey: 'fixture-music-key', baseUrl: 'https://music.fixture.invalid/v1',
  mediaProtocol: 'openai-responses-images', models: [
    { id: 'gemini-music', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' },
    { id: 'unassigned-music', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' },
    { id: 'gemini-image', capabilities: ['image-gen'] }
  ] }], assignments: { 'music-gen': ['gateway::gemini-music'] } };
const routes = musicCandidatesFromCatalog(catalog);
const adapter = createConfiguredProviderAdapter(routes[0].provider);
const candidates = [{ adapter, model: routes[0].modelRef, selectionReason: routes[0].selectionReason,
  providerBinding: providerTaskBinding(routes[0].provider) }];
const response = { choices: [{ message: { content: '[audio](data:audio/wav;base64,' + FAKE_WAV.toString('base64') + ')' } }] };
const originalFetch = global.fetch;
let statuses = [], calls = 0, badBody = false;
global.fetch = async (url, init) => {
  assert.equal(String(url), 'https://music.fixture.invalid/v1/chat/completions');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-music-key');
  assert.deepEqual(JSON.parse(init.body), { model: 'gemini-music', stream: false, messages: [{ role: 'user', content: 'fixture music' }] });
  calls++;
  const status = statuses.shift() || 200;
  return new Response(JSON.stringify(status === 200 ? (badBody ? { choices: [{ message: { content: 'only lyrics' } }] } : response)
    : { error: { message: 'fixture upstream error; key=fixture-music-key' } }), { status });
};
const run = (input = {}) => {
  const normalized = normalizeGenerationInput('music', { prompt: 'fixture music', retry_delay_ms: 0, ...input });
  return generateMusicTask({ runner: createProviderTaskRunner(runtime), candidates, providerInput: normalized.providerInput,
    options: normalized.musicOptions, signal: input.signal });
};
try {
  runtime.start();
  assert.equal(routes.length, 1);
  assert.equal(adapter.protocol, 'gemini-web-music');
  assert.equal(catalog.providers[0].mediaProtocol, 'openai-responses-images');
  assert.throws(() => musicCandidatesFromCatalog({ ...catalog, assignments: {} }), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' });
  assert.throws(() => musicCandidatesFromCatalog(catalog, 'gateway::unassigned-music'));
  assert.throws(() => normalizeGenerationInput('music', { prompt: 'fixture', retry_502: 6 }));
  assert.throws(() => normalizeGenerationInput('music', { prompt: 'fixture', retry_502: true }));
  assert.throws(() => normalizeGenerationInput('music', { prompt: 'fixture', duration: 30 }));
  assert.throws(() => musicArtifactsFromResponse({ choices: [{ message: { content: 'song description' } }] }), /音频/);
  assert.throws(() => musicArtifactsFromResponse({ choices: [{ message: { content: 'data:audio/wav;base64,AAA===' } }] }), /base64/);
  const duplicate = structuredClone(response);
  duplicate.choices.push(...response.choices);
  assert.equal(musicArtifactsFromResponse(duplicate).length, 1);

  statuses = [502, 502, 200];
  const generated = await run();
  assert.equal(calls, 3);
  assert.equal(generated.retries, 2);
  assert.equal(generated.task.deliveryState, 'ready');
  assert.equal(generated.task.capability, 'music');
  assert.equal(generated.task.remoteTaskId, undefined);
  assert.equal(generated.taskIds.length, 3);
  const facts = generated.taskIds.map(id => inspectCoreTask(dataRoot, id));
  assert.equal(facts[0].acceptance, 'unknown', '502 不伪装成明确未受理');
  assert.equal(facts[0].lastError.httpStatus, 502);
  assert.equal(facts[1].retriedFrom, facts[0].id);
  assert.equal(facts[2].retriedFrom, facts[1].id);
  assert(facts.every(task => task.attempts.length === 1 && task.modelRef === 'gateway::gemini-music'));
  assert(!JSON.stringify(facts).includes('fixture music'));
  assert(!JSON.stringify(facts).includes('fixture-music-key'));
  const artifact = inspectCoreArtifact(dataRoot, generated.task.artifactIds[0]);
  assert.equal(artifact.kind, 'generated-audio');
  assert.equal(artifact.metadata.capability, 'music');
  assert.equal(artifact.mediaType, 'audio/wav');
  assert.deepEqual(readCoreArtifactBytes(dataRoot, artifact.id).bytes, FAKE_WAV);
  assert.equal(providerForTaskFromCatalog(catalog, generated.task).mediaProtocol, 'gemini-web-music');

  statuses = [502, 502, 502];
  const exhausted = await run({ retry_502: 1 });
  assert.equal(exhausted.retries, 1);
  assert.equal(exhausted.task.lastError.httpStatus, 502);
  statuses = [503];
  const before503 = calls;
  assert.equal((await run()).retries, 0);
  assert.equal(calls - before503, 1, '503不套用502重试策略');
  statuses = [502];
  assert.equal((await run({ retry_502: 0 })).retries, 0);
  statuses = []; badBody = true;
  assert.equal((await run()).task.artifactIds.length, 0);
  badBody = false;

  const fixtureFetch = global.fetch;
  global.fetch = async (_url, init) => new Promise((resolve, reject) => {
    calls++;
    const timer = setTimeout(() => resolve(new Response(JSON.stringify(response))), 200);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
  });
  const beforeTimeout = calls;
  const timed = await run({ timeout_ms: 10 });
  assert.equal(timed.task.lastError.category, 'timeout');
  assert.equal(timed.retries, 0);
  assert.equal(calls - beforeTimeout, 1);
  global.fetch = fixtureFetch;

  statuses = [502];
  const cancelWait = new AbortController();
  const cancelTimer = setTimeout(() => cancelWait.abort(), 20);
  const waitInput = normalizeGenerationInput('music', { prompt: 'fixture music', retry_delay_ms: 1000 });
  const beforeCanceledWait = calls;
  try {
    await assert.rejects(generateMusicTask({ runner: createProviderTaskRunner(runtime), candidates,
      providerInput: waitInput.providerInput, options: waitInput.musicOptions, signal: cancelWait.signal }), { name: 'AbortError' });
    assert.equal(calls - beforeCanceledWait, 1, '等待重试时取消，不继续提交');
  } finally { clearTimeout(cancelTimer); }
  statuses = [];

  let downloads = 0, remoteSubmissions = 0;
  const interrupted = defineProviderAdapter({ ...adapter, operations: { ...adapter.operations,
    async submit() { remoteSubmissions++; return { kind: 'completed', artifacts: [
      { kind: 'remote-url', url: 'https://fixture.invalid/music.wav', mediaType: 'audio/wav' }
    ] }; },
    async download(request) {
      if (++downloads === 1) throw new Error('fixture interrupted delivery');
      fs.writeFileSync(request.targetPath, FAKE_WAV, { flag: 'wx', mode: 0o600 });
      return { bytes: FAKE_WAV.length };
    }
  } });
  const normalized = normalizeGenerationInput('music', { prompt: 'fixture music' });
  const lost = await generateMusicTask({ runner: createProviderTaskRunner(runtime),
    candidates: [{ ...candidates[0], adapter: interrupted }], providerInput: normalized.providerInput, options: normalized.musicOptions });
  assert.equal(lost.task.outcome, 'succeeded');
  assert.equal(lost.task.deliveryState, 'failed');
  assert.equal(lost.retries, 0);
  await createProviderTaskRunner(runtime).redeliver(lost.task.id, interrupted);
  assert.equal(inspectCoreTask(dataRoot, lost.task.id).deliveryState, 'ready');
  assert.equal(remoteSubmissions, 1, '缓存补交付不重新生成');

  const aborted = new AbortController(); aborted.abort();
  const beforeAbort = calls;
  await assert.rejects(generateMusicTask({ runner: createProviderTaskRunner(runtime), candidates,
    providerInput: normalized.providerInput, options: normalized.musicOptions, signal: aborted.signal }), { name: 'AbortError' });
  assert.equal(calls, beforeAbort);
  assert(listCoreTasks(dataRoot, { capability: 'music' }).tasks.length > 0);
  console.log('PASS Music：显式分配、协议隔离、真实请求格式、音频交付、502有限重试关系、失败边界、缓存补交付与取消');
} finally {
  global.fetch = originalFetch;
  await runtime.dispose();
  fs.rmSync(base, { recursive: true, force: true });
}
