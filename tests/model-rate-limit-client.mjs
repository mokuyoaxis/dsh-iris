/** 实际客户端组件渲染，不替代浏览器目视验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
let entry;
const window = { __ModuleLoader__: { load(value) { entry = value; } } };
const React = { createElement(type, props, ...children) { return { type, props: { ...props, children } }; }, useState(initial) { return [initial, () => {}]; } };
vm.runInNewContext(source.replace(anchor, 'window.ModelPool = ModelPool;\n    ' + anchor), {
  window, document: { getElementById() { return {}; } }, console: { log() {} }
});
entry.factory(() => React).apply({ slots: { inject(_name, callback) { return callback(); }, register() { return () => {}; } } });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const label = node => (node.props?.children || []).filter(value => typeof value === 'string').join('');
const model = { id: 'qwen-image-3.0-pro', capabilities: ['image-gen'], health: { 'image-gen': { status: 'failed', rateLimited: true,
  httpStatus: 429, retryAt: new Date(Date.now() + 60000).toISOString(), observedAt: new Date().toISOString() } } };
const provider = { id: 'account-a', models: [model] };
const tested = [];
const render = () => window.ModelPool({ provider, testModel: (...args) => tested.push(args), removeModel() {}, addModel() {} });
let tree = nodes(render());
const badge = tree.find(node => node.type === 'button' && label(node) === 'image-gen◷');
assert(badge.props.className.includes('cooling') && !badge.props.className.includes('rate-limited'));
assert(badge.props.title.includes('冷却中') && badge.props.title.includes('恢复候选资格') && badge.props.title.includes('提前实测'));
assert(!badge.props.disabled, '停用模型的显式实测入口保持可用');
assert(tree.some(node => label(node) === '429 冷却中'));
badge.props.onClick(); assert.equal(tested.length, 1); assert.equal(tested[0][0], provider); assert.equal(tested[0][1], model);
for (const [reason, text] of [['free_quota', '额度耗尽已停用'], ['budget', '预算耗尽已停用']]) {
  model.health['image-gen'] = { status: 'failed', rateLimited: true, category: 'quota', reason };
  tree = nodes(render());
  const red = tree.find(node => node.type === 'button' && label(node) === 'image-gen×');
  assert(red.props.className.includes('rate-limited') && !red.props.className.includes('cooling'));
  assert(red.props.title.includes(text) && red.props.title.includes('实测成功后恢复'));
  assert(!red.props.disabled);
}
model.health['image-gen'] = { status: 'verified', observedAt: new Date().toISOString() };
tree = nodes(render());
assert(tree.some(node => node.type === 'button' && label(node) === 'image-gen✓' && node.props.className.includes('verified')));
assert(!tree.some(node => label(node) === '429 冷却中' || label(node).includes('耗尽已停用')), '恢复后移除冷却或停用标记');
console.log('PASS 模型池实际组件：429 琥珀冷却、额度/预算红光、恢复时间、可点击实测、成功恢复绿标');
