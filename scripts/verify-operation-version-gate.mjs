/** Actual released 0.2.7 CLI versus the new v1 root. All data/configuration is isolated. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from '../tests/fixtures/image-flow-fixture.mjs';

const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Usage: --baseline-cli <absolute-0.2.7-cli> --output <new-absolute-directory>');
assert.equal(args[0], '--baseline-cli'); assert.equal(args[2], '--output');
assert(path.isAbsolute(args[1]) && path.isAbsolute(args[3]));
const baselineCli = fs.realpathSync(args[1]), baselineRoot = path.dirname(path.dirname(baselineCli)), out = args[3];
const pkg = JSON.parse(fs.readFileSync(path.join(baselineRoot, 'package.json'), 'utf8'));
assert.equal(pkg.version, '0.2.7'); assert(!fs.existsSync(path.join(baselineRoot, 'lib/operation-store.js')), 'use released baseline, not the unreleased working tree');
fs.mkdirSync(out, { mode: 0o700 });
const dataRoot = path.join(out, 'core'), unusedDsh = path.join(out, 'unused-dsh-home'), fixture = imageFlowFixture(dataRoot);
const app = createApplicationRuntime({ dataRoot, ...fixture });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tree = root => Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(name => {
  const file = path.join(root, name), stat = fs.lstatSync(file);
  return [name, { mode: stat.mode & 0o777, ...(stat.isFile() ? { sha256: sha(fs.readFileSync(file)) }
    : stat.isDirectory() ? { directory: true } : { link: fs.readlinkSync(file) }) }];
}));
const report = { status: 'running', baseline: { version: pkg.version, cli: baselineCli,
  cliSha256: sha(fs.readFileSync(baselineCli)), coreRuntimeSha256: sha(fs.readFileSync(path.join(baselineRoot, 'lib/core-runtime.js'))) },
  attempts: [], actualPaidCalls: 0, dailyDshTouched: false };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
function run(args, status) {
  const result = spawnSync(process.execPath, [baselineCli, ...args], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', DSH_HOME: unusedDsh, IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  report.attempts.push({ args, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }); save();
  assert(!result.error, result.error?.message); assert.equal(result.status, status, result.stderr);
  return result;
}
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const facts = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'Version gate fixture; no generation' });
  const accepted = await app.execute('operation.accept', { key: crypto.randomUUID(), runId: facts.run.id,
    expectedRunRevision: 1, ownerInstanceId: crypto.randomUUID() });
  const imageFile = path.join(out, 'source.png'); fs.writeFileSync(imageFile, FLOW_SOURCE, { mode: 0o600 });
  const before = tree(dataRoot), events = readFlowEvents(dataRoot), flags = ['--data-root', dataRoot];
  const read = run(['flow', 'inspect', facts.run.id, ...flags], 0);
  assert.equal(JSON.parse(read.stdout).status, 'not_started');
  for (const args of [
    ['artifact', 'import', ...flags, '--input', JSON.stringify({ image_path: imageFile })],
    ['flow', 'continue', facts.run.id, ...flags],
    ['core', 'restore', 'delete_' + '0'.repeat(24), ...flags]
  ]) {
    const rejected = run(args, 1); assert.match(rejected.stderr, /IRIS_CREATION_STORE_INVALID/);
    assert.deepEqual(tree(dataRoot), before, 'old writer leaves all v1 business and Operation files unchanged');
  }
  assert.deepEqual(readFlowEvents(dataRoot), events); assert(!fs.existsSync(unusedDsh));
  assert.equal((await app.execute('operation.inspect', { id: accepted.operation.id })).operation.state, 'queued');
  report.before = before; report.after = tree(dataRoot);
  report.checks = { oldReaderWorks: true, oldWritersRejected: 3, coreAndOperationBytesAndModesUnchanged: true,
    noProviderCalls: true, noAutomaticReplay: true, noDailyDshHomeCreated: true, snapshotsUseLstat: true };
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; }
finally { await app.dispose(); save(); console.log(JSON.stringify({ status: report.status, attempts: report.attempts.length, output: out,
  ...(report.failure ? { failure: report.failure } : {}) }, null, 2)); }
