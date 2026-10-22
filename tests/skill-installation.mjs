import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { manageCoreSkill } from '../lib/skill-installation.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iris-skill-install-')));
const packageRoot = path.join(root, 'package-v1'), second = path.join(root, 'package-v2');
const skillSource = path.join(repo, 'skills/iris-core');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
for (const [directory, version] of [[packageRoot, '1.0.0'], [second, '1.0.1']]) {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@mokuyoaxis/dsh-iris', version }));
  fs.cpSync(skillSource, path.join(directory, 'skills/iris-core'), { recursive: true });
}
fs.appendFileSync(path.join(second, 'skills/iris-core/SKILL.md'), '\nA verified package update.\n');
const invoke = (action, directory, extra = {}, source = packageRoot) => manageCoreSkill({ action, directory, ...extra }, {
  packageRoot: source, env: {}, home: path.join(root, 'unused-home')
});
const snapshot = directory => {
  if (!fs.existsSync(directory)) return null;
  const result = Object.create(null);
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), relative = path.relative(directory, file), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) result[relative] = 'link:' + fs.readlinkSync(file);
      else if (stat.isDirectory()) { result[relative] = 'directory'; visit(file); }
      else result[relative] = hash(fs.readFileSync(file));
    }
  };
  visit(directory); return result;
};
let checks = 0;
const check = (name, body) => { body(); checks++; console.log('ok ' + name); };
const directory = name => path.join(root, name, 'skills');
const installed = name => { const d = directory(name); invoke('install', d); return d; };
const conflict = body => assert.throws(body, cause => cause.code === 'IRIS_SKILL_CONFLICT');

check('status and dry-run do not create directories', () => {
  const d = directory('read-only'); const before = snapshot(root);
  assert.equal(invoke('status', d).status, 'not_installed');
  assert.equal(invoke('install', d, { dryRun: true }).action, 'install');
  assert.equal(invoke('uninstall', d, { dryRun: true }).action, 'unchanged');
  assert.deepEqual(snapshot(root), before);
});
check('copy includes all resources and an ownership receipt', () => {
  const d = installed('copy'), target = path.join(d, 'iris-core');
  const receipt = JSON.parse(fs.readFileSync(path.join(target, '.iris-install.json')));
  assert.equal(receipt.packageVersion, '1.0.0');
  assert.deepEqual(Object.keys(receipt.files).sort(), Object.keys(snapshot(skillSource)).filter(k => snapshot(skillSource)[k] !== 'directory').sort());
  for (const name of Object.keys(receipt.files)) assert.deepEqual(fs.readFileSync(path.join(target, name)), fs.readFileSync(path.join(skillSource, name)));
  assert.equal(invoke('status', d).status, 'current');
  assert.equal(invoke('status', d).discovery, 'not_checked');
  const before = snapshot(root);
  assert.equal(invoke('install', d).action, 'unchanged');
  assert.deepEqual(snapshot(root), before);
});
check('Kimi honors its explicit Home and custom directory overrides it', () => {
  const home = path.join(root, 'kimi-home');
  const ctx = { packageRoot, env: { KIMI_CODE_HOME: home }, home: path.join(root, 'not-used') };
  const result = manageCoreSkill({ action: 'install', target: 'kimi' }, ctx);
  assert.equal(result.directory, path.join(home, 'skills'));
  const custom = directory('custom');
  assert.equal(manageCoreSkill({ action: 'install', target: 'kimi', directory: custom }, ctx).directory, custom);
});
check('invalid inputs and source overlap fail before writes', () => {
  const before = snapshot(root);
  for (const options of [{ action: 'install' }, { action: 'install', target: 'unknown' },
    { action: 'install', directory: 'relative' }, { action: 'remove', directory: directory('bad') },
    { action: 'status', directory: directory('bad'), dryRun: true },
    { action: 'install', directory: path.join(packageRoot, 'skills') },
    { action: 'install', directory: path.join(packageRoot, 'skills/iris-core/nested') }]) {
    assert.throws(() => manageCoreSkill(options, { packageRoot, env: {}, home: root }), cause => cause.code === 'IRIS_SKILL_OPTIONS_INVALID');
  }
  assert.deepEqual(snapshot(root), before);
});
check('unmanaged empty and populated directories are never adopted', () => {
  for (const populated of [false, true]) {
    const d = directory('unmanaged-' + populated), target = path.join(d, 'iris-core');
    fs.mkdirSync(target, { recursive: true });
    if (populated) fs.writeFileSync(path.join(target, 'SKILL.md'), 'User-owned instructions');
    const before = snapshot(root);
    assert.equal(invoke('status', d).status, 'unmanaged');
    conflict(() => invoke('install', d)); conflict(() => invoke('uninstall', d));
    assert.deepEqual(snapshot(root), before);
  }
});
for (const kind of ['changed', 'added-file', 'added-prototype-file', 'missing-file', 'added-directory']) check('preserve ' + kind, () => {
  const d = installed(kind), target = path.join(d, 'iris-core');
  if (kind === 'changed') fs.appendFileSync(path.join(target, 'SKILL.md'), '\nUser changes.\n');
  if (kind === 'added-file') fs.writeFileSync(path.join(target, 'user-notes.md'), 'Keep me');
  if (kind === 'added-prototype-file') fs.writeFileSync(path.join(target, '__proto__'), 'Keep this extra file');
  if (kind === 'missing-file') fs.renameSync(path.join(target, 'SKILL.md'), path.join(root, 'moved-user-skill.md'));
  if (kind === 'added-directory') fs.mkdirSync(path.join(target, 'user-assets'));
  const before = snapshot(root);
  assert.equal(invoke('status', d).status, 'modified');
  conflict(() => invoke('install', d, {}, second)); conflict(() => invoke('uninstall', d));
  assert.deepEqual(snapshot(root), before);
});
check('manual directory symlinks and nested links are preserved', () => {
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'user.txt'), 'Preserve');
  const d = directory('manual-link'); fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(outside, path.join(d, 'iris-core'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(invoke('status', d).status, 'unmanaged'); conflict(() => invoke('install', d));
  const nested = installed('nested-link');
  fs.symlinkSync(outside, path.join(nested, 'iris-core/user-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(root);
  assert.equal(invoke('status', nested).status, 'modified'); conflict(() => invoke('uninstall', nested));
  assert.deepEqual(snapshot(root), before);
});
check('invalid and traversal receipts are not trusted', () => {
  for (const invalid of ['broken-json', 'traversal', 'foreign-owner']) {
    const d = installed(invalid), receipt = path.join(d, 'iris-core/.iris-install.json');
    const value = JSON.parse(fs.readFileSync(receipt));
    if (invalid === 'traversal') value.files['../outside.txt'] = { size: 0, sha256: '0'.repeat(64) };
    if (invalid === 'foreign-owner') value.packageName = 'another-package';
    fs.writeFileSync(receipt, invalid === 'broken-json' ? '{invalid' : JSON.stringify(value));
    const before = snapshot(root);
    assert.equal(invoke('status', d).status, 'unmanaged'); conflict(() => invoke('install', d)); conflict(() => invoke('uninstall', d));
    assert.deepEqual(snapshot(root), before);
  }
});
check('upgrade is explicit, archived, idempotent and uninstall is recoverable', () => {
  const d = installed('upgrade'), old = snapshot(path.join(d, 'iris-core'));
  assert.equal(invoke('status', d, {}, second).status, 'update_available');
  const before = snapshot(root);
  assert.equal(invoke('install', d, { dryRun: true }, second).action, 'update');
  assert.deepEqual(snapshot(root), before);
  const updated = invoke('install', d, {}, second);
  assert.equal(updated.action, 'updated');
  assert(!updated.backupPath.startsWith(d + path.sep));
  assert.deepEqual(snapshot(updated.backupPath), old);
  assert.equal(invoke('install', d, {}, second).action, 'unchanged');
  const fresh = snapshot(path.join(d, 'iris-core')), unchanged = snapshot(root);
  assert.equal(invoke('uninstall', d, { dryRun: true }, second).action, 'uninstall'); assert.deepEqual(snapshot(root), unchanged);
  const removed = invoke('uninstall', d, {}, second);
  assert.equal(removed.status, 'not_installed'); assert.deepEqual(snapshot(removed.backupPath), fresh);
  assert.equal(invoke('uninstall', d, {}, second).action, 'unchanged');
});
check('content changes are detected even when package version is unchanged', () => {
  const same = path.join(root, 'same-version'); fs.cpSync(second, same, { recursive: true });
  fs.writeFileSync(path.join(same, 'package.json'), JSON.stringify({ name: '@mokuyoaxis/dsh-iris', version: '1.0.0' }));
  const d = installed('same-version-target');
  assert.equal(invoke('status', d, {}, same).status, 'update_available');
  assert.equal(invoke('install', d, {}, same).action, 'updated');
});
check('busy coordination files are never reclaimed', () => {
  const d = installed('busy');
  const lock = path.join(path.dirname(d), '.iris-skill-installs', hash(d).slice(0, 16), 'lock.json');
  fs.writeFileSync(lock, 'Existing owner'); const before = snapshot(root);
  assert.throws(() => invoke('install', d, {}, second), cause => cause.code === 'IRIS_SKILL_BUSY');
  assert.deepEqual(snapshot(root), before);
});
check('control-directory links cannot redirect archives', () => {
  const d = directory('control-link'), outside = path.join(root, 'outside');
  fs.mkdirSync(path.dirname(d));
  fs.symlinkSync(outside, path.join(path.dirname(d), '.iris-skill-installs'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(root);
  assert.throws(() => invoke('install', d), cause => cause.code === 'IRIS_SKILL_UNSAFE_PATH');
  assert.deepEqual(snapshot(root), before);
});
check('copy failure preserves the old version and partial new files', () => {
  const d = installed('copy-failure'), old = snapshot(path.join(d, 'iris-core'));
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (file === path.join(d, 'iris-core/references/cli.md')) throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
    return write(file, ...args);
  };
  let failed;
  try { invoke('install', d, {}, second); } catch (cause) { failed = cause; } finally { fs.writeFileSync = write; }
  assert.equal(failed.code, 'EIO'); assert(failed.message.includes('原版保存在：'));
  const backup = failed.message.split('原版保存在：')[1]; assert.deepEqual(snapshot(backup), old);
  assert(fs.existsSync(path.join(d, 'iris-core/SKILL.md')));
  assert.equal(invoke('status', d).status, 'unmanaged'); conflict(() => invoke('install', d));
});
console.log(`ALL OK — ${checks} installation boundary groups; retained fixtures: ${root}`);
