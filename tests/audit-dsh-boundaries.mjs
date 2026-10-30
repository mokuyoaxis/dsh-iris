import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { apply } from '../lib/index.js';
import { createDshHostAdapter } from '../lib/dsh-host-adapter.js';
import { sseClientCount } from '../lib/api.js';
import * as tasks from '../lib/tasks.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-audit-dsh'), checks = [], instances = [];
function context({ failRouteAt, failRouteEffect = false } = {}) {
  const effects = [], tools = new Map(), routes = new Map(), services = {}, removed = [];
  let registrations = 0;
  services.tools = { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } };
  services.webServer = { register(route) {
    if (++registrations === failRouteAt) throw Error('route fixture failure');
    routes.set(route.path, route); return () => { removed.push(route.path); routes.delete(route.path); };
  } };
  const ctx = { get: name => services[name], provide(name, service) { services[name] = service; }, inject() {},
    effect(setup, label) {
      if (failRouteEffect && label === 'iris: media+api+actions+render routes') throw Error('route effect fixture failure');
      const dispose = setup(); effects.push({ label, dispose }); return dispose;
    } };
  const instance = { ctx, services, tools, routes, removed, async close() {
    for (const effect of effects.splice(0).reverse()) await effect.dispose?.();
  } };
  instances.push(instance); return instance;
}
const quiet = console.log, warn = console.error; console.log = () => {}; console.error = () => {};
try {
  for (const options of [{ failRouteAt: 2 }, { failRouteEffect: true }]) {
    const failed = context(options); await apply(failed.ctx);
    assert.equal(failed.routes.size, 0); assert.equal(failed.removed.length, options.failRouteAt ? 1 : 3);
    await failed.close();
  }
  checks.push('partial route registration and effect ownership failure remove every route already installed');

  const late = context(); await apply(late.ctx);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const image = path.join(root, 'source.png'); fs.writeFileSync(image, png);
  const saved = [];
  late.services.attachments = { async saveImage(input) { saved.push(input); return { attachmentId: 'late', mediaType: 'image/png' }; },
    async readImage() { return { data: png, mediaType: 'image/png' }; } };
  const cropped = await late.tools.get('iris_crop').execute({ image_path: image, left: 0, top: 0, width: 4, height: 4 });
  assert.equal(saved.length, 1); assert(cropped.blocks.some(block => block.attachment?.attachmentId === 'late'));
  checks.push('a tool registered before attachments exist uses the service that arrives before invocation');

  const replacement = context(); await apply(replacement.ctx);
  const response = new EventEmitter(); let ended = false;
  Object.assign(response, { writeHead() {}, write() { return true; }, end() { ended = true; this.emit('close'); } });
  await replacement.routes.get('/iris/api').handler({ url: '/iris/api/state/events', method: 'GET', headers: { host: '127.0.0.1' } }, response);
  assert.equal(sseClientCount(), 1);
  let polled; const observed = new Promise(resolve => { polled = resolve; });
  const task = tasks.create({ cap: 'video', remoteTaskId: 'hot-replacement' });
  tasks.watch(task, { intervalMs: 60000, async poll() { polled(); return { done: false }; } });
  await late.close();
  assert.equal(ended, false); assert.equal(sseClientCount(), 1);
  let timeout;
  try { await Promise.race([observed, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('new watcher was stopped')), 2000); })]); }
  finally { clearTimeout(timeout); }
  await replacement.close();
  assert.equal(ended, true); assert.equal(sseClientCount(), 0);
  checks.push('late disposal of an older native instance keeps replacement SSE and legacy task observation alive; current disposal closes them');

  const llm = { resolveModelInfo: async () => ({ provider: 'p', id: 'm', inputModalities: ['image'] }) };
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } };
  for (const kind of ['length', 'max-tokens', 'tool-calls', 'content-blocked', 'oversize']) {
    llm.stream = async function* () {
      yield { type: 'text-delta', text: kind === 'oversize' ? 'x'.repeat(6001) : 'partial answer' };
      yield { type: 'finish', reason: { kind: kind === 'oversize' ? 'stop' : kind } };
    };
    const host = createDshHostAdapter({ get: name => services[name] });
    await assert.rejects(host.ports.visionModel.analyze({ question: 'q', ref: {} }), { code: 'IRIS_HOST_CAPABILITY_INCOMPATIBLE' });
  }
  checks.push('legacy vision truncation, filtering, tool-only completion and local output budget cannot return a partial success');
} finally {
  for (const instance of instances.reverse()) await instance.close();
  tasks.stopWatchAll(); console.log = quiet; console.error = warn;
}
console.log(JSON.stringify({ ok: true, checks }, null, 2));
