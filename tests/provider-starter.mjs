// Outside source consumer. Archive byte parity and independent npm packing are verified separately.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-provider-consumer-')); fs.chmodSync(directory, 0o700);
const project = path.join(directory, 'plugin');
fs.cpSync(path.join(root, 'templates/provider-starter'), project, { recursive: true });
const scope = path.join(project, 'node_modules/@mokuyoaxis'); fs.mkdirSync(scope, { recursive: true });
fs.symlinkSync(root, path.join(scope, 'dsh-iris'), process.platform === 'win32' ? 'junction' : 'dir');
const metadata = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
assert.equal(metadata.dependencies, undefined); assert.equal(metadata.private, true);
const protocol = await promisify(execFile)(process.execPath, ['scripts/protocol-smoke.mjs'], { cwd: project, timeout: 30000, maxBuffer: 1024 * 1024 });
assert.equal(JSON.parse(protocol.stdout).ok, true);
const { stdout } = await promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], { cwd: project, timeout: 110000, maxBuffer: 2 * 1024 * 1024 });
const result = JSON.parse(stdout); assert.equal(result.ok, true); assert.equal(result.checks.length, 9);
console.log(JSON.stringify({ ...result, project, core: 'source package via public exports; no private deep imports' }, null, 2));
