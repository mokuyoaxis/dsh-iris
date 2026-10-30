import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCorePluginRegistry } from '@mokuyoaxis/dsh-iris/plugins';
import { loadCorePluginFixture } from './fixtures/core-plugin-fixture.mjs';

const fixture = await loadCorePluginFixture(), checks = [];
fs.writeFileSync(path.join(fixture.directory, 'web/library.mjs'), "throw new Error('Web modules must not run during Node registration');\n");
const registry = await loadCorePluginRegistry({ entries: [fixture.entry] });
try {
  assert.equal(registry.snapshot().contributions.pages[0].id, 'example.media.library');
  assert.equal(registry.snapshot().contributions.renderers[0].entry, 'web/png.mjs');
  assert.equal(registry.snapshot().coreVersion, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
  checks.push('explicit loader resolves real peer package and Web files without evaluating a browser module or inventing Core version');
} finally { await registry.dispose(); }

await assert.rejects(loadCorePluginRegistry({ entries: ['./relative.mjs'] }), { code: 'IRIS_PLUGIN_INVALID' });
await assert.rejects(loadCorePluginRegistry({ entries: [path.join(fixture.directory, 'package.json')] }), { code: 'IRIS_PLUGIN_INVALID' });
await assert.rejects(loadCorePluginRegistry({ entries: [fixture.entry, fixture.entry] }), { code: 'IRIS_PLUGIN_INVALID' });
checks.push('relative entries, non-JS entries and repeated plugin identities cannot activate');

const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-plugin-outside-'));
const target = path.join(outside, 'private.mjs'); fs.writeFileSync(target, 'export const privateValue = true;\n');
fs.symlinkSync(target, path.join(fixture.directory, 'web/escape.mjs'));
const source = fs.readFileSync(fixture.entry, 'utf8');
const escaped = path.join(fixture.directory, 'escape-entry.mjs');
fs.writeFileSync(escaped, source.replace("entry: 'web/library.mjs'", "entry: 'web/escape.mjs'"));
await assert.rejects(loadCorePluginRegistry({ entries: [escaped] }), { code: 'IRIS_PLUGIN_INVALID' });
const missing = path.join(fixture.directory, 'missing-entry.mjs');
fs.writeFileSync(missing, source.replace("entry: 'web/library.mjs'", "entry: 'web/missing.mjs'"));
await assert.rejects(loadCorePluginRegistry({ entries: [missing] }), { code: 'ENOENT' });
checks.push('symlink escape and missing Web resources fail before plugin activation; filesystem failures remain explicit');
console.log(JSON.stringify({ ok: true, checks }, null, 2));
