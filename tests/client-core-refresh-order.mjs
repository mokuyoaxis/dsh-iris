import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// Controlled network order against the actual bundle readers; no host or provider calls.
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const specifications = [
  ['works', 'function useCoreWorks(limit)', 'function galleryKindLabel', 'useCoreWorks(6)', ''],
  ['tasks', 'function useCoreUserTasks()', '/* 五类用户状态', 'useCoreUserTasks()', ''],
  ['panel', 'function CoreRuntimePanel()', 'var taskData =', 'CoreRuntimePanel()', 'return null; }']
];
const flush = () => new Promise(resolve => setImmediate(resolve));
function mount(specification) {
  const [kind, begin, end, invoke, suffix] = specification;
  const start = source.indexOf(begin), stop = source.indexOf(end, start);
  assert(start >= 0 && stop > start, 'actual client function must be present');
  const states = [], updates = [], effects = [], cleanups = [], listeners = new Map(), requests = [];
  const context = {
    React: {
      useState(value) {
        const index = states.length; states.push(value);
        return [value, next => { states[index] = next; updates.push({ index, next }); }];
      },
      useRef(value) { return { current: value }; }, useEffect(effect) { effects.push(effect); }
    },
    EMPTY_CORE_USER: { rows: [], available: false, degraded: false, droppedTasks: 0 },
    coreGalleryItems(data) { return data.items; },
    fetch() { return new Promise(resolve => requests.push(resolve)); },
    window: { addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } }
  };
  vm.runInNewContext(source.slice(start, stop) + suffix + '\n' + invoke, context, { timeout: 1000 });
  function setup() { cleanups.push(...effects.map(effect => effect())); }
  function cleanup() { for (const dispose of cleanups.splice(0)) dispose?.(); }
  setup();
  return { states, updates, requests, setup, cleanup,
    refresh() { listeners.get('iris-core-refresh-tick')(); },
    async reply(index, label, status = 200) {
      requests[index]({ ok: status === 200, status, json: async () => ({ items: [label], userTasks: [{ id: label }],
        available: true, tasks: { total: label === 'new' ? 2 : 1, recent: [] }, artifacts: { total: 0, recent: [] } }) });
      await flush();
    },
    current() { return kind === 'works' ? states[0]?.[0] : kind === 'tasks' ? states[0]?.rows[0]?.id : states[0]?.tasks.total; }
  };
}
for (const specification of specifications) {
  const expected = specification[0] === 'panel' ? 2 : 'new';
  const reversed = mount(specification); reversed.refresh(); assert.equal(reversed.requests.length, 2);
  await reversed.reply(1, 'new'); await reversed.reply(0, 'old');
  assert.equal(reversed.current(), expected, specification[0] + ': an older response must not replace the latest refresh'); reversed.cleanup();

  const unmounted = mount(specification); unmounted.cleanup(); const count = unmounted.updates.length;
  await unmounted.reply(0, 'old'); assert.equal(unmounted.updates.length, count, specification[0] + ': no updates after cleanup');

  const remounted = mount(specification); remounted.cleanup(); remounted.setup();
  await remounted.reply(1, 'new'); await remounted.reply(0, 'old');
  assert.equal(remounted.current(), expected, specification[0] + ': a previous effect lifetime must remain obsolete after remount'); remounted.cleanup();
}
const panel = specifications.find(item => item[0] === 'panel');
const pending = mount(panel); pending.refresh(); await pending.reply(0, 'old');
assert.equal(pending.states[0], null, 'an obsolete success is ignored while a newer request is pending');
assert.equal(pending.states[1], true, 'an obsolete finally cannot clear the latest busy state');
await pending.reply(1, 'new'); assert.equal(pending.current(), 2); assert.equal(pending.states[1], false); pending.cleanup();

const oldError = mount(panel); oldError.refresh(); await oldError.reply(1, 'new'); await oldError.reply(0, 'old', 500);
assert.equal(oldError.current(), 2); assert.equal(oldError.states[2], '', 'an obsolete error must not replace the latest success'); oldError.cleanup();
const currentError = mount(panel); await currentError.reply(0, 'new', 503);
assert.match(currentError.states[2], /503/); assert.equal(currentError.states[1], false, 'current errors still clear busy and remain visible'); currentError.cleanup();
console.log('PASS DSH Core refresh: three actual bundle readers preserve the latest response, pending busy, current errors and cleanup/remount boundaries');
