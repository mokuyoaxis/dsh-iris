// Actual archives, independent consumer directories and cached dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert([4, 6].includes(args.length) && args[0] === '--package' && args[2] === '--output'
  && (args.length === 4 || args[4] === '--baseline'), 'Usage: --package <absolute-tgz> --output <new-absolute-directory> [--baseline <published-alpha.1-tgz>]');
for (const index of [1, 3, ...(args.length === 6 ? [5] : [])]) assert(path.isAbsolute(args[index]));
const repo = fileURLToPath(new URL('..', import.meta.url)), out = args[3]; fs.mkdirSync(out, { mode: 0o700 });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-starter-archives-')); fs.chmodSync(work, 0o700);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { status: 'running', work, paidCalls: 0, freshDependencyInstall: false, checks: [], coreArchiveSha256: hash(args[1]) };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const execute = promisify(execFile); let sequence = 0;
async function run(command, argv, cwd = work, timeout = 30_000) {
  const log = path.join(out, String(++sequence).padStart(2, '0') + '.log');
  try {
    const result = await execute(command, argv, { cwd, timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '', NODE_OPTIONS: '' } });
    fs.writeFileSync(log, result.stdout + result.stderr, { mode: 0o600 }); return result.stdout;
  } catch (error) {
    fs.writeFileSync(log, (error.stdout || '') + (error.stderr || '') + '\n' + error.message, { mode: 0o600 }); throw error;
  }
}
async function unpack(archive, target) {
  fs.mkdirSync(target); await run('tar', ['-xzf', archive, '-C', target]); return path.join(target, 'package');
}
async function core(archive, label) {
  const directory = await unpack(archive, path.join(work, label));
  for (const name of ['.internal', 'node_modules', 'tests', 'scripts']) assert(!fs.existsSync(path.join(directory, name)), name + ' must not be packed at package root');
  // Reuse installed production dependencies without installing or replacing any.
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return directory;
}
async function consume(coreDirectory, pluginArchive, label) {
  const consumer = path.join(work, label); fs.mkdirSync(consumer);
  const scope = path.join(consumer, 'node_modules/@mokuyoaxis'); fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(coreDirectory, path.join(scope, 'dsh-iris'), process.platform === 'win32' ? 'junction' : 'dir');
  const project = await unpack(pluginArchive, path.join(consumer, 'plugin'));
  const resolved = await run(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('@mokuyoaxis/dsh-iris/plugins'))"], project);
  const metadata = JSON.parse(fs.readFileSync(path.join(coreDirectory, 'package.json')));
  assert.equal(resolved.trim(), pathToFileURL(path.resolve(coreDirectory, metadata.exports['./plugins'].default)).href,
    'consumer must resolve the public export of the actual archive');
  const stdout = await run(process.execPath, ['scripts/smoke.mjs'], project, 110_000), result = JSON.parse(stdout);
  assert.equal(result.ok, true); assert.equal(result.checks.length, 9);
  const inspection = JSON.parse(await run(process.execPath, [path.resolve(coreDirectory, metadata.bin['dsh-iris']),
    'plugins', 'inspect', '--plugin-config', path.join(result.work, 'demo/plugins.json')], project));
  assert.equal(inspection.plugins[0].id, 'example.starter-board');
  assert.equal(inspection.contributions.pages[0].access.web, 'available-in-panel');
  assert.equal(inspection.contributions.renderers[0].id, 'example.starter-board.png');
  return { project, coreVersion: metadata.version, sdk: resolved.trim(), startupInspected: true, ...result };
}
try {
  save();
  const installed = await core(args[1], 'current-core');
  const source = path.join(installed, 'templates/plugin-starter');
  assert(fs.statSync(path.join(source, 'scripts/smoke.mjs')).isFile());
  const packaging = path.join(work, 'packaging-plugin'); fs.cpSync(source, packaging, { recursive: true });
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], packaging))[0];
  const paths = packed.files.map(item => item.path);
  for (const name of ['index.mjs', 'web/board.mjs', 'web/board.css', 'web/png.mjs', 'assets/violet.png', 'assets/peach.png', 'scripts/setup.mjs', 'scripts/smoke.mjs', 'LICENSE']) assert(paths.includes(name), name);
  assert(!paths.some(name => /(^|\/)(node_modules|\.internal|core|connections)(\/|$)|\.tgz$/.test(name)));
  const pluginArchive = path.join(out, packed.filename);
  report.plugin = { archive: pluginArchive, sha256: hash(pluginArchive), files: paths }; save();
  report.current = await consume(installed, pluginArchive, 'current-consumer');
  report.checks.push('Core archive ships a copyable template; separately packed plugin exposes real browser assets and passes nine outside acceptance checks'); save();
  if (args[5]) {
    report.baselineArchiveSha256 = hash(args[5]);
    const baseline = await core(args[5], 'released-core');
    report.baseline = await consume(baseline, pluginArchive, 'released-consumer');
    report.checks.push('the same independent plugin archive passes against the actual published alpha.1 Core, without pretending a newer source tree is the minimum version');
  }
  report.status = 'passed'; save();
  console.log(JSON.stringify({ status: report.status, output: out, pluginFiles: paths.length,
    currentProject: report.current.project, baselineProject: report.baseline?.project, checks: report.checks }, null, 2));
} catch (error) { report.status = 'failed'; report.failure = error.stack; save(); throw error; }
