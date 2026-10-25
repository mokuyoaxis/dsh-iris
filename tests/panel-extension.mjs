import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPanelExtension } from '../lib/panel-extension.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { normalizeAppearance, DEFAULT_APPEARANCE } from '../lib/web/appearance.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-panel-extension'), directory = path.join(root, 'panel'), dataRoot = path.join(root, 'core');
fs.mkdirSync(directory); const file = path.join(directory, 'iris-panel.json');
const manifest = { contractVersion: 0, id: 'example.panel', version: '1.0.0', assets: { '/': 'index.html', '/theme.css': 'theme.css' } };
fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Independent Panel</title>');
fs.writeFileSync(path.join(directory, 'theme.css'), 'body{background:white}');
fs.writeFileSync(file, JSON.stringify(manifest));
const panel = loadPanelExtension(file); assert.equal(panel.identity.id, 'example.panel'); assert.equal(panel.has('/api/v0/session'), false);
const bytes = (await panel.read('/')).bytes; fs.writeFileSync(path.join(directory, 'index.html'), 'not the pinned page');
assert.deepEqual((await panel.read('/')).bytes, bytes);
for (const invalid of [{ ...manifest, contractVersion: 1 }, { ...manifest, assets: { '/': '../outside.html' } },
  { ...manifest, assets: { '/': 'index.html', '/api/v0/session': 'index.html' } }, { ...manifest, assets: { '/': 'index.html', '/mcp': 'index.html' } },
  { ...manifest, assets: { '/': 'index.html', '/../../escape.css': 'theme.css' } }]) {
  fs.writeFileSync(file, JSON.stringify(invalid)); assert.throws(() => loadPanelExtension(file), { code: 'IRIS_PANEL_INVALID' });
}
fs.writeFileSync(path.join(root, 'outside.html'), 'private'); fs.symlinkSync(path.join(root, 'outside.html'), path.join(directory, 'linked.html'));
fs.writeFileSync(file, JSON.stringify({ ...manifest, assets: { '/': 'linked.html' } })); assert.throws(() => loadPanelExtension(file), { code: 'IRIS_PANEL_INVALID' });
fs.writeFileSync(file, JSON.stringify(manifest));
assert.deepEqual(normalizeAppearance(DEFAULT_APPEARANCE), DEFAULT_APPEARANCE);
for (const invalid of [{ ...DEFAULT_APPEARANCE, background: 'https://example.com/x' }, { ...DEFAULT_APPEARANCE, overlay: 0 },
  { ...DEFAULT_APPEARANCE, accent: 'url(https://example.com)' }, { ...DEFAULT_APPEARANCE, contractVersion: 1 }]) assert.throws(() => normalizeAppearance(invalid));
const app = createApplicationRuntime({ dataRoot }); let api;
try {
  await app.execute('flow.init', {});
  api = createLocalReadApi({ dataRoot, serveWorkbench: true, panelManifestPath: file }); const session = await api.start();
  assert.equal((await fetch(session.origin + '/')).status, 200); assert.equal((await fetch(session.origin + '/theme.css')).status, 200);
  assert.equal((await fetch(session.origin + '/api/v0/session')).status, 401);
  const facts = await (await fetch(session.origin + '/api/v0/session', { headers: { Authorization: 'Bearer ' + session.accessToken } })).json();
  assert.deepEqual(facts.panel, { contractVersion: 0, id: 'example.panel', version: '1.0.0' });
  assert.equal((await fetch(session.origin + '/app.js')).status, 401, 'replacement does not accidentally expose the built-in panel');
  console.log('Panel: explicit manifest/version, pinned finite resources, reserved routes/traversal/symlink boundaries, API auth independence and restricted data-only themes OK');
} finally { await api?.dispose(); await app.dispose(); }
