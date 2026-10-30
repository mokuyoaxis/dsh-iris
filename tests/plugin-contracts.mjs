import assert from 'node:assert/strict';
import { definePlugin, defineProviderAdapter, createCorePluginRegistry, checkedPluginDependency, comparePluginVersions } from '@mokuyoaxis/dsh-iris/plugins';
import { loadCorePluginFixture } from './fixtures/core-plugin-fixture.mjs';

const { fixturePlugin } = await loadCorePluginFixture();

const checks = [];
function changed(edit) {
  const source = fixturePlugin(), manifest = structuredClone(source.manifest); edit(manifest);
  return { manifest, activate: source.activate };
}
const invalid = edit => assert.throws(() => definePlugin(changed(edit)), { code: 'IRIS_PLUGIN_INVALID' });

const order = ['0.3.0-alpha', '0.3.0-alpha.1', '0.3.0-alpha.beta', '0.3.0-beta', '0.3.0-beta.2', '0.3.0-beta.11', '0.3.0-rc.1', '0.3.0'];
for (let i = 1; i < order.length; i++) {
  assert.equal(comparePluginVersions(order[i - 1], order[i]), -1); assert.equal(comparePluginVersions(order[i], order[i - 1]), 1);
}
assert.equal(comparePluginVersions('0.3.0+first', '0.3.0+second'), 0);
assert.equal(comparePluginVersions('0.3.0-rc1', '0.3.0-rc1'), 0);
assert.equal(comparePluginVersions('99999999999999999999.0.0', '99999999999999999998.0.0'), 1);
for (const value of ['0.03.0', '0.3', '0.3.0-alpha.01', '^0.3.0', 'latest', '0.3.0-']) {
  assert.throws(() => comparePluginVersions(value, '0.3.0'), { code: 'IRIS_PLUGIN_INVALID' });
}
checks.push('SemVer precedence, build metadata, numbered prereleases and invalid versions');

invalid(m => { m.contractVersion = 1; }); invalid(m => { m.id = 'iris.plugin'; }); invalid(m => { m.id = '../escape'; });
invalid(m => { m.id = 'artifact'; });
invalid(m => { m.compatibility.maxExclusive = m.compatibility.min; });
invalid(m => { m.contributions.operations.push(m.contributions.operations[0]); });
invalid(m => { m.contributions.unknown = []; }); invalid(m => { m.contributions = {}; });
invalid(m => { m.contributions.pages = null; });
invalid(m => { m.contributions.providers[0].capabilities = ['text']; });
invalid(m => { m.contributions.providers[0].configuration = [{ key: 'apiKey', type: 'url', label: 'Key' }]; });
invalid(m => { m.contributions.providers[0].configuration = null; });
invalid(m => { m.contributions.operations[0].commands.push('artifact.import'); });
invalid(m => { m.contributions.operations[0].inputSchema.properties.limit.default = 2; });
invalid(m => { m.contributions.operations[0].inputSchema.properties.limit.customValidation = true; });
invalid(m => { m.contributions.operations[0].inputSchema.properties.limit.minimum = '1'; });
invalid(m => { m.contributions.operations[0].inputSchema.properties.limit.minLength = -1; });
invalid(m => { m.contributions.operations[0].inputSchema.properties.limit.enum = []; });
for (const entry of ['../page.js', '/page.js', 'https://invalid/page.js', 'page.js?x', 'web/../page.js', 'web\\page.js', 'web/page.html']) {
  invalid(m => { m.contributions.pages[0].entry = entry; });
}
invalid(m => { m.contributions.renderers[0].mediaTypes = ['image/*']; });
checks.push('closed manifests, namespaces, contribution identity, command modes, schema subset and Web paths');

let activated = 0;
const definition = fixturePlugin({ activated: () => activated++ });
await assert.rejects(createCorePluginRegistry({ plugins: [definition], coreVersion: '0.2.6' }), { code: 'IRIS_PLUGIN_INCOMPATIBLE' });
await assert.rejects(createCorePluginRegistry({ plugins: [definition], coreVersion: '0.4.0' }), { code: 'IRIS_PLUGIN_INCOMPATIBLE' });
await assert.rejects(createCorePluginRegistry({ plugins: [definition, definition], coreVersion: '0.3.0-alpha.1' }), { code: 'IRIS_PLUGIN_INVALID' });
for (const kind of ['providers', 'operations', 'pages', 'renderers']) {
  const collision = changed(m => { m.id = 'example'; m.contributions[kind][0].id = 'media.' + m.contributions[kind][0].id; });
  await assert.rejects(createCorePluginRegistry({ plugins: [definition, collision], coreVersion: '0.3.0-alpha.1' }), { code: 'IRIS_PLUGIN_INVALID' });
}
const badSchema = changed(m => { m.contributions.operations[0].inputSchema.properties.limit.type = 'unrecognized'; });
await assert.rejects(createCorePluginRegistry({ plugins: [definition, badSchema], coreVersion: '0.3.0-alpha.1' }), { code: 'IRIS_PLUGIN_INVALID' });
assert.equal(activated, 0);
checks.push('all manifests, compatibility and duplicate IDs are checked before any activation');

const registry = await createCorePluginRegistry({ plugins: [definition], coreVersion: '0.3.0-alpha.1' });
try {
  assert.equal(activated, 1);
  const metadata = registry.snapshot();
  assert.deepEqual(Object.fromEntries(Object.entries(metadata.contributions).map(([kind, entries]) => [kind, entries.length])), { providers: 1, operations: 2, pages: 1, renderers: 1, settings: 0 });
  assert.equal(metadata.contributions.providers[0].id, 'example.media.images');
  metadata.plugins[0].contributions.operations[0].title = 'mutated';
  assert.equal(registry.snapshot().contributions.operations[0].title, 'List images');
  const dependency = registry.dependency('operations', 'example.media.list');
  assert(Object.isFrozen(dependency));
  assert.deepEqual(registry.assertDependency(JSON.parse(JSON.stringify(dependency))), dependency);
  assert.throws(() => registry.assertDependency({ ...dependency, pluginVersion: '1.0.1' }), { code: 'IRIS_PLUGIN_DEPENDENCY_MISMATCH' });
  assert.throws(() => registry.assertDependency({ ...dependency, contributionVersion: '2.0.0' }), { code: 'IRIS_PLUGIN_DEPENDENCY_MISMATCH' });
  assert.throws(() => registry.assertDependency({ ...dependency, contributionId: 'example.media.missing' }), { code: 'IRIS_PLUGIN_CONTRIBUTION_MISSING' });
  assert.throws(() => checkedPluginDependency({ ...dependency, pluginId: 'different' }), { code: 'IRIS_PLUGIN_INVALID' });
  checks.push('four contribution kinds share immutable identity and serializable exact dependency pins');
} finally { await registry.dispose(); }

const sequence = [];
const simple = (id, activate) => definePlugin({ manifest: { contractVersion: 0, id, version: '1.0.0', compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
  contributions: { pages: [{ id: 'main', version: '1.0.0', title: 'Main', entry: 'main.js' }] } }, activate });
await assert.rejects(createCorePluginRegistry({ coreVersion: '0.3.0-alpha.1', plugins: [
  simple('example.first', ctx => { ctx.onDispose(() => sequence.push('first')); return {}; }),
  simple('example.second', ctx => { ctx.onDispose(() => sequence.push('second')); throw new Error('activation failed'); })
] }), /activation failed/);
assert.deepEqual(sequence, ['second', 'first']);
const broken = await createCorePluginRegistry({ coreVersion: '0.3.0-alpha.1', plugins: [simple('example.broken', ctx => {
  ctx.onDispose(() => { throw new Error('cleanup failed'); }); return {};
})] });
const closing = broken.dispose(); assert.equal(broken.dispose(), closing); await assert.rejects(closing, AggregateError);
assert.equal(broken.snapshot().cleanupFailed, true); await assert.rejects(broken.dispose(), AggregateError);
checks.push('partial activation releases in reverse order; cleanup failure remains explicit and disposal is idempotent');

let entered, finish, released = 0;
const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { finish = resolve; });
const source = fixturePlugin({ disposed: () => { released++; } });
const delayed = definePlugin({ manifest: source.manifest, activate: ctx => {
  const implementation = source.activate(ctx);
  return { ...implementation, providers: { images: { ...implementation.providers.images,
    createAdapter: provider => defineProviderAdapter({ id: provider.id, protocol: 'example.media.images', capabilities: ['image'],
      operations: { submit: async () => { entered(); await blocked; return { kind: 'accepted', remoteTaskId: 'held-original' }; }, mapError: error => error },
      unsupported: { discover: 'fixture', poll: 'fixture', cancel: 'fixture', download: 'fixture' } })
  } } };
} });
const holding = await createCorePluginRegistry({ plugins: [delayed] });
const adapter = holding.providers.createAdapter('example.media.images', { id: 'configured', auth: 'none' });
const call = adapter.operations.submit({}); await started;
const draining = holding.dispose(); assert.equal(released, 0);
await assert.rejects(adapter.operations.submit({}), { code: 'IRIS_PROVIDER_EXTENSION_CLOSED' });
assert.throws(() => holding.providers.createAdapter('example.media.images', { id: 'configured' }), { code: 'IRIS_PROVIDER_EXTENSION_CLOSED' });
finish(); assert.equal((await call).remoteTaskId, 'held-original'); await draining;
assert.equal(released, 1);
checks.push('unified shutdown rejects new Provider calls and drains an accepted call before releasing the plugin resource');

const forgedSource = fixturePlugin();
const forged = await createCorePluginRegistry({ plugins: [definePlugin({ manifest: forgedSource.manifest, activate: ctx => {
  const implementation = forgedSource.activate(ctx);
  return { ...implementation, providers: { images: { ...implementation.providers.images, createAdapter: provider => ({
    ...implementation.providers.images.createAdapter(provider),
    pluginDependency: { contractVersion: 0, pluginId: 'example.media', pluginVersion: '9.0.0', kind: 'providers',
      contributionId: 'example.media.images', contributionVersion: '1.0.0' }
  }) } } };
} })] });
try {
  assert.throws(() => forged.providers.createAdapter('example.media.images', { id: 'configured', auth: 'none' }), { code: 'IRIS_PLUGIN_DEPENDENCY_MISMATCH' });
} finally { await forged.dispose(); }
checks.push('Provider factory cannot substitute a different dependency for the Core-owned manifest identity');
console.log(JSON.stringify({ ok: true, checks }, null, 2));
