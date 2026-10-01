import { createHook } from 'node:async_hooks';
import path from 'node:path';

// Phase logging is always on. Resource stack collection is opt-in because
// async_hooks and WeakRef change GC scheduling, including during shutdown.
const label = path.basename(process.argv[1] || '<inline>');
const resources = new Map();
const hook = createHook({
  init(id, type, _trigger, resource) {
    if (type === 'PROMISE' || type === 'TickObject') return;
    resources.set(id, { type, resource: new WeakRef(resource), stack: new Error().stack });
  },
  destroy(id) { resources.delete(id); }
});
if (process.env.IRIS_TEST_TRACE_RESOURCES === '1') hook.enable();

process.once('beforeExit', () => {
  hook.disable();
  resources.clear();
  console.log(`${label}: beforeExit`);
  process.once('exit', () => console.log(`${label}: exit cleanup complete`));
});
process.once('exit', () => console.log(`${label}: exit cleanup begins`));
setTimeout(() => {
  console.log(`${label}: active resources`, process.getActiveResourcesInfo());
  console.log(`${label}: referenced resources`, [...resources.values()]
    .filter(item => item.resource.deref()?.hasRef?.())
    .map(item => ({ type: item.type, stack: item.stack })));
  hook.disable();
}, 10000).unref();
