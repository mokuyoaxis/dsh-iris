import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectCreationRoot, listCreationRequests } from '../lib/creation-request-store.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-creation-cli');
const cli = fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url));
const dataRoot = path.join(root, 'core'), app = createApplicationRuntime({ dataRoot }), children = [];
function run(args, code = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, code, result.stderr); return result.stdout ? JSON.parse(result.stdout) : result.stderr;
}
async function start(tokenFile, extra = []) {
  const child = spawn(process.execPath, [cli, 'api', 'serve', '--data-root', dataRoot, '--token-file', tokenFile, ...extra],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { child, stdout: '', stderr: '', exited: false }; children.push(entry);
  child.stdout.on('data', data => { entry.stdout += data; }); child.stderr.on('data', data => { entry.stderr += data; });
  entry.closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { entry.exited = true; resolve({ code, signal }); }); });
  const deadline = Date.now() + 15000;
  while (!entry.stdout.includes('\n') && !entry.exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert(entry.stdout.includes('\n'), 'CLI startup failed: ' + entry.stderr);
  entry.session = JSON.parse(entry.stdout.split('\n')[0]); entry.token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert(!entry.stdout.includes(entry.token)); assert(!entry.stderr.includes(entry.token));
  if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  return entry;
}
async function stop(entry) { if (!entry.exited) entry.child.kill('SIGTERM'); return entry.closed; }
const requestKey = crypto.randomUUID();
async function upload(entry) {
  const response = await fetch(entry.session.origin + '/api/v0/images', { method: 'POST', headers: {
    Authorization: 'Bearer ' + entry.token, 'Content-Type': 'image/png', 'Idempotency-Key': requestKey
  }, body: FLOW_SOURCE });
  return { status: response.status, body: await response.json() };
}
try {
  await app.execute('flow.init', {});
  const initialized = run(['api', 'init', '--data-root', dataRoot]);
  assert.equal(initialized.root.kind, 'iris-creation-requests');
  assert.deepEqual(run(['api', 'init', '--data-root', dataRoot]), initialized);
  const first = await start(path.join(root, 'first-token'), ['--allow-local-writes']);
  assert.equal(first.session.readOnly, false);
  const uploaded = await upload(first); assert.equal(uploaded.status, 201);
  const stopped = await stop(first);
  if (process.platform === 'win32') assert.equal(stopped.signal, 'SIGTERM'); else assert.equal(stopped.code, 143);
  assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  const second = await start(path.join(root, 'second-token'), ['--allow-local-writes']);
  assert.notEqual(first.token, second.token);
  const replay = await upload(second); assert.equal(replay.status, 200);
  assert.equal(replay.body.artifact.artifactId, uploaded.body.artifact.artifactId);
  await stop(second);
  const readonly = await start(path.join(root, 'readonly-token'));
  assert.equal(readonly.session.readOnly, true); assert.equal((await upload(readonly)).status, 405); await stop(readonly);
  assert.deepEqual(inspectCreationRoot(dataRoot), initialized.root);
  assert.equal(listCreationRequests(dataRoot).length, 1); assert.equal(listCoreTasks(dataRoot).total, 0);
  run(['api', 'serve', '--data-root', dataRoot, '--token-file', path.join(root, 'bad'), '--allow-local-writes', '--allow-local-writes'], 2);
  run(['api', 'init', '--data-root', 'relative'], 2);
  run(['api', 'init', '--data-root', path.join(root, 'missing')], 2);
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
  console.log('local creation CLI: explicit init/write flag, default read-only, private Token, cross-process Key replay and graceful POSIX shutdown OK');
} finally { for (const entry of children) await stop(entry); await app.dispose(); }
