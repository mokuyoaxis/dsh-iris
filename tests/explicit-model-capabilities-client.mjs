/** 实际功能标签编辑组件：明确选入功能池，清空/取消/失败及零实测。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
let entry, failed = false, refreshes = 0, cursor = 0;
const state = [], requests = [], notes = [], events = [];
const window = { __ModuleLoader__: { load(value) { entry = value; } }, dispatchEvent(event) { events.push(event.type); } };
const React = {
  createElement(type, props, ...children) {
    const values = { ...props, children };
    return typeof type === 'function' ? type(values) : { type, props: values };
  },
  useState(initial) {
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  }
};
vm.runInNewContext(source.replace(anchor, 'window.ModelCapabilityEditor = ModelCapabilityEditor;\n    ' + anchor), {
  window, document: { getElementById() { return {}; } }, console: { log() {} },
  CustomEvent: class { constructor(type) { this.type = type; } },
  fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: !failed, json: async () => ({ error: '保存失败' }) };
  }
});
entry.factory(() => React).apply({ slots: { inject(_name, callback) { return callback(); }, register() { return () => {}; } } });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const props = { provider: { id: 'account' }, model: { id: 'custom', capabilities: ['vision'] },
  onNote: value => notes.push(value), onDone: () => { refreshes++; } };
const render = () => {
  cursor = 0;
  const tree = nodes(window.ModelCapabilityEditor(props));
  if (!state[0]) state.splice(1); // the nested form unmounts when the editor closes
  return tree;
};
const button = (tree, text) => tree.find(node => node.type === 'button' && node.props.children.includes(text));
const checkbox = (tree, value) => tree.find(node => node.type === 'input' && node.props.value === value);
const tick = () => new Promise(setImmediate);
button(render(), '设置功能').props.onClick();
let tree = render();
assert.equal(tree.filter(node => node.type === 'input' && node.props.value).length, 6);
assert.equal(tree.find(node => node.type === 'input' && !node.props.value).props.checked, false, 'editing does not implicitly enable automatic pools');
assert.equal(checkbox(tree, 'music-gen').props.checked, false);
assert.equal(checkbox(tree, 'vision').props.checked, true);
assert.equal(checkbox(tree, 'image-gen').props.checked, false);
checkbox(tree, 'image-gen').props.onChange({ target: { checked: true } });
tree = render();
button(tree, '保存模型用途').props.onClick();
assert(tree.filter(node => node.type === 'input' && node.props.value).every(node => !node.props.disabled));
assert(render().filter(node => node.type === 'input' && node.props.value).every(node => node.props.disabled));
await tick();
assert.deepEqual(requests[0], { url: '/iris/api/actions/providers_confirm_model',
  body: { id: 'account', model_id: 'custom', capabilities: ['vision', 'image-gen'], enableAutomatic: false } });
assert.equal(refreshes, 1);
assert.equal(notes[0], '模型用途已确认');
assert(events.includes('iris-function-configuration-changed'));

props.model.capabilities = [];
button(render(), '设置功能').props.onClick();
tree = render();
assert(tree.filter(node => node.type === 'input').every(node => !node.props.checked));
button(tree, '取消').props.onClick();
assert.equal(requests.length, 1, '取消不落盘');
button(render(), '设置功能').props.onClick();
button(render(), '保存模型用途').props.onClick();
await tick();
assert.deepEqual(requests[1].body.capabilities, [], '清空能力不触发名字兜底');
assert.equal(refreshes, 2);

failed = true;
button(render(), '设置功能').props.onClick();
checkbox(render(), 'tts').props.onChange({ target: { checked: true } });
button(render(), '保存模型用途').props.onClick();
await tick();
tree = render();
assert.equal(checkbox(tree, 'tts').props.checked, true, '失败保留用户选择');
assert.equal(refreshes, 2, '失败不假装保存并刷新');
assert.equal(notes.at(-1), '保存失败');
button(tree, '取消').props.onClick();
assert(requests.every(request => request.url.endsWith('/providers_confirm_model') && request.body.enableAutomatic === false), '标签编辑不实测、不生成、不隐式改策略');
failed = false;
button(render(), '设置功能').props.onClick();
checkbox(render(), 'music-gen').props.onChange({ target: { checked: true } });
tree = render();
tree.find(node => node.type === 'select').props.onChange({ target: { value: 'gemini-web-music' } });
button(render(), '保存模型用途').props.onClick();
await tick();
assert.deepEqual(requests.at(-1).body.capabilities, ['music-gen']);
assert.equal(requests.at(-1).body.musicProtocol, 'gemini-web-music');
assert.equal(refreshes, 3);
console.log('PASS 功能标签实际组件：六类功能、音乐标签、已有选择、明确保存、空能力、取消、失败反馈与零实测');
