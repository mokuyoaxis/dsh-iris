import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { createCoreRuntime, inspectCoreWriterLease } from '../lib/core-runtime.js';

const CLI = fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url));
const WRITER = fileURLToPath(new URL('./fixtures/core-writer-child.mjs', import.meta.url));

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('writer child READY timeout: ' + stderr));
    }, 8000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      if (!stdout.includes('READY')) {
        clearTimeout(timer);
        reject(new Error(`writer child exited ${code}: ${stderr}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', shell: false });
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-runtime-recover-'));
const children = new Set();
try {
  // 活跃 owner 即使用户回显了正确 PID 也必须拒绝，且不得产生审计或改写租约。
  const liveRoot = path.join(base, 'live');
  const liveRuntime = createCoreRuntime({ dataRoot: liveRoot, mode: 'writer' });
  liveRuntime.start();
  const liveOwnerFile = path.join(liveRoot, '.iris-runtime-writer-v0', 'owner.json');
  const liveBefore = fs.readFileSync(liveOwnerFile, 'utf8');
  assert.throws(
    () => recoverCoreWriterLease(liveRoot, { confirmStalePid: process.pid }),
    { code: 'IRIS_CORE_LEASE_OWNER_ALIVE' }
  );
  assert.equal(fs.readFileSync(liveOwnerFile, 'utf8'), liveBefore);
  assert.equal(fs.existsSync(path.join(liveRoot, '.iris-runtime-recovery-audit-v0')), false);
  await liveRuntime.dispose();

  // 损坏或不完整证据不可恢复。
  const invalidRoot = path.join(base, 'invalid');
  const invalidLease = path.join(invalidRoot, '.iris-runtime-writer-v0');
  fs.mkdirSync(invalidLease, { recursive: true });
  fs.writeFileSync(path.join(invalidLease, 'owner.json'), '{"pid":1}\n');
  assert.throws(
    () => recoverCoreWriterLease(invalidRoot, { confirmStalePid: 1 }),
    { code: 'IRIS_CORE_LEASE_INVALID' }
  );
  fs.unlinkSync(path.join(invalidLease, 'owner.json'));
  assert.throws(
    () => recoverCoreWriterLease(invalidRoot, { confirmStalePid: 1 }),
    { code: 'IRIS_CORE_LEASE_INVALID' },
    '租约目录存在但 owner 缺失必须判为损坏，而不是无租约'
  );

  // 真实子进程强杀留下租约；错误 PID 确认必须零写入，正确 PID 才能恢复。
  const staleRoot = path.join(base, 'stale');
  const child = spawn(process.execPath, [WRITER, staleRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  await waitForReady(child);
  const staleOwnerFile = path.join(staleRoot, '.iris-runtime-writer-v0', 'owner.json');
  const staleOwner = JSON.parse(fs.readFileSync(staleOwnerFile, 'utf8'));
  const childExit = waitForExit(child);
  child.kill('SIGKILL');
  await childExit;
  assert.equal(inspectCoreWriterLease(staleRoot).ownerStatus, 'missing');

  const staleBefore = fs.readFileSync(staleOwnerFile, 'utf8');
  const wrong = cli(['runtime', 'recover', '--data-root', staleRoot, '--confirm-stale-pid', String(staleOwner.pid + 1)]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /IRIS_CORE_LEASE_CONFIRMATION_MISMATCH/);
  assert.equal(fs.readFileSync(staleOwnerFile, 'utf8'), staleBefore);
  assert.equal(fs.existsSync(path.join(staleRoot, '.iris-runtime-recovery-audit-v0')), false);

  const recovered = cli(['runtime', 'recover', '--data-root', staleRoot, '--confirm-stale-pid', String(staleOwner.pid)]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.status, 'recovered');
  assert.equal(result.staleOwner.pid, staleOwner.pid);
  assert.match(result.auditId, /^lease_recovery_[a-f0-9]{24}$/);
  assert.equal(fs.existsSync(path.join(staleRoot, '.iris-runtime-writer-v0')), false);

  const auditDirectory = path.join(staleRoot, '.iris-runtime-recovery-audit-v0');
  const auditFiles = fs.readdirSync(auditDirectory);
  assert.deepEqual(auditFiles, [result.auditId + '.json']);
  const auditText = fs.readFileSync(path.join(auditDirectory, auditFiles[0]), 'utf8');
  const audit = JSON.parse(auditText);
  assert.equal(audit.action, 'writer-lease-recovery');
  assert.equal(audit.confirmation.ownerPid, staleOwner.pid);
  assert.equal(audit.staleOwner.instanceId, staleOwner.instanceId);
  assert.equal(audit.recoveryOwner.pid > 0, true);
  assert.equal(auditText.includes(staleRoot), false, '审计记录不得泄露绝对数据根');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(auditDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(auditDirectory, auditFiles[0])).mode & 0o777, 0o600);
  }

  const successor = createCoreRuntime({ dataRoot: staleRoot, mode: 'writer' });
  successor.start();
  await successor.dispose();
  const repeated = cli(['runtime', 'recover', '--data-root', staleRoot, '--confirm-stale-pid', String(staleOwner.pid)]);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /IRIS_CORE_LEASE_NOT_FOUND/);
  assert.equal(fs.readdirSync(auditDirectory).length, 1, '重复恢复不得新增审计或伪造成功');

  const missingConfirm = cli(['runtime', 'recover', '--data-root', staleRoot]);
  assert.equal(missingConfirm.status, 2);
  assert.match(missingConfirm.stderr, /IRIS_CLI_USAGE/);

  console.log('ALL OK —— runtime recover：活跃/损坏拒绝、真实 SIGKILL、PID 回显、私有审计、恢复后可写与幂等拒绝');
} finally {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(base, { recursive: true, force: true });
}
