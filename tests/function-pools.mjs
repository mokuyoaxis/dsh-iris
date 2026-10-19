import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { CAPABILITIES } from '../lib/capability.js';
import { functionPolicy, savedAssignmentRefs, HOST_VISION_REF, CAP_FIELD } from '../lib/models.js';
import * as catalog from '../lib/provider-catalog.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

useTempDshHome('iris-function-pools');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { inspectProviderTaskForDsh } = await import('../lib/dsh-core-adapter.js');
const caps = Object.values(CAPABILITIES);
const provider = config.upsert({ name: 'all fixture', auth: 'none', enabled: true,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
  models: ['a', 'b'].map(id => ({ id, capabilities: caps, musicProtocol: 'gemini-web-music' })) });
const refs = ['a', 'b'].map(id => provider.id + '::' + id);
const selectors = { 'image-gen': catalog.imageCandidatesFromCatalog, 'video-gen': catalog.videoCandidatesFromCatalog,
  tts: catalog.ttsCandidatesFromCatalog, 'music-gen': catalog.musicCandidatesFromCatalog,
  transcribe: catalog.transcribeCandidatesFromCatalog, vision: catalog.visionCandidatesFromCatalog };
const snapshot = () => ({ providers: config.allProviders(), assignments: config.assignments() });
const file = path.join(config.irisHome(), 'providers.json');
const saved = () => fs.readFileSync(file);
for (const capability of caps) {
  const before = saved();
  assert.deepEqual(config.pickAllFor(capability), []);
  assert.deepEqual(saved(), before, 'missing legacy policy must not be migrated while reading');
  config.setAssignmentOrder(capability, [refs[1]]);
  assert.deepEqual(selectors[capability](snapshot()).map(route => route.modelRef), [refs[1]]);
  config.setFunctionPolicy(capability, 'auto');
  assert.deepEqual(selectors[capability](snapshot()).map(route => route.modelRef), refs);
  assert.deepEqual(config.pickAllFor(capability).map(p => p.id + '::' + p[CAP_FIELD[capability]]), refs);
  assert.deepEqual(selectors[capability](snapshot(), refs[1]).map(route => route.modelRef), [refs[1]]);
  assert.equal(selectors[capability](snapshot())[0].selectionReason, 'pool');
  config.setFunctionPolicy(capability, 'disabled');
  assert.throws(() => selectors[capability](snapshot(), refs[0]), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' });
  config.setFunctionPolicy(capability, 'manual');
  assert.deepEqual(config.assignmentOrder(capability), [refs[1]], 'turning a function off preserves its manual list');
  config.clearAssignment(capability);
  const cleared = saved();
  assert.deepEqual(config.pickAllFor(capability), []);
  assert.deepEqual(saved(), cleared);
}
assert.throws(() => functionPolicy({ mode: 'unknown' }, 'image-gen'), { code: 'IRIS_FUNCTION_POLICY_INVALID' });
assert.throws(() => functionPolicy({ mode: 'auto', hostVision: true }, 'tts'), { code: 'IRIS_FUNCTION_POLICY_INVALID' });
assert.deepEqual(savedAssignmentRefs([], 'image-gen', [{ providerId: 'old', modelId: 'missing' }, 'missing-name']),
  ['old::missing', 'missing-name'], 'policy switches retain unavailable legacy references');
config.assignments()['image-gen'] = { providerId: provider.id, modelId: 'b' };
config.setFunctionPolicy('image-gen', 'disabled');
config.setFunctionPolicy('image-gen', 'manual');
assert.deepEqual(config.assignmentOrder('image-gen'), [refs[1]], 'legacy object list survives explicit policy switches');
config.assignments()['image-gen'] = [{ providerId: provider.id, modelId: 'b' }];
config.confirmModelUsage(provider.id, 'b', caps, { enableAutomatic: true });
assert.deepEqual(config.assignments()['image-gen'].models, [refs[1]]);
config.setModelVerified(provider.id, 'a', 'music-gen', { ok: true });
config.setModelVerified(provider.id, 'a', 'vision', { ok: true });
delete config.allProviders()[0].models[0].musicProtocol;
config.confirmModelUsage(provider.id, 'a', caps, { musicProtocol: 'gemini-web-music' });
assert.equal(config.allProviders()[0].models[0].verified['music-gen'], undefined, 'new protocol invalidates old success');
assert.equal(config.allProviders()[0].models[0].verified.vision.ok, true, 'unrelated health is preserved');

config.setFunctionPolicy('image-gen', 'auto');
config.mergeDiscoveredModels(provider.id, [{ id: 'pending', capabilities: ['image-gen'] }]);
assert.deepEqual(catalog.imageCandidatesFromCatalog(snapshot()).map(route => route.modelRef), refs);
config.confirmModelUsage(provider.id, 'pending', ['image-gen']);
assert.equal(catalog.imageCandidatesFromCatalog(snapshot()).length, 3, 'one confirmation joins an already automatic function');
config.mergeDiscoveredModels(provider.id, [{ id: 'pending', capabilities: ['vision'] }]);
assert.equal(catalog.imageCandidatesFromCatalog(snapshot()).length, 3, 'rediscovery must not undo a user confirmation');
config.upsert({ name: 'wrong video protocol', auth: 'none', baseUrl: 'http://127.0.0.1:12345/v1',
  mediaProtocol: 'openai-images', models: [{ id: 'video-declared', capabilities: ['video-gen'] }] });
config.setFunctionPolicy('video-gen', 'auto');
assert.deepEqual(catalog.videoCandidatesFromCatalog(snapshot()).map(route => route.modelRef), refs,
  'automatic selection rejects known protocol gaps');
config.recordRateLimit({ providerId: provider.id, modelId: 'a', capability: 'image', retryAfterMs: 60000 });
assert.equal(catalog.imageCandidatesFromCatalog(snapshot())[0].model, 'b');
for (const p of config.allProviders()) config.upsert({ id: p.id, enabled: false });
config.setFunctionPolicy('vision', 'auto');
assert.deepEqual(config.pickAllFor('vision'), [], 'host vision is not implicitly appended');
config.setFunctionPolicy('vision', 'auto', { hostVision: true });
assert.equal(config.pickAllFor('vision')[0].id, HOST_VISION_REF);
assert.throws(() => catalog.visionCandidatesFromCatalog(snapshot()), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' }, 'headless cannot resolve host vision');

const images = config.upsert({ name: 'image fixture', auth: 'none', enabled: true, baseUrl: 'http://image.fixture.invalid/v1',
  mediaProtocol: 'openai-images', models: ['a', 'b'].map(id => ({ id, capabilities: ['image-gen'] })) });
config.setFunctionPolicy('image-gen', 'auto');
const originalFetch = globalThis.fetch;
let unknown = false;
const calls = [];
globalThis.fetch = async (_url, options) => {
  const model = JSON.parse(options.body).model;
  calls.push(model);
  if (model === 'a') {
    if (unknown) throw new Error('socket closed after write');
    return Response.json({ error: { message: 'fixture credential rejected' } }, { status: 401 });
  }
  return Response.json({ data: [{ b64_json: FAKE_PNG.toString('base64') }] });
};
try {
  const result = await runAction({}, 'image', { prompt: 'automatic pool fixture' });
  const task = await inspectProviderTaskForDsh(result.taskId);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(task.deliveryState, 'ready');
  assert.equal(task.attempts.length, 2);
  assert(task.attempts.every(attempt => attempt.selectionReason === 'pool'));
  calls.length = 0;
  // An explicit model cannot cause a fallback to another pool member.
  await assert.rejects(runAction({}, 'image', { prompt: 'explicit fixture', model: images.id + '::a' }));
  assert.deepEqual(calls, ['a']);
  calls.length = 0;
  unknown = true;
  await assert.rejects(runAction({}, 'image', { prompt: 'unknown fixture' }), /受理状态未知/);
  assert.deepEqual(calls, ['a']);
  calls.length = 0;
  config.setFunctionPolicy('image-gen', 'disabled');
  await assert.rejects(runAction({}, 'image', { prompt: 'disabled fixture', model: images.id + '::b' }));
  assert.equal(calls.length, 0);
  await runAction({}, 'providers_confirm_model', { id: images.id, model_id: 'b', capabilities: ['image-gen'], enableAutomatic: true });
  const management = await runAction({}, 'assignments_get');
  assert.equal(management.policies['image-gen'].mode, 'auto');
  assert.equal(management.readiness['image-gen'].candidateCount, 2);
  assert.equal(calls.length, 0, 'configuration confirmation and preview never submit');
} finally { globalThis.fetch = originalFetch; }
const managed = config.upsert({ name: 'host reference health', enabled: true,
  dshProvider: { provider: 'fixture', settingsNs: 'llm-pi-ai' }, mediaProtocol: 'openai-images',
  models: [{ id: 'managed-image', capabilities: ['image-gen'] }, { id: 'unsupported-video', capabilities: ['video-gen'] }] });
config.recordProviderHealth(managed.id, 'managed-image', 'image-gen', { ok: true, source: 'task' });
const health = config.providerHealthSnapshot();
assert.equal(health.capabilities['image-gen'].candidates.find(model => model.providerId === managed.id)?.status, 'verified',
  'reference-only persistence must not hide recorded health from global badges');
assert(!health.capabilities['video-gen'].candidates.some(model => model.providerId === managed.id), 'known protocol gaps still excluded');
assert(!config.pickAllFor('image-gen').some(provider => provider.id === managed.id), 'health metadata never makes unresolved references executable');
console.log('PASS automatic/manual/disabled pools, six capabilities, confirmation, discovery, protocols, cooldown, host opt-in and real Action/Core acceptance boundaries');
