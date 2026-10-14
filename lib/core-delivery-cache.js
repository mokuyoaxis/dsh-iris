'use strict';

/** 同步完成结果的私有交付证据；来源 URL/字节不进入 Task、Manifest 或日志。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWritePrivate, ensurePrivateDir } from './private-storage.js';

const TASK_ID = /^task_[a-f0-9]{24}$/;
const ARTIFACT_ID = /^artifact_[a-f0-9]{24}$/;
const PAYLOAD_FILE = /^payload-[a-f0-9]{24}\.bin$/;
const HASH = /^[a-f0-9]{64}$/;

export class DeliveryCacheError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeliveryCacheError';
    this.code = 'IRIS_DELIVERY_CACHE_INVALID';
  }
}

function invalid() { throw new DeliveryCacheError('同步交付缓存缺失、损坏或与 Task 身份不一致；不会重新生成'); }

function directory(dataRoot, taskId, create = false) {
  if (!TASK_ID.test(taskId)) invalid();
  let current = dataRoot;
  for (const part of ['delivery-cache', 'v0', taskId]) {
    current = path.join(current, part);
    if (create) {
      try { fs.lstatSync(current); }
      catch (error) { if (error.code !== 'ENOENT') throw error; ensurePrivateDir(current); }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  }
  return current;
}

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) invalid();
  return stat;
}

function fingerprint(file) {
  const stat = regular(file);
  if (!stat.size) invalid();
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return { size: stat.size, sha256: hash.digest('hex') };
}

function save(dataRoot, cache) {
  atomicWritePrivate(path.join(directory(dataRoot, cache.taskId), 'result.json'), JSON.stringify(cache, null, 2) + '\n');
}

export function createDeliveryCache(dataRoot, task, artifacts) {
  if (!Array.isArray(artifacts) || !artifacts.length) invalid();
  const root = directory(dataRoot, task.id, true);
  try { fs.lstatSync(path.join(root, 'result.json')); invalid(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cache = {
    schemaVersion: 0, resultKind: 'completed', taskId: task.id, attemptId: task.activeAttemptId,
    providerId: task.providerId, modelRef: task.modelRef, capability: task.capability,
    ...(task.providerBinding ? { providerBinding: task.providerBinding } : {}),
    createdAt: new Date().toISOString(), items: []
  };
  for (const remote of artifacts) {
    const item = { artifactId: 'artifact_' + crypto.randomBytes(12).toString('hex') };
    if (remote.kind === 'remote-url') {
      item.source = { kind: 'remote-url', url: remote.url, ...(remote.mediaType ? { mediaType: remote.mediaType } : {}) };
    } else if (remote.kind === 'inline-base64') {
      const bytes = Buffer.from(remote.data, 'base64');
      if (!bytes.length || bytes.toString('base64') !== remote.data) invalid();
      const file = 'payload-' + crypto.randomBytes(12).toString('hex') + '.bin';
      atomicWritePrivate(path.join(root, file), bytes);
      item.payload = { file, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        ...(remote.mediaType ? { mediaType: remote.mediaType } : {}) };
    } else invalid();
    cache.items.push(item);
  }
  // result.json 是完整同步响应的提交证据；未发布的文件不作为可恢复结果。
  save(dataRoot, cache);
  return cache;
}

export function readDeliveryCache(dataRoot, task, { allowAbsent = false } = {}) {
  let cache;
  try {
    const file = path.join(directory(dataRoot, task.id), 'result.json');
    regular(file);
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (allowAbsent && error.code === 'ENOENT') return null;
    invalid();
  }
  if (!cache || cache.schemaVersion !== 0 || cache.resultKind !== 'completed'
      || cache.taskId !== task.id || cache.attemptId !== task.activeAttemptId
      || cache.providerId !== task.providerId || cache.modelRef !== task.modelRef
      || cache.capability !== task.capability || cache.providerBinding !== task.providerBinding
      || !Array.isArray(cache.items) || !cache.items.length
      || typeof cache.createdAt !== 'string' || !Number.isFinite(Date.parse(cache.createdAt))) invalid();
  const ids = new Set();
  for (const item of cache.items) {
    if (!item || !ARTIFACT_ID.test(item.artifactId) || ids.has(item.artifactId)) invalid();
    ids.add(item.artifactId);
    if (item.source && (item.source.kind !== 'remote-url' || typeof item.source.url !== 'string' || !item.source.url.trim()
        || (item.source.mediaType !== undefined && typeof item.source.mediaType !== 'string'))) invalid();
    if (item.payload && (!PAYLOAD_FILE.test(item.payload.file) || !HASH.test(item.payload.sha256)
        || !Number.isSafeInteger(item.payload.size) || item.payload.size < 1
        || (item.payload.mediaType !== undefined && typeof item.payload.mediaType !== 'string'))) invalid();
    if (!item.payload && !item.source) invalid();
  }
  return cache;
}

export function deliveryCacheNeedsProvider(dataRoot, task) {
  return readDeliveryCache(dataRoot, task).items.some(item => !item.payload);
}

export function newDeliveryPayloadPath(dataRoot, cache) {
  return path.join(directory(dataRoot, cache.taskId), 'payload-' + crypto.randomBytes(12).toString('hex') + '.bin');
}

export function recordDeliveryPayload(dataRoot, cache, index, file, mediaType) {
  const root = directory(dataRoot, cache.taskId);
  if (path.dirname(file) !== root || !PAYLOAD_FILE.test(path.basename(file))) invalid();
  cache.items[index].payload = { file: path.basename(file), ...fingerprint(file), mediaType };
  delete cache.items[index].source;
  save(dataRoot, cache);
}

export function readDeliveryPayload(dataRoot, cache, index) {
  const payload = cache.items[index].payload;
  const file = path.join(directory(dataRoot, cache.taskId), payload.file);
  let actual;
  try { actual = fingerprint(file); } catch (_) { invalid(); }
  if (actual.size !== payload.size || actual.sha256 !== payload.sha256) invalid();
  return file;
}
