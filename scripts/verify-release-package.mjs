// Linux/POSIX release check: exercise the actual archive, not repository imports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
assert(args.length === 8 && args[0] === '--package' && args[2] === '--output'
  && args[4] === '--typescript' && args[6] === '--browser-executable',
  'Usage: --package <absolute-tgz> --output <new-absolute-directory> --typescript <absolute-tsc.js> --browser-executable <absolute-Chromium>');
for (const index of [1, 3, 5, 7]) assert(path.isAbsolute(args[index]));
const root = fileURLToPath(new URL('..', import.meta.url)), out = args[3];
fs.mkdirSync(out, { mode: 0o700 });
const report = { status: 'running', archiveSha256: createHash('sha256').update(fs.readFileSync(args[1])).digest('hex'), checks: [], paidCalls: 0 };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
async function check(name, values, cwd, timeoutMs) {
  const log = fs.openSync(path.join(out, name + '.log'), 'wx', 0o600), started = performance.now();
  const child = spawn(process.execPath, values, { cwd, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, NODE_OPTIONS: '', IRIS_CORE_CONNECTION_FILE: '', IRIS_CORE_SCOPES: '',
      IRIS_IMPORT_WORKBENCH_CONFIG: '', DSH_HOME: path.join(out, 'unused-dsh-home') } });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; process.kill(-child.pid, 'SIGTERM'); }, timeoutMs);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ error: error.code }));
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  clearTimeout(timer); fs.closeSync(log);
  const elapsedMs = Math.round(performance.now() - started);
  const record = { name, ...result, timedOut, timeoutMs, elapsedMs,
    ...(timedOut ? { timerLatenessMs: Math.max(0, elapsedMs - timeoutMs) } : {}) };
  report.checks.push(record); save(); console.log(JSON.stringify(record));
  const succeeded = result.status === 0 && !result.signal && !result.error && !timedOut;
  if (!succeeded) {
    console.error(fs.readFileSync(path.join(out, name + '.log'), 'utf8'));
    const browserLog = path.join(out, name, 'browser.log');
    if (fs.existsSync(browserLog)) console.error(fs.readFileSync(browserLog, 'utf8'));
  }
  assert(succeeded,
    name + ' failed; inspect ' + path.join(out, name + '.log'));
}
try {
  save();
  assert(fs.statSync(args[5]).isFile(), 'TypeScript compiler is required');
  assert(fs.statSync(args[7]).isFile(), 'Chromium executable is required');
  const unpacked = path.join(out, 'unpacked'); fs.mkdirSync(unpacked);
  execFileSync('tar', ['-xzf', args[1], '-C', unpacked]);
  const installed = path.join(unpacked, 'package');
  for (const name of ['.internal', '.git', 'tests', 'scripts', 'node_modules']) assert(!fs.existsSync(path.join(installed, name)), name + ' must not be distributed');
  for (const name of fs.readdirSync(installed, { recursive: true })) {
    const file = path.join(installed, name);
    if (fs.statSync(file).isFile()) assert(fs.readFileSync(file).equals(fs.readFileSync(path.join(root, name))), 'archive differs from source: ' + name);
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
  const harness = path.join(out, 'browser-harness'); fs.mkdirSync(harness);
  fs.mkdirSync(path.join(harness, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/verify-local-web-browser.mjs'), path.join(harness, 'scripts/verify-local-web-browser.mjs'));
  fs.cpSync(path.join(root, 'tests'), path.join(harness, 'tests'), { recursive: true });
  fs.copyFileSync(path.join(installed, 'package.json'), path.join(harness, 'package.json'));
  for (const name of ['lib', 'bin', 'docs', 'plugins', 'templates', '.dsh', 'skills', 'node_modules']) {
    if (fs.existsSync(path.join(installed, name))) fs.symlinkSync(path.join(installed, name), path.join(harness, name), 'dir');
  }
  const checks = [
    ['core-sdk', ['scripts/verify-core-plugins-package.mjs', '--package', args[1], '--output', path.join(out, 'core-sdk'), '--typescript', args[5]]],
    ['provider-starter', ['scripts/verify-provider-starter-package.mjs', '--package', args[1], '--output', path.join(out, 'provider-starter')]],
    ['credentials', ['scripts/verify-provider-credentials-package.mjs', '--package', args[1], '--output', path.join(out, 'credentials')]],
    ['scheduling', ['scripts/verify-scheduling-package.mjs', '--package-root', installed, '--output', path.join(out, 'scheduling')]]
  ];
  for (const [name, values] of checks) await check(name, values, root, 150000);
  for (const name of ['overview', 'provider-credentials', 'video', 'scheduling']) {
    await check('browser-' + name, ['scripts/verify-local-web-browser.mjs', '--browser-executable', args[7],
      '--output', path.join(out, 'browser-' + name), '--no-sandbox', '--' + name], harness, 120000);
  }
  report.status = 'passed'; save();
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; save(); throw error;
}
