import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinLaunchPlugins, loadPluginLaunch } from '../lib/plugin-launch.js';
import { checkLocalApiTokenDirectory, writeLocalApiTokenDirectory } from '../lib/local-api-token-directory.js';
import { loadCorePluginFixture } from './fixtures/core-plugin-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-plugin-launch'), checks = [];
const configuration = path.join(root, 'startup.json');
const write = value => fs.writeFileSync(configuration, JSON.stringify(value));
const selected = { schemaVersion: 0, entries: ['builtin:contact-sheet'], operations: ['community.contact-sheet.create'],
  panel: { pages: ['community.contact-sheet.board'] } };
assert.deepEqual(builtinLaunchPlugins(), ['builtin:contact-sheet']);
write(selected);
let launch = await loadPluginLaunch(configuration);
try {
  assert.equal(launch.summary.plugins[0].id, 'community.contact-sheet');
  assert.equal(launch.summary.plugins[0].version, '0.1.0');
  assert.equal(launch.summary.contributions.pages[0].access.web, 'available-in-panel');
  assert.equal(launch.summary.contributions.operations[0].access.mcp, 'requires-selection');
  assert.equal(launch.registry.providers.snapshot().protocols.length > 0, true);
} finally { await launch.dispose(); }
write({ schemaVersion: 0, entries: ['builtin:contact-sheet'] });
launch = await loadPluginLaunch(configuration);
assert.equal(launch.allowedOperations, undefined); assert.equal(launch.summary.pluginExecution, false);
assert.equal(launch.summary.selection.operations, null); assert.equal(launch.panelContributions, undefined);
await launch.dispose();
write({ schemaVersion: 0, entries: [], operations: [] });
launch = await loadPluginLaunch(configuration);
assert.deepEqual(launch.allowedOperations, []); assert.equal(launch.summary.pluginExecution, true);
await launch.dispose();
checks.push('builtin identity and explicit business/Panel selection, omitted execution and history-only empty selection');

for (const value of [null, [], { ...selected, schemaVersion: 1 }, { ...selected, accessToken: 'not-accepted' },
  { ...selected, entries: ['relative.mjs'] }, { ...selected, entries: ['builtin:unknown'] },
  { ...selected, entries: ['https://example.invalid/index.mjs'] }, { ...selected, entries: ['builtin:contact-sheet', 'builtin:contact-sheet'] },
  { ...selected, operations: [selected.operations[0], selected.operations[0]] }, { ...selected, panel: { unknown: [] } },
  { ...selected, panel: { pages: 'invalid' } }, { ...selected, panel: { settings: [123] } },
  { ...selected, panel: { renderers: ['duplicate', 'duplicate'] } }]) {
  write(value);
  await assert.rejects(loadPluginLaunch(configuration), error => error.code === 'IRIS_PLUGIN_LAUNCH_INVALID'
    && error.diagnostic.file === configuration && error.diagnostic.stage === 'plugin-config');
}
await assert.rejects(loadPluginLaunch('relative.json'), { code: 'IRIS_PLUGIN_LAUNCH_INVALID' });
fs.writeFileSync(configuration, '{ invalid'); await assert.rejects(loadPluginLaunch(configuration), { code: 'IRIS_PLUGIN_LAUNCH_INVALID' });
fs.writeFileSync(configuration, ' '.repeat(65537)); await assert.rejects(loadPluginLaunch(configuration), { code: 'IRIS_PLUGIN_LAUNCH_INVALID' });
await assert.rejects(loadPluginLaunch(root), { code: 'IRIS_PLUGIN_LAUNCH_INVALID' });
write(selected);
await assert.rejects(loadPluginLaunch(configuration, { serveWorkbench: false }), { code: 'IRIS_PLUGIN_LAUNCH_INVALID' });
await assert.rejects(loadPluginLaunch(configuration, { panelManifestPath: '/explicit/other.json' }), { code: 'IRIS_PLUGIN_LAUNCH_INVALID' });
checks.push('strict JSON boundary, size, file type, unknown fields, duplicate choices and incompatible Panel modes');

const fixture = await loadCorePluginFixture(), marker = path.join(root, 'lifecycle.log');
const entry = path.join(fixture.directory, 'launch.mjs');
fs.writeFileSync(entry, `import fs from 'node:fs';
import { fixturePlugin } from './index.mjs';
export default fixturePlugin({ activated: () => fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify('activate\n')}),
  disposed: () => fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify('dispose\n')}) });
`);
write({ schemaVersion: 0, entries: [entry], panel: { pages: 'invalid' } });
await assert.rejects(loadPluginLaunch(configuration), { code: 'IRIS_PLUGIN_LAUNCH_INVALID' });
assert.equal(fs.existsSync(marker), false, 'Panel 字段形状应在执行第三方 activate 前拒绝');
write({ schemaVersion: 0, entries: [entry], operations: ['missing.operation'] });
await assert.rejects(loadPluginLaunch(configuration), error => error.code === 'IRIS_PLUGIN_OPERATION_DENIED'
  && error.diagnostic.stage === 'plugin-load' && error.diagnostic.file === configuration);
assert.equal(fs.readFileSync(marker, 'utf8'), 'activate\ndispose\n');
write({ schemaVersion: 0, entries: [entry], panel: { pages: ['missing.page'] } });
await assert.rejects(loadPluginLaunch(configuration), { code: 'IRIS_PLUGIN_CONTRIBUTION_MISSING' });
assert.equal(fs.readFileSync(marker, 'utf8'), 'activate\ndispose\nactivate\ndispose\n');
const alias = path.join(fixture.directory, 'alias.mjs'); fs.symlinkSync(entry, alias);
write({ schemaVersion: 0, entries: [entry, alias] });
await assert.rejects(loadPluginLaunch(configuration), { code: 'IRIS_PLUGIN_LAUNCH_INVALID' });
assert.equal(fs.readFileSync(marker, 'utf8'), 'activate\ndispose\nactivate\ndispose\n', 'canonical duplicates fail before importing/activating again');
checks.push('selection errors release the activated registry; canonical duplicate references are rejected before activation');

const dataRoot = path.join(root, 'core'); fs.mkdirSync(dataRoot);
const directory = path.join(root, 'sessions'), initial = 'A'.repeat(43), next = 'B'.repeat(43);
assert.equal(checkLocalApiTokenDirectory(root, dataRoot), root, 'a private parent is outside the data root too');
assert.equal(checkLocalApiTokenDirectory(directory, dataRoot), directory);
assert.equal(fs.existsSync(directory), false, 'validation does not create a directory');
assert.throws(() => checkLocalApiTokenDirectory(path.join(dataRoot, 'native-sessions'), fs.realpathSync.native(dataRoot)), { code: 'IRIS_API_TOKEN_DIRECTORY_INVALID' });
assert(!fs.existsSync(path.join(dataRoot, 'native-sessions')));
const first = writeLocalApiTokenDirectory(directory, initial, dataRoot), second = writeLocalApiTokenDirectory(directory, next, dataRoot);
assert.notEqual(first, second); assert.equal(fs.readFileSync(first, 'utf8').trim(), initial);
assert.equal(fs.readFileSync(second, 'utf8').trim(), next);
if (process.platform !== 'win32') {
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  for (const file of [first, second]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const publicDirectory = path.join(root, 'public-sessions'); fs.mkdirSync(publicDirectory, { mode: 0o755 });
  await assert.rejects(async () => writeLocalApiTokenDirectory(publicDirectory, next, dataRoot), { code: 'IRIS_API_TOKEN_DIRECTORY_INVALID' });
  assert.equal(fs.statSync(publicDirectory).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(publicDirectory), []);
}
const link = path.join(root, 'session-link'); fs.symlinkSync(directory, link, 'dir');
for (const value of ['relative', link, first, dataRoot, path.join(dataRoot, 'sessions')]) {
  await assert.rejects(async () => writeLocalApiTokenDirectory(value, next, dataRoot), { code: 'IRIS_API_TOKEN_DIRECTORY_INVALID' });
}
const parentAlias = path.join(root, 'core-alias'); fs.symlinkSync(dataRoot, parentAlias, 'dir');
await assert.rejects(async () => writeLocalApiTokenDirectory(path.join(parentAlias, 'sessions'), next, dataRoot), { code: 'IRIS_API_TOKEN_DIRECTORY_INVALID' });
await assert.rejects(async () => writeLocalApiTokenDirectory(path.join(root, 'missing-parent', 'sessions'), next, dataRoot), { code: 'ENOENT' });
assert.equal(fs.readFileSync(first, 'utf8').trim(), initial); assert.equal(fs.readdirSync(directory).length, 2);
assert.deepEqual(fs.readdirSync(dataRoot), []);
checks.push('repeatable private session files preserve earlier bytes; reject symlink, public, relative and data-root destinations without chmod or cleanup');
console.log(JSON.stringify({ ok: true, checks }));
