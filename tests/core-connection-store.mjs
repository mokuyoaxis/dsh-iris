import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectExecutionRoot } from '../lib/operation-store.js';
import { createManagedConnectionStore } from '../lib/core-connection-store.js';
import { readPrivateConnectionJson } from '../lib/core-connections.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-connection-store'), dataRoot = path.join(root, 'core');
const app = createApplicationRuntime({ dataRoot }), stores = [];
const directory = path.join(root, 'managed'), changes = [];
let rootId;
const make = (options = {}) => {
  const store = createManagedConnectionStore({ directory, dataRoot, rootId, getOrigin: () => 'http://127.0.0.1:3210',
    onChange: (grant, id) => changes.push({ grant, id }), ...options }); stores.push(store); return store;
};
const snapshot = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile())
  .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, name))).digest('hex')]));
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {}); await app.dispose();
  rootId = inspectExecutionRoot(dataRoot).rootId;
  const before = snapshot(), store = make(); assert(!fs.existsSync(directory));
  await store.start(); assert.deepEqual(store.list(), []);
  const second = make(); await assert.rejects(second.start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
  const forbidden = make({ directory: path.join(dataRoot, 'managed') });
  await assert.rejects(forbidden.start(), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  assert(!fs.existsSync(path.join(dataRoot, 'managed')));
  const physicalForbidden = make({ dataRoot: fs.realpathSync.native(dataRoot), directory: path.join(dataRoot, 'native-managed') });
  await assert.rejects(physicalForbidden.start(), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  assert(!fs.existsSync(path.join(dataRoot, 'native-managed')));
  const input = { key: crypto.randomUUID(), label: 'Free harness / workspace', scopes: ['read'], capabilities: ['image-edit'] };
  const result = store.create(input); assert.equal(result.connectionId, input.key); assert.equal(result.idempotentReplay, false);
  const file = path.join(directory, 'profiles', input.key + '.json'), original = fs.readFileSync(file);
  const token = readPrivateConnectionJson(file).accessToken;
  assert.equal(store.create(input).idempotentReplay, true); assert.deepEqual(fs.readFileSync(file), original);
  assert.throws(() => store.create({ ...input, label: 'different' }), { code: 'IRIS_CONNECTION_CONFIG_CHANGED' });
  for (const value of [{ ...input, key: crypto.randomUUID(), scopes: [] }, { ...input, key: crypto.randomUUID(), capabilities: ['video'] },
    { ...input, key: crypto.randomUUID(), label: '\nunsafe' }, { ...input, key: crypto.randomUUID(), capabilities: [], tools: ['iris_core_image'] },
    { ...input, key: crypto.randomUUID(), accessToken: 'injected' }]) {
    assert.throws(() => store.create(value), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  }
  const exported = store.exportConfig(input.key, { transport: 'stdio', format: 'mcpServers' });
  const clientFile = exported.configuration.mcpServers.iris.args[exported.configuration.mcpServers.iris.args.indexOf('--connection-file') + 1];
  assert.equal(readPrivateConnectionJson(clientFile).accessToken, token); assert.equal(exported.containsCredentials, false);
  assert.equal(store.exportConfig(input.key, { transport: 'http', format: 'entry' }).configuration.headers.Authorization, 'Bearer ' + token);
  const clientBytes = fs.readFileSync(clientFile); fs.writeFileSync(clientFile, clientBytes.toString() + ' ');
  assert.throws(() => store.exportConfig(input.key, { transport: 'stdio', format: 'mcpServers' }), { code: 'IRIS_CONNECTION_CONFIG_CHANGED' });
  assert.equal(fs.readFileSync(clientFile, 'utf8'), clientBytes.toString() + ' '); fs.writeFileSync(clientFile, clientBytes);
  assert(!JSON.stringify(store.list()).includes(token)); assert(!JSON.stringify(store.list()).includes(directory));
  if (process.platform !== 'win32') {
    for (const name of ['', 'profiles', 'clients', 'ownership']) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(clientFile).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644); assert.throws(() => store.revoke(input.key, { expectedRevision: 1 }), { code: 'IRIS_CONNECTION_CONFIG_INVALID' }); fs.chmodSync(file, 0o600);
    const link = path.join(root, 'linked'); fs.symlinkSync(directory, link);
    await assert.rejects(make({ directory: link }).start(), { code: 'IRIS_CONNECTION_CONFIG_INVALID' });
  }
  fs.writeFileSync(file, original.toString() + ' ');
  assert.throws(() => store.update(input.key, { ...input, key: undefined, expectedRevision: 1 }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  assert.throws(() => store.revoke(input.key, { expectedRevision: 1 }), { code: 'IRIS_CONNECTION_CONFIG_CHANGED' });
  assert.equal(fs.readFileSync(file, 'utf8'), original.toString() + ' ', 'external edits never overwritten'); fs.writeFileSync(file, original);
  const edit = { expectedRevision: 1, label: 'Renamed', scopes: ['read'], capabilities: [], tools: [] };
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('controlled write failure'), { code: 'EIO' }); return rename(from, to); };
    assert.throws(() => store.update(input.key, edit), { code: 'EIO' });
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), original); assert.equal(store.list()[0].revision, 1, 'failed commit cannot publish a new grant');
  assert.equal(store.update(input.key, edit).revision, 2);
  assert.throws(() => store.update(input.key, edit), { code: 'IRIS_CONNECTION_CONFIG_CHANGED' });
  store.observe(input.key, { clientInfo: { name: 'Arbitrary client', version: '42' }, source: 'client-declared', transport: 'http', at: new Date().toISOString() });
  assert.equal(store.list()[0].state, 'used'); assert.equal(store.list()[0].revision, 2);
  const currentFile = fs.readFileSync(file); store.observe(input.key, { ...store.list()[0].lastContact, at: new Date().toISOString() });
  assert.deepEqual(fs.readFileSync(file), currentFile, 'identical frequent declarations do not rewrite');
  assert.equal(readPrivateConnectionJson(clientFile).label, input.label, 'old client exports remain immutable');
  store.revoke(input.key, { expectedRevision: 2 }); assert.equal(changes.at(-1).grant, null);
  assert.equal(store.revoke(input.key, { expectedRevision: 2 }).idempotentReplay, true);
  assert.throws(() => store.exportConfig(input.key, { transport: 'stdio', format: 'entry' }), { code: 'IRIS_CONNECTION_REVOKED' });
  assert.throws(() => store.update(input.key, { ...edit, expectedRevision: 3 }), { code: 'IRIS_CONNECTION_REVOKED' });
  await store.dispose(); const restored = make(); assert.deepEqual(await restored.start(), []);
  assert.equal(restored.list()[0].state, 'revoked'); assert.equal(restored.list()[0].lastContact.clientInfo.version, '42');
  assert.equal(restored.create(input).idempotentReplay, true, 'replaying creation never revives a revoked connection');
  await restored.dispose();
  await assert.rejects(make({ rootId: crypto.randomUUID() }).start(), { code: 'IRIS_CONNECTION_CONFIG_INVALID' });
  const revokedBytes = fs.readFileSync(file), invalidRecord = JSON.parse(revokedBytes); invalidRecord.revokedAt = '';
  fs.writeFileSync(file, JSON.stringify(invalidRecord)); await assert.rejects(make().start(), { code: 'IRIS_CONNECTION_CONFIG_INVALID' }); fs.writeFileSync(file, revokedBytes);
  const nonempty = path.join(root, 'unknown'); fs.mkdirSync(nonempty, { mode: 0o700 }); fs.writeFileSync(path.join(nonempty, 'keep'), 'keep');
  await assert.rejects(make({ directory: nonempty }).start(), { code: 'IRIS_CONNECTION_CONFIG_INVALID' });
  assert.equal(fs.readFileSync(path.join(nonempty, 'keep'), 'utf8'), 'keep');
  const crashDirectory = path.join(root, 'crash-store'), crashKey = crypto.randomUUID();
  const child = fork(fileURLToPath(new URL('./fixtures/connection-store-crash-child.mjs', import.meta.url)), [dataRoot, crashDirectory, crashKey],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Crash fixture exited before readiness')));
    });
    const waitTimer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try { assert.equal((await ready).key, crashKey); } finally { clearTimeout(waitTimer); }
    await assert.rejects(make({ directory: crashDirectory }).start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
    child.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL');
    const ownership = path.join(crashDirectory, 'ownership'), lease = inspectCoreWriterLease(ownership);
    assert.equal(lease.ownerStatus, 'missing');
    await assert.rejects(make({ directory: crashDirectory }).start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
    assert.throws(() => recoverCoreWriterLease(ownership, { confirmStalePid: process.pid }));
    recoverCoreWriterLease(ownership, { confirmStalePid: child.pid });
    const recovered = make({ directory: crashDirectory }); await recovered.start();
    assert.equal(recovered.list()[0].connectionId, crashKey); assert.equal(recovered.list()[0].state, 'revoked');
  } finally { child.kill('SIGKILL'); await exited; }
  const removedDirectory = path.join(root, 'deleted-store'), removal = make({ directory: removedDirectory }); await removal.start();
  const removing = { ...input, key: crypto.randomUUID(), label: 'Remove without deleting business data' };
  removal.create(removing);
  const removingFile = path.join(removedDirectory, 'profiles', removing.key + '.json'), archiveFile = path.join(removedDirectory, 'archived', removing.key + '.json');
  const originalProfile = fs.readFileSync(removingFile), launch = removal.exportConfig(removing.key, { transport: 'stdio', format: 'entry' });
  const exportFile = launch.configuration.args[launch.configuration.args.indexOf('--connection-file') + 1], exportBefore = fs.readFileSync(exportFile);
  assert.throws(() => removal.remove(removing.key, { expectedRevision: 9 }), { code: 'IRIS_CONNECTION_CONFIG_CHANGED' });
  assert.deepEqual(fs.readFileSync(removingFile), originalProfile); assert(!fs.existsSync(archiveFile));
  try {
    fs.renameSync = (from, to) => { if (to === removingFile) throw Object.assign(new Error('controlled revoke failure'), { code: 'EIO' }); return rename(from, to); };
    assert.throws(() => removal.remove(removing.key, { expectedRevision: 1 }), { code: 'EIO' });
  } finally { fs.renameSync = rename; }
  assert.equal(removal.list()[0].state, 'pending'); assert.deepEqual(fs.readFileSync(removingFile), originalProfile);
  const link = fs.linkSync;
  try {
    fs.linkSync = (from, to) => { if (to === archiveFile) throw Object.assign(new Error('controlled archive failure'), { code: 'EIO' }); return link(from, to); };
    assert.throws(() => removal.remove(removing.key, { expectedRevision: 1 }), { code: 'EIO' });
  } finally { fs.linkSync = link; }
  assert.equal(removal.list()[0].state, 'revoked'); assert.equal(changes.at(-1).grant, null);
  assert.deepEqual(removal.activeGrants(), []); assert(!fs.existsSync(archiveFile)); await removal.dispose();
  const retry = make({ directory: removedDirectory }); await retry.start();
  assert.equal(retry.list()[0].state, 'revoked', 'an interrupted deletion remains durably revoked and visible');
  assert.throws(() => retry.remove(removing.key, { expectedRevision: 1 }), { code: 'IRIS_CONNECTION_CONFIG_CHANGED' });
  assert.equal(retry.remove(removing.key, { expectedRevision: 2 }).deleted, true); assert.deepEqual(retry.list(), []);
  assert.equal(retry.remove(removing.key, { expectedRevision: 1 }).idempotentReplay, true, 'lost delete responses are safe to replay');
  assert.throws(() => retry.create(removing), { code: 'IRIS_CONNECTION_REVOKED' });
  assert.throws(() => retry.exportConfig(removing.key, { transport: 'http', format: 'entry' }), { code: 'IRIS_CONNECTION_REVOKED' });
  assert.deepEqual(fs.readFileSync(archiveFile), fs.readFileSync(removingFile)); assert.deepEqual(fs.readFileSync(exportFile), exportBefore);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(path.dirname(archiveFile)).mode & 0o777, 0o700); assert.equal(fs.statSync(archiveFile).mode & 0o777, 0o600); }
  const archiveBytes = fs.readFileSync(archiveFile); fs.writeFileSync(archiveFile, archiveBytes.toString() + ' ');
  assert.throws(() => retry.remove(removing.key, { expectedRevision: 1 }), { code: 'IRIS_CONNECTION_CONFIG_CHANGED' });
  assert.throws(() => retry.create(removing), { code: 'IRIS_CONNECTION_CONFIG_CHANGED' });
  await retry.dispose(); await assert.rejects(make({ directory: removedDirectory }).start(), { code: 'IRIS_CONNECTION_CONFIG_INVALID' });
  fs.writeFileSync(archiveFile, archiveBytes);
  const afterDeleteRestart = make({ directory: removedDirectory }); assert.deepEqual(await afterDeleteRestart.start(), []); assert.deepEqual(afterDeleteRestart.list(), []);
  assert.equal(afterDeleteRestart.remove(removing.key, { expectedRevision: 1 }).idempotentReplay, true);
  assert.throws(() => afterDeleteRestart.create(removing), { code: 'IRIS_CONNECTION_REVOKED' });
  const interrupted = { ...input, key: crypto.randomUUID(), label: 'Archive published before process loss' }; afterDeleteRestart.create(interrupted);
  const interruptedArchive = path.join(removedDirectory, 'archived', interrupted.key + '.json');
  try {
    fs.linkSync = (from, to) => { link(from, to); if (to === interruptedArchive) throw Object.assign(new Error('controlled loss after archive publication'), { code: 'EIO' }); };
    assert.throws(() => afterDeleteRestart.remove(interrupted.key, { expectedRevision: 1 }), { code: 'EIO' });
  } finally { fs.linkSync = link; }
  await afterDeleteRestart.dispose();
  const recoveredDelete = make({ directory: removedDirectory }); assert.deepEqual(await recoveredDelete.start(), []); assert.deepEqual(recoveredDelete.list(), []);
  assert.throws(() => recoveredDelete.create(interrupted), { code: 'IRIS_CONNECTION_REVOKED' });
  assert.deepEqual(snapshot(), before, 'connection owner storage never changes business Core bytes');
  console.log('Deleted connections: CAS, revoke/archive failures, safe replay, restart, private recovery records and no credential revival OK');
  console.log('Managed connections: single writer, private/root boundaries, stable keys, CAS/drift protection, immutable exports, metadata checkpoint and persistent revoke OK');
} finally { for (const store of stores.reverse()) await store.dispose(); await app.dispose(); }
