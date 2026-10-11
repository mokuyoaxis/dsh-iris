'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CORE_CONTRACT_VERSION } from './core-contract.js';
import { privateSibling } from './private-storage.js';

export const WRITER_LEASE_DIR = '.iris-runtime-writer-v0';
export const WRITER_INTENT_FILE = '.iris-runtime-writer-v0.owner.json';
export function recoveryClaimFile(root, owner) {
  return path.join(root, WRITER_LEASE_DIR + '.recovery-' + owner.instanceId + '.json');
}
const UUID = /^[a-f0-9-]{36}$/;
const STALE = /^\.owner\.stale-([a-f0-9-]{36})\.json$/;

export function writerOwnerStatus(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error?.code === 'ESRCH' ? 'missing' : 'unknown'; }
}

export function newWriterOwner() {
  return { contractVersion: CORE_CONTRACT_VERSION, instanceId: crypto.randomUUID(),
    pid: process.pid, createdAt: new Date().toISOString() };
}

function checkedOwner(owner) {
  if (owner?.contractVersion !== CORE_CONTRACT_VERSION || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !UUID.test(String(owner.instanceId || '')) || !Number.isFinite(Date.parse(owner.createdAt))) {
    throw new Error('incomplete owner');
  }
  return owner;
}

function readRecord(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('invalid lease record');
  const serialized = fs.readFileSync(file, 'utf8');
  return { serialized, value: JSON.parse(serialized) };
}

function optionalRecord(file) {
  try { return readRecord(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/** 完整私有记录先在根中准备，再以 hard link 原子发布；已有目标绝不覆盖。 */
export function publishLeaseRecord(root, target, value) {
  const prepared = privateSibling(path.join(root, WRITER_INTENT_FILE), 'prepare');
  let created = false;
  try {
    fs.writeFileSync(prepared, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    created = true;
    fs.linkSync(prepared, target);
  } finally {
    if (created) { try { fs.unlinkSync(prepared); } catch (_) { /* 未发布的准备文件不占有租约 */ } }
  }
}

export function withdrawLeaseRecord(target, value) {
  if (readRecord(target).serialized !== JSON.stringify(value, null, 2) + '\n') throw new Error('published record changed');
  fs.unlinkSync(target);
}

export function retireLeaseDirectory(source, target) {
  try { fs.lstatSync(target); throw new Error('retirement destination already exists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  fs.renameSync(source, target);
}

/** 只读识别完整 owner、创建/释放意图及恢复链；未知内容和缺失证据拒绝。 */
export function readWriterLease(root) {
  const directory = path.join(root, WRITER_LEASE_DIR);
  const intentFile = path.join(root, WRITER_INTENT_FILE);
  const intent = optionalRecord(intentFile);
  if (intent) checkedOwner(intent.value);
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (!stat && !intent) return null;
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('invalid lease directory');
  const entries = stat ? fs.readdirSync(directory).sort() : [];
  const records = new Map();
  for (const name of entries) {
    if (name !== 'owner.json' && !STALE.test(name)) throw new Error('unexpected lease contents');
    records.set(name, readRecord(path.join(directory, name)));
  }
  const ownerRecord = records.get('owner.json');
  if (ownerRecord) checkedOwner(ownerRecord.value);
  const staleRecords = entries.filter(name => STALE.test(name));
  if (staleRecords.length > 1) throw new Error('ambiguous legacy recovery');
  const staleRecord = staleRecords.length ? records.get(staleRecords[0]) : null;
  if (staleRecord) checkedOwner(staleRecord.value);
  if (staleRecord && !ownerRecord) throw new Error('legacy recovery PID unknown');
  if (intent && ownerRecord && ownerRecord.serialized !== intent.serialized) {
    throw new Error('intent owner mismatch');
  }
  if (staleRecord && ownerRecord && STALE.exec(staleRecords[0])[1] !== ownerRecord.value.instanceId) {
    throw new Error('legacy recovery owner mismatch');
  }
  const original = staleRecord || ownerRecord || intent;
  if (!original) throw new Error('owner evidence missing');
  let owner = (ownerRecord || original).value;
  const owners = [original.value];
  if (owner.instanceId !== original.value.instanceId) owners.push(owner);
  const claims = [];
  for (;;) {
    const file = recoveryClaimFile(root, owner);
    const record = optionalRecord(file);
    if (!record) break;
    const claim = record.value;
    if (claim?.schemaVersion !== 1 || claim.previousInstanceId !== owner.instanceId) throw new Error('invalid recovery claim');
    claims.push({ file, ...record });
    owner = checkedOwner(claim.owner);
    if (owners.some(previous => previous.instanceId === owner.instanceId)) throw new Error('cyclic recovery chain');
    owners.push(owner);
    if (owners.length > 64) throw new Error('recovery chain too long');
  }
  const phase = owners.length > 1 || staleRecord ? 'recovering' : ownerRecord ? 'owned' : 'pending';
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    identity: stat ? [stat.dev, stat.ino] : null, intent: intent?.serialized,
    records: [...records].map(([name, record]) => [name, record.serialized]),
    claims: claims.map(record => [path.basename(record.file), record.serialized])
  })).digest('hex');
  return { directory, intentFile, intent, stat, entries, records, claims, owner, owners,
    originalOwner: original.value, phase, fingerprint };
}

export function removeWriterIntent(lease) {
  if (!lease.intent) return;
  const actual = readRecord(lease.intentFile);
  if (actual.serialized !== lease.intent.serialized) throw new Error('intent changed');
  fs.unlinkSync(lease.intentFile);
}
