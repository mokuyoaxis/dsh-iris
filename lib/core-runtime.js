'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CORE_CONTRACT_VERSION,
  CoreContractError,
  assertCoreOperation,
  coreDataRootBusyError,
  createCoreLifecycle,
  normalizeCoreOptions,
  transitionCoreLifecycle
} from './core-contract.js';
import { ensurePrivateDir } from './private-storage.js';
import { listCreationRequests } from './creation-request-store.js';
import { readAllOperations } from './operation-store.js';
import { WRITER_LEASE_DIR, WRITER_INTENT_FILE, publishLeaseRecord, readWriterLease,
  removeWriterIntent, retireLeaseDirectory, writerOwnerStatus } from './core-writer-lease.js';

/** 只读租约证据；PID 缺失不等于已经获准恢复，绝不自动夺取租约。 */
export function inspectCoreWriterLease(dataRoot) {
  const options = normalizeCoreOptions({ dataRoot, mode: 'reader' });
  try {
    const lease = readWriterLease(options.dataRoot);
    if (!lease) return { status: 'absent' };
    const owner = lease.owner;
    const created = Date.parse(owner.createdAt);
    return {
      status: 'present', ownerStatus: writerOwnerStatus(owner.pid), pid: owner.pid, phase: lease.phase,
      createdAt: new Date(created).toISOString(), ageMs: Math.max(0, Date.now() - created)
    };
  } catch (_) { return { status: 'invalid' }; }
}

function coreError(code, message) {
  return new CoreContractError(code, message);
}

function physicalDataRoot(options) {
  if (options.mode === 'writer') {
    try { ensurePrivateDir(options.dataRoot); }
    catch (_) { throw coreError('IRIS_CORE_DATA_ROOT_UNAVAILABLE', '无法创建或访问 Iris 数据根'); }
  }
  let root;
  try { root = fs.realpathSync.native(options.dataRoot); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      throw coreError('IRIS_CORE_DATA_ROOT_NOT_FOUND', 'Iris 数据根不存在；只读模式不会自动创建');
    }
    throw coreError('IRIS_CORE_DATA_ROOT_UNAVAILABLE', '无法访问 Iris 数据根');
  }
  try {
    if (!fs.statSync(root).isDirectory()) {
      throw coreError('IRIS_CORE_DATA_ROOT_UNAVAILABLE', 'Iris 数据根必须是目录');
    }
  } catch (error) {
    if (error instanceof CoreContractError) throw error;
    throw coreError('IRIS_CORE_DATA_ROOT_UNAVAILABLE', '无法检查 Iris 数据根');
  }
  return root;
}

function acquireWriterLease(root, instanceId) {
  const directory = path.join(root, WRITER_LEASE_DIR);
  const ownerFile = path.join(directory, 'owner.json');
  const intentFile = path.join(root, WRITER_INTENT_FILE);
  try {
    fs.lstatSync(directory);
    throw coreDataRootBusyError();
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof CoreContractError) throw error;
      throw coreError('IRIS_CORE_DATA_ROOT_UNAVAILABLE', '无法检查 Iris 数据根写者租约');
    }
  }
  const owner = Object.freeze({
    contractVersion: CORE_CONTRACT_VERSION,
    instanceId,
    pid: process.pid,
    createdAt: new Date().toISOString()
  });
  try {
    // 创建目录之前已有完整 owner；SIGKILL 不会留下无法确认 PID 的新空锁。
    publishLeaseRecord(root, intentFile, owner);
  } catch (error) {
    if (error?.code === 'EEXIST') throw coreDataRootBusyError();
    throw coreError('IRIS_CORE_DATA_ROOT_UNAVAILABLE', '无法记录 Iris 数据根写者租约');
  }
  let madeDirectory = false;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    madeDirectory = true;
    fs.linkSync(intentFile, ownerFile);
    return Object.freeze({ root, directory, ownerFile, owner, evidence: readWriterLease(root) });
  } catch (error) {
    // 仅撤回本次创建的空目录和意图；不碰其他 writer 或未知目录内容。
    let withdrawn = !madeDirectory;
    if (madeDirectory) {
      try { fs.rmdirSync(directory); withdrawn = true; } catch (_) { /* owner/目录证据保留 */ }
    }
    if (withdrawn) { try { fs.unlinkSync(intentFile); } catch (_) { /* 保留 owner 供显式恢复 */ } }
    if (error?.code === 'EEXIST') throw coreDataRootBusyError();
    throw coreError('IRIS_CORE_DATA_ROOT_UNAVAILABLE', '无法取得 Iris 数据根写者租约');
  }
}

function releaseWriterLease(lease) {
  let actual;
  try {
    actual = readWriterLease(lease.root);
    if (!actual || actual.fingerprint !== lease.evidence.fingerprint || actual.phase !== 'owned') throw new Error('lease changed');
  } catch (_) {
    throw coreError('IRIS_CORE_LEASE_INVALID', 'Iris 写者租约无法安全释放；已保留现场');
  }
  if (actual.owner.instanceId !== lease.owner.instanceId) {
    throw coreError('IRIS_CORE_LEASE_INVALID', 'Iris 写者租约所有者不匹配；已保留现场');
  }

  const retired = path.join(lease.root, WRITER_LEASE_DIR + '.released-' + lease.owner.instanceId);
  try {
    // 整体移开非空目录；owner 从不在占位目录中先被删除。
    retireLeaseDirectory(lease.directory, retired);
    removeWriterIntent(actual);
  } catch (_) {
    throw coreError('IRIS_CORE_LEASE_INVALID', 'Iris 写者租约释放失败；已保留现场');
  }
  // 退役目录已不占有租约。中断或清理失败只留下可读证据，不阻止后续 writer。
  try { fs.unlinkSync(path.join(retired, 'owner.json')); fs.rmdirSync(retired); } catch (_) { /* 保留退役现场 */ }
}

function runtimeSnapshot(options, lifecycle, hasLease, inFlight) {
  return Object.freeze({
    contractVersion: CORE_CONTRACT_VERSION,
    state: lifecycle.state,
    mode: options.mode,
    writerLease: Boolean(hasLease),
    inFlight
  });
}

/**
 * 创建一个最小 Core Runtime 实例。它尚未迁移 0.1.4 的模块级存储；当前职责只有
 * 显式数据根、单写者租约、操作权限、AbortSignal 与可验证释放顺序。
 */
export function createCoreRuntime(input) {
  const options = normalizeCoreOptions(input);
  const instanceId = crypto.randomUUID();
  const abortController = new AbortController();
  const inFlight = new Set();
  const cleanup = [];
  let lifecycle = createCoreLifecycle();
  let root = null;
  let lease = null;
  let disposePromise = null;

  function snapshot() {
    return runtimeSnapshot(options, lifecycle, lease, inFlight.size);
  }

  function start() {
    if (lifecycle.state !== 'created') {
      return transitionCoreLifecycle(lifecycle, 'start');
    }
    const candidateRoot = physicalDataRoot(options);
    const candidateLease = options.mode === 'writer' ? acquireWriterLease(candidateRoot, instanceId) : null;
    if (candidateLease) {
      try { listCreationRequests(candidateRoot); readAllOperations(candidateRoot); }
      catch (error) {
        try { releaseWriterLease(candidateLease); }
        catch (cleanupError) {
          // Retained ownership must also make dispose fail, so the application stops its writer queue.
          root = candidateRoot; lease = candidateLease;
          lifecycle = transitionCoreLifecycle(lifecycle, 'dispose');
          abortController.abort();
          const failure = Object.assign(new AggregateError([error, cleanupError], '请求区检查失败且租约未能安全释放'),
            { code: 'IRIS_CORE_LEASE_INVALID' });
          disposePromise = Promise.reject(failure);
          void disposePromise.catch(() => {});
          throw failure;
        }
        throw error;
      }
    }
    root = candidateRoot;
    lease = candidateLease;
    lifecycle = transitionCoreLifecycle(lifecycle, 'start');
    return snapshot();
  }

  function onDispose(callback) {
    if (typeof callback !== 'function') throw new TypeError('Core Runtime cleanup 必须是函数');
    if (lifecycle.state === 'disposing' || lifecycle.state === 'disposed') {
      throw coreError('IRIS_CORE_STATE_INVALID', 'Core Runtime 已开始释放，不能注册 cleanup');
    }
    cleanup.push(callback);
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      const index = cleanup.indexOf(callback);
      if (index >= 0) cleanup.splice(index, 1);
      return index >= 0;
    };
  }

  function run(operation, callback) {
    if (typeof callback !== 'function') throw new TypeError('Core Runtime 操作必须是函数');
    assertCoreOperation(options, lifecycle, operation);
    const context = Object.freeze({ dataRoot: root, signal: abortController.signal });
    let result;
    try { result = callback(context); }
    catch (error) { result = Promise.reject(error); }
    const promise = Promise.resolve(result);
    inFlight.add(promise);
    promise.then(
      () => inFlight.delete(promise),
      () => inFlight.delete(promise)
    );
    return promise;
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    lifecycle = transitionCoreLifecycle(lifecycle, 'dispose');
    abortController.abort();
    disposePromise = (async () => {
      await Promise.allSettled([...inFlight]);
      for (const callback of [...cleanup].reverse()) await callback();
      cleanup.length = 0;
      if (lease) {
        releaseWriterLease(lease);
        lease = null;
      }
      root = null;
      lifecycle = transitionCoreLifecycle(lifecycle, 'finish-dispose');
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({
    start,
    run,
    onDispose,
    dispose,
    snapshot,
    get signal() { return abortController.signal; }
  });
}
