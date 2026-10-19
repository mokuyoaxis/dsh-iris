/** Actual health component events; every network response is an in-memory fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const caps = ['image-gen', 'video-gen', 'tts', 'music-gen', 'transcribe', 'vision'];
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = data => ({ ok: true, json: async () => clone(data) });
function data() {
  const models = caps.map((cap, i) => ({ id: 'model-' + i, capabilities: [cap], health: { [cap]: { status: 'configured' } } }));
  models.push({ id: 'outside', capabilities: ['image-gen'], health: { 'image-gen': { status: 'configured' } } });
  return {
    ok: true,
    providers: [{ id: 'p', name: '测试连接', enabled: true, models }],
    policies: Object.fromEntries(caps.map(cap => [cap, { mode: 'auto' }])),
    order: Object.fromEntries(caps.map((cap, i) => [cap, ['p::model-' + i]])),
    readiness: Object.fromEntries(caps.map(cap => [cap, { candidateCount: 1 }])),
    poolByCapability: Object.fromEntries(caps.map((cap, i) => [cap, [{ ref: 'p::model-' + i, providerId: 'p', id: 'model-' + i, protocolSupported: true },
      ...(i === 0 ? [{ ref: 'p::outside', providerId: 'p', id: 'outside', protocolSupported: true }] : [])]])),
    health: { generatedAt: new Date().toISOString(), capabilities: Object.fromEntries(caps.map(cap => [cap, { status: 'configured', candidateCount: 1 }])) }
  };
}
function fixture() {
  let entry, cursor, first = true, timerId = 0;
  const hooks = [], effects = [], requests = [], timers = new Map(), listeners = new Map(), openedTasks = [];
  const controls = { data: data(), probe: null, failRead: false, reply: { ok: true, passed: true, text: '[iris] 模型实测通过：生成返回图片' } };
  const taskSection = { tagName: 'DETAILS', open: false, parentElement: null };
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
    confirm() { throw new Error('inspection must not use a blocking native dialog'); },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); }
  };
  const fetch = async (url, options) => {
    const request = { url, body: options?.body ? JSON.parse(options.body) : {} }; requests.push(request);
    if (url.endsWith('/providers_test_model')) return controls.probe ? controls.probe(request.body, options) : response(controls.reply);
    assert(['/iris/api/state', '/iris/api/actions/assignments_get', '/iris/api/actions/providers_list'].includes(url), 'unexpected mutation or generation: ' + url);
    if (controls.failRead) throw new Error('fixture offline');
    if (url.endsWith('/providers_list')) return response({ ok: true, providers: controls.data.providers });
    return response(controls.data);
  };
  const document = {
    getElementById() { return { scrollIntoView() {} }; },
    querySelector(selector) {
      if (selector.startsWith('[data-iris-action=')) return { parentElement: taskSection, classList: { contains() { return false; } },
        querySelector() { return { click() { openedTasks.push(selector); } }; }, scrollIntoView() {} };
      return null;
    }
  };
  vm.runInNewContext(source.replace('var clientSlots = clientSlotsPort(ctx);',
    'window.Health = CapabilityHealthOverview; window.WorkbenchSection = WorkbenchSection; var clientSlots = clientSlotsPort(ctx);'), {
    window, document, fetch, AbortController,
    EventSource: class { constructor() { controls.eventSource = this; } close() {} }, setInterval() { return 1; }, clearInterval() {},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, console: { log() {} }
  });
  entry.factory(() => React).apply({ slots: { inject(_seat, callback) { callback(); }, register() {} } });
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes)
    : [tree, ...nodes(tree.props?.children)];
  const text = tree => nodes(tree).flatMap(node => node.props?.children || []).filter(value => typeof value === 'string').join(' ');
  const render = () => {
    cursor = 0; const tree = window.Health(); const pending = effects.splice(0); first = false;
    for (const effect of pending) effect(); return tree;
  };
  const button = label => { const node = nodes(render()).find(n => n.type === 'button' && n.props.children.includes(label)); assert(node, label); return node; };
  const select = cap => { const node = nodes(render()).find(n => n.props?.['data-health-capability'] === cap); assert(node); node.props.onClick(); };
  const probes = () => requests.filter(r => r.url.endsWith('/providers_test_model'));
  return { controls, window, render, nodes, text, button, select, probes, requests, timers, openedTasks, taskSection,
    async mount() { render(); await tick(); },
    async start(cap = 'image-gen') { select(cap); button('实测此模型').props.onClick(); button('确认并实测').props.onClick(); await tick(); }
  };
}

const ui = fixture(); await ui.mount();
const content = target => target.nodes(target.render()).find(n => n.props?.id === 'iris-health-content');
assert.equal(content(ui).props.hidden, true, 'capability inspection is collapsed on first visit');
assert(ui.text(ui.render()).includes('6 项能力'));
ui.button('展开检测').props.onClick();
assert.equal(content(ui).props.hidden, false);
assert.equal(ui.probes().length, 0);
const compactSection = ui.window.WorkbenchSection({ name: 'settings', title: '设置', collapsible: true, children: 'kept content' });
assert.equal(compactSection.type, 'details'); assert.equal(compactSection.props.open, undefined);
assert(ui.text(compactSection).includes('kept content'), 'folding keeps the underlying component mounted');
assert.equal(ui.window.WorkbenchSection({ title: '运行中任务' }).type, 'section', 'active task sections stay visible');
assert.equal(ui.nodes(ui.render()).filter(n => n.props?.['data-health-capability']).length, 6);
assert(ui.text(ui.render()).includes('音乐'));
assert.equal(ui.probes().length, 0, 'mounting or checking configuration must not probe');
ui.button('检查配置').props.onClick(); await tick();
assert.equal(ui.probes().length, 0);
ui.select('image-gen'); ui.button('实测此模型').props.onClick();
assert(ui.text(ui.render()).includes('可能产生费用'));
assert.equal(ui.probes().length, 0);
ui.button('取消').props.onClick(); assert.equal(ui.probes().length, 0);
ui.button('实测此模型').props.onClick(); ui.button('收起检测').props.onClick();
assert.equal(content(ui).props.hidden, true);
ui.button('展开检测').props.onClick();
assert(!ui.text(ui.render()).includes('确认向此模型发起一次真实请求'), 'collapsing must dismiss an unsubmitted confirmation');
assert.equal(ui.probes().length, 0);

const live = fixture(); await live.mount();
const readsBefore = live.requests.length;
const update = clone(live.controls.data);
update.health.generatedAt = new Date(Date.now() + 1000).toISOString();
update.health.capabilities['image-gen'] = { status: 'verified', candidateCount: 1, candidates: [{ providerId: 'p', modelId: 'model-0', status: 'verified' }] };
live.controls.eventSource.onmessage({ data: JSON.stringify(update) });
assert(live.text(live.render()).includes('1 个可用 · 1/1 近期成功'), 'live task evidence must update coverage together with the status color');
assert.equal(live.requests.length, readsBefore, 'SSE health evidence must not add polling or probes');

// Slow model response: one explicit target, one request even on a same-tick double click.
let finish;
ui.controls.probe = () => new Promise(resolve => { finish = resolve; });
ui.button('实测此模型').props.onClick();
const confirm = ui.button('确认并实测'); confirm.props.onClick(); confirm.props.onClick();
await tick();
assert.equal(ui.probes().length, 1);
assert.deepEqual(ui.probes()[0].body, { id: 'p', model_id: 'model-0', capability: 'image-gen', confirm_paid: true });
assert(ui.text(ui.render()).includes('正在实测'));
assert.equal(ui.button('检查配置').props.disabled, true);
ui.button('收起检测').props.onClick();
assert.equal(content(ui).props.hidden, true);
assert(ui.text(ui.render()).includes('正在检测，请等待本次结果'));
finish(response({ ok: true, passed: true, text: '[iris] 模型实测通过：生成返回图片' })); await tick();
assert.equal(content(ui).props.hidden, true, 'receiving a result must not force the panel open');
ui.button('展开检测').props.onClick();
assert(ui.text(ui.render()).includes('实测通过 · 生成返回图片'));
assert.equal(ui.probes().length, 1);
assert.equal(ui.timers.size, 0);

// A normal HTTP 200 can still report a failed capability test.
const failed = fixture(); await failed.mount();
failed.controls.reply = { ok: true, passed: false, text: '[iris] 模型实测未通过：接口拒绝请求' };
await failed.start();
assert(failed.text(failed.render()).includes('实测未通过 · 接口拒绝请求'));
assert(!failed.text(failed.render()).includes('实测通过 ·'));

// Real-task-only functions open their actual form; no empty probe or generation is sent.
for (const [cap, action] of [['video-gen', 'video'], ['transcribe', 'transcribe'], ['music-gen', 'music']]) {
  const task = fixture(); await task.mount(); task.select(cap); task.button('前往功能验证 ↗').props.onClick();
  assert.equal(task.probes().length, 0);
  assert.equal(task.openedTasks.length, 1);
  assert.equal(task.taskSection.open, true, 'the destination section must be revealed before opening the form');
  assert(task.openedTasks[0].includes('"' + action + '"'));
}
for (const cap of ['tts', 'vision']) {
  const other = fixture(); await other.mount(); await other.start(cap);
  assert.equal(other.probes().length, 1); assert.equal(other.probes()[0].body.capability, cap);
}
const hostVision = fixture();
hostVision.controls.data.order.vision = ['host:current-vision'];
hostVision.controls.data.poolByCapability.vision = [{ ref: 'host:current-vision', id: 'DSH 当前默认模型', providerId: 'host' }];
await hostVision.mount(); hostVision.select('vision'); hostVision.button('前往功能验证 ↗').props.onClick();
assert.equal(hostVision.probes().length, 0); assert(hostVision.openedTasks[0].includes('"ocr"'));

// Mode changes or a lost preflight must not turn stale UI into an out-of-scope request.
for (const change of [test => { test.controls.data.policies['image-gen'].mode = 'disabled'; },
  test => { test.controls.data.order['image-gen'] = []; },
  test => { test.controls.data.poolByCapability['image-gen'] = []; test.controls.data.providers = []; },
  test => { test.controls.failRead = true; }]) {
  const stale = fixture(); await stale.mount(); stale.select('image-gen'); stale.button('实测此模型').props.onClick();
  change(stale); stale.button('确认并实测').props.onClick(); await tick();
  assert.equal(stale.probes().length, 0);
  assert(stale.text(stale.render()).includes('未发起实测'));
}
const legacy = fixture(); delete legacy.controls.data.policies; delete legacy.controls.data.readiness;
await legacy.mount(); legacy.select('image-gen');
assert(legacy.text(legacy.render()).includes('暂停模型实测'));
assert.equal(legacy.button('实测此模型').props.disabled, true); assert.equal(legacy.probes().length, 0);

for (const reason of ['pending', 'protocol', 'connection']) {
  const blocked = fixture();
  const option = blocked.controls.data.poolByCapability['image-gen'][0];
  if (reason === 'pending') option.pendingConfirmation = true;
  if (reason === 'protocol') option.protocolSupported = false;
  if (reason === 'connection') { option.unavailable = true; option.reason = '连接尚未就绪'; }
  await blocked.mount(); blocked.select('image-gen'); assert.equal(blocked.button('实测此模型').props.disabled, true);
  assert.equal(blocked.probes().length, 0);
}
const realtimeTts = fixture();
const realtimeOption = realtimeTts.controls.data.poolByCapability.tts[0];
realtimeOption.protocolSupported = false;
realtimeOption.reason = '该实时语音模型需要 WebSocket，Iris 尚未接入该调用方式';
await realtimeTts.mount(); realtimeTts.select('tts');
assert(realtimeTts.text(realtimeTts.render()).includes(realtimeOption.reason), '显示供应商给出的具体协议限制');
assert.equal(realtimeTts.button('实测此模型').props.disabled, true);
assert.equal(realtimeTts.probes().length, 0);
const customVoiceTts = fixture(); await customVoiceTts.mount();
customVoiceTts.controls.reply = { ok: true, skipped: true, passed: false,
  text: '[iris] model-2 · tts 已跳过：请在语音功能填写与该模型匹配的音色 ID 后验证' };
await customVoiceTts.start('tts');
assert(customVoiceTts.text(customVoiceTts.render()).includes('未发起实测 · 请在语音功能填写'));
assert(!customVoiceTts.text(customVoiceTts.render()).includes('实测未通过 ·'), '本地跳过不显示为供应商调用失败');
const outside = fixture(); await outside.mount();
outside.window.dispatchEvent({ type: 'iris-capability-inspect', detail: { capability: 'image-gen', providerId: 'p', modelId: 'outside' } });
await tick();
assert.equal(content(outside).props.hidden, false, 'model badge navigation opens collapsed inspection');
const outsideRow = outside.nodes(outside.render()).find(n => n.props?.['data-health-model'] === 'p::outside');
assert(outside.text(outsideRow).includes('未纳入当前功能池'));
assert.equal(outside.nodes(outsideRow).find(n => n.type === 'button').props.disabled, true);

// Recovery probes are explicit and single-target even for a quota-blocked candidate.
const recovery = fixture();
recovery.controls.data.providers[0].models[0].health['image-gen'] = { status: 'failed', rateLimited: true, reason: 'budget' };
recovery.controls.data.poolByCapability['image-gen'][0].unavailable = true;
await recovery.mount(); recovery.select('image-gen');
assert.equal(recovery.button('实测此模型').props.disabled, false);
assert(recovery.text(recovery.render()).includes('解除此模型的冷却或额度停用'));
await recovery.start(); assert.equal(recovery.probes().length, 1);
const missingModel = fixture();
missingModel.controls.data.providers[0].models[0].health['image-gen'] = { status: 'failed', modelUnavailable: true };
missingModel.controls.data.poolByCapability['image-gen'][0].unavailable = true;
missingModel.controls.data.poolByCapability['image-gen'][0].modelUnavailable = true;
await missingModel.mount(); missingModel.select('image-gen');
assert.equal(missingModel.button('实测此模型').props.disabled, false, '明确模型不存在仍允许用户确认单项恢复实测');
assert(missingModel.text(missingModel.render()).includes('同步目录不会代替实测'));
await missingModel.start(); assert.equal(missingModel.probes().length, 1);
const disconnected = fixture();
disconnected.controls.data.providers[0].dshProvider = { provider: 'fixture', settingsNs: 'fixture' };
disconnected.controls.data.providers[0].connection = { available: false };
disconnected.controls.data.providers[0].models[0].health['image-gen'] = { status: 'failed', rateLimited: true };
await disconnected.mount(); disconnected.select('image-gen');
assert.equal(disconnected.button('实测此模型').props.disabled, true, 'a recovery probe must not bypass a missing DSH connection');

// A timed-out request may have been accepted: preserve uncertainty and never retry.
const unknown = fixture(); await unknown.mount();
unknown.controls.probe = (_body, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
await unknown.start();
for (const timer of [...unknown.timers.values()]) if (timer.delay === 90000) timer.callback();
await tick();
assert(unknown.text(unknown.render()).includes('结果未确认'));
assert.equal(unknown.probes().length, 1);
assert.equal(unknown.button('实测此模型').props.disabled, true);
unknown.button('检查配置').props.onClick(); await tick(); assert.equal(unknown.probes().length, 1);

console.log('PASS 能力检测：六项状态、只读配置检查、确认/取消、慢响应防重复、单模型绑定、真实任务入口、范围变化、旧服务端、额度恢复与未知结果零重试');
