/** Actual component events: old-server protection, slow writes, readback and uncertainty. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const caps = ['image-gen', 'video-gen', 'tts', 'music-gen', 'transcribe', 'vision'];
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (value, ok = true) => ({ ok, json: async () => clone(value) });
function snapshot(mode = 'manual') {
  return { ok: true, assignments: {},
    policies: Object.fromEntries(caps.map(cap => [cap, { mode: cap === 'image-gen' ? mode : 'disabled', models: ['p::a'], hostVision: false }])),
    readiness: Object.fromEntries(caps.map(cap => [cap, { mode: cap === 'image-gen' ? mode : 'disabled', candidateCount: cap === 'image-gen' ? mode === 'auto' ? 2 : mode === 'manual' ? 1 : 0 : 0 }])),
    order: Object.fromEntries(caps.map(cap => [cap, cap === 'image-gen' ? mode === 'auto' ? ['p::a', 'p::b'] : mode === 'manual' ? ['p::a'] : [] : []])),
    poolByCapability: { 'image-gen': [{ ref: 'p::a', label: 'A' }, { ref: 'p::b', label: 'B' }] } };
}
function fixture() {
  let entry, cursor, first = true, nextTimer = 0;
  const hooks = [], effects = [], requests = [], timers = new Map(), listeners = new Map();
  const controls = { state: snapshot(), get: null, set: null };
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(value) { const index = cursor++; return hooks[index] ||= { current: value }; },
    useEffect(effect) { cursor++; if (first) effects.push(effect); }
  };
  const window = {
    __ModuleLoader__: { load(value) { entry = value; } },
    confirm() { throw new Error('native blocking dialog must not be used'); },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); }
  };
  const fetch = async (url, options) => {
    const request = { url, body: JSON.parse(options.body) }; requests.push(request);
    if (url.endsWith('/assignments_get')) return controls.get ? controls.get(options) : response(controls.state);
    assert(url.endsWith('/assignments_set'), 'configuration must not generate, probe or discover');
    if (controls.set) return controls.set(request.body, options);
    controls.state = snapshot(request.body.mode || (request.body.model_refs.length ? 'manual' : 'disabled'));
    return response({ ok: true, mode: request.body.mode, model_refs: controls.state.order[request.body.capability] });
  };
  vm.runInNewContext(source.replace('var clientSlots = clientSlotsPort(ctx);',
    'window.CapabilityAssigner = CapabilityAssigner; var clientSlots = clientSlotsPort(ctx);'), {
    window, document: { getElementById() { return {}; } }, console: { log() {} }, fetch, AbortController,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  entry.factory(() => React).apply({ slots: { inject(_name, callback) { callback(); }, register() {} } });
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes)
    : [tree, ...nodes(tree.props?.children)];
  const text = tree => nodes(tree).flatMap(node => node.props?.children || []).filter(value => typeof value === 'string').join(' ');
  const render = () => {
    cursor = 0;
    const tree = window.CapabilityAssigner();
    const pending = effects.splice(0); first = false;
    for (const effect of pending) effect();
    return tree;
  };
  const row = (cap = 'image-gen') => nodes(render()).find(node => node.props?.['data-function'] === cap);
  const chooser = cap => nodes(row(cap)).find(node => node.type === 'select');
  const button = label => nodes(render()).find(node => node.type === 'button' && node.props.children.includes(label));
  const choose = value => chooser().props.onChange({ target: { value } });
  const writes = () => requests.filter(request => request.url.endsWith('/assignments_set'));
  return { controls, requests, timers, window, nodes, text, render, row, chooser, button, choose, writes,
    async mount() { render(); await tick(); } };
}

// Same HTTP 200 legacy payload as the running host: no mode write may reach it.
const old = fixture();
delete old.controls.state.policies; delete old.controls.state.readiness;
await old.mount();
assert(old.text(old.render()).includes('请重启 DSH 后刷新页面'));
for (const cap of caps) assert.equal(old.chooser(cap).props.disabled, true);
old.choose('auto');
assert.equal(old.writes().length, 0, 'old server must never receive a mode-only request');

// Inline confirmation and cancellation are zero-write actions.
const ui = fixture(); await ui.mount();
ui.choose('auto');
assert(ui.text(ui.row()).includes('尚未保存'));
assert.equal(ui.writes().length, 0);
ui.button('取消').props.onClick();
assert.equal(ui.chooser().props.value, 'manual');
assert.equal(ui.writes().length, 0);

let acknowledge, finishRead;
ui.controls.set = () => new Promise(resolve => { acknowledge = resolve; });
ui.choose('auto');
const confirm = ui.button('确认启用自动池');
confirm.props.onClick(); confirm.props.onClick();
assert.equal(ui.writes().length, 1, 'same-tick repeat clicks must produce one write');
assert(ui.text(ui.row()).includes('正在保存'));
assert.equal(ui.chooser().props.disabled, true);
ui.controls.state = snapshot('auto');
ui.controls.get = () => new Promise(resolve => { finishRead = resolve; });
acknowledge(response({ ok: true, mode: 'auto', model_refs: ['p::a', 'p::b'] }));
await tick();
assert(ui.text(ui.row()).includes('正在更新候选'));
assert.equal(ui.chooser().props.value, 'auto', 'accepted mode is visible before the preview finishes');
finishRead(response(ui.controls.state)); await tick();
assert(ui.text(ui.row()).includes('已保存：按功能自动选择 · 2 个可用候选'));
assert.equal(ui.chooser().props.disabled, false);
assert.equal(ui.requests.filter(request => request.url.endsWith('/assignments_get')).length, 2,
  'one initial read and one readback; publishing a snapshot must not trigger another read');
assert.equal(ui.timers.size, 0);

// An earlier refresh cannot undo a later saved policy.
let releaseOld;
ui.controls.get = () => new Promise(resolve => { releaseOld = resolve; });
ui.window.dispatchEvent({ type: 'iris-function-configuration-changed' });
const oldRead = releaseOld;
ui.controls.set = null; ui.controls.get = null;
ui.choose('disabled'); await tick();
assert.equal(ui.chooser().props.value, 'disabled');
ui.choose('auto');
assert(!ui.text(ui.row()).includes('已保存：'), 'a new pending choice must not retain a previous green success message');
ui.button('取消').props.onClick();
oldRead(response(snapshot('manual'))); await tick();
assert.equal(ui.chooser().props.value, 'disabled');

// A legacy acknowledgement is not success, even after a new-style initial read.
const mismatch = fixture(); await mismatch.mount();
mismatch.controls.set = () => response({ ok: true, model_ref: '' });
mismatch.choose('auto'); mismatch.button('确认启用自动池').props.onClick(); await tick();
assert(mismatch.text(mismatch.row()).includes('服务端未确认新策略'));
assert(!mismatch.text(mismatch.row()).includes('已保存：'));
assert.equal(mismatch.chooser().props.disabled, true);
for (const cap of caps) assert.equal(mismatch.chooser(cap).props.disabled, true, 'an old acknowledgement pauses all strategy writes');
mismatch.controls.set = null;
mismatch.button('刷新状态').props.onClick(); await tick();
assert.equal(mismatch.chooser().props.value, 'manual');
assert.equal(mismatch.writes().length, 1, 'verification is read-only and must never resubmit');

// A delayed metadata read cannot turn a confirmed write into a reported failure.
const preview = fixture(); await preview.mount();
preview.controls.get = async () => { throw new Error('fixture read lost'); };
preview.choose('disabled'); await tick();
assert(preview.text(preview.row()).includes('已保存为“停用”，候选未能刷新'));
assert.equal(preview.chooser().props.value, 'disabled');
preview.controls.get = null; preview.button('刷新状态').props.onClick(); await tick();
assert(preview.text(preview.row()).includes('当前已保存：停用'));
assert.equal(preview.writes().length, 1);

// The server may commit before the connection is lost; timeout stays uncertain.
const timeout = fixture(); await timeout.mount();
timeout.controls.set = (body, options) => {
  timeout.controls.state = snapshot(body.mode);
  return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
};
timeout.choose('disabled');
for (const callback of [...timeout.timers.values()]) callback();
await tick();
assert(timeout.text(timeout.row()).includes('未收到保存确认'));
assert(!timeout.text(timeout.row()).includes('已保存：'));
timeout.button('刷新状态').props.onClick(); await tick();
assert(timeout.text(timeout.row()).includes('当前已保存：停用'));
assert.equal(timeout.writes().length, 1);
assert.equal(timeout.timers.size, 0);

console.log('PASS 功能策略反馈：旧服务端零写入、页面内确认/取消、慢保存/回读、重复点击、旧响应、错误ACK、超时未知与只读核对');
