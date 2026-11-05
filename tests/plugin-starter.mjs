// Copy the shipped project outside the repository; consume only public exports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-starter-consumer-')); fs.chmodSync(directory, 0o700);
const project = path.join(directory, 'plugin');
fs.cpSync(path.join(root, 'templates/plugin-starter'), project, { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
const scope = path.join(project, 'node_modules/@mokuyoaxis'); fs.mkdirSync(scope, { recursive: true });
fs.symlinkSync(root, path.join(scope, 'dsh-iris'), process.platform === 'win32' ? 'junction' : 'dir');
const metadata = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
assert.equal(metadata.dependencies, undefined, 'starter adds no runtime dependency beyond its Core peer');
const { stdout } = await promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], { cwd: project, timeout: 110_000,
  env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '' }, maxBuffer: 1024 * 1024 });
const result = JSON.parse(stdout); assert.equal(result.ok, true); assert.equal(result.checks.length, 9);
console.log(JSON.stringify({ ...result, project, core: 'public SDK from a source package link; archive consumption is verified separately' }, null, 2));
