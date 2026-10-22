// Private local creation intents. No Host, HTTP, Provider or Runtime dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicCreatePrivate, atomicWritePrivate } from './private-storage.js';
import { inspectFlowRoot, validateFlowCreation } from './flow-store.js';
import { WRITER_LEASE_DIR, WRITER_INTENT_FILE } from './core-writer-lease.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^req_[a-f0-9]{64}$/;
const ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const SHA = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE = 20 * 1024 * 1024;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
function keys(value, allowed, required = allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
export function creationFail(code, message) { throw Object.assign(new Error(message), { code }); }
const invalid = () => creationFail('IRIS_CREATION_STORE_INVALID', '创建请求区未知、损坏或尚未完整初始化');
function directory(root, segments, create = false) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  }
  return current;
}
function jsonFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) invalid();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { invalid(); }
}

export function inspectCreationRoot(root, { allowAbsent = false } = {}) {
  let base;
  try { base = directory(root, ['creation-requests']); }
  catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(path.join(root, 'creation-requests'))) {
      if (allowAbsent) return null;
      creationFail('IRIS_CREATION_ROOT_REQUIRED', '请先在空的专用 Flow 根显式执行 api init');
    }
    if (error.code === 'ENOENT') invalid();
    throw error;
  }
  try {
    if (fs.readdirSync(base).some(name => name !== 'v0')) invalid();
    const version = directory(root, ['creation-requests', 'v0']);
    if (fs.readdirSync(version).some(name => !['root.json', 'requests'].includes(name)
        && !/^root\.json\.tmp-[1-9][0-9]*-[a-f0-9]{12}$/.test(name))) invalid();
    const marker = jsonFile(path.join(version, 'root.json'));
    if (!keys(marker, ['schemaVersion', 'kind', 'rootId', 'createdAt']) || marker.schemaVersion !== 0
        || marker.kind !== 'iris-creation-requests' || !UUID.test(marker.rootId) || !iso(marker.createdAt)) invalid();
    directory(root, ['creation-requests', 'v0', 'requests']);
    return copy(marker);
  } catch (error) { if (error.code === 'ENOENT') invalid(); throw error; }
}

export function initializeCreationRoot(root) {
  const existing = inspectCreationRoot(root, { allowAbsent: true });
  if (existing) { listCreationRequests(root); return existing; }
  inspectFlowRoot(root);
  if (fs.readdirSync(root).some(name => !['flow-store', WRITER_LEASE_DIR, WRITER_INTENT_FILE].includes(name))
      || fs.readdirSync(path.join(root, 'flow-store')).some(name => name !== 'v0')
      || fs.readdirSync(path.join(root, 'flow-store/v0')).some(name => !['root.json', 'runs'].includes(name))
      || fs.readdirSync(path.join(root, 'flow-store/v0/runs')).length) {
    creationFail('IRIS_CREATION_ROOT_NOT_EMPTY', '请求区仅在新的空 Flow 根初始化；不转换已有创作数据');
  }
  const marker = { schemaVersion: 0, kind: 'iris-creation-requests', rootId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  directory(root, ['creation-requests', 'v0', 'requests'], true);
  atomicCreatePrivate(path.join(root, 'creation-requests/v0/root.json'), JSON.stringify(marker, null, 2) + '\n');
  return copy(marker);
}

export function creationRequestId(marker, kind, key) {
  if (!UUID.test(key)) creationFail('IRIS_CREATION_KEY_INVALID', 'Idempotency-Key 须为单个小写 UUIDv4');
  if (!['image-import', 'flow-create'].includes(kind)) throw new TypeError('未知本地创建类型');
  return 'req_' + hash(JSON.stringify(['creation-requests/v0', marker.rootId, kind, key]));
}
export function creationInputDigest(kind, input) {
  return 'sha256:' + hash(JSON.stringify(kind === 'image-import'
    ? ['image-import/v0', input.mediaType, input.size, input.sha256]
    : ['flow-create/v0', 'image-edit/v0', input.source_artifact_id, input.model_ref, input.prompt, input.size ?? null, 1]));
}
function validate(record, id, marker) {
  if (!keys(record, ['schemaVersion', 'id', 'rootId', 'kind', 'inputDigest', 'createdAt', 'intent', 'state', 'completedAt', 'result'],
    ['schemaVersion', 'id', 'rootId', 'kind', 'inputDigest', 'createdAt', 'intent', 'state'])
      || record.schemaVersion !== 0 || !ID.test(id) || record.id !== id || record.rootId !== marker.rootId
      || !DIGEST.test(record.inputDigest) || !iso(record.createdAt) || record.intent?.createdAt !== record.createdAt
      || !['prepared', 'succeeded'].includes(record.state)) invalid();
  const intent = record.intent;
  let expectedResult, expectedDigest;
  if (record.kind === 'image-import') {
    if (!keys(intent, ['artifactId', 'mediaType', 'size', 'sha256', 'metadata', 'createdAt'])
        || !ARTIFACT.test(intent.artifactId) || !TYPES.has(intent.mediaType) || !SHA.test(intent.sha256)
        || !Number.isSafeInteger(intent.size) || intent.size < 1 || intent.size > MAX_IMAGE
        || !keys(intent.metadata, ['width', 'height']) || !['width', 'height'].every(key => Number.isSafeInteger(intent.metadata[key]) && intent.metadata[key] > 0)) invalid();
    expectedDigest = creationInputDigest(record.kind, intent);
    expectedResult = { artifactId: intent.artifactId };
  } else if (record.kind === 'flow-create') {
    try { validateFlowCreation(intent); } catch (_) { invalid(); }
    expectedDigest = creationInputDigest(record.kind, intent.input);
    expectedResult = { runId: intent.runId };
  } else invalid();
  if (record.inputDigest !== expectedDigest) invalid();
  if (record.state === 'prepared') {
    if (Object.hasOwn(record, 'completedAt') || Object.hasOwn(record, 'result')) invalid();
  } else if (!iso(record.completedAt) || !keys(record.result, Object.keys(expectedResult))
      || JSON.stringify(record.result) !== JSON.stringify(expectedResult)) invalid();
  return record;
}
export function readCreationRequest(root, id, marker = inspectCreationRoot(root)) {
  if (!ID.test(id)) invalid();
  let record;
  try { record = jsonFile(path.join(root, 'creation-requests/v0/requests', id + '.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return copy(validate(record, id, marker));
}
export function listCreationRequests(root) {
  const marker = inspectCreationRoot(root, { allowAbsent: true });
  if (!marker) return [];
  const records = [];
  for (const name of fs.readdirSync(path.join(root, 'creation-requests/v0/requests'))) {
    if (/^req_[a-f0-9]{64}\.json\.tmp-[1-9][0-9]*-[a-f0-9]{12}$/.test(name)) continue;
    if (!/^req_[a-f0-9]{64}\.json$/.test(name)) invalid();
    const record = readCreationRequest(root, name.slice(0, -5), marker);
    if (!record) invalid();
    records.push(record);
  }
  return records;
}
export function publishCreationRequest(root, record) {
  const marker = inspectCreationRoot(root);
  validate(record, record.id, marker);
  atomicCreatePrivate(path.join(root, 'creation-requests/v0/requests', record.id + '.json'), JSON.stringify(record, null, 2) + '\n');
  return copy(record);
}
export function completeCreationRequest(root, record) {
  const current = readCreationRequest(root, record.id);
  if (!current || JSON.stringify(current) !== JSON.stringify(record) || current.state !== 'prepared') invalid();
  const finished = { ...record, state: 'succeeded', completedAt: new Date().toISOString(),
    result: record.kind === 'image-import' ? { artifactId: record.intent.artifactId } : { runId: record.intent.runId } };
  validate(finished, record.id, inspectCreationRoot(root));
  atomicWritePrivate(path.join(root, 'creation-requests/v0/requests', record.id + '.json'), JSON.stringify(finished, null, 2) + '\n');
  return copy(finished);
}
export function creationReferences(root) {
  return listCreationRequests(root).filter(record => record.state === 'prepared').map(record => ({
    requestId: record.id, taskIds: record.kind === 'flow-create' ? [record.intent.taskId] : [],
    artifactIds: record.kind === 'image-import' ? [record.intent.artifactId]
      : [record.intent.source.artifactId, record.intent.comparisonArtifactId]
  }));
}
