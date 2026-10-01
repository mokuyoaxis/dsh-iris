import { createHook } from 'node:async_hooks';
import path from 'node:path';

// Loaded before each test: retain only weak references so diagnostics cannot
// keep a resource alive or turn a shutdown leak into a successful forced exit.
const label = path.basename(process.argv[1] || '<inline>');
const resources = new Map();
const hook = createHook({
  init(id, type, _trigger, resource) {
    if (type === 'PROMISE' || type === 'TickObject') return;
    resources.set(id, { type, resource: new WeakRef(resource), stack: new Error().stack });
  },
  destroy(id) { resources.delete(id); }
});
hook.enable();

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
