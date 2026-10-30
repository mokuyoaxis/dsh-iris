import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreRuntime, inspectCoreWriterLease } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { inspectCoreTransactions, restoreCoreTransaction } from '../lib/core-maintenance.js';
import { loadCorePluginRegistry, createCorePluginWorkbench } from '../lib/plugins.js';
import { FLOW_SOURCE, FLOW_RESULT } from './fixtures/image-flow-fixture.mjs';

const work = fs.mkdtempSync(path.join(process.env.IRIS_TEST_EVIDENCE_DIRECTORY || os.tmpdir(), 'iris-maintenance-read-'));
const dataRoot = path.join(work, 'core'), app = createApplicationRuntime({ dataRoot }), children = [], checks = [];
const fixture = fileURLToPath(new URL('./fixtures/maintenance-writer-window.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url));
const inventory = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => { const file = path.join(entry.parentPath, entry.name); return [path.relative(dataRoot, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]; }));
let registry, api, started;
function launch(artifactId, mode, transactionId = '') {
  const gate = path.join(work, 'continue-' + crypto.randomUUID());
  const child = spawn(process.execPath, [fixture, dataRoot, artifactId, gate, mode, transactionId], { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { child, gate, stdout: '', stderr: '', exited: false }; children.push(entry);
  entry.closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { entry.exited = true; resolve({ code, signal }); });
  });
  entry.paused = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('writer did not reach checkpoint')), 10000);
    child.stdout.on('data', bytes => { entry.stdout += bytes; if (entry.stdout.includes('PAUSED\n')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', bytes => { entry.stderr += bytes; });
    entry.closed.then(() => { clearTimeout(timer); reject(Error('writer exited before checkpoint: ' + entry.stderr)); }, reject);
  });
  return entry;
}
async function release(entry) {
  fs.writeFileSync(entry.gate, 'continue');
  assert.equal((await entry.closed).code, 0, entry.stderr);
  return JSON.parse(entry.stdout.trim().split('\n').at(-1));
}
async function catalog() {
  const response = await fetch(started.origin + '/api/v0/plugin-operations/catalog', { headers: { Authorization: 'Bearer ' + started.accessToken } });
  return { status: response.status, body: await response.json() };
}
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const first = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const second = (await app.execute('artifact.import', { image_bytes: FLOW_RESULT })).artifact;
  registry = await loadCorePluginRegistry({ entries: [fileURLToPath(new URL('../plugins/contact-sheet/index.mjs', import.meta.url))] });
  api = createCorePluginWorkbench({ dataRoot, registry, allowedOperations: ['community.contact-sheet.create'] });
  started = await api.start();

  const writer = createCoreRuntime({ dataRoot, mode: 'writer' }); writer.start();
  try {
    assert.equal((await app.execute('artifact.list', {})).total, 2, 'healthy reads remain available while a writer owns the root');
    const index = path.join(dataRoot, 'artifact-store/v0/index.json'), indexBytes = fs.readFileSync(index);
    fs.writeFileSync(index, '{invalid');
    await assert.rejects(app.execute('artifact.list', {}), { code: 'IRIS_ARTIFACT_INDEX_INVALID' });
    fs.writeFileSync(index, indexBytes);
    const record = path.join(dataRoot, 'artifact-store/v0/records', second.id + '.json'), original = fs.readFileSync(record);
    fs.writeFileSync(record, '{invalid');
    await assert.rejects(app.execute('artifact.list', {}), { code: 'IRIS_ARTIFACT_INDEX_INVALID' });
    fs.writeFileSync(record, original);
  } finally { await writer.dispose(); }
  checks.push('healthy concurrent reads succeed; corrupt index and existing corrupt record still fail under an active writer');

  const removing = launch(first.id, 'delete'); await removing.paused;
  const beforeRead = inventory();
  await assert.rejects(app.execute('artifact.list', {}), error => error.code === 'IRIS_CORE_DATA_ROOT_BUSY'
    && error.cause?.code === 'IRIS_ARTIFACT_INDEX_INVALID');
  const response = await catalog(); assert.equal(response.status, 409); assert.equal(response.body.error.code, 'IRIS_API_ROOT_BUSY');
  const command = spawnSync(process.execPath, [cli, 'artifact', 'list', '--data-root', dataRoot], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, IRIS_CORE_CONNECTION_FILE: '', IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  assert.equal(command.status, 1, command.stderr); assert.match(command.stderr, /IRIS_CORE_DATA_ROOT_BUSY/);
  assert.deepEqual(inventory(), beforeRead, 'reads must neither repair nor rewrite any writer evidence or store file');
  const removed = await release(removing); assert.equal((await app.execute('artifact.list', {})).total, 1);
  checks.push('a second process paused during quarantine yields explicit busy through App, HTTP and CLI, with no read-side changes');

  const restoring = launch(first.id, 'restore', removed.transactionId); await restoring.paused;
  assert.equal((await app.execute('artifact.list', {})).total, 1, 'a partial restoration stays outside the published index');
  await release(restoring); assert.equal((await app.execute('artifact.list', {})).total, 2);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, first.id).bytes, FLOW_SOURCE);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, second.id).bytes, FLOW_RESULT);
  checks.push('committed deletion and restoration produce valid lists and preserve both original images');

  const record = path.join(dataRoot, 'artifact-store/v0/records', first.id + '.json'), savedRecord = path.join(work, 'preserved-record.json');
  fs.renameSync(record, savedRecord);
  await assert.rejects(app.execute('artifact.list', {}), { code: 'IRIS_ARTIFACT_INDEX_INVALID' });
  fs.renameSync(savedRecord, record);
  checks.push('a genuinely missing record without a writer remains an index error');

  const previousTransactions = new Set(inspectCoreTransactions(dataRoot).map(item => item.transactionId));
  const interrupted = launch(first.id, 'delete'); await interrupted.paused;
  interrupted.child.kill('SIGKILL'); const closed = await interrupted.closed;
  if (process.platform !== 'win32') assert.equal(closed.signal, 'SIGKILL');
  assert.equal(inspectCoreWriterLease(dataRoot).ownerStatus, 'missing');
  await assert.rejects(app.execute('artifact.list', {}), { code: 'IRIS_ARTIFACT_INDEX_INVALID' });
  const transaction = inspectCoreTransactions(dataRoot).find(item => !previousTransactions.has(item.transactionId));
  recoverCoreWriterLease(dataRoot, { confirmStalePid: interrupted.child.pid });
  const recovery = createCoreRuntime({ dataRoot, mode: 'writer' }); recovery.start();
  try { await recovery.run('execute', ({ dataRoot }) => restoreCoreTransaction(dataRoot, transaction.transactionId)); }
  finally { await recovery.dispose(); }
  assert.equal((await app.execute('artifact.list', {})).total, 2);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, first.id).bytes, FLOW_SOURCE);
  checks.push('a dead writer is not disguised as temporary busy; explicit lease recovery and transaction restore retain original bytes');
  console.log(JSON.stringify({ ok: true, checks, work }, null, 2));
} finally {
  for (const entry of children) {
    if (!entry.exited) { fs.writeFileSync(entry.gate, 'continue'); await entry.closed; }
  }
  await api?.dispose(); await registry?.dispose(); await app.dispose();
}
