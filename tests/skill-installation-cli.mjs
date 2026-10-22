import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iris-skill-cli-')));
const home = path.join(root, 'kimi-home'), directory = path.join(home, 'skills');
const unusedDsh = path.join(root, 'unused-dsh');
let commands = 0;
function cli(args, expected = 0) {
  const result = spawnSync(process.execPath, [path.join(repo, 'bin/dsh-iris.js'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, shell: false,
    env: { ...process.env, KIMI_CODE_HOME: home, DSH_HOME: unusedDsh, IRIS_IMPORT_WORKBENCH_CONFIG: '' }
  });
  assert.ifError(result.error); assert.equal(result.signal, null);
  assert.equal(result.status, expected, result.stderr); commands++;
  return result;
}
const parsed = (args, expected = 0) => JSON.parse(cli(args, expected).stdout);

const help = cli(['skills', '--help']);
assert(help.stdout.includes('skills <install|status|uninstall>'));
assert.equal(parsed(['skills', 'status', '--target', 'kimi'], 1).status, 'not_installed');
assert(!fs.existsSync(home), 'Read-only status must not create Kimi Home');
assert.equal(parsed(['skills', 'install', '--target', 'kimi', '--dry-run']).action, 'install');
assert(!fs.existsSync(home), 'Dry-run must not create Kimi Home');

const result = parsed(['skills', 'install', '--target', 'kimi']);
assert.equal(result.action, 'installed'); assert.equal(result.discovery, 'not_checked');
assert.equal(result.directory, directory);
assert(fs.existsSync(path.join(directory, 'iris-core/references/tasks.md')));
const original = fs.readFileSync(path.join(directory, 'iris-core/SKILL.md'));
assert.equal(parsed(['skills', 'status', '--target', 'kimi']).status, 'current');
assert.equal(parsed(['skills', 'install', '--target', 'kimi']).action, 'unchanged');

const custom = path.join(root, 'project with spaces', '.agents', 'skills');
assert.equal(parsed(['skills', 'install', '--directory', custom]).directory, custom);
assert.equal(parsed(['skills', 'status', '--directory', custom]).status, 'current');
assert.equal(parsed(['skills', 'uninstall', '--directory', custom, '--dry-run']).action, 'uninstall');
assert(fs.existsSync(path.join(custom, 'iris-core/SKILL.md')));
const removed = parsed(['skills', 'uninstall', '--directory', custom]);
assert.equal(removed.action, 'uninstalled'); assert(fs.existsSync(path.join(removed.backupPath, 'SKILL.md')));
assert(!fs.existsSync(path.join(custom, 'iris-core')));
assert.equal(parsed(['skills', 'uninstall', '--directory', custom]).action, 'unchanged');

fs.appendFileSync(path.join(directory, 'iris-core/SKILL.md'), '\nUser changes.\n');
assert.equal(parsed(['skills', 'status', '--target', 'kimi'], 1).status, 'modified');
for (const action of ['install', 'uninstall']) {
  const failed = cli(['skills', action, '--target', 'kimi'], 1);
  assert(failed.stderr.includes('IRIS_SKILL_CONFLICT'));
}
assert(fs.readFileSync(path.join(directory, 'iris-core/SKILL.md')).subarray(0, original.length).equals(original));
for (const args of [[], ['install'], ['install', '--target', 'unknown'], ['install', '--directory', 'relative'],
  ['install', '--target', 'kimi', '--dry-run', '--dry-run'], ['status', '--target', 'kimi', '--dry-run'],
  ['install', '--target', 'kimi', '--force'], ['remove', '--target', 'kimi'],
  ['status', '--target', 'kimi', '--target', 'kimi']]) {
  assert(cli(['skills', ...args], 2).stderr.includes('IRIS_CLI_USAGE'));
}
assert(!fs.existsSync(unusedDsh), 'Skill installation must not initialize a DSH profile or Core');
console.log(`ALL OK — ${commands} isolated CLI commands; retained fixtures: ${root}`);
