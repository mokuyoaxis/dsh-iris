import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCoreRuntime, inspectCoreWriterLease } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { initializeFlowRoot } from '../lib/flow-store.js';
import { initializeLocalRequestRoot } from '../lib/local-request-root.js';
import { isAbandonedWriterPreparation } from '../lib/core-writer-lease.js';

const childFile = fileURLToPath(new URL('./fixtures/core-lease-crash-child.mjs', import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-lease-interruptions-'));
const children = new Set();
const root = name => { const value = path.join(base, name); fs.mkdirSync(value, { mode: 0o700 }); return value; };
function crash(stage, dataRoot, pid) {
  const result = spawnSync(process.execPath, [childFile, stage, dataRoot, String(pid || '')], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.stdout, 'CHECKPOINT ' + stage + '\n', result.stderr || stage + ': interruption checkpoint reached');
  assert.equal(result.stderr, '', stage + ': must not be an exception exit');
  // Windows 的进程内 SIGKILL 返回 TerminateProcess 的退出码，父进程没有 signalCode。
  if (process.platform === 'win32') { assert.equal(result.status, 1); assert.equal(result.signal, null); }
  else assert.equal(result.signal, 'SIGKILL', stage);
}
async function canWrite(dataRoot) {
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start(); await runtime.dispose();
  assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
}
function blocked(dataRoot) {
  const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
  assert.throws(() => runtime.start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
}
function recover(dataRoot) {
  const evidence = inspectCoreWriterLease(dataRoot);
  assert.equal(evidence.status, 'present'); assert.equal(evidence.ownerStatus, 'missing');
  blocked(dataRoot);
  const result = recoverCoreWriterLease(dataRoot, { confirmStalePid: evidence.pid });
  assert.equal(result.status, 'recovered'); assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  const audit = path.join(dataRoot, '.iris-runtime-recovery-audit-v0');
  const record = JSON.parse(fs.readFileSync(path.join(audit, result.auditId + '.json'), 'utf8'));
  assert(fs.statSync(path.join(audit, record.evidenceDirectory)).isDirectory());
}
try {
  // 通过目录别名传入根路径；fixture 的检查点须匹配 Runtime 的真实路径。
  const aliasTarget = root('alias-target'), alias = path.join(base, 'root-alias');
  fs.symlinkSync(aliasTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
  crash('intent-published', alias);
  recover(alias); await canWrite(alias);
  for (const stage of ['prepare-written', 'intent-published', 'directory-created', 'owner-published',
    'release-retired', 'release-intent-removed', 'release-owner-removed']) {
    const dataRoot = root(stage); crash(stage, dataRoot);
    const evidence = inspectCoreWriterLease(dataRoot);
    if (['prepare-written', 'release-intent-removed', 'release-owner-removed'].includes(stage)) assert.equal(evidence.status, 'absent');
    else recover(dataRoot);
    await canWrite(dataRoot);
    if (stage === 'prepare-written') {
      const name = fs.readdirSync(dataRoot).find(name => name.includes('.prepare-'));
      const preserved = fs.readFileSync(path.join(dataRoot, name));
      initializeFlowRoot(dataRoot); initializeLocalRequestRoot(dataRoot, 3);
      assert.deepEqual(fs.readFileSync(path.join(dataRoot, name)), preserved, 'initialization preserves the abandoned preparation evidence');
    }
  }
  const notAbandoned = root('not-abandoned');
  const preparation = '.iris-runtime-writer-v0.owner.json.prepare-' + process.pid + '-0123456789ab';
  const liveOwner = { contractVersion: 0, instanceId: crypto.randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(notAbandoned, preparation), JSON.stringify(liveOwner), { mode: 0o600 });
  assert.equal(isAbandonedWriterPreparation(notAbandoned, preparation), false);
  assert.throws(() => initializeFlowRoot(notAbandoned), { code: 'IRIS_FLOW_ROOT_NOT_EMPTY' });
  fs.writeFileSync(path.join(notAbandoned, preparation), '{}');
  assert.equal(isAbandonedWriterPreparation(notAbandoned, preparation), false);
  assert.throws(() => initializeFlowRoot(notAbandoned), { code: 'IRIS_FLOW_ROOT_NOT_EMPTY' });
  for (const stage of ['recovery-claim-published', 'recovery-audit-published', 'recovery-retired', 'recovery-intent-removed']) {
    const dataRoot = root(stage); crash('owner-published', dataRoot);
    crash(stage, dataRoot, inspectCoreWriterLease(dataRoot).pid);
    if (stage === 'recovery-intent-removed') assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
    else recover(dataRoot);
    await canWrite(dataRoot);
  }
  // 恢复连续被杀仍可续办；每次只确认最新 owner，旧确认不得改写证据。
  const repeated = root('repeated'); crash('owner-published', repeated);
  const oldPid = inspectCoreWriterLease(repeated).pid;
  for (let i = 0; i < 2; i++) crash('recovery-claim-published', repeated, inspectCoreWriterLease(repeated).pid);
  assert.equal(inspectCoreWriterLease(repeated).phase, 'recovering');
  const before = fs.readdirSync(path.join(repeated, '.iris-runtime-writer-v0'));
  assert.throws(() => recoverCoreWriterLease(repeated, { confirmStalePid: oldPid }), { code: 'IRIS_CORE_LEASE_CONFIRMATION_MISMATCH' });
  assert.deepEqual(fs.readdirSync(path.join(repeated, '.iris-runtime-writer-v0')), before);
  recover(repeated); await canWrite(repeated);

  // 第一个恢复者持有 claim 时，第二恢复者和普通 writer 均不得进入。
  const live = root('live-recovery'); crash('owner-published', live);
  const originalPid = inspectCoreWriterLease(live).pid;
  const child = spawn(process.execPath, [childFile, 'recovery-hold', live, String(originalPid)], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('recovery READY timeout')), 8000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', reject);
  });
  assert.equal(inspectCoreWriterLease(live).pid, child.pid); blocked(live);
  assert.throws(() => recoverCoreWriterLease(live, { confirmStalePid: child.pid }), { code: 'IRIS_CORE_LEASE_OWNER_ALIVE' });
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; children.delete(child);
  recover(live); await canWrite(live);

  // 陈旧观察在发布 claim 前被另一恢复完成、新 writer 接替：不污染新租约。
  const replaced = root('replaced-lease'); crash('owner-published', replaced);
  const replacedPid = inspectCoreWriterLease(replaced).pid, link = fs.linkSync;
  let interleaved = false, successor;
  fs.linkSync = (...args) => {
    if (!interleaved && String(args[1]).includes('.iris-runtime-writer-v0.recovery-')) {
      interleaved = true;
      recoverCoreWriterLease(replaced, { confirmStalePid: replacedPid });
      successor = createCoreRuntime({ dataRoot: replaced, mode: 'writer' }); successor.start();
    }
    return link(...args);
  };
  try { assert.throws(() => recoverCoreWriterLease(replaced, { confirmStalePid: replacedPid }), { code: 'IRIS_CORE_LEASE_RECOVERY_FAILED' }); }
  finally { fs.linkSync = link; }
  assert(interleaved); assert.equal(inspectCoreWriterLease(replaced).pid, process.pid);
  assert.equal(fs.readdirSync(replaced).filter(name => name.includes('.recovery-')).length, 0);
  await successor.dispose(); await canWrite(replaced);

  // 旧双 owner 现场有完整恢复 PID 可处理；单 stale 无恢复 PID 证据必须拒绝。
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  for (const pair of [false, true]) {
    const dataRoot = root('legacy-' + pair), directory = path.join(dataRoot, '.iris-runtime-writer-v0'); fs.mkdirSync(directory);
    const recoveryId = crypto.randomUUID();
    const owner = { contractVersion: 0, instanceId: crypto.randomUUID(), pid: Number(dead.stdout), createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(directory, '.owner.stale-' + recoveryId + '.json'), JSON.stringify(owner), { mode: 0o600 });
    if (pair) fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ ...owner, instanceId: recoveryId }), { mode: 0o600 });
    if (pair) { recover(dataRoot); await canWrite(dataRoot); }
    else { assert.throws(() => recoverCoreWriterLease(dataRoot, { confirmStalePid: owner.pid }), { code: 'IRIS_CORE_LEASE_INVALID' }); blocked(dataRoot); }
  }
  // 旧空目录无 PID、新意图损坏/额外文件/符号链接均保留并拒绝；EPERM 也拒绝。
  const empty = root('legacy-empty'); fs.mkdirSync(path.join(empty, '.iris-runtime-writer-v0'));
  assert.throws(() => recoverCoreWriterLease(empty, { confirmStalePid: Number(dead.stdout) }), { code: 'IRIS_CORE_LEASE_INVALID' }); blocked(empty);
  for (const kind of ['corrupt-intent', 'extra-file', 'symlink-owner']) {
    const dataRoot = root(kind); crash('owner-published', dataRoot);
    const pid = inspectCoreWriterLease(dataRoot).pid, directory = path.join(dataRoot, '.iris-runtime-writer-v0');
    if (kind === 'corrupt-intent') fs.writeFileSync(path.join(dataRoot, '.iris-runtime-writer-v0.owner.json'), '{}');
    if (kind === 'extra-file') fs.writeFileSync(path.join(directory, 'unknown'), 'keep');
    if (kind === 'symlink-owner') { fs.unlinkSync(path.join(directory, 'owner.json')); fs.symlinkSync(path.join(dataRoot, '.iris-runtime-writer-v0.owner.json'), path.join(directory, 'owner.json')); }
    const names = fs.readdirSync(directory);
    assert.throws(() => recoverCoreWriterLease(dataRoot, { confirmStalePid: pid }), { code: 'IRIS_CORE_LEASE_INVALID' });
    assert.deepEqual(fs.readdirSync(directory), names); blocked(dataRoot);
  }
  const unknown = root('unknown-pid'); crash('owner-published', unknown);
  const pid = inspectCoreWriterLease(unknown).pid, kill = process.kill;
  process.kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  try { assert.throws(() => recoverCoreWriterLease(unknown, { confirmStalePid: pid }), { code: 'IRIS_CORE_LEASE_OWNER_UNVERIFIED' }); }
  finally { process.kill = kill; }
  recover(unknown); await canWrite(unknown);
  const occupied = root('occupied-retirement'), runtime = createCoreRuntime({ dataRoot: occupied, mode: 'writer' }); runtime.start();
  const original = fs.readFileSync(path.join(occupied, '.iris-runtime-writer-v0/owner.json'), 'utf8');
  const id = JSON.parse(original).instanceId;
  const destination = path.join(occupied, '.iris-runtime-writer-v0.released-' + id); fs.mkdirSync(destination);
  await assert.rejects(runtime.dispose(), { code: 'IRIS_CORE_LEASE_INVALID' });
  assert(fs.existsSync(destination)); assert.equal(fs.readFileSync(path.join(occupied, '.iris-runtime-writer-v0/owner.json'), 'utf8'), original);
  console.log('PASS 租约：根路径别名、11 个真实 SIGKILL 窗口、连续恢复中断、并发拒绝、旧恢复兼容、损坏/未知拒绝与后续可写');
} finally {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(base, { recursive: true, force: true });
}
