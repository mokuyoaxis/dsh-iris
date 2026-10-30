// State/response races in the actual DSH components; browser layout is verified separately.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { COMFY_WORKFLOW } from './fixtures/comfyui-protocol-fixture.mjs';
import { projectComfyWorkflow } from '../lib/comfyui-workflow.js';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const label = node => (node.props?.children || []).filter(value => typeof value === 'string').join('');
const json = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { resolve, promise }; };
function mount(name, initialProps, handler) {
  let entry, props = initialProps, cursor = 0;
  const hooks = [], pendingEffects = [], requests = [], events = [];
  const React = { createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }]; },
    useRef(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: value }; return hooks[index]; },
    useEffect(effect, deps) { const index = cursor++, before = hooks[index]; if (!before || deps.some((value, i) => value !== before.deps[i])) { pendingEffects.push(() => { before?.cleanup?.(); hooks[index] = { deps, cleanup: effect() }; }); } }
  };
  const fetch = async (url, options = {}) => {
    if (url.endsWith('/host-client')) return { ok: true, json: async () => ({}) };
    const request = { url, body: options.body ? JSON.parse(options.body) : {}, signal: options.signal }; requests.push(request);
    return handler(request);
  };
  const window = { __ModuleLoader__: { load(value) { entry = value; } }, fetch, innerWidth: 800, innerHeight: 600,
    addEventListener() {}, removeEventListener() {}, dispatchEvent(event) { events.push(event); } };
  vm.runInNewContext(source.replace('var clientSlots = clientSlotsPort(ctx);', 'window.testComponent=' + name + ';var clientSlots = clientSlotsPort(ctx);'),
    { window, document: { getElementById() { return {}; } }, fetch, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, AbortController,
      CustomEvent: class { constructor(type) { this.type = type; } }, console: { log() {} } });
  entry.factory(() => React).apply({ slots: { inject(_seat, callback) { callback(); }, register() {} } });
  const render = () => { cursor = 0; const tree = window.testComponent(props); for (const effect of pendingEffects.splice(0)) effect(); return nodes(tree); };
  const button = text => { const node = render().find(node => node.type === 'button' && label(node) === text); assert(node, text); return node; };
  const field = text => { const node = render().find(node => node.type === 'label' && node.props.children.includes(text)); assert(node, text); return node.props.children.find(child => child?.type === 'input' || child?.type === 'select' || child?.type === 'textarea'); };
  return { render, button, field, requests, events, update(next) { props = next; }, unmount() { for (const hook of hooks) hook?.cleanup?.(); } };
}
const response = (data, ok = true) => ({ ok, json: async () => json(data) });
const summary = projectComfyWorkflow(COMFY_WORKFLOW), checkReport = { ok: true, issues: [], parameters: [
  { id: 'lora', availableChoices: ['iris.safetensors', 'portrait.safetensors'] }
] };
const props = { provider: { id: 'p', mediaProtocol: 'comfyui', models: [{ id: 'same', comfyWorkflow: summary }] }, onDone() {} };
const auth = mount('ProviderAuthenticationEditor', { provider: { id: 'p', auth: 'bearer' }, onDone() {} }, () => response({ ok: true }));
auth.field('认证方式').props.onChange({ target: { value: 'none' } });
await auth.button('保存认证').props.onClick();
assert.deepEqual(auth.requests[0].body, { id: 'p', auth: 'none' });
assert(auth.render().every(node => node.type !== 'input' || node.props.type !== 'password')); auth.unmount();
let saveMode = 'conflict';
const editor = mount('ComfyWorkflowEditor', props, request => {
  if (request.url.endsWith('/providers_check_comfy_workflow')) return response({ ok: true, report: checkReport });
  if (saveMode === 'lost') throw new Error('lost response');
  return response({ error: '工作流已变化，草稿未保存' }, false);
});
async function upload(component, workflow, name = 'same.json') {
  const file = component.render().find(node => node.type === 'input' && node.props.type === 'file');
  await file.props.onChange({ target: { files: [{ name, size: JSON.stringify(workflow).length, async text() { return JSON.stringify(workflow); } }] } });
}
await upload(editor, COMFY_WORKFLOW);
assert.equal(editor.requests.length, 0, 'import must be entirely local');
const changedSummary = { ...summary, sha256: 'b'.repeat(64) };
editor.update({ ...props, provider: { ...props.provider, models: [{ id: 'same', comfyWorkflow: changedSummary }] } });
await editor.button('保存工作流').props.onClick();
assert.equal(editor.requests.length, 0, 'replacement needs its own confirmation');
await editor.button('确认替换').props.onClick();
await tick();
assert.equal(editor.requests[0].body.expectedSha, summary.sha256, 'polling must not silently approve a newer template');
assert.deepEqual(editor.requests[0].body.workflow, COMFY_WORKFLOW);
assert.equal(editor.field('工作流名称').props.value, 'same', 'conflict preserves draft');
assert(editor.render().some(node => label(node).includes('草稿未保存')));
await editor.button('只读检查').props.onClick();
await tick();
assert(editor.requests.at(-1).url.endsWith('/providers_check_comfy_workflow'));
assert(!Object.hasOwn(editor.requests.at(-1).body, 'enableAutomatic'));
saveMode = 'lost'; await editor.button('确认替换').props.onClick(); await tick();
assert(editor.render().some(node => node.type === 'fieldset' && node.props.disabled));
const count = editor.requests.length; await editor.button('保存工作流').props.onClick(); assert.equal(editor.requests.length, count, 'unknown save cannot be repeated');
assert(editor.render().some(node => label(node).includes('保存结果未知'))); editor.unmount();

// Unrenderable declarations must reach the shared validator, never be silently discarded.
const invalid = mount('ComfyWorkflowEditor', props, request => response({ error: 'bad target' }, false));
await upload(invalid, { ...COMFY_WORKFLOW, parameters: [{ id: 'missing', node: 'unknown', input: 'text', type: 'string' }] }, 'new.json');
await invalid.button('只读检查').props.onClick();
assert.equal(invalid.requests[0].body.workflow.parameters[0].node, 'unknown'); invalid.unmount();

let currentValues = {}, pending = deferred();
let paramProps = { option: { id: 'same', providerId: 'p', ref: 'p::same', comfyWorkflow: summary }, values: currentValues,
  onChange(value) { currentValues = json(value); paramProps = { ...paramProps, values: currentValues }; parameters.update(paramProps); } };
const parameters = mount('ComfyParameters', paramProps, () => pending.promise);
const first = parameters.button('只读检查并读取选项').props.onClick();
parameters.field('LoRA').props.onChange({ target: { value: 'portrait.safetensors' } });
pending.resolve(response({ ok: true, report: checkReport })); await first;
assert.equal(parameters.render().find(node => typeof node.type === 'function' && node.type.name === 'ComfyCheckResult').props.report, null,
  'late check result cannot certify changed parameters');
pending = deferred(); const second = parameters.button('只读检查并读取选项').props.onClick();
pending.resolve(response({ ok: true, report: checkReport })); await second;
assert.equal(parameters.field('LoRA').type, 'select'); assert.equal(parameters.field('LoRA').props.value, JSON.stringify('portrait.safetensors'));
parameters.field('模型权重').props.onChange({ target: { value: '0.65' } });
parameters.field('CLIP 权重').props.onChange({ target: { value: '0.4' } });
assert.equal(currentValues.model_weight, 0.65); assert.equal(currentValues.clip_weight, 0.4);
parameters.unmount();

const option = { id: 'same', providerId: 'p', ref: 'p::same', comfyWorkflow: summary };
const assignments = { ok: true, poolByCapability: { 'image-gen': [option, { id: 'remote', ref: 'r::remote' }] }, order: { 'image-gen': ['p::same', 'r::remote'] },
  policies: { 'image-gen': { mode: 'auto' } }, readiness: { 'image-gen': { candidateCount: 2 } } };
const card = mount('ActionCard', { action: 'image', capability: 'image-gen', fields: [{ key: 'prompt', label: '提示词', type: 'textarea' }, { key: 'model', label: '模型' }] }, request => {
  if (request.url.endsWith('/assignments_get')) return response(assignments);
  if (request.url.endsWith('/state')) return response({});
  throw new Error('lost submission');
});
const cardHeader = card.render().find(node => node.props.className === 'iris-act-head');
assert.equal(cardHeader.type, 'button'); assert.equal(cardHeader.props.type, 'button'); assert.equal(cardHeader.props['aria-expanded'], false);
cardHeader.props.onClick(); assert.equal(card.render().find(node => node.props.className === 'iris-act-head').props['aria-expanded'], true); await tick();
const modelSelect = () => card.render().find(node => node.type === 'select');
modelSelect().props.onChange({ target: { value: 'p::same' } });
let control = card.render().find(node => typeof node.type === 'function' && node.type.name === 'ComfyParameters');
control.props.onChange({ seed: '' }); await card.button('生成图片').props.onClick(); await tick();
assert(card.requests.every(request => !request.url.endsWith('/image')), 'invalid numeric input never submits');
modelSelect().props.onChange({ target: { value: 'r::remote' } });
modelSelect().props.onChange({ target: { value: 'p::same' } });
control = card.render().find(node => typeof node.type === 'function' && node.type.name === 'ComfyParameters');
assert.deepEqual(json(control.props.values), {}, 'switching models clears workflow overrides');
const execute = card.button('生成图片'); execute.props.onClick(); execute.props.onClick(); await tick();
assert.equal(card.requests.filter(request => request.url.endsWith('/image')).length, 1);
assert.equal(card.requests.find(request => request.url.endsWith('/image')).body.workflow_sha, summary.sha256);
assert.equal(card.button('生成图片').props.disabled, true, 'unknown submission stops further sends'); card.unmount();
const history = mount('HistoryBrowser', { recent: [{ id: 't_history', createdAt: new Date().toISOString(), status: 'failed', cap: 'image' }] }, () => response({}));
let heading = history.render().find(node => node.props.className === 'iris-hist-head');
assert.equal(heading.type, 'button'); assert.equal(heading.props.type, 'button'); assert.equal(heading.props['aria-expanded'], true);
heading.props.onClick(); assert.equal(history.render().find(node => node.props.className === 'iris-hist-head').props['aria-expanded'], false); history.unmount();
const bubble = mount('FloatingBubble', {}, () => response({})), target = {};
let bubbleRoot = bubble.render()[0], prevented = 0;
assert.equal(bubbleRoot.props.role, 'button'); assert.equal(bubbleRoot.props.tabIndex, 0); assert.equal(bubbleRoot.props['aria-expanded'], false);
bubbleRoot.props.onKeyDown({ key: 'Enter', target, currentTarget: target, preventDefault() { prevented++; } });
bubbleRoot = bubble.render()[0]; assert.equal(bubbleRoot.props['aria-expanded'], true);
bubbleRoot.props.onKeyDown({ key: ' ', target: {}, currentTarget: target, preventDefault() { assert.fail('nested control key must not toggle the bubble'); } });
assert.equal(bubble.render()[0].props['aria-expanded'], true);
bubbleRoot.props.onKeyDown({ key: ' ', target, currentTarget: target, preventDefault() { prevented++; } });
assert.equal(bubble.render()[0].props['aria-expanded'], false); assert.equal(prevented, 2); bubble.unmount();
console.log('PASS DSH ComfyUI components: explicit replacement, stale digest and draft preservation, unknown save/submission, declared parameters retained, late response rejection, typed weights, model switching and duplicate submit');
