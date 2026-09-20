import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { useTempDshHome } from './test-env.js';
import { doctor } from '../lib/doctor.js';
import { createCoreRuntime, inspectCoreWriterLease } from '../lib/core-runtime.js';
import { createCoreArtifact } from '../lib/core-artifact-store.js';
import { createCoreTask } from '../lib/core-tasks.js';

const { root } = useTempDshHome('iris-core-doctor');
const dataRoot = path.join(root, 'core');
const options = { dataRoot, commandRunner: () => ({ status: 0 }), sharpLoader: async () => ({}) };
const snapshot = (directory) => {
  const entries = [];
  const visit = (target) => {
    const stat = fs.lstatSync(target);
    entries.push([path.relative(directory, target), stat.mode, stat.mtimeMs, stat.size,
      stat.isFile() ? fs.readFileSync(target).toString('base64') : null]);
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
  };
  visit(directory);
  return entries;
};
const absent = await doctor(options);
assert.equal(absent.core.status, 'absent');
assert.equal(absent.exitCode, 0);
assert(!fs.existsSync(dataRoot));
await assert.rejects(doctor({ ...options, dataRoot: 'relative' }), { code: 'IRIS_CORE_OPTIONS_INVALID' });

const writer = createCoreRuntime({ dataRoot, mode: 'writer' });
writer.start();
await writer.run('execute', ({ dataRoot: target }) => {
  createCoreTask(target, { capability: 'image' });
  createCoreArtifact(target, { kind: 'fixture', mediaType: 'text/plain', bytes: Buffer.from('private text') });
});
const before = snapshot(dataRoot);
const active = await doctor(options);
assert.equal(active.core.lease.ownerStatus, 'alive');
assert.equal(active.core.lease.pid, process.pid);
assert.equal(active.core.artifacts.index, 'valid');
assert.equal(active.core.tasks.total, 1);
assert.equal(active.core.artifacts.total, 1);
assert.equal(active.exitCode, 1);
assert.deepEqual(snapshot(dataRoot), before);
assert(!JSON.stringify(active).includes(root));
assert(!JSON.stringify(active).includes('private text'));
await writer.dispose();
assert.equal((await doctor(options)).exitCode, 0);

const artifactBase = path.join(dataRoot, 'artifact-store/v0');
const taskDir = path.join(dataRoot, 'task-store/v0/tasks');
fs.writeFileSync(path.join(taskDir, 'task_' + 'a'.repeat(24) + '.json'), '{invalid');
fs.writeFileSync(path.join(taskDir, 'unknown.tmp'), 'private');
fs.writeFileSync(path.join(artifactBase, 'objects', 'artifact_' + 'b'.repeat(24) + '.txt'), 'orphan');
fs.writeFileSync(path.join(artifactBase, 'objects', 'unfinished.part'), 'partial');
const indexFile = path.join(artifactBase, 'index.json');
const originalIndex = fs.readFileSync(indexFile, 'utf8');
const index = JSON.parse(originalIndex);
index.artifacts = [];
index.count = 0;
index.inventoryDigest = crypto.createHash('sha256').update('[]').digest('hex');
fs.writeFileSync(indexFile, JSON.stringify(index));
const brokenBefore = snapshot(dataRoot);
const broken = await doctor(options);
assert.equal(broken.core.tasks.invalid, 1);
assert.equal(broken.core.tasks.unresolved, 1);
assert.equal(broken.core.artifacts.orphanObjects, 1);
assert.equal(broken.core.artifacts.unresolved, 1);
assert.equal(broken.core.artifacts.index, 'invalid', 'self-consistent but incomplete index must be detected');
assert.equal(broken.exitCode, 1);
assert.deepEqual(snapshot(dataRoot), brokenBefore);

fs.writeFileSync(indexFile, '{broken-json');
assert.equal((await doctor(options)).core.artifacts.index, 'invalid');
fs.writeFileSync(indexFile, JSON.stringify(index));

const cli = spawnSync(process.execPath, ['bin/dsh-iris.js', 'doctor', '--json', '--data-root', dataRoot], {
  encoding: 'utf8', env: { ...process.env, DSH_HOME: path.join(root, 'unused') }
});
assert.equal(cli.status, 1, cli.stderr);
assert.equal(JSON.parse(cli.stdout).core.artifacts.index, 'invalid');
assert.equal(JSON.parse(cli.stdout).mode, 'core-offline');
assert(!cli.stdout.includes(root));
assert(!fs.existsSync(path.join(root, 'unused')));
assert.equal(fs.readFileSync(indexFile, 'utf8'), JSON.stringify(index));

const crashRoot = path.join(root, 'crash');
const child = spawn(process.execPath, ['tests/fixtures/core-writer-child.mjs', crashRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child ready timeout')), 10000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('READY')) { clearTimeout(timer); resolve(); } });
  });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const killedBefore = snapshot(crashRoot);
  assert.equal(inspectCoreWriterLease(crashRoot).ownerStatus, 'missing');
  const stale = await doctor({ ...options, dataRoot: crashRoot });
  assert.equal(stale.core.lease.ownerStatus, 'missing');
  assert.deepEqual(snapshot(crashRoot), killedBefore);
  const blocked = createCoreRuntime({ dataRoot: crashRoot, mode: 'writer' });
  assert.throws(() => blocked.start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
  await blocked.dispose();
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
}

const invalidLease = path.join(crashRoot, '.iris-runtime-writer-v0/owner.json');
fs.writeFileSync(invalidLease, JSON.stringify({ pid: process.pid, createdAt: 'bad', secret: 'never-print' }));
assert.equal(inspectCoreWriterLease(crashRoot).status, 'invalid');
assert(!JSON.stringify(await doctor({ ...options, dataRoot: crashRoot })).includes('never-print'));
const partialRoot = path.join(root, 'partial');
fs.mkdirSync(path.join(partialRoot, 'task-store'), { recursive: true });
assert.equal((await doctor({ ...options, dataRoot: partialRoot })).core.tasks.status, 'invalid');

const linkedRoot = path.join(root, 'linked');
fs.mkdirSync(linkedRoot);
try {
  fs.symlinkSync(path.join(dataRoot, 'artifact-store'), path.join(linkedRoot, 'artifact-store'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const linkedBefore = snapshot(dataRoot);
  assert.equal((await doctor({ ...options, dataRoot: linkedRoot })).core.artifacts.status, 'invalid');
  assert.deepEqual(snapshot(dataRoot), linkedBefore);
} catch (error) {
  if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
}
const defaultCore = path.join(root, 'iris/v1/core-v0');
createCoreArtifact(defaultCore, { kind: 'fixture', mediaType: 'text/plain', bytes: Buffer.from('default-core') });
const defaultReport = await doctor({ dshHome: root, commandRunner: options.commandRunner, sharpLoader: options.sharpLoader });
assert.equal(defaultReport.mode, 'offline');
assert.equal(defaultReport.core.artifacts.total, 1);
assert.equal(defaultReport.storageComparison.legacy.tasks, 0);
assert.equal(defaultReport.storageComparison.core.artifacts, 1);
console.log('ALL OK - Core Doctor: read-only inventory/index, lease PID, SIGKILL evidence, CLI isolation');
