import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(
  'var clientSlots = clientSlotsPort(ctx);', 'window.Directory = ProviderDirectory; var clientSlots = clientSlotsPort(ctx);');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let entry, cursor = 0, refreshed = 0;
  const hooks = [], requests = [], timers = new Map();
  const provider = { id: 'fixture', enabled: true, directory: { status: 'current', checkedAt: '2026-10-18T12:00:00Z',
    modelCount: 2, added: ['new'], missing: ['old'] } };
  const control = { respond: async () => ({ ok: true, json: async () => ({ ok: true, synced: true, text: '目录已同步，新模型待确认' }) }) };
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(value) { const i = cursor++; if (!(i in hooks)) hooks[i] = value; return [hooks[i], next => { hooks[i] = next; }]; },
    useRef(value) { const i = cursor++; return hooks[i] ||= { current: value }; }
  };
  const window = { __ModuleLoader__: { load(value) { entry = value; } } };
  vm.runInNewContext(source, { window, document: { getElementById() { return {}; } }, AbortController, console: { log() {}, error: console.error },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { requests.push({ url, body: JSON.parse(options.body) }); return control.respond(url, options); } });
  entry.factory(() => React).apply({ slots: { inject(_seat, callback) { callback(); }, register() {} } });
  const render = () => { cursor = 0; return window.Directory({ provider, onDone() { refreshed++; } }); };
  const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes)
    : [value, ...nodes(value.props.children)];
  const text = () => nodes(render()).flatMap(node => node.props.children).filter(value => typeof value === 'string').join(' ');
  const button = () => nodes(render()).find(node => node.type === 'button');
  return { provider, control, requests, timers, render, text, button, refreshed: () => refreshed };
}
const ui = fixture();
assert.equal(ui.render().type, 'details');
assert.equal(ui.render().props.open, undefined, '目录详情默认折叠');
assert(ui.text().includes('目录未列出 1 项'));
assert.equal(ui.requests.length, 0, '展示同步状态不访问供应商');
let finish;
ui.control.respond = () => new Promise(resolve => { finish = resolve; });
const button = ui.button(); button.props.onClick(); button.props.onClick();
assert.equal(ui.requests.length, 1, '慢响应/双击只提交一次同步');
assert.equal(ui.button().props.disabled, true);
assert(ui.text().includes('正在同步'));
assert.deepEqual(ui.requests[0], { url: '/iris/api/actions/providers_sync_directory', body: { id: 'fixture', force: true } });
finish({ ok: true, json: async () => ({ ok: true, synced: true, text: '目录已同步，新模型待确认' }) }); await tick();
assert(ui.text().includes('目录已同步，新模型待确认'));
assert.equal(ui.refreshed(), 1); assert.equal(ui.button().props.disabled, false);
assert.equal(ui.timers.size, 0);
const failed = fixture();
failed.control.respond = async () => ({ ok: true, json: async () => ({ ok: true, synced: false, text: '同步失败，已保留上次完整目录' }) });
failed.button().props.onClick(); await tick();
assert(failed.text().includes('同步失败，已保留上次完整目录'));
assert.equal(failed.button().props.disabled, false, '目录读取失败可手动重试');
const legacy = fixture(); delete legacy.provider.directory;
assert.equal(legacy.button().props.disabled, true);
assert(legacy.text().includes('加载新版 Iris'));
legacy.button().props.onClick(); assert.equal(legacy.requests.length, 0);
const unknown = fixture();
unknown.control.respond = async () => ({ ok: true, json: async () => ({ ok: true }) });
unknown.button().props.onClick(); await tick();
assert(unknown.text().includes('同步结果未确认'));
assert.equal(unknown.refreshed(), 0, '旧形状不能被宣告为同步成功');
console.log('PASS 目录UI：默认折叠、零生成、单次同步、慢响应反馈、失败保留与旧服务端保护');
