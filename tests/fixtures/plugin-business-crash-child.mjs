// Fault checkpoint wraps the real business through the public plugin contract only.
import { createCorePluginRegistry, createCorePluginWorkbench, definePlugin } from '@mokuyoaxis/dsh-iris/plugins';
import business from '@mokuyoaxis/dsh-iris/contact-sheet';

const [dataRoot, checkpoint, key, sources] = process.argv.slice(2);
const registry = await createCorePluginRegistry({ plugins: [definePlugin({ manifest: business.manifest, activate(context) {
  const implementation = business.activate(context);
  async function hold(signal) {
    process.send({ checkpoint });
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }
  return { operations: { create: async (input, ctx) => {
    if (checkpoint === 'before-read') await hold(ctx.signal);
    return implementation.operations.create(input, { ...ctx, core: { execute: async (name, args) => {
      const value = await ctx.core.execute(name, args);
      if (checkpoint === 'after-import' && name === 'artifact.import') await hold(ctx.signal);
      return value;
    } } });
  } } };
} })] });
const api = createCorePluginWorkbench({ dataRoot, registry, allowedOperations: ['community.contact-sheet.create'] });
const started = await api.start();
const response = await fetch(started.origin + '/api/v0/plugin-operations', { method: 'POST', headers: {
  Authorization: 'Bearer ' + started.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': key
}, body: JSON.stringify({ operationId: 'community.contact-sheet.create', dependency: registry.dependency('operations', 'community.contact-sheet.create'),
  input: { artifactIds: JSON.parse(sources), columns: 2, cellSize: 128 } }) });
if (response.status !== 202) throw new Error('Public acceptance failed: ' + response.status);
process.send({ accepted: (await response.json()).operation.id });
