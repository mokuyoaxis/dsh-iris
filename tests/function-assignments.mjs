import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { CAPABILITIES } from '../lib/capability.js';
import { modelRef, HOST_VISION_REF } from '../lib/models.js';
import * as catalog from '../lib/provider-catalog.js';
import { buildVisionModelCandidates, runVisionRequest } from '../lib/vision-model-routing.js';
import { defineHostAdapter } from '../lib/host-contract.js';
import { createDshVisionFixture } from './fixtures/vision-models.mjs';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

useTempDshHome('iris-function-assignments');
const config = await import('../lib/config.js');
const { runAction } = await import('./fixtures/dsh-runtime-fixture.mjs');
const capabilities = Object.values(CAPABILITIES);
const provider = config.upsert({ id: 'fixture', enabled: true, auth: 'none', type: 'openai',
  baseUrl: 'https://fixture.invalid/v1', mediaProtocol: 'openai-images',
  models: ['a', 'b', 'c'].map(id => ({ id, capabilities, musicProtocol: 'gemini-web-music' })) });
const refs = ['a', 'b', 'c'].map(id => modelRef(provider.id, id));
const selectors = { 'image-gen': catalog.imageCandidatesFromCatalog, 'video-gen': catalog.videoCandidatesFromCatalog,
  tts: catalog.ttsCandidatesFromCatalog, 'music-gen': catalog.musicCandidatesFromCatalog,
  transcribe: catalog.transcribeCandidatesFromCatalog, vision: catalog.visionCandidatesFromCatalog };
const snapshot = () => ({ providers: config.allProviders(), assignments: config.assignments() });
const stored = () => fs.readFileSync(path.join(config.irisHome(), 'providers.json'));

for (const capability of capabilities) {
  assert.deepEqual(config.pickAllFor(capability), [], capability + ' 未分配不调用模型池');
  assert.throws(() => selectors[capability](snapshot()), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' });
  config.setAssignmentOrder(capability, refs.slice(0, 2));
  assert.deepEqual(selectors[capability](snapshot()).map(route => route.modelRef), refs.slice(0, 2));
  assert.deepEqual(selectors[capability](snapshot(), refs[1]).map(route => route.modelRef), [refs[1]]);
  assert.throws(() => selectors[capability](snapshot(), refs[2]), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' });
}

const fixture = createDshVisionFixture({ steps: [{ text: 'host result' }] });
let metadataReads = 0;
const host = defineHostAdapter({ id: 'fixture-host', ports: { attachments: fixture.attachments,
  textModel: { ...fixture.textModel, currentSelection: () => ({ provider: 'fixture', model: 'vision-v0' }),
    async resolveModelInfo() { metadataReads++; return { provider: 'fixture', id: 'vision-v0', inputModalities: ['image'] }; } } } });
assert.equal(buildVisionModelCandidates(host, { providers: config.pickAllFor('vision') }).filter(c => c.via === 'global').length, 0);
assert.throws(() => buildVisionModelCandidates(host, { providers: config.pickAllFor('vision'), model: refs[2] }),
  { code: 'IRIS_MODEL_UNAVAILABLE' }, '同账号的其他模型也不得绕过视觉名单');
config.setAssignmentOrder('vision', [HOST_VISION_REF, refs[0]]);
assert.deepEqual(buildVisionModelCandidates(host, { providers: config.pickAllFor('vision') }).map(c => c.via), ['global', 'selfstack']);
assert.equal(metadataReads + fixture.stats.invocations, 0, '分配与候选查询不读取宿主模型或生成');

let requests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { requests++; return new Response('', { status: 401 }); };
try {
  const image = { bytes: new Uint8Array(FAKE_PNG), mediaType: 'image/png' };
  await assert.rejects(runVisionRequest(host, { providers: config.pickAllFor('vision'), model: refs[0], question: 'color', image }),
    { code: 'IRIS_MODEL_AUTH_FAILED' });
  assert.equal(requests, 1); assert.equal(fixture.stats.invocations, 0, '显式自持模型失败不退到宿主');
  assert.equal((await runVisionRequest(host, { providers: config.pickAllFor('vision'), model: HOST_VISION_REF, question: 'color', image })).answer, 'host result');
  assert.equal(metadataReads, 1); assert.equal(requests, 1, '显式宿主不调用其他名单项');
  await assert.rejects(runAction({}, 'image', { prompt: 'fixture', model: refs[2] }), /未分配/);
  assert.equal(requests, 1, '名单外生成在网络前拒绝');

  const binding = catalog.providerTaskBinding(provider);
  const task = { capability: 'image', providerId: provider.id, modelRef: refs[0], providerBinding: binding };
  for (const capability of capabilities) config.clearAssignment(capability);
  const afterClear = stored();
  for (const capability of capabilities) assert.deepEqual(config.pickAllFor(capability), []);
  assert.equal(catalog.providerForTaskFromCatalog(snapshot(), task).id, provider.id, '清空不改变旧任务绑定恢复');
  assert.deepEqual(stored(), afterClear, '选择与恢复不自动填写名单');
  globalThis.fetch = async () => { requests++; return new Response('data: {"choices":[{"delta":{"content":"红色"},"finish_reason":"stop"}]}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }); };
  const tested = await runAction({}, 'providers_test_model', { id: provider.id, model_id: 'c', capability: 'vision', confirm_paid: true });
  assert.equal(tested.passed, true, '未分配模型仍可明确手动实测');
  assert.deepEqual(config.assignmentOrder('vision'), [], '实测成功不自动分配');
  assert.equal((await runAction({}, 'assignments_get', {})).poolByCapability.vision.some(m => m.ref === HOST_VISION_REF), true);
} finally { globalThis.fetch = originalFetch; }
console.log('PASS 六类严格名单、同账号名单外零调用、显式单项、宿主排序与绑定、空名单、旧任务恢复及独立实测');
