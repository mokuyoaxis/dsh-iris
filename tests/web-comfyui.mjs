import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readWorkflowImport, workflowSlots, buildWorkflow, normalizeWorkflowValues } from '../lib/web/comfyui.js';
import { createMediaClient } from '../lib/web/media-client.js';
import { checkedComfyWorkflow } from '../lib/comfyui-workflow.js';
import { COMFY_WORKFLOW } from './fixtures/comfyui-protocol-fixture.mjs';

const template = readWorkflowImport(JSON.stringify(COMFY_WORKFLOW)), original = structuredClone(template);
const slots = workflowSlots(template), rebuilt = buildWorkflow(template, template, slots);
assert.deepEqual(checkedComfyWorkflow(rebuilt), COMFY_WORKFLOW);
assert(!slots.some(slot => slot.node === '6' && slot.input === 'text'));
assert(!slots.some(slot => slot.node === '5' && ['width', 'height'].includes(slot.input)));
assert(!slots.some(slot => slot.input === 'model' || slot.input === 'clip'));
assert.equal(slots.find(slot => slot.input === 'strength_model').type, 'number');
const raw = readWorkflowImport(JSON.stringify(template.graph));
const rawSlots = workflowSlots(raw, template);
assert.equal(rawSlots.filter(slot => slot.exposed).length, 0);
for (const slot of rawSlots) if (['lora_name', 'strength_model', 'strength_clip', 'seed'].includes(slot.input)) slot.exposed = true;
const generated = buildWorkflow(raw, template, rawSlots);
assert.equal(checkedComfyWorkflow(generated).version, 1); assert.equal(generated.parameters.length, 4);
assert.equal(buildWorkflow(raw, template, []).version, 0);
assert.deepEqual(template, original, 'import and form building do not mutate the graph or original declarations');
for (const text of ['{"nodes":[]}', '{"graph":{},"version":1}', JSON.stringify({ ...COMFY_WORKFLOW, version: 2 }), ' '.repeat(41000) + '{}']) {
  assert.throws(() => readWorkflowImport(text));
}
const unsafe = structuredClone(template.graph); unsafe['3'].inputs.seed = Number.MAX_SAFE_INTEGER + 1;
assert.throws(() => readWorkflowImport(JSON.stringify(unsafe)), /安全范围/);
assert.throws(() => buildWorkflow(raw, { ...template, promptNode: '' }, []), /正向提示词/);
assert.throws(() => buildWorkflow(raw, template, [...slots, ...slots].map(slot => ({ ...slot, exposed: true }))), /重复/);
const colliding = readWorkflowImport(JSON.stringify({ 'a.b': { class_type: 'Text', inputs: { text: '' } }, 'a_b': { class_type: 'Text', inputs: { text: '' } } }));
assert.equal(new Set(workflowSlots(colliding).map(slot => slot.id)).size, 2);
const values = { seed: 42, clip_weight: 0.4, lora: '', negative: '', enabled: false };
assert.deepEqual(Object.keys(normalizeWorkflowValues(values)), Object.keys(values).sort());
for (const value of [{}, [], { seed: Number.MAX_SAFE_INTEGER + 1 }, { seed: NaN }, { nested: {} }, { 'bad-id': 3 }, { constructor: true }, { text: 'x'.repeat(20001) }]) assert.throws(() => normalizeWorkflowValues(value));

// A click captures parameters before dispatch; recovery stores identities, never model inputs.
let resolve, received; const saved = new Map(), runId = 'run_' + 'a'.repeat(24);
const session = { contractVersion: 0, rootId: crypto.randomUUID(), operations: ['generations.create', 'runs.create', 'creation.lookup'] };
const client = { createGeneration(input) { received = input; return new Promise(done => { resolve = done; }); } };
const media = createMediaClient({ client, session, origin: 'http://127.0.0.1:1', getStorage: () => ({ getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }) });
const input = { modelRef: 'comfy::portrait', prompt: 'PRIVATE_PROMPT', workflowParameters: { seed: 42, lora: 'PRIVATE_LORA' } };
const pending = media.createGeneration(input);
assert.equal(media.createGeneration({ ...input, workflowParameters: { lora: 'PRIVATE_LORA', seed: 42 } }), pending);
input.workflowParameters.seed = 99;
await Promise.resolve();
assert.equal(received.workflowParameters.seed, 42);
for (const raw of saved.values()) for (const privateText of ['PRIVATE_PROMPT', 'PRIVATE_LORA', 'workflowParameters']) assert(!raw.includes(privateText));
resolve({ contractVersion: 0, flow: { contractVersion: 0, recipe: 'image-generate/v0', id: runId, source: null, selection: null, revision: 1 } });
await pending; assert.equal(media.snapshot().actions.length, 0);
assert.throws(() => media.createRun({ sourceArtifactId: 'artifact_' + 'b'.repeat(24), modelRef: 'comfy::portrait', prompt: 'Edit', workflowParameters: { seed: 1 } }), /输入无效/);
assert.throws(() => media.createGeneration({ modelRef: 'comfy::portrait', prompt: 'Invalid', workflowParameters: { seed: 2 ** 53 } }), /安全范围/);
media.close();
console.log('PASS Core ComfyUI: v0/v1 import, explicit scalar slots, default/type preservation, safe seeds, unique IDs, parameter snapshots and private recovery');
