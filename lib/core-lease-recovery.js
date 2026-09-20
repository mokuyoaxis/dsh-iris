'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CORE_CONTRACT_VERSION, CoreContractError, normalizeCoreOptions } from './core-contract.js';
import { writePrivateFile } from './private-storage.js';

const WRITER_LEASE_DIR = '.iris-runtime-writer-v0';
const WRITER_OWNER_FILE = 'owner.json';
const RECOVERY_AUDIT_DIR = '.iris-runtime-recovery-audit-v0';

function fail(code, message) {
  throw new CoreContractError(code, message);
}

function physicalDataRoot(dataRoot) {
  const options = normalizeCoreOptions({ dataRoot, mode: 'reader' });
  try {
    const root = fs.realpathSync.native(options.dataRoot);
    if (!fs.statSync(root).isDirectory()) fail('IRIS_CORE_DATA_ROOT_UNAVAILABLE', 'Iris 数据根必须是目录');
    return root;
  } catch (error) {
    if (error instanceof CoreContractError) throw error;
    if (error?.code === 'ENOENT') fail('IRIS_CORE_DATA_ROOT_NOT_FOUND', 'Iris 数据根不存在；恢复不会自动创建');
    fail('IRIS_CORE_DATA_ROOT_UNAVAILABLE', '无法访问 Iris 数据根');
  }
}

function readLease(root) {
  const directory = path.join(root, WRITER_LEASE_DIR);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid lease directory');
  const entries = fs.readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== WRITER_OWNER_FILE) throw new Error('invalid lease contents');
  const ownerFile = path.join(directory, WRITER_OWNER_FILE);
  const ownerStat = fs.lstatSync(ownerFile);
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 16384) throw new Error('invalid owner');
  const serialized = fs.readFileSync(ownerFile, 'utf8');
  const owner = JSON.parse(serialized);
  const created = Date.parse(owner?.createdAt);
  if (owner?.contractVersion !== CORE_CONTRACT_VERSION || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !/^[a-f0-9-]{36}$/.test(String(owner.instanceId || '')) || !Number.isFinite(created)) {
    throw new Error('incomplete owner');
  }
  return { directory, ownerFile, owner, serialized, created };
}

function ownerStatus(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'missing' : 'unknown';
  }
}

function auditDirectory(root) {
  const directory = path.join(root, RECOVERY_AUDIT_DIR);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid audit directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('IRIS_CORE_LEASE_RECOVERY_FAILED', '租约恢复审计目录不安全；已保留现场');
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (_) { fail('IRIS_CORE_LEASE_RECOVERY_FAILED', '无法创建租约恢复审计目录；已保留现场'); }
  }
  return directory;
}

function releaseRecoveryLease(lease) {
  const stat = fs.lstatSync(lease.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid recovery lease');
  const entries = fs.readdirSync(lease.directory);
  if (entries.length !== 1 || entries[0] !== WRITER_OWNER_FILE) throw new Error('unexpected recovery lease contents');
  const actual = JSON.parse(fs.readFileSync(lease.ownerFile, 'utf8'));
  if (actual.instanceId !== lease.owner.instanceId) throw new Error('recovery owner changed');
  fs.unlinkSync(lease.ownerFile);
  fs.rmdirSync(lease.directory);
}

/**
 * 显式接管并释放一个可证明 owner PID 已不存在的 writer 租约。
 * 调用方必须回显 Doctor 报告中的 PID；活跃、未知或损坏证据一律拒绝。
 */
export function recoverCoreWriterLease(dataRoot, { confirmStalePid } = {}) {
  const root = physicalDataRoot(dataRoot);
  const leaseDirectory = path.join(root, WRITER_LEASE_DIR);
  try { fs.lstatSync(leaseDirectory); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('IRIS_CORE_LEASE_NOT_FOUND', '未发现可恢复的 Iris 写者租约');
    fail('IRIS_CORE_LEASE_INVALID', 'Iris 写者租约证据无法读取；已保留现场');
  }
  let lease;
  try { lease = readLease(root); }
  catch (_) { fail('IRIS_CORE_LEASE_INVALID', 'Iris 写者租约证据不完整；已保留现场'); }
  if (!Number.isSafeInteger(confirmStalePid) || confirmStalePid <= 0 || confirmStalePid !== lease.owner.pid) {
    fail('IRIS_CORE_LEASE_CONFIRMATION_MISMATCH', '确认的 owner PID 与租约证据不一致；未执行恢复');
  }
  const processStatus = ownerStatus(lease.owner.pid);
  if (processStatus === 'alive') fail('IRIS_CORE_LEASE_OWNER_ALIVE', '租约 owner PID 仍存活；拒绝恢复');
  if (processStatus !== 'missing') fail('IRIS_CORE_LEASE_OWNER_UNVERIFIED', '无法确认租约 owner PID 已退出；拒绝恢复');

  const auditId = 'lease_recovery_' + crypto.randomBytes(12).toString('hex');
  const instanceId = crypto.randomUUID();
  const recoveredAt = new Date().toISOString();
  const recoveryOwner = Object.freeze({
    contractVersion: CORE_CONTRACT_VERSION,
    instanceId,
    pid: process.pid,
    createdAt: recoveredAt
  });
  const recoverySerialized = JSON.stringify(recoveryOwner, null, 2) + '\n';
  const staleOwnerFile = path.join(lease.directory, `.owner.stale-${instanceId}.json`);
  let tookLease = false;
  let auditFile = null;
  try {
    // 租约目录始终存在；普通 writer 在接管窗口内仍会 fail-fast。
    fs.renameSync(lease.ownerFile, staleOwnerFile);
    if (fs.readFileSync(staleOwnerFile, 'utf8') !== lease.serialized) throw new Error('lease changed');
    writePrivateFile(lease.ownerFile, recoverySerialized, { flag: 'wx' });
    tookLease = true;

    const directory = auditDirectory(root);
    auditFile = path.join(directory, auditId + '.json');
    const audit = {
      schemaVersion: 1,
      id: auditId,
      action: 'writer-lease-recovery',
      recoveredAt,
      confirmation: { ownerPid: confirmStalePid },
      staleOwner: {
        contractVersion: lease.owner.contractVersion,
        instanceId: lease.owner.instanceId,
        pid: lease.owner.pid,
        createdAt: new Date(lease.created).toISOString()
      },
      recoveryOwner
    };
    writePrivateFile(auditFile, JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' });
    fs.unlinkSync(staleOwnerFile);
    releaseRecoveryLease({
      directory: lease.directory,
      ownerFile: lease.ownerFile,
      owner: recoveryOwner
    });
    return Object.freeze({
      status: 'recovered',
      auditId,
      staleOwner: Object.freeze({ pid: lease.owner.pid, createdAt: new Date(lease.created).toISOString() })
    });
  } catch (error) {
    // 恢复失败时尽力还原原 owner；绝不把不确定现场宣布为可写。
    try {
      if (tookLease && fs.existsSync(lease.ownerFile)) {
        const actual = JSON.parse(fs.readFileSync(lease.ownerFile, 'utf8'));
        if (actual.instanceId === instanceId) fs.unlinkSync(lease.ownerFile);
      }
      if (fs.existsSync(lease.directory) && !fs.existsSync(lease.ownerFile)) {
        if (fs.existsSync(staleOwnerFile)) fs.renameSync(staleOwnerFile, lease.ownerFile);
        else writePrivateFile(lease.ownerFile, lease.serialized, { flag: 'wx' });
      }
    } catch (_) { /* 保留现场，由 Doctor 报告 invalid */ }
    if (error instanceof CoreContractError) throw error;
    fail('IRIS_CORE_LEASE_RECOVERY_FAILED',
      auditWritten ? '租约恢复未能安全完成；审计证据与现场均已保留' : '租约恢复失败；原租约已尽力保留');
  }
}
