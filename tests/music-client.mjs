/** Component events and payloads; browser visual/audio validation remains separate. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
let entry, cursor = 0, values = [], effects = [];
const requests = [], events = [], notes = [];
const window = { __ModuleLoader__: { load(value) { entry = value; } }, dispatchEvent(event) { events.push(event.type); } };
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
  useState(initial) {
    const index = cursor++;
    if (!(index in values)) values[index] = initial;
    return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
  },
  useEffect(callback) { effects.push(callback); }
};
const assigned = 'gateway::gemini-music';
vm.runInNewContext(source.replace(anchor, 'window.MusicComponents = { ModelPool, ActionCard, CARD_DEFS };\n    ' + anchor), {
  window, document: { getElementById() { return {}; } }, console: { log() {} },
  CustomEvent: class { constructor(type) { this.type = type; } },
  fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return { ok: true, json: async () => url.endsWith('assignments_get') ? {
      poolByCapability: { 'music-gen': [{ ref: assigned, label: 'Assigned Music' }, { ref: 'gateway::unassigned', label: 'Unassigned Music' }] },
      order: { 'music-gen': [assigned] }
    } : url.endsWith('/music') ? { storage: 'core', audioUrl: '/iris/api/core/artifact/fixture/media', text: 'fixture music ready' } : {} };
  }
});
entry.factory(() => React).apply({ slots: { inject(_name, callback) { return callback(); }, register() { return () => {}; } } });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
let refreshed = 0;
const pool = nodes(window.MusicComponents.ModelPool({ provider: { id: 'gateway', mediaProtocol: 'openai-responses-images', models: [
  { id: 'gemini-image', capabilities: ['image-gen'] }, { id: 'gemini-music', capabilities: ['music-gen'] }
] }, onNote: value => notes.push(value), onDone: () => { refreshed++; }, testModel() {}, removeModel() {}, addModel() {} }));
const protocol = pool.find(node => node.type === 'select' && nodes(node).some(item => item.type === 'option' && item.props.value === 'gemini-web-music'));
assert(protocol);
protocol.props.onChange({ target: { value: 'gemini-web-music' } });
await new Promise(setImmediate);
assert.deepEqual(requests[0], { url: '/iris/api/actions/providers_set_model_music_protocol',
  body: { id: 'gateway', model_id: 'gemini-music', musicProtocol: 'gemini-web-music' } });
assert.equal(refreshed, 1);
assert.equal(notes[0], '模型音乐协议已更新');

values = [true, { prompt: 'fixture music' }];
const definition = window.MusicComponents.CARD_DEFS.find(card => card.action === 'music');
assert.equal(definition.capability, 'music-gen');
function render() { cursor = 0; effects = []; return nodes(window.MusicComponents.ActionCard(definition)); }
render();
effects.find(callback => callback.toString().includes('loadModels'))();
await new Promise(setImmediate);
let tree = render();
const chooser = tree.find(node => node.type === 'select');
const options = nodes(chooser).filter(node => node.type === 'option');
assert.deepEqual(options.map(node => node.props.value), ['', assigned], 'Music选择器只展示功能分配名单');
tree.find(node => node.type === 'input' && node.props.placeholder === '2（0关闭，最多5）').props.onChange({ target: { value: '0' } });
tree = render();
tree.find(node => node.type === 'button' && node.props.className === 'iris-act-run').props.onClick();
await new Promise(setImmediate);
assert.deepEqual(requests.at(-1), { url: '/iris/api/actions/music', body: { prompt: 'fixture music', retry_502: '0' } });
tree = render();
const audio = tree.find(node => node.type === 'audio');
assert.equal(audio.props.src, '/iris/api/core/artifact/fixture/media');
assert.equal(audio.props.controls, true);
assert(tree.some(node => node.type === 'a' && node.props.href === audio.props.src && node.props.download === ''));
assert(events.includes('iris-core-artifacts-changed'));
values[3] = { assigned: '', assignedRef: '', options: [], loaded: true };
assert(JSON.stringify(render()).includes('未分配'), 'Music缺少分配时准确显示配置状态');
assert(requests.every(request => !request.url.includes('test_model')), '配置与组件加载不提交生成探针');
console.log('PASS Music工作台组件：协议绑定、明确模型名单、重试配置请求、试听/下载与作品刷新');
