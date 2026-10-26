// Actual DSH actions and instance Task/Artifact lifecycle against controlled official wire shapes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { comfyProtocolFixture, COMFY_WORKFLOW } from './fixtures/comfyui-protocol-fixture.mjs';
import { FLOW_RESULT } from './fixtures/image-flow-fixture.mjs';
import { comfyWorkflowDigest } from '../lib/comfyui-workflow.js';
import { providerForImageModel } from '../lib/provider-protocol.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { inspectCoreTask, listCoreTasks } from '../lib/core-tasks.js';

const { root } = useTempDshHome('iris-dsh-comfyui');
const store = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { createDshRuntime, dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const dataRoot = dshCoreDataRoot(), core = createDshRuntime({ dataRoot }), fixture = await comfyProtocolFixture();
const action = (name, args = {}) => runAction({}, name, args, { core });
const file = path.join(root, 'iris/v1/providers.json');
try {
  const created = await action('providers_upsert', { name: 'ComfyUI', baseUrl: fixture.baseUrl, auth: 'none', mediaProtocol: 'comfyui' });
  const id = created.providerId, modelId = 'LoRA workflow', ref = id + '::' + encodeURIComponent(modelId);
  assert.equal(store.providerById(id).auth, 'none');
  await assert.rejects(action('providers_upsert', { id, auth: 'invalid' }), /认证方式/);
  const bytes = fs.readFileSync(file);
  const good = await action('providers_check_comfy_workflow', { id, workflow: COMFY_WORKFLOW });
  assert.equal(good.report.ok, true); assert.equal(good.report.executed, false); assert.equal(good.report.persisted, false);
  assert(good.report.parameters.find(parameter => parameter.id === 'lora').availableChoices.includes('iris.safetensors'));
  assert(fs.readFileSync(file).equals(bytes)); assert.equal(fixture.graphs.length, 0); assert(!fs.existsSync(dataRoot));
  const bad = structuredClone(COMFY_WORKFLOW); bad.graph['10'].inputs.lora_name = 'missing.safetensors';
  assert.equal((await action('providers_check_comfy_workflow', { id, workflow: bad })).report.ok, false);
  assert(fs.readFileSync(file).equals(bytes)); assert.equal(fixture.graphs.length, 0);
  await assert.rejects(action('providers_save_comfy_workflow', { id, model_id: modelId, expectedSha: null, workflow: { nodes: [] } }), /API 工作流/);
  assert(fs.readFileSync(file).equals(bytes));
  const unsafeSeed = structuredClone(COMFY_WORKFLOW); unsafeSeed.graph['3'].inputs.seed = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(action('providers_save_comfy_workflow', { id, model_id: modelId, expectedSha: null, workflow: unsafeSeed }), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  assert(fs.readFileSync(file).equals(bytes)); assert.equal(fixture.graphs.length, 0);
  const saved = await action('providers_save_comfy_workflow', { id, model_id: modelId, expectedSha: null, workflow: COMFY_WORKFLOW, enableAutomatic: true });
  assert.equal(saved.comfyWorkflow.sha256, comfyWorkflowDigest(COMFY_WORKFLOW));
  assert.equal(store.assignments()['image-gen'].mode, 'auto'); assert.equal(fixture.graphs.length, 0);
  const listed = (await action('providers_list')).providers.find(provider => provider.id === id);
  assert.equal(listed.models[0].comfyWorkflow.parameters[0].id, 'lora');
  assert(!Object.hasOwn(listed.models[0].comfyWorkflow, 'graph'));
  const option = (await action('assignments_get')).poolByCapability['image-gen'].find(option => option.id === modelId);
  assert.equal(option.comfyWorkflow.sha256, saved.comfyWorkflow.sha256); assert.equal(option.unavailable, false);
  const beforeProbe = fs.readFileSync(file), probeRequests = fixture.requests.length;
  const probe = await action('providers_test_model', { id, model_id: modelId, capability: 'image-gen', confirm_paid: true });
  assert.equal(probe.skipped, true); assert.equal(fixture.requests.length, probeRequests);
  assert(fs.readFileSync(file).equals(beforeProbe), 'generic probe must not enqueue an untracked Comfy prompt or change health');
  const conflictBefore = fs.readFileSync(file);
  await assert.rejects(action('providers_save_comfy_workflow', { id, model_id: modelId, expectedSha: null, workflow: COMFY_WORKFLOW }), { code: 'IRIS_CONFIG_CHANGED' });
  assert(fs.readFileSync(file).equals(conflictBefore));

  // Legacy pool replacement and discovery must retain the native template and non-image health.
  store.setProviderModels(id, [{ id: modelId, capabilities: ['image-gen', 'vision'] }]);
  store.mergeDiscoveredModels(id, [{ id: 'unconfirmed-directory-item', capabilities: [] }]);
  assert.deepEqual(store.providerById(id).models.find(model => model.id === modelId).comfyWorkflow, COMFY_WORKFLOW);
  store.setModelVerified(id, modelId, 'image-gen', { ok: true, note: 'fixture image' });
  store.setModelVerified(id, modelId, 'vision', { ok: true, note: 'fixture vision' });
  const changed = structuredClone(COMFY_WORKFLOW); changed.graph['3'].inputs.steps = 22;
  const replaced = await action('providers_save_comfy_workflow', { id, model_id: modelId, workflow: changed, expectedSha: saved.comfyWorkflow.sha256 });
  const raw = store.providerById(id).models.find(model => model.id === modelId);
  assert.equal(raw.verified['image-gen'], undefined); assert.equal(raw.verified.vision.ok, true);
  assert.equal(store.assignments()['image-gen'].mode, 'auto');
  const parameters = { lora: 'portrait.safetensors', model_weight: 0.65, clip_weight: 0.4, negative: '', seed: 7, steps: 24 };
  const createInput = { model: ref, prompt: 'a flower', workflow_sha: replaced.comfyWorkflow.sha256, workflow_parameters: parameters };
  const requestCount = fixture.requests.length;
  for (const invalid of [{ ...createInput, workflow_parameters: { unknown: 1 } }, { ...createInput, workflow_sha: '0'.repeat(64) },
    { ...createInput, workflow_parameters: { seed: -1 } }, { ...createInput, model: modelId }, { ...createInput, source_artifact_id: 'artifact_' + 'a'.repeat(24) }]) {
    await assert.rejects(action(invalid.source_artifact_id ? 'image_edit' : 'image', invalid));
  }
  assert.equal(fixture.requests.length, requestCount, 'invalid parameters rejected before any Comfy request');
  assert(!fs.existsSync(dataRoot), 'invalid requests do not create Task storage');
  const submitted = await action('image', createInput);
  await core.stopProviderTaskWatchesForDsh();
  assert.equal(fixture.graphs.length, 1);
  const graph = fixture.graphs[0];
  assert.equal(graph['10'].inputs.lora_name, parameters.lora); assert.equal(graph['10'].inputs.strength_model, 0.65);
  assert.equal(graph['10'].inputs.strength_clip, 0.4); assert.equal(graph['7'].inputs.text, ''); assert.equal(graph['3'].inputs.steps, 24);
  assert.equal(store.providerById(id).models.find(model => model.id === modelId).comfyWorkflow.graph['3'].inputs.steps, 22);
  assert(fixture.requests.every(request => request.authorization === undefined));
  const task = inspectCoreTask(dataRoot, submitted.taskId);
  assert.equal(task.acceptance, 'accepted'); assert.equal(task.remoteTaskId, 'prompt_1');
  fixture.phase = 'done';
  const adapter = createConfiguredProviderAdapter(providerForImageModel(store.providerById(id), modelId));
  const beforeObserve = fixture.requests.filter(request => request.path.startsWith('/object_info/')).length;
  await core.observeProviderTaskForDsh({ taskId: task.id, adapter });
  const done = inspectCoreTask(dataRoot, task.id);
  assert.equal(done.outcome, 'succeeded'); assert.equal(done.deliveryState, 'ready');
  assert(readCoreArtifactBytes(dataRoot, done.artifactIds[0]).bytes.equals(FLOW_RESULT));
  assert.equal(fixture.graphs.length, 1); assert.equal(fixture.requests.filter(request => request.path.startsWith('/object_info/')).length, beforeObserve);

  const originalFetch = globalThis.fetch; let edited = false;
  globalThis.fetch = async (...args) => { const response = await originalFetch(...args); if (!edited) { edited = true; store.upsert({ id, name: 'edited during check' }); } return response; };
  try { await assert.rejects(action('providers_check_comfy_workflow', { id, model_id: modelId }), { code: 'IRIS_CONFIG_CHANGED' }); }
  finally { globalThis.fetch = originalFetch; }
  fixture.mode = 'post-lost';
  await assert.rejects(action('image', createInput), /受理状态未知/);
  const unknown = listCoreTasks(dataRoot).tasks.find(task => task.acceptance === 'unknown');
  assert(unknown); assert.equal(fixture.graphs.length, 2);
  assert.equal(unknown.attempts.length, 1, 'uncertain acceptance never falls through to another candidate');
  console.log('PASS DSH ComfyUI: local connection, read-only inspection, explicit save/conflict, legacy field protection, selective health reset, parameterized Action → Task → Artifact and uncertain POST');
} finally { await core.dispose(); await fixture.close(); }
