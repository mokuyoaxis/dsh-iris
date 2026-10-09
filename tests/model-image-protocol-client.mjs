/** 实际组件事件与请求，不替代浏览器目视验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
let entry, failed = false, refreshes = 0;
const requests = [], notes = [];
const window = { __ModuleLoader__: { load(value) { entry = value; } } };
const React = { createElement(type, props, ...children) { return { type, props: { ...props, children } }; }, useState(initial) { return [initial, () => {}]; } };
vm.runInNewContext(source.replace(anchor, 'window.ModelPool = ModelPool;\n    ' + anchor), {
  window, document: { getElementById() { return {}; } }, console: { log() {} },
  fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: !failed, json: async () => ({ error: '保存失败' }) }; }
});
entry.factory(() => React).apply({ slots: { inject(_name, callback) { return callback(); }, register() { return () => {}; } } });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const provider = { id: 'account', mediaProtocol: 'dashscope', models: [
  { id: 'inherit-image', capabilities: ['image-gen'], imageRouting: { mediaProtocol: 'dashscope', protocolInferred: false } },
  { id: 'override-image', capabilities: ['image-gen', 'vision'], imageProtocol: 'openai-images' },
  { id: 'vision-only', capabilities: ['vision'] }
] };
const tree = nodes(window.ModelPool({ provider, onNote: value => notes.push(value), onDone: () => { refreshes++; }, testModel() {}, removeModel() {}, addModel() {} }));
const selectors = tree.filter(node => node.type === 'select');
assert.equal(selectors.length, 2, '图片协议只显示在有生图能力的模型行');
assert.equal(selectors[0].props.value, 'auto'); assert.equal(selectors[1].props.value, 'openai-images');
assert(tree.some(node => node.type === 'option' && node.props.value === 'openai-chat-images'));
assert(tree.some(node => node.type === 'option' && node.props.value === 'openai-responses-images'));
assert(tree.some(node => node.type === 'option' && node.props.children.includes('继承账号默认（dashscope）')));
selectors[0].props.onChange({ target: { value: 'openai-chat-images' } });
await new Promise(setImmediate);
assert.deepEqual(requests[0], { url: '/iris/api/actions/providers_set_model_image_protocol',
  body: { id: 'account', model_id: 'inherit-image', imageProtocol: 'openai-chat-images' } });
assert.equal(refreshes, 1); assert.equal(notes[0], '模型图片协议已更新');
selectors[1].props.onChange({ target: { value: 'auto' } });
await new Promise(setImmediate);
assert.equal(requests[1].body.model_id, 'override-image'); assert.equal(requests[1].body.imageProtocol, 'auto');
failed = true; selectors[1].props.onChange({ target: { value: 'dashscope' } });
await new Promise(setImmediate);
assert.equal(refreshes, 2, '保存失败不刷新为成功状态'); assert.equal(notes.at(-1), '保存失败');
failed = false; selectors[0].props.onChange({ target: { value: 'openai-responses-images' } });
await new Promise(setImmediate);
assert.equal(refreshes, 3);
assert.deepEqual(requests.at(-1).body, { id: 'account', model_id: 'inherit-image', imageProtocol: 'openai-responses-images' });
assert(requests.every(request => request.url.endsWith('/providers_set_model_image_protocol')), '修改协议不触发模型实测或生成');
console.log('PASS 模型图片协议组件：仅生图模型、继承/覆盖、目标账号与模型、恢复默认、成功刷新、失败反馈、零实测');
