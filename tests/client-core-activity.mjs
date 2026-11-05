import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = tree => !tree ? '' : typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.props?.children);
let active, entry, eventSource;
const requests = [], listeners = new Map(), components = [];
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
  useState(initial) {
    const component = active, index = component.cursor++;
    if (!(index in component.hooks)) component.hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [component.hooks[index], value => { component.updates++; component.hooks[index] = typeof value === 'function' ? value(component.hooks[index]) : value; }];
  },
  useRef(value) { const index = active.cursor++; return active.hooks[index] ||= { current: value }; },
  useEffect(effect, deps) {
    const component = active, index = component.cursor++, before = component.hooks[index];
    if (!before || deps.some((value, i) => value !== before.deps[i])) component.effects.push(() => {
      before?.cleanup?.(); component.hooks[index] = { deps, cleanup: effect() };
    });
  }
};
const fetch = (url) => url.endsWith('/host-client') ? Promise.resolve({ ok: true, json: async () => ({}) })
  : new Promise(resolve => requests.push({ url, resolve }));
const window = { __ModuleLoader__: { load(value) { entry = value; } }, innerWidth: 412, innerHeight: 915,
  addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
  removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  dispatchEvent(event) { for (const callback of [...(listeners.get(event.type) || [])]) callback(event); }
};
vm.runInNewContext(source.replace('var clientSlots = clientSlotsPort(ctx);',
  'window.activityComponents = {ProgressDock,FloatingBubble};var clientSlots = clientSlotsPort(ctx);'), {
  window, fetch, document: { getElementById() { return {}; } }, localStorage: { getItem() { return null; } },
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  EventSource: class { constructor() { eventSource = this; } close() {} },
  CustomEvent: class { constructor(type) { this.type = type; } }, console: { log() {} }
});
entry.factory(() => React).apply({ slots: { inject(_name, callback) { callback(); }, register() {} } });
function mount(name) {
  const component = { name, hooks: [], effects: [], updates: 0, cursor: 0 };
  component.render = () => {
    active = component; component.cursor = 0;
    const tree = window.activityComponents[name]({});
    for (const effect of component.effects.splice(0)) effect(); return tree;
  };
  component.unmount = () => { for (const hook of component.hooks) hook?.cleanup?.(); };
  components.push(component); component.render(); return component;
}
const refresh = () => window.dispatchEvent({ type: 'iris-core-refresh-tick' });
const coreRequests = () => requests.filter(row => row.url.includes('/core/snapshot'));
const payload = count => ({ available: true, userTasks: [], activity: { running: count, paused: count ? 1 : 0, attention: count ? 1 : 0,
  truncated: false, recent: count ? [{ id: 'core-running', capability: 'image', model: 'core-model', label: '运行中' },
    { id: 'core-paused', capability: 'video', model: 'paused-model', label: '观察已暂停，远端可能仍在运行' }] : [] } });
const reply = async (index, data) => { coreRequests()[index].resolve({ ok: true, json: async () => data }); await tick(); };
const badge = component => nodes(component.render()).find(row => row.props.className === 'iris-bubble-badge');
try {
  const dock = mount('ProgressDock'), bubble = mount('FloatingBubble');
  assert.equal(coreRequests().length, 1, 'Core-only progress must load one shared snapshot for both seats');
  await reply(0, payload(1));
  assert.match(text(dock.render()), /Core.*core-model.*运行中/); assert.match(text(dock.render()), /观察已暂停/);
  assert.equal(text(badge(bubble)), '3');
  eventSource.onmessage({ data: JSON.stringify({ stateEpoch: 'fixture', stateRevision: 1, tasks: {
    running: [{ id: 'legacy', cap: 'image', model: 'legacy-model', progress: '50%' }], attention: [{ id: 'legacy-alert' }] } }) });
  await tick();
  assert.equal(coreRequests().length, 2, 'a fresh SSE snapshot refreshes Core once, not once per seat');
  await reply(1, payload(1));
  assert.equal(text(badge(bubble)), '5'); assert.match(text(dock.render()), /legacy-model/);
  const count = coreRequests().length; refresh(); refresh();
  assert.equal(coreRequests().length, count + 2);
  await reply(count + 1, payload(0)); await reply(count, payload(7));
  assert.equal(text(badge(bubble)), '2', 'late Core responses cannot restore obsolete counts');
  assert(!text(dock.render()).includes('core-model'));
  const partialIndex = coreRequests().length; refresh();
  const partial = payload(0); partial.activity.truncated = true;
  // No legacy tasks: incomplete Core statistics must still be visible rather than imply idle.
  eventSource.onmessage({ data: JSON.stringify({ stateEpoch: 'fixture', stateRevision: 2, tasks: { running: [], attention: [] } }) });
  await tick(); await reply(partialIndex + 1, partial);
  assert.equal(text(badge(bubble)), '…'); assert.match(badge(bubble).props.title, /尚未统计/);
  dock.unmount(); const before = coreRequests().length; refresh(); assert.equal(coreRequests().length, before + 1);
  bubble.unmount(); const updates = bubble.updates; await reply(before, payload(9));
  assert.equal(bubble.updates, updates); assert.equal(listeners.get('iris-core-refresh-tick').size, 0);
  const fresh = mount('ProgressDock'); assert(!text(fresh.render()).includes('core-model'), 'last unmount clears the cached Core snapshot'); fresh.unmount();
  console.log('PASS actual DSH dock/badge: Core-only and mixed tasks, separate paused/attention facts, shared snapshots, SSE refresh, late responses and unmount');
} finally { for (const component of components) component.unmount(); }
