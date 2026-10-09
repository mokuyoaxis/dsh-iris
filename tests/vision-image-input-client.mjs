/** 实际组件事件，不代替浏览器目视验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
let entry, hookIndex = 0, hooks = [], refreshes = 0, failed = false;
const requests = [], notes = [];
const window = { __ModuleLoader__: { load(value) { entry = value; } } };
const React = { createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
  useState(initial) { const index = hookIndex++; if (hooks[index] === undefined) hooks[index] = initial; return [hooks[index], value => { hooks[index] = value; }]; },
  useEffect() {} };
vm.runInNewContext(source.replace(anchor, 'window.VisionInputEditor = VisionInputEditor;\n    ' + anchor), {
  window, document: { getElementById() { return {}; } }, console: { log() {} },
  fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: !failed, json: async () => ({ error: '保存失败' }) }; }
});
entry.factory(() => React).apply({ slots: { inject(_name, callback) { return callback(); }, register() { return () => {}; } } });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
let props = { provider: { id: 'a' }, model: { id: 'same' }, onNote: value => notes.push(value), onDone: () => { refreshes++; } };
const render = () => { hookIndex = 0; return nodes(window.VisionInputEditor(props)); };
const button = (tree, text) => tree.find(node => node.type === 'button' && node.props.children.includes(text));
let tree = render();
tree.find(node => node.props['aria-label'] === '视觉大小上限 MiB').props.onChange({ target: { value: '12' } });
tree.find(node => node.props['aria-label'] === '视觉最长边像素').props.onChange({ target: { value: '2048' } });
button(render(), '保存预算').props.onClick(); await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(requests[0], { url: '/iris/api/actions/providers_set_model_vision_input',
  body: { id: 'a', model_id: 'same', visionInput: { maxBytes: 12582912, maxDimension: 2048 } } });
assert.equal(refreshes, 1);
button(render(), '恢复继承').props.onClick(); await new Promise(resolve => setImmediate(resolve));
assert.equal(requests[1].body.visionInput, null);
hooks = []; props = { ...props, model: undefined, provider: { id: 'b', visionInput: { maxBytes: 8388608 } } };
button(render(), '保存预算').props.onClick(); await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(requests[2], { url: '/iris/api/actions/providers_upsert', body: { id: 'b', visionInput: { maxBytes: 8388608 } } });
tree = render(); tree.find(node => node.props['aria-label'] === '视觉大小上限 MiB').props.onChange({ target: { value: '-1' } });
button(render(), '保存预算').props.onClick(); assert.equal(requests.length, 3, '非法预算不提交');
failed = true; button(render(), '恢复继承').props.onClick(); await new Promise(resolve => setImmediate(resolve));
assert.equal(notes.at(-1), '保存失败'); assert.equal(refreshes, 3);
console.log('PASS 看图预算组件：账号/模型准确绑定、MiB 换算、恢复继承、成功刷新、非法输入零请求与失败反馈');
