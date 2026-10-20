/** Execute actual diagnostic React components with controlled requests; no browser rendering claimed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
const exposed = source.replace(anchor, 'window.__browserCheck = BrowserCheckPanel; window.__hostDoctor = HostDoctorPanel; ' + anchor);
const tick = () => new Promise(resolve => setImmediate(resolve));
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = tree => nodes(tree).flatMap(node => node.props?.children || []).filter(value => typeof value === 'string').join(' ');
const artifact = 'artifact_' + 'a'.repeat(24);
function fixture(available = true) {
  const instances = new Map(), requests = [], timers = new Map(), changes = [], pending = [];
  let entry, cursor, current, timerId = 0, hold = false, body = { ok: true, storage: 'core', artifactIds: [artifact] }, ok = true;
  const effects = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const index = cursor++, hooks = current.hooks;
      if (!hooks[index]) hooks[index] = { value: initial };
      return [hooks[index].value, value => { hooks[index].value = value; }];
    },
    useRef(initial) { const index = cursor++; if (!current.hooks[index]) current.hooks[index] = { current: initial }; return current.hooks[index]; },
    useEffect(run, deps) {
      const index = cursor++, instance = current, hook = instance.hooks[index];
      if (!hook || deps.some((value, i) => value !== hook.deps[i])) {
        instance.hooks[index] = { deps, cleanup: hook?.cleanup };
        effects.push(() => { hook?.cleanup?.(); instance.hooks[index].cleanup = run(); });
      }
    }
  };
  const response = (value, success = true) => ({ ok: success, json: async () => value });
  const fetch = async (url, options = {}) => {
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    if (url === '/iris/api/doctor') return response({ host: { version: 'fixture' }, summary: { errors: 0, warnings: 0 },
      capabilities: { browser: { status: available ? 'available' : 'unavailable' } }, checks: [] });
    assert.equal(url, '/iris/api/actions/html', '自检只能调用固定 HTML action');
    if (hold) return new Promise(resolve => pending.push(value => resolve(value || response(body, ok))));
    return response(body, ok);
  };
  const window = { __ModuleLoader__: { load(value) { entry = value; } }, dispatchEvent(event) { changes.push(event.type); } };
  vm.runInNewContext(exposed, { window, document: { getElementById() { return {}; } }, fetch, AbortController,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    CustomEvent: class { constructor(type) { this.type = type; } }, console: { log() {} } });
  entry.factory(() => React).apply({ slots: { inject(_name, callback) { callback(); }, register() {} } });
  function render(id, Component, props) {
    if (!instances.has(id)) instances.set(id, { hooks: [] });
    current = instances.get(id); cursor = 0;
    const tree = Component(props);
    for (const effect of effects.splice(0)) effect();
    return tree;
  }
  const panel = () => render('check', window.__browserCheck, { available });
  const doctor = () => render('doctor', window.__hostDoctor, {});
  const button = label => nodes(panel()).find(node => node.type === 'button' && node.props.children.includes(label));
  const unmount = () => { for (const instance of instances.values()) for (const hook of instance.hooks) hook.cleanup?.(); instances.clear(); };
  return { panel, doctor, button, requests, timers, changes, pending, unmount,
    hold(value) { hold = value; }, result(value, success = true) { body = value; ok = success; } };
}

const ui = fixture(); ui.doctor(); ui.panel(); await tick();
assert.deepEqual(ui.requests.map(row => row.url), ['/iris/api/doctor'], '打开诊断只读装载证据，不自动截图');
assert(text(ui.panel()).includes('尚未实测'));
const refresh = nodes(ui.doctor()).find(node => node.type === 'button' && node.props.children.includes('刷新'));
refresh.props.onClick(); await tick();
assert(ui.requests.every(row => !row.options.method), '刷新不能发起 POST');

ui.hold(true);
const start = ui.button('截图自检'); start.props.onClick(); start.props.onClick();
assert.equal(ui.requests.filter(row => row.options.method === 'POST').length, 1, '同一时刻重复点击只创建一个请求');
assert(ui.button('检测中…').props.disabled);
assert.equal([...ui.timers.values()][0].ms, 60000);
const sent = ui.requests.at(-1);
assert.equal(sent.body.fullPage, false);
assert.match(sent.body.html, /中文/);
assert(!/<script|https?:\/\//.test(sent.body.html), '固定样例不含脚本或外部资源');
assert.equal(sent.options.credentials, 'same-origin');
ui.pending.shift()(); await tick();
assert(text(ui.panel()).includes('本次截图已保存'));
assert.equal(ui.timers.size, 0);
assert.deepEqual(ui.changes, ['iris-core-artifacts-changed']);
const preview = nodes(ui.panel()).find(node => node.type === 'details');
assert(!preview.props.open, '测试截图默认折叠');
assert.equal(nodes(preview).find(node => node.type === 'img').props.src, '/iris/api/core/artifact/' + artifact + '/media');

ui.button('截图自检').props.onClick();
const canceled = ui.requests.at(-1); ui.button('取消').props.onClick();
assert(canceled.options.signal.aborted);
assert(text(ui.panel()).includes('已取消本次自检等待'));
ui.button('截图自检').props.onClick();
const currentPending = ui.pending.pop(), latePending = ui.pending.shift();
latePending(); await tick();
assert(text(ui.panel()).includes('正在打开浏览器'), '上次迟到结果不得覆盖当前检测');
assert.equal(ui.changes.length, 1);
ui.result({ error: 'ERR_CONNECTION_REFUSED', code: 'BROWSER_NAVIGATION_FAILED' }, false);
currentPending(); await tick();
assert(text(ui.panel()).includes('未能打开渲染页面'));
assert(text(ui.panel()).includes('ERR_CONNECTION_REFUSED'));
assert.equal(ui.changes.length, 1);

ui.button('截图自检').props.onClick();
const timed = ui.requests.at(-1); [...ui.timers.values()][0].fn();
assert(timed.options.signal.aborted);
assert(text(ui.panel()).includes('超过 60 秒'));
ui.pending.shift()(); await tick();
assert(!text(ui.panel()).includes('本次截图已保存'));

ui.hold(false);
ui.result({ ok: true, artifactIds: [artifact] });
ui.button('截图自检').props.onClick(); await tick();
assert(text(ui.panel()).includes('服务端未返回有效截图作品'));
ui.result({ error: 'invalid explicit URL', code: 'IRIS_RENDER_ADDRESS_INVALID' }, false);
ui.button('截图自检').props.onClick(); await tick();
assert(text(ui.panel()).includes('截图地址配置有误'));
ui.hold(true); ui.button('截图自检').props.onClick();
const unfinished = ui.requests.at(-1);
ui.unmount();
assert(unfinished.options.signal.aborted);
assert.equal(ui.timers.size, 0);
ui.pending.shift()(); await tick();
assert.equal(ui.changes.length, 1);

const unavailable = fixture(false); unavailable.panel();
assert(unavailable.button('截图自检').props.disabled);
unavailable.button('截图自检').props.onClick();
assert.equal(unavailable.requests.length, 0);
unavailable.unmount();
console.log('ALL OK —— 诊断零自动截图、自检单次提交、固定本地样例、作品预览、取消/超时/迟到结果/错误反馈与卸载清理');
