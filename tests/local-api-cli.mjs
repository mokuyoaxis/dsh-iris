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
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).filter(name => fs.lstatSync(path.join(directory, name)).isFile())
    .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
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
  const uninitializedWrites = await failure(['web', 'serve', '--data-root', dataRoot, '--token-file', path.join(root, 'no-web-write'), '--allow-local-writes'], 1);
  assert.match(uninitializedWrites.stderr, /IRIS_CREATION_/);
  assert.equal(fs.existsSync(path.join(root, 'no-web-write')), false, 'explicit writes still require an initialized request root');
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
  await failure(['api', 'serve', '--data-root', dataRoot, '--token-file', path.join(root, 'duplicate-selection'), '--allow-selection', '--allow-selection'], 2);
  assert.equal(fs.existsSync(path.join(root, 'duplicate-selection')), false);

  const completed = await app.execute('flow.continue', { run_id: created.run.id });
  const selectionEvents = readFlowEvents(dataRoot);
  for (const mode of ['api', 'web']) {
    const file = path.join(root, mode + '-selection-token');
    const entry = launch([mode, 'serve', '--data-root', dataRoot, '--token-file', file, '--allow-selection']);
    const selectedSession = await ready(entry), selectedToken = fs.readFileSync(file, 'utf8').trim();
    assert.equal(selectedSession.readOnly, false); assert(!entry.stdout.includes(selectedToken));
    const facts = await query(selectedSession, selectedToken, '/api/v0/session');
    assert.equal(facts.body.connectionManagement, false); assert(facts.body.operations.includes('runs.select'));
    assert(!facts.body.operations.includes('runs.continue') && !facts.body.operations.includes('images.create'));
    const original = (await query(selectedSession, selectedToken, '/api/v0/runs/' + created.run.id)).body;
    const artifactId = mode === 'api' ? source.id : completed.run.output.artifactId;
    const saved = await fetch(selectedSession.origin + '/api/v0/runs/' + created.run.id + '/selection', { method: 'POST',
      headers: { Authorization: 'Bearer ' + selectedToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifactId, expectedRevision: original.revision }) });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).selection.artifactId, artifactId);
    await stop(entry);
    assert.equal((await app.execute('flow.inspect', { run_id: created.run.id })).run.selection.artifactId, artifactId);
    assert.equal(fs.existsSync(path.join(dataRoot, 'creation-requests')), false, 'selection CLI never initializes request storage');
  }
  assert.deepEqual(readFlowEvents(dataRoot), selectionEvents, 'selection-only processes never call the Provider');

  const newRoot = path.join(root, 'explicit-web-writes'), local = createApplicationRuntime({ dataRoot: newRoot });
  try {
    await local.execute('flow.init', {}); await local.execute('execution.init', {});
    const uploadTokenFile = path.join(root, 'upload-token');
    const upload = launch(['web', 'serve', '--data-root', newRoot, '--token-file', uploadTokenFile, '--allow-local-writes']);
    const uploadSession = await ready(upload), uploadToken = fs.readFileSync(uploadTokenFile, 'utf8').trim();
    const available = (await query(uploadSession, uploadToken, '/api/v0/session')).body;
    assert(available.operations.includes('images.create')); assert(!available.operations.includes('runs.select'));
    assert.equal(available.connectionManagement, false);
    const imported = await fetch(uploadSession.origin + '/api/v0/images', { method: 'POST', headers: {
      Authorization: 'Bearer ' + uploadToken, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, body: FLOW_SOURCE });
    assert.equal(imported.status, 201); await imported.json(); await stop(upload);
    const config = path.join(root, 'configured-execution.json');
    fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'configured', enabled: true, name: 'fixture',
      baseUrl: 'https://must-not-contact.invalid/v1', apiKey: 'FIXTURE_EXECUTION_KEY', mediaProtocol: 'openai-chat-images',
      models: [{ id: 'edit', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': ['configured::edit'] } }), { mode: 0o600 });
    const executionTokenFile = path.join(root, 'execution-token');
    const execution = launch(['web', 'serve', '--data-root', newRoot, '--token-file', executionTokenFile,
      '--allow-execution', '--provider-config', config]);
    const executionSession = await ready(execution), executionToken = fs.readFileSync(executionTokenFile, 'utf8').trim();
    const executionInfo = (await query(executionSession, executionToken, '/api/v0/session')).body;
    assert.equal(executionInfo.executionEnabled, true); assert.equal(executionInfo.connectionManagement, false);
    assert(executionInfo.operations.includes('runs.continue')); assert(!executionInfo.operations.includes('runs.select'));
    await stop(execution);
    assert.equal((await local.execute('task.list', {})).total, 0, 'startup/upload never submit generation');
  } finally { await local.dispose(); }
  console.log('local API CLI: real processes, private token output, read-only Core, signal shutdown, restart revocation and argument boundaries OK');
  console.log('selection CLI: independent api/web flags, persisted choices, no implicit request root/Provider, explicit Web creation/execution without connection management OK');
} finally {
  for (const entry of children) await stop(entry);
  await app.dispose();
}
