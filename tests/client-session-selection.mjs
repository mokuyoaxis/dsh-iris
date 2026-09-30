/** 实际客户端 FileField 的附件请求，覆盖旧列表和 rc.2 主视图持有者。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
assert.equal(source.split(anchor).length, 2);
// 只在测试沙箱暴露现有组件，执行真实点击路径；生产 bundle 不增加导出。
const testSource = source.replace(anchor, 'window.__fileFieldForTest = FileField;\n    ' + anchor);
function fixture(initial, getService = true) {
  let entry;
  let snapshot = initial;
  const listeners = new Set();
  const disposers = [];
  const requests = [];
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initialValue) { return [initialValue, () => {}]; },
    useRef(initialValue) { return { current: initialValue }; }
  };
  const fetch = async (url, options) => { requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, attachments: [] }) }; };
  const window = { fetch, __ModuleLoader__: { load(value) { entry = value; } } };
  vm.runInNewContext(testSource, { window, fetch, console: { log() {}, error() {} },
    document: { getElementById() { return {}; } } });
  const module = entry.factory(name => { assert.equal(name, 'react'); return react; });
  const sessions = { list: {
    getSnapshot: () => snapshot,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); }
  } };
  const ctx = { effect(run) { disposers.push(run()); }, slots: {
    inject(_name, callback) { return callback(); }, register() { return () => {}; }
  } };
  if (getService) {
    ctx.get = name => name === 'sessions' ? sessions : undefined;
    Object.defineProperty(ctx, 'sessions', { get() { throw new Error('undeclared service access'); } });
  } else ctx.sessions = sessions;
  module.apply(ctx);
  function clickAttachments() {
    const tree = window.__fileFieldForTest({ onChange() {} });
    const button = tree.props.children[0].props.children.find(node => node.props?.children?.[0] === '📎 会话附件');
    assert(button);
    button.props.onClick();
    return requests.filter(item => item.url.endsWith('/attachments_list')).at(-1).body.session_id;
  }
  return { clickAttachments, listeners,
    update(value) { snapshot = value; for (const listener of listeners) listener(); },
    dispose() { for (const disposer of disposers.reverse()) disposer(); }
  };
}
const current = fixture({ ids: ['other', 'main'], byId: {
  other: { id: 'other', retainedBy: { subagent: 1 } }, main: { id: 'main', retainedBy: { mainView: 1 } }
} });
assert.equal(current.clickAttachments(), 'main', '不使用列表首项或子代理会话');
current.update({ byId: { next: { id: 'next', retainedBy: { mainView: 1 } } } });
assert.equal(current.clickAttachments(), 'next', '无参数变更通知必须回读快照');
current.update({ byId: { other: { id: 'other', retainedBy: {} } } });
assert.equal(current.clickAttachments(), '', '无主视图时不猜测会话');
current.update({ byId: { a: { id: 'a', retainedBy: { mainView: 1 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } });
assert.equal(current.clickAttachments(), '', '有歧义时不选择其他会话');
assert.equal(current.listeners.size, 1);
current.dispose();
assert.equal(current.listeners.size, 0, '插件卸载释放订阅');
const legacy = fixture({ current: 'old' }, false);
assert.equal(legacy.clickAttachments(), 'old');
legacy.update({ current: 'old-next' });
assert.equal(legacy.clickAttachments(), 'old-next');
legacy.update({ current: null, byId: { main: { id: 'main', retainedBy: { mainView: 1 } } } });
assert.equal(legacy.clickAttachments(), '', '旧接口显式无选择保持无选择');
legacy.dispose();
console.log('ALL OK —— FileField 支持旧 current 与 rc.2 mainView、回读快照、无选择/歧义和订阅清理');
