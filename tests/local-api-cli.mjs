import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-local-api-cli');
const cli = fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url)), children = [];
const dataRoot = path.join(root, 'core'), fixture = imageFlowFixture(dataRoot);
const app = createApplicationRuntime({ dataRoot, ...fixture });
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const file = path.join(item.parentPath, item.name); return [path.relative(directory, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]; }));
}
function launch(args) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  const entry = { child, stdout: '', stderr: '', exited: false }; children.push(entry);
  child.stdout.on('data', bytes => { entry.stdout += bytes; }); child.stderr.on('data', bytes => { entry.stderr += bytes; });
  entry.closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { entry.exited = true; resolve({ code, signal }); });
  });
  return entry;
}
async function ready(entry) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (entry.stdout.includes('\n')) return JSON.parse(entry.stdout.split('\n')[0]);
    if (entry.exited) throw new Error('API CLI exited before startup: ' + entry.stderr);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('API CLI startup timeout');
}
async function stop(entry) {
  if (!entry.exited) entry.child.kill('SIGTERM');
  return entry.closed;
}
async function failure(args, expected) {
  const entry = launch(args), result = await entry.closed;
  assert.equal(result.code, expected); assert.equal(entry.stdout, ''); return entry;
}
async function query(session, token, url) {
  const response = await fetch(session.origin + url, { headers: { Authorization: 'Bearer ' + token } });
  const body = await response.json(); return { response, body };
}

try {
  await app.execute('flow.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const created = await app.execute('flow.create', { model_ref: FLOW_MODEL, source_artifact_id: source.id, prompt: 'Keep the subject' });
  const before = tree(dataRoot), beforeEvents = readFlowEvents(dataRoot), tokenFile = path.join(root, 'first-token');
  const first = launch(['api', 'serve', '--data-root', dataRoot, '--token-file', tokenFile]);
  const session = await ready(first);
  assert.equal(session.readOnly, true); assert.equal(session.contractVersion, 0);
  assert.equal(new URL(session.origin).hostname, '127.0.0.1'); assert.equal(session.tokenFile, tokenFile);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert(/^[A-Za-z0-9_-]{43}$/.test(token));
  if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert(!first.stdout.includes(token)); assert(!first.stderr.includes(token));
  assert(!new URL(session.origin).search);
  const inspected = await query(session, token, '/api/v0/runs/' + created.run.id);
  assert.equal(inspected.response.status, 200); assert.equal(inspected.body.status, 'not_started'); assert.equal(inspected.body.task, null);
  const models = await query(session, token, '/api/v0/models'); assert.equal(models.body.configured, false);
  const refused = await fetch(session.origin + '/api/v0/runs/' + created.run.id + '/continue', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.equal(refused.status, 405); await refused.text();
  assert.deepEqual(tree(dataRoot), before); assert.deepEqual(readFlowEvents(dataRoot), beforeEvents);
  const firstStop = await stop(first);
  if (process.platform === 'win32') assert.equal(firstStop.signal, 'SIGTERM');
  else assert.equal(firstStop.code, 143);
  await assert.rejects(fetch(session.origin + '/api/v0/session'));
  assert.deepEqual(tree(dataRoot), before);

  const secondTokenFile = path.join(root, 'second-token');
  const second = launch(['api', 'serve', '--data-root', dataRoot, '--token-file', secondTokenFile, '--port', new URL(session.origin).port]);
  const restarted = await ready(second), secondToken = fs.readFileSync(secondTokenFile, 'utf8').trim();
  assert(secondToken !== token);
  assert.equal((await query(restarted, token, '/api/v0/session')).response.status, 401);
  assert.equal((await query(restarted, secondToken, '/api/v0/session')).response.status, 200);
  assert(!second.stdout.includes(secondToken)); assert(!second.stderr.includes(secondToken));
  await stop(second);
  const webTokenFile = path.join(root, 'web-token');
  const web = launch(['web', 'serve', '--data-root', dataRoot, '--token-file', webTokenFile]);
  const webSession = await ready(web), webToken = fs.readFileSync(webTokenFile, 'utf8').trim();
  assert.equal(webSession.readOnly, true); assert.match(webSession.message, /只读工作台/);
  assert.equal((await fetch(webSession.origin + '/')).status, 200);
  assert.equal((await fetch(webSession.origin + '/api/v0/session')).status, 401);
  assert.equal((await query(webSession, webToken, '/api/v0/runs/' + created.run.id)).body.status, 'not_started');
  assert(!web.stdout.includes(webToken)); assert(!web.stderr.includes(webToken));
  await stop(web);
  await failure(['web', 'serve', '--data-root', dataRoot, '--token-file', path.join(root, 'no-web-write'), '--allow-local-writes'], 2);
  await failure(['web', 'init', '--data-root', dataRoot], 2);
  const existingBytes = fs.readFileSync(tokenFile);
  const exists = await failure(['api', 'serve', '--data-root', dataRoot, '--token-file', tokenFile], 1);
  assert.match(exists.stderr, /IRIS_API_TOKEN_FILE_UNAVAILABLE/); assert.deepEqual(fs.readFileSync(tokenFile), existingBytes);
  const inside = await failure(['api', 'serve', '--data-root', dataRoot, '--token-file', path.join(dataRoot, 'token')], 1);
  assert.match(inside.stderr, /IRIS_API_TOKEN_FILE_INVALID/); assert.equal(fs.existsSync(path.join(dataRoot, 'token')), false);
  await failure(['api', 'serve', '--data-root', dataRoot], 2);
  await failure(['api', 'serve', '--data-root', dataRoot, '--token-file', 'relative-token'], 2);
  await failure(['api', 'serve', '--data-root', dataRoot, '--token-file', path.join(root, 'invalid-port'), '--port', '65536'], 2);
  await failure(['api', 'serve', '--data-root', dataRoot, '--token-file', path.join(root, 'invalid-host'), '--host', '0.0.0.0'], 2);
  const missingRoot = path.join(root, 'missing');
  await failure(['api', 'serve', '--data-root', missingRoot, '--token-file', path.join(root, 'missing-token')], 2);
  assert.equal(fs.existsSync(missingRoot), false); assert.equal(fs.existsSync(path.join(root, 'missing-token')), false);
  assert.deepEqual(tree(dataRoot), before); assert.deepEqual(readFlowEvents(dataRoot), beforeEvents);
  console.log('local API CLI: real processes, private token output, read-only Core, signal shutdown, restart revocation and argument boundaries OK');
} finally {
  for (const entry of children) await stop(entry);
  await app.dispose();
}
