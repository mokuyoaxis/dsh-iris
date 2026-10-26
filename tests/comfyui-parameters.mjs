import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkedComfyWorkflow, compileComfyWorkflow, comfyWorkflowDigest, normalizeComfyParameters, projectComfyWorkflow } from '../lib/comfyui-workflow.js';
import { createComfyUiClient } from '../lib/comfyui-client.js';
import { inspectComfyWorkflow } from '../lib/comfyui-inspection.js';
import { createComfyUiProviderAdapter } from '../lib/comfyui-adapter.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';
import { executeConfigCommand } from '../lib/provider-config-service.js';
import { createProviderRegistry } from '../lib/provider-extensions.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { configuredImagePorts } from '../lib/configured-image-runtime.js';
import { readFlowRun } from '../lib/flow-store.js';
import { creationInputDigest } from '../lib/creation-request-store.js';
import { normalizeGenerationInput } from '../lib/generation-input.js';
import { COMFY_WORKFLOW, COMFY_SCHEMAS, comfyProtocolFixture } from './fixtures/comfyui-protocol-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-comfyui-parameters'), fixture = await comfyProtocolFixture(), apps = [];
const configPath = path.join(root, 'providers.json'), provider = { id: 'comfy', name: 'Comfy', baseUrl: fixture.baseUrl, auth: 'none',
  mediaProtocol: 'comfyui', models: [{ id: 'portrait', capabilities: ['image-gen'], comfyWorkflow: COMFY_WORKFLOW }] };
fs.writeFileSync(configPath, JSON.stringify({ providers: [provider], assignments: { 'image-gen': { mode: 'auto', models: [] } } }), { mode: 0o600 });
const registry = await createProviderRegistry(), client = createComfyUiClient(provider), adapter = createComfyUiProviderAdapter(provider);
const parameters = { lora: 'portrait.safetensors', model_weight: 0.7, clip_weight: 0.4, negative: '', seed: 42, steps: 25, sampler: 'dpmpp_2m' };
const submit = input => invokeProviderOperation(adapter, 'submit', { capability: 'image', model: 'portrait', input: { prompt: 'An iris portrait', n: 1, ...input } });
try {
  assert.deepEqual(checkedComfyWorkflow(COMFY_WORKFLOW), COMFY_WORKFLOW);
  const compiled = compileComfyWorkflow(COMFY_WORKFLOW, { prompt: 'Changed', workflow_parameters: parameters });
  assert.equal(compiled.graph['10'].inputs.lora_name, 'portrait.safetensors'); assert.equal(compiled.graph['10'].inputs.strength_model, 0.7);
  assert.equal(compiled.graph['10'].inputs.strength_clip, 0.4); assert.equal(compiled.graph['7'].inputs.text, '');
  assert.equal(compiled.graph['3'].inputs.seed, 42); assert.equal(compiled.graph['3'].inputs.steps, 25);
  assert.equal(COMFY_WORKFLOW.graph['6'].inputs.text, 'Positive'); assert.equal(COMFY_WORKFLOW.graph['10'].inputs.strength_model, 1);
  assert.deepEqual(normalizeComfyParameters({ seed: 42, lora: 'x' }), { lora: 'x', seed: 42 });
  for (const value of [{}, [], { seed: NaN }, { seed: Number.MAX_SAFE_INTEGER + 1 }, { seed: {} }, { seed: [] }, { constructor: 1 }, { 'bad.key': 1 }, { negative: 'x'.repeat(25000) }]) {
    assert.throws(() => normalizeComfyParameters(value), { code: 'IRIS_COMFYUI_PARAMETERS_INVALID' });
  }
  for (const value of [{ unknown: 1 }, { seed: '1' }, { seed: -1 }, { steps: 1.5 }, { model_weight: 3 }, { sampler: 'unexposed' }]) {
    assert.throws(() => compileComfyWorkflow(COMFY_WORKFLOW, { workflow_parameters: value }), { code: 'IRIS_COMFYUI_PARAMETERS_INVALID' });
  }
  for (const modify of [w => { w.parameters[0].id = null; }, w => { w.parameters[0].node = 'missing'; },
    w => { w.parameters[0].input = 'model'; }, w => { w.parameters[0] = { id: 'reserved', node: '6', input: 'text', type: 'string' }; },
    w => { w.parameters.push({ ...w.parameters[0], id: 'duplicate_target' }); }, w => { w.parameters[1].min = 2; w.parameters[1].max = -2; },
    w => { w.parameters[0].extra = true; }]) {
    const invalid = structuredClone(COMFY_WORKFLOW); modify(invalid); assert.throws(() => checkedComfyWorkflow(invalid));
  }
  const fixed = { ...COMFY_WORKFLOW, version: 0 }; delete fixed.parameters;
  const safeSeed = structuredClone(fixed); safeSeed.graph['3'].inputs.seed = Number.MAX_SAFE_INTEGER;
  assert.equal(checkedComfyWorkflow(safeSeed).graph['3'].inputs.seed, Number.MAX_SAFE_INTEGER);
  for (const seed of [Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1, JSON.parse('18446744073709551615'), Infinity, NaN]) {
    const unsafeSeed = structuredClone(fixed); unsafeSeed.graph['3'].inputs.seed = seed;
    assert.throws(() => checkedComfyWorkflow(unsafeSeed), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  }
  assert.throws(() => compileComfyWorkflow(fixed, { workflow_parameters: { seed: 1 } }));
  assert(!Object.hasOwn(projectComfyWorkflow(COMFY_WORKFLOW), 'graph'));
  assert.equal(projectComfyWorkflow(COMFY_WORKFLOW).parameters.find(p => p.id === 'model_weight').default, 1);
  assert.throws(() => normalizeGenerationInput('image', { prompt: 'x', workflow_parameters: { seed: 1 } }));
  assert.throws(() => normalizeGenerationInput('image', { model_ref: 'comfy::portrait', prompt: '\0'.repeat(20000),
    workflow_parameters: { negative: '\0'.repeat(4000) } }), { code: 'IRIS_GENERATION_INPUT_INVALID' });

  const original = fs.readFileSync(configPath), initialFiles = fs.readdirSync(root);
  const shown = await executeConfigCommand(configPath, 'show', {}, { registry });
  assert.equal(shown.models[0].comfyWorkflow.parameters.length, 7); assert(!JSON.stringify(shown).includes('class_type'));
  const checked = await executeConfigCommand(configPath, 'models.workflow-check', { model_ref: 'comfy::portrait', workflow_parameters: parameters }, { registry });
  assert(checked.ok); assert.equal(checked.checkedClasses, 7); assert.equal(checked.executed, false); assert.equal(checked.persisted, false);
  assert.deepEqual(checked.parameters.find(p => p.id === 'lora').availableChoices, ['iris.safetensors', 'portrait.safetensors']);
  fixture.schemas.SaveImage.output = []; // Older ComfyUI releases had no data output on SaveImage.
  assert.equal((await inspectComfyWorkflow(client, COMFY_WORKFLOW)).ok, true);
  fixture.schemas.SaveImage = structuredClone(COMFY_SCHEMAS.SaveImage);
  assert.equal(checked.parameters.find(p => p.id === 'model_weight').value, 0.7);
  assert.equal(shown.models[0].comfyWorkflow.parameters.find(p => p.id === 'model_weight').default, 1);
  assert.deepEqual(fs.readFileSync(configPath), original); assert.deepEqual(fs.readdirSync(root), initialFiles);
  assert.equal(fixture.graphs.length, 0); assert(fixture.requests.every(request => request.method === 'GET'));
  fixture.schemas.LoraLoader.input.required.lora_name[0] = ['iris.safetensors'];
  const unavailable = await inspectComfyWorkflow(client, compiled);
  assert(unavailable.issues.some(issue => issue.code === 'choice_unavailable' && issue.node === '10' && issue.input === 'lora_name'));
  assert.equal((await submit({ workflow_parameters: parameters })).kind, 'not_accepted'); assert.equal(fixture.graphs.length, 0);
  fixture.schemas.LoraLoader = structuredClone(COMFY_SCHEMAS.LoraLoader);
  const isolatedConfig = path.join(root, 'other-protocol.json');
  fs.writeFileSync(isolatedConfig, JSON.stringify({ providers: [{ ...provider, mediaProtocol: 'openai-images',
    models: [{ id: 'portrait', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': { mode: 'auto', models: [] } } }), { mode: 0o600 });
  const isolated = createApplicationRuntime({ dataRoot: path.join(root, 'other-core'), ...configuredImagePorts(isolatedConfig, registry) }); apps.push(isolated);
  await isolated.execute('flow.init', {}); await isolated.execute('execution.init', { imageGeneration: true });
  await assert.rejects(isolated.execute('creation.generate', { key: crypto.randomUUID(), value: { modelRef: 'comfy::portrait', prompt: 'x', workflowParameters: { seed: 1 } } }), { code: 'IRIS_COMFYUI_PARAMETERS_INVALID' });
  await assert.rejects(isolated.generateImage({ model_ref: 'comfy::portrait', prompt: 'x', workflow_parameters: { seed: 1 } }), { code: 'IRIS_COMFYUI_PARAMETERS_INVALID' });
  assert.equal((await isolated.execute('flow.list', {})).total, 0); assert.equal(fixture.graphs.length, 0);
  const badLink = structuredClone(COMFY_WORKFLOW); badLink.graph['6'].inputs.clip = ['4', 0];
  assert((await inspectComfyWorkflow(client, badLink)).issues.some(issue => issue.code === 'link_type'));
  const missing = structuredClone(COMFY_WORKFLOW); missing.graph['7'].class_type = 'UnavailableCustomNode';
  assert((await inspectComfyWorkflow(client, missing)).issues.some(issue => issue.code === 'node_unavailable'));
  fixture.schemas.KSampler.input.required.steps[1].max = 10;
  assert.equal((await submit({ workflow_parameters: parameters })).kind, 'not_accepted'); assert.equal(fixture.graphs.length, 0);
  fixture.schemas.KSampler = structuredClone(COMFY_SCHEMAS.KSampler);

  for (const mode of ['drop', 'malformed', 'unauthorized', 'oversized', 'redirect', 'hang']) {
    fixture.mode = mode;
    const result = await invokeProviderOperation(adapter, 'submit', { capability: 'image', model: 'portrait', input: { prompt: 'x', n: 1 }, timeoutMs: mode === 'hang' ? 30 : 15000 });
    assert.equal(result.kind, 'not_accepted', mode + ' in preflight must never become unknown acceptance');
    assert.equal(result.error.stage, 'validate'); assert(!JSON.stringify(result).includes('private fixture upstream detail'));
    assert.equal(fixture.graphs.length, 0);
  }
  fixture.mode = 'normal';
  const bearer = createComfyUiClient({ ...provider, auth: 'bearer', apiKey: 'fixture-bearer-key' });
  await inspectComfyWorkflow(bearer, COMFY_WORKFLOW);
  assert(fixture.requests.slice(-7).every(request => request.authorization === 'Bearer fixture-bearer-key'));

  const dataRoot = path.join(root, 'core'), ports = configuredImagePorts(configPath, registry);
  let app = createApplicationRuntime({ dataRoot, ...ports }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true });
  const key = crypto.randomUUID(), value = { modelRef: 'comfy::portrait', prompt: 'A violet iris', workflowParameters: parameters };
  const created = await app.execute('creation.generate', { key, value });
  assert.equal(created.flow.run.schemaVersion, 2); assert.equal(created.flow.task, null);
  assert.deepEqual(created.flow.run.input.workflow_parameters, normalizeComfyParameters(parameters));
  assert.equal((await app.execute('creation.generate', { key, value: { ...value, workflowParameters: Object.fromEntries(Object.entries(parameters).reverse()) } })).flow.run.id, created.flow.run.id);
  await assert.rejects(app.execute('creation.generate', { key, value: { ...value, workflowParameters: { ...parameters, seed: 43 } } }), { code: 'IRIS_CREATION_KEY_CONFLICT' });
  await assert.rejects(app.execute('creation.generate', { key: crypto.randomUUID(), value: { ...value, workflowParameters: { injected: true } } }), { code: 'IRIS_COMFYUI_PARAMETERS_INVALID' });
  assert.equal(fixture.graphs.length, 0, 'creation and lookup never enqueue or check the service');
  const run_id = created.flow.run.id, first = await app.execute('flow.continue', { run_id });
  assert.equal(first.status, 'running'); assert.equal(fixture.graphs.length, 1);
  assert.equal(fixture.graphs[0]['10'].inputs.strength_model, 0.7); assert.equal(fixture.graphs[0]['10'].inputs.strength_clip, 0.4);
  assert.equal(fixture.graphs[0]['7'].inputs.text, ''); assert.equal(fixture.graphs[0]['3'].inputs.seed, 42);
  await app.dispose(); fixture.phase = 'done'; fixture.mode = 'drop';
  app = createApplicationRuntime({ dataRoot, ...ports }); apps.push(app);
  const beforeRecovery = fixture.requests.length, recovered = await app.execute('flow.continue', { run_id });
  assert.equal(recovered.status, 'awaiting_selection'); assert.equal(recovered.task.id, first.task.id);
  assert.equal(fixture.graphs.length, 1); assert(fixture.requests.slice(beforeRecovery).every(request => !request.path.startsWith('/object_info/')));
  const file = path.join(dataRoot, 'flow-store/v0/runs', run_id + '.json'), saved = fs.readFileSync(file);
  const tampered = JSON.parse(saved); tampered.input.workflow_parameters.seed++;
  fs.writeFileSync(file, JSON.stringify(tampered)); assert.throws(() => readFlowRun(dataRoot, run_id), { code: 'IRIS_FLOW_RECORD_INVALID' }); fs.writeFileSync(file, saved);
  const legacyInput = { model_ref: 'comfy::portrait', prompt: 'x', n: 1 };
  assert.equal(creationInputDigest('generation-create', legacyInput), 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(['generation-create/v0', 'image-generate/v0', 'comfy::portrait', 'x', null, 1])).digest('hex'));
  assert.notEqual(comfyWorkflowDigest(COMFY_WORKFLOW), comfyWorkflowDigest(compiled));
  const healthConfig = path.join(root, 'health.json'), healthProvider = structuredClone(provider);
  healthProvider.models[0].verified = { 'image-gen': { ok: true }, vision: { ok: true } };
  fs.writeFileSync(healthConfig, JSON.stringify({ providers: [healthProvider], assignments: {} }), { mode: 0o600 });
  const changedModel = structuredClone(healthProvider.models[0]); changedModel.comfyWorkflow.graph['3'].inputs.steps = 26;
  await executeConfigCommand(healthConfig, 'providers.set', { provider: { id: 'comfy', models: [changedModel] } }, { registry });
  const updatedHealth = JSON.parse(fs.readFileSync(healthConfig)).providers[0].models[0].verified;
  assert.equal(updatedHealth['image-gen'], undefined); assert.equal(updatedHealth.vision.ok, true);
  fixture.mode = 'post-lost';
  const uncertain = await submit({ workflow_parameters: parameters }); assert.equal(uncertain.kind, 'acceptance_unknown');
  assert.equal(fixture.graphs.length, 2); assert(!fixture.requests.some(request => /interrupt|upload|delete/.test(request.path)));
  console.log('PASS ComfyUI parameters/preflight: immutable scalar slots, LoRA model/CLIP weights, official schema choices/ranges/links, GET-only inspection, stage-specific network failures, v2 Run snapshots, Key conflicts, restart without re-enqueue and unchanged legacy hashes');
} finally { await Promise.allSettled(apps.map(app => app.dispose())); await registry.dispose(); await fixture.close(); }
