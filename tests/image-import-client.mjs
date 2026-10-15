/** 组件事件验收；不替代实际浏览器目视检查。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
let entry, cursor = 0, values = [];
const requests = [], events = [];
const window = { __ModuleLoader__: { load(value) { entry = value; } }, dispatchEvent(event) { events.push(event.type); } };
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
  useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = value; }]; },
  useEffect() {}
};
let success = true;
vm.runInNewContext(source.replace(anchor, 'window.ImportComponents = { ActionCard, FileField, CARD_DEFS };\n    ' + anchor), {
  window, document: { getElementById() { return {}; } }, console: { log() {} },
  CustomEvent: class { constructor(type) { this.type = type; } },
  fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: success, json: async () => success ? { storage: 'core', text: '图片已导入', imageUrl: '/iris/api/core/artifact/fixture/media' } : { error: '仅支持静态图片' } };
  }
});
entry.factory(() => React).apply({ slots: { inject(_name, cb) { return cb(); }, register() { return () => {}; } } });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const { ActionCard, FileField, CARD_DEFS } = window.ImportComponents;
const definition = CARD_DEFS.find(card => card.action === 'image_import');
assert(definition && !definition.capability, '图片导入是本地功能，无模型分配');
values = [true, {}];
const render = () => { cursor = 0; return nodes(ActionCard(definition)); };
assert.equal(requests.length, 0);
render().find(node => node.type === FileField).props.onChange('/fixture/upload.png');
render().find(node => node.type === 'button' && node.props.className === 'iris-act-run').props.onClick();
await new Promise(setImmediate);
assert.deepEqual(requests, [{ url: '/iris/api/actions/image_import', body: { image_path: '/fixture/upload.png' } }]);
assert(render().some(node => node.type === 'img' && node.props.src === '/iris/api/core/artifact/fixture/media'));
assert.deepEqual(events, ['iris-core-artifacts-changed']);
success = false;
render().find(node => node.type === 'button' && node.props.className === 'iris-act-run').props.onClick();
await new Promise(setImmediate);
assert(JSON.stringify(render()).includes('仅支持静态图片'));
assert.equal(events.length, 1, '失败不通知作品区增加作品');
console.log('PASS 导入组件：本地入口、文件选择请求、持久图片预览、刷新事件及明确失败');
