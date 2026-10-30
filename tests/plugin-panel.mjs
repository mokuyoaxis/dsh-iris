import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCorePluginRegistry, createCorePluginRegistry, createCorePluginWorkbench, definePlugin } from '@mokuyoaxis/dsh-iris/plugins';
import { createPluginPanelAssembly } from '../lib/plugin-web-assets.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createPanelPluginFixture } from './fixtures/panel-plugin-fixture.mjs';

const fixture = createPanelPluginFixture(), registry = await loadCorePluginRegistry({ entries: [fixture.entry] }), checks = [];
const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iris-plugin-panel-api-')), 'core');
const app = createApplicationRuntime({ dataRoot }); let api;
try {
  const selection = { pages: ['example.panel.library'], settings: ['example.panel.connection'], renderers: ['example.panel.png'] };
  const assembly = createPluginPanelAssembly(registry, selection), original = (await assembly.read(assembly.manifest.pages[0].entry)).bytes;
  fs.writeFileSync(path.join(fixture.directory, 'web/library.mjs'), 'throw new Error("changed after pinning");\n');
  assert.deepEqual((await assembly.read(assembly.manifest.pages[0].entry)).bytes, original);
  assert.equal(assembly.manifest.settings[0].dependency.kind, 'settings');
  assert.equal(assembly.has('/plugin-assets/example.panel/1.0.0/pages/example.panel.hidden/web/hidden.mjs'), false);
  assert.equal(assembly.has('/plugin-assets/example.panel/1.0.0/pages/example.panel.library/index.mjs'), false);
  assert.equal(assembly.has('/api/v0/session'), false);
  assert.deepEqual(createPluginPanelAssembly(registry).manifest, { contractVersion: 0, pages: [], settings: [], renderers: [] });
  checks.push('explicit three-kind selection pins original bytes, exact identities and finite JS/CSS; no directory or unselected module exposure');
  for (const value of [null, [], { operations: [] }, { pages: 'example.panel.library' }, { pages: ['example.panel.library', 'example.panel.library'] }]) {
    assert.throws(() => createPluginPanelAssembly(registry, value), { code: 'IRIS_PLUGIN_WEB_INVALID' });
  }
  assert.throws(() => createPluginPanelAssembly(registry, { pages: ['example.panel.missing'] }), { code: 'IRIS_PLUGIN_CONTRIBUTION_MISSING' });
  const bare = await createCorePluginRegistry({ plugins: [definePlugin({ manifest: registry.snapshot().plugins[0], activate: () => ({}) })] });
  try { assert.throws(() => createPluginPanelAssembly(bare, selection), { code: 'IRIS_PLUGIN_WEB_ASSET_MISSING' }); }
  finally { await bare.dispose(); }
  checks.push('malformed/unknown/duplicate selections and unpinned in-memory module resources are explicit errors');
  assert.throws(() => createLocalReadApi({ dataRoot, panelContributions: selection }), { code: 'IRIS_API_CONFIG_INVALID' });
  assert.throws(() => createLocalReadApi({ dataRoot, serveWorkbench: true, panelManifestPath: '/explicit/manifest.json', panelContributions: selection }), { code: 'IRIS_API_CONFIG_INVALID' });
  await app.execute('flow.init', {});
  assert.throws(() => createCorePluginWorkbench({ dataRoot, allowExecution: true }), { code: 'IRIS_PLUGIN_WEB_INVALID' });
  api = createCorePluginWorkbench({ dataRoot, registry, panelContributions: selection });
  const started = await api.start(), headers = { Authorization: 'Bearer ' + started.accessToken };
  const session = await (await fetch(started.origin + '/api/v0/session', { headers })).json();
  assert.deepEqual(session.panelContributions, assembly.manifest);
  assert.equal(session.providerManagement, false);
  const catalog = await (await fetch(started.origin + '/api/v0/capabilities', { headers })).json();
  assert.equal(catalog.contributions.pages.find(value => value.id === 'example.panel.library').access.web, 'available-in-panel');
  assert.equal(catalog.contributions.pages.find(value => value.id === 'example.panel.hidden').access.web, 'not-mounted');
  assert.equal(catalog.contributions.settings[0].access.web, 'available-in-panel');
  assert.equal(catalog.contributions.pages[0].entry, undefined);
  assert.equal((await fetch(started.origin + '/api/v0/session')).status, 401);
  const asset = await fetch(started.origin + session.panelContributions.pages[0].entry);
  assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/);
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), original);
  const style = await fetch(started.origin + session.panelContributions.settings[0].styles[0]);
  assert.equal(style.status, 200); assert.match(style.headers.get('content-type'), /css/);
  assert.equal((await fetch(started.origin + '/plugin-panel.js')).status, 200);
  assert.equal((await fetch(started.origin + '/plugin-surface.css')).status, 200);
  assert.equal((await fetch(started.origin + '/api/v0/provider-management/settings', { headers })).status, 405);
  assert.equal((await fetch(started.origin + '/plugin-assets/example.panel/1.0.0/pages/example.panel.hidden/web/hidden.mjs', { headers })).status, 404);
  assert.equal((await fetch(started.origin + session.panelContributions.pages[0].entry, { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(started.origin + session.panelContributions.pages[0].entry, { headers: { Origin: 'https://example.com' } })).status, 403);
  checks.push('real local API projects selected mounts for owner, keeps discovery path-free, authenticates data and preserves management/static origin/method gates');
  await api.dispose(); api = null;
  assert.equal(registry.snapshot().state, 'active', 'service does not own shared registry');
  await registry.dispose(); assert.equal(assembly.has(assembly.manifest.pages[0].entry), false);
  assert.throws(() => createPluginPanelAssembly(registry, selection), { code: 'IRIS_PLUGIN_CLOSED' });
  checks.push('default Panel replacement stays an explicit alternative; shared registry ownership and closed module service are retained');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally { await api?.dispose(); await app.dispose(); await registry.dispose(); }
