'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CoreContractError, normalizeCoreOptions } from './core-contract.js';
import { newWriterOwner, publishLeaseRecord, readWriterLease, recoveryClaimFile, removeWriterIntent,
  retireLeaseDirectory, withdrawLeaseRecord,
  writerOwnerStatus } from './core-writer-lease.js';

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

function requireMissingOwners(lease) {
  for (const owner of lease.owners) {
    const status = writerOwnerStatus(owner.pid);
    if (status === 'alive') fail('IRIS_CORE_LEASE_OWNER_ALIVE', '租约 owner PID 仍存活；拒绝恢复');
    if (status !== 'missing') fail('IRIS_CORE_LEASE_OWNER_UNVERIFIED', '无法确认租约 owner PID 已退出；拒绝恢复');
  }
}

/**
 * 显式接管并释放一个可证明 owner PID 已不存在的 writer 租约。
 * 调用方必须回显 Doctor 报告中的 PID；活跃、未知或损坏证据一律拒绝。
 */
export function recoverCoreWriterLease(dataRoot, { confirmStalePid } = {}) {
  const root = physicalDataRoot(dataRoot);
  let lease;
  try { lease = readWriterLease(root); }
  catch (_) { fail('IRIS_CORE_LEASE_INVALID', 'Iris 写者租约证据不完整；已保留现场'); }
  if (!lease) fail('IRIS_CORE_LEASE_NOT_FOUND', '未发现可恢复的 Iris 写者租约');
  if (!Number.isSafeInteger(confirmStalePid) || confirmStalePid <= 0 || confirmStalePid !== lease.owner.pid) {
    fail('IRIS_CORE_LEASE_CONFIRMATION_MISMATCH', '确认的 owner PID 与租约证据不一致；未执行恢复');
  }
  requireMissingOwners(lease);

  const auditId = 'lease_recovery_' + crypto.randomBytes(12).toString('hex');
  const recoveredAt = new Date().toISOString();
  const recoveryOwner = newWriterOwner();
  const claimFile = recoveryClaimFile(root, lease.owner);
  const claim = { schemaVersion: 1, previousInstanceId: lease.owner.instanceId, owner: recoveryOwner };
  let published = false;
  let retired = false;
  let auditFile = null;
  try {
    if (readWriterLease(root)?.fingerprint !== lease.fingerprint) throw new Error('lease changed');
    if (!lease.intent) {
      // 兼容旧 owner 目录；固定意图屏障使目录退役后的中断也可诊断和续办。
      fs.linkSync(path.join(lease.directory, 'owner.json'), lease.intentFile);
      lease = readWriterLease(root);
      requireMissingOwners(lease);
    }
    if (!lease.stat) {
      // 已原子发布意图，但在 mkdir 前被杀；建立占位后仍只允许显式恢复。
      fs.mkdirSync(lease.directory, { mode: 0o700 });
      lease = readWriterLease(root);
    }
    // 每一步以父 owner UUID 命名且独占发布；并发恢复只有一个能取得下一步。
    // 前驱不删除，中断后可确认最近恢复 PID 并继续，证据不会消失。
    publishLeaseRecord(root, claimFile, claim);
    published = true;
    const claimed = readWriterLease(root);
    if (claimed?.owner.instanceId !== recoveryOwner.instanceId
        || claimed.stat?.dev !== lease.stat.dev || claimed.stat?.ino !== lease.stat.ino
        || claimed.intent?.serialized !== lease.intent.serialized) throw new Error('lease changed');
    requireMissingOwners(lease);

    const directory = auditDirectory(root);
    auditFile = path.join(directory, auditId + '.json');
    const audit = {
      schemaVersion: 1,
      id: auditId,
      action: 'writer-lease-recovery',
      recoveredAt,
      confirmation: { ownerPid: confirmStalePid },
      staleOwner: lease.originalOwner,
      recoveryOwner,
      leasePhase: lease.phase,
      evidenceDirectory: auditId + '.lease',
      evidenceFingerprint: claimed.fingerprint,
      recoveryClaims: claimed.claims.map(claim => claim.value),
      authorization: 'retire-lease-directory'
    };
    publishLeaseRecord(root, auditFile, audit);
    if (readWriterLease(root)?.fingerprint !== claimed.fingerprint) throw new Error('lease changed');
    // 审计先发布，完整目录再原子退役。只在最终步骤撤下意图屏障。
    retireLeaseDirectory(lease.directory, path.join(directory, audit.evidenceDirectory));
    retired = true;
    removeWriterIntent(lease);
    // 意图屏障解除后只整理 UUID 专属旧证据，不再触碰当前租约路径。
    for (const claim of claimed.claims) {
      try { fs.renameSync(claim.file, path.join(directory, audit.evidenceDirectory, path.basename(claim.file))); }
      catch (_) { /* 未整理的记录仍在根中，不阻止新 UUID 的 writer */ }
    }
    return Object.freeze({
      status: 'recovered',
      auditId,
      staleOwner: Object.freeze({ pid: lease.originalOwner.pid,
        createdAt: new Date(Date.parse(lease.originalOwner.createdAt)).toISOString() })
    });
  } catch (error) {
    // 可捕获的错误只撤回本次最后一条 claim；原 owner 与旧恢复证据保持。
    if (published && !retired) {
      try { withdrawLeaseRecord(claimFile, claim); }
      catch (_) { /* 保留可识别的恢复链供进程退出后显式重试 */ }
    }
    if (error instanceof CoreContractError) throw error;
    fail('IRIS_CORE_LEASE_RECOVERY_FAILED',
      auditFile && fs.existsSync(auditFile)
        ? '租约恢复未能安全完成；审计证据与现场均已保留'
        : '租约恢复失败；原租约已尽力保留');
  }
}
