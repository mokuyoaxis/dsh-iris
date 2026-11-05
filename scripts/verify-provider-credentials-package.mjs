// Actual tarball consumer. Reuse cached dependencies without installing anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === '--package' && args[2] === '--output', 'Usage: --package <absolute-tgz> --output <new-absolute-directory>');
assert(path.isAbsolute(args[1]) && path.isAbsolute(args[3]));
const repo = fileURLToPath(new URL('..', import.meta.url)), out = args[3]; fs.mkdirSync(out, { mode: 0o700 });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-env-package-')); fs.chmodSync(work, 0o700);
const execute = promisify(execFile), report = { status: 'running', work, paidCalls: 0, freshDependencyInstall: false,
  archiveSha256: createHash('sha256').update(fs.readFileSync(args[1])).digest('hex') };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
try {
  save(); const unpacked = path.join(work, 'archive'); fs.mkdirSync(unpacked);
  await execute('tar', ['-xzf', args[1], '-C', unpacked], { timeout: 30_000 });
  const installed = path.join(unpacked, 'package');
  for (const name of ['.internal', 'tests', 'scripts', 'node_modules']) assert(!fs.existsSync(path.join(installed, name)));
  assert(fs.statSync(path.join(installed, 'lib/provider-credentials.js')).isFile());
  assert(fs.statSync(path.join(installed, 'docs/PROVIDER_CREDENTIALS.md')).isFile());
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(installed, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const consumer = path.join(work, 'consumer'), scope = path.join(consumer, 'node_modules/@mokuyoaxis'); fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(installed, path.join(scope, 'dsh-iris'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const name of ['provider-credential-consumer.mjs', 'provider-env-fetch.mjs', 'provider-credential-directory-consumer.mjs']) fs.copyFileSync(path.join(repo, 'tests/fixtures', name), path.join(consumer, name));
  const result = await execute(process.execPath, ['provider-credential-consumer.mjs'], { cwd: consumer, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '', NODE_OPTIONS: '' } });
  fs.writeFileSync(path.join(out, 'consumer.log'), result.stdout + result.stderr, { mode: 0o600 });
  report.consumer = JSON.parse(result.stdout); assert.equal(report.consumer.ok, true); assert.equal(report.consumer.checks.length, 5);
  const directory = await execute(process.execPath, ['provider-credential-directory-consumer.mjs'], { cwd: consumer, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '', NODE_OPTIONS: '' } });
  fs.writeFileSync(path.join(out, 'directory-consumer.log'), directory.stdout + directory.stderr, { mode: 0o600 });
  report.directory = JSON.parse(directory.stdout); assert.equal(report.directory.ok, true); assert.equal(report.directory.checks.length, 3);
  report.status = 'passed'; save();
  console.log(JSON.stringify({ status: report.status, output: out, checks: report.consumer.checks.length,
    cliProcesses: report.consumer.cliProcesses + report.directory.cliProcesses, directoryChecks: report.directory.checks.length,
    submits: report.consumer.submitCount, polls: report.consumer.pollCount }, null, 2));
} catch (error) {
  fs.writeFileSync(path.join(out, 'failure.log'), (error.stdout || '') + (error.stderr || '') + '\n' + error.stack, { mode: 0o600 });
  report.status = 'failed'; report.failure = error.stack; save(); throw error;
}
