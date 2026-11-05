// Actual Core + independent Provider archives. Template business uses only public SDK/CLI/HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNetworkProxyFixture } from '../tests/fixtures/network-proxy-fixture.mjs';

const args = process.argv.slice(2);
assert([4, 6].includes(args.length) && args[0] === '--package' && args[2] === '--output'
  && (args.length === 4 || args[4] === '--baseline'), 'Usage: --package <absolute-Core-tgz> --output <new-absolute-directory> [--baseline <old-Core-tgz>]');
for (const index of [1, 3, ...(args.length === 6 ? [5] : [])]) assert(path.isAbsolute(args[index]));
const repo = fileURLToPath(new URL('..', import.meta.url)), out = args[3]; fs.mkdirSync(out, { mode: 0o700 });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-provider-archives-')); fs.chmodSync(work, 0o700);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { status: 'running', work, paidCalls: 0, freshDependencyInstall: false, checks: [], coreArchiveSha256: hash(args[1]) };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const execute = promisify(execFile); let sequence = 0, fixture;
async function run(command, argv, cwd = work, timeout = 30000) {
  const log = path.join(out, String(++sequence).padStart(2, '0') + '.log');
  try {
    const result = await execute(command, argv, { cwd, timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '', NODE_OPTIONS: '' } });
    fs.writeFileSync(log, result.stdout + result.stderr, { mode: 0o600 }); return result.stdout;
  } catch (error) { fs.writeFileSync(log, (error.stdout || '') + (error.stderr || '') + '\n' + error.message, { mode: 0o600 }); throw error; }
}
async function unpack(archive, target) {
  fs.mkdirSync(target); await run('tar', ['-xzf', archive, '-C', target]); return path.join(target, 'package');
}
async function core(archive, label) {
  const directory = await unpack(archive, path.join(work, label));
  for (const name of ['.internal', 'node_modules', 'tests', 'scripts']) assert(!fs.existsSync(path.join(directory, name)), name + ' must not be packed at package root');
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return directory;
}
async function consumer(coreDirectory, archive, label) {
  const root = path.join(work, label), scope = path.join(root, 'node_modules/@mokuyoaxis'); fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(coreDirectory, path.join(scope, 'dsh-iris'), process.platform === 'win32' ? 'junction' : 'dir');
  const project = await unpack(archive, path.join(root, 'plugin'));
  const resolved = (await run(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('@mokuyoaxis/dsh-iris/plugins'))"], project)).trim();
  const metadata = JSON.parse(fs.readFileSync(path.join(coreDirectory, 'package.json')));
  assert.equal(resolved, pathToFileURL(path.resolve(coreDirectory, metadata.exports['./plugins'].default)).href);
  return { project, resolved, version: metadata.version };
}
try {
  save(); const installed = await core(args[1], 'candidate-core');
  const source = path.join(installed, 'templates/provider-starter'), packaging = path.join(work, 'packaging');
  fs.cpSync(source, packaging, { recursive: true });
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], packaging))[0];
  const paths = packed.files.map(item => item.path);
  for (const item of ['index.mjs', 'index.d.mts', 'scripts/setup.mjs', 'scripts/protocol-smoke.mjs', 'scripts/smoke.mjs', 'README.md', 'LICENSE']) assert(paths.includes(item), item);
  assert(!paths.some(name => /(^|\/)(node_modules|\.internal|core|connections)(\/|$)|\.tgz$/.test(name)));
  const archive = path.join(out, packed.filename);
  report.plugin = { archive, sha256: hash(archive), files: paths }; save();
  const current = await consumer(installed, archive, 'consumer');
  report.current = current;
  report.protocol = JSON.parse(await run(process.execPath, ['scripts/protocol-smoke.mjs'], current.project)); assert.equal(report.protocol.ok, true);
  fs.mkdirSync(path.join(out, 'proxy-fixture'));
  fixture = await createNetworkProxyFixture(path.join(out, 'proxy-fixture'));
  const proxy = await fixture.createProxy({ tag: 'provider-template' });
  report.smoke = JSON.parse(await run(process.execPath, ['scripts/smoke.mjs', '--proxy-url', proxy.url], current.project, 110000));
  assert.equal(report.smoke.ok, true); assert.equal(report.smoke.checks.length, 9); assert.equal(report.smoke.peakHttp, 2);
  assert.equal(report.smoke.proxy, 'explicit-loopback-CONNECT');
  assert(proxy.connects.length >= 2); assert.deepEqual(fixture.errors, []);
  assert(proxy.connects.every(row => !JSON.stringify(row.headers).includes('synthetic-b4-starter-key')));
  report.proxy = { protocol: 'http-CONNECT', connects: proxy.connects.length, providerKeyAbsentFromProxyHeaders: true };
  report.checks.push('separate Provider tarball uses only the actual candidate public exports and passes protocol boundaries');
  report.checks.push('actual CLI/Web/API/formal HTTP MCP with public network setup, real CONNECT, scheduling, exact dependency recovery, unknown acceptance and reduced authority pass outside the repository'); save();
  if (args[5]) {
    report.baselineArchiveSha256 = hash(args[5]);
    const previous = await core(args[5], 'previous-core'), old = await consumer(previous, archive, 'previous-consumer');
    let rejected = false;
    try { await run(process.execPath, ['scripts/setup.mjs', '--directory', path.join(work, 'must-not-exist'), '--endpoint', 'http://127.0.0.1:1', '--credential-env', 'IRIS_B4_NOT_A_REAL_KEY'], old.project); }
    catch (error) { assert.match(error.stderr || '', /requires Iris Provider factory context v1/); rejected = true; }
    assert(rejected); assert(!fs.existsSync(path.join(work, 'must-not-exist')));
    report.baseline = { ...old, rejectedBeforeSetup: true }; report.checks.push('older Core with the same npm version is explicitly rejected by feature marker before any file or HTTP operation');
  }
  report.status = 'passed'; save(); console.log(JSON.stringify({ status: report.status, output: out, pluginFiles: paths.length, checks: report.checks }, null, 2));
} catch (error) { report.status = 'failed'; report.failure = error.stack; save(); throw error; }
finally { await fixture?.close(); }
