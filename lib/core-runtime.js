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
import { ensurePrivateDir, writePrivateFile } from './private-storage.js';

const WRITER_LEASE_DIR = '.iris-runtime-writer-v0';
const WRITER_OWNER_FILE = 'owner.json';

/** 只读租约证据；PID 缺失不等于已经获准恢复，绝不自动夺取租约。 */
export function inspectCoreWriterLease(dataRoot) {
  const options = normalizeCoreOptions({ dataRoot, mode: 'reader' });
  const directory = path.join(options.dataRoot, WRITER_LEASE_DIR);
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) { return { status: error?.code === 'ENOENT' ? 'absent' : 'invalid' }; }
  try {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid lease');
    const entries = fs.readdirSync(directory);
    if (entries.length !== 1 || entries[0] !== WRITER_OWNER_FILE) throw new Error('invalid contents');
    const ownerFile = path.join(directory, WRITER_OWNER_FILE);
    const ownerStat = fs.lstatSync(ownerFile);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 16384) throw new Error('invalid owner');
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    const created = Date.parse(owner?.createdAt);
    if (owner?.contractVersion !== CORE_CONTRACT_VERSION || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || !/^[a-f0-9-]{36}$/.test(String(owner.instanceId || '')) || !Number.isFinite(created)) {
      throw new Error('incomplete owner');
    }
    let ownerStatus = 'alive';
    try { process.kill(owner.pid, 0); }
    catch (error) { ownerStatus = error?.code === 'ESRCH' ? 'missing' : 'unknown'; }
    return {
      status: 'present', ownerStatus, pid: owner.pid,
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
  const ownerFile = path.join(directory, WRITER_OWNER_FILE);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === 'EEXIST') throw coreDataRootBusyError();
    throw coreError('IRIS_CORE_DATA_ROOT_UNAVAILABLE', '无法取得 Iris 数据根写者租约');
  }

  const owner = Object.freeze({
    contractVersion: CORE_CONTRACT_VERSION,
    instanceId,
    pid: process.pid,
    createdAt: new Date().toISOString()
  });
  const serialized = JSON.stringify(owner, null, 2) + '\n';
  try {
    writePrivateFile(ownerFile, serialized, { flag: 'wx' });
  } catch (_) {
    try { fs.unlinkSync(ownerFile); } catch (_) { /* owner 文件可能尚未建立 */ }
    try { fs.rmdirSync(directory); } catch (_) { /* 保留不确定租约比误删安全 */ }
    throw coreError('IRIS_CORE_DATA_ROOT_UNAVAILABLE', '无法记录 Iris 数据根写者租约');
  }
  return Object.freeze({ directory, ownerFile, owner, serialized });
}

function releaseWriterLease(lease) {
  let actual;
  try {
    const stat = fs.lstatSync(lease.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('lease is not a directory');
    const entries = fs.readdirSync(lease.directory);
    if (entries.length !== 1 || entries[0] !== WRITER_OWNER_FILE) throw new Error('unexpected lease contents');
    actual = JSON.parse(fs.readFileSync(lease.ownerFile, 'utf8'));
  } catch (_) {
    throw coreError('IRIS_CORE_LEASE_INVALID', 'Iris 写者租约无法安全释放；已保留现场');
  }
  if (actual.instanceId !== lease.owner.instanceId) {
    throw coreError('IRIS_CORE_LEASE_INVALID', 'Iris 写者租约所有者不匹配；已保留现场');
  }

  try {
    fs.unlinkSync(lease.ownerFile);
    fs.rmdirSync(lease.directory);
  } catch (_) {
    // 若目录删除失败，尽力恢复 owner 证据；绝不把仍不确定的根宣布为可写。
    if (fs.existsSync(lease.directory) && !fs.existsSync(lease.ownerFile)) {
      try { writePrivateFile(lease.ownerFile, lease.serialized, { flag: 'wx' }); } catch (_) { /* 保持失败 */ }
    }
    throw coreError('IRIS_CORE_LEASE_INVALID', 'Iris 写者租约释放失败；已保留现场');
  }
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
