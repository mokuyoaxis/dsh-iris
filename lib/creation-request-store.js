// Private local creation intents. No Host, HTTP, Provider or Runtime dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicCreatePrivate, atomicWritePrivate } from './private-storage.js';
import { validateFlowCreation } from './flow-store.js';
import { inspectLocalRequestRoot, initializeLocalRequestRoot, requestDirectory } from './local-request-root.js';
import { normalizeComfyParameters } from './comfyui-workflow.js';

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
function jsonFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) invalid();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { invalid(); }
}

export function inspectCreationRoot(root, { allowAbsent = false } = {}) {
  return inspectLocalRequestRoot(root, { allowAbsent });
}

export function initializeCreationRoot(root) {
  const marker = initializeLocalRequestRoot(root, 0);
  listCreationRequests(root);
  return marker;
}

export function creationRequestId(marker, kind, key) {
  if (!UUID.test(key)) creationFail('IRIS_CREATION_KEY_INVALID', 'Idempotency-Key 须为单个小写 UUIDv4');
  if (!['image-import', 'flow-create', 'generation-create'].includes(kind)) throw new TypeError('未知本地创建类型');
  return 'req_' + hash(JSON.stringify(['creation-requests/v0', marker.rootId, kind, key]));
}
export function creationInputDigest(kind, input) {
  return 'sha256:' + hash(JSON.stringify(kind === 'image-import'
    ? ['image-import/v0', input.mediaType, input.size, input.sha256]
    : kind === 'generation-create' ? ['generation-create/v0', 'image-generate/v0', input.model_ref, input.prompt, input.size ?? null, 1,
      ...(input.workflow_parameters !== undefined ? [['comfyui-parameters/v0', normalizeComfyParameters(input.workflow_parameters)]] : [])]
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
  } else if (['flow-create', 'generation-create'].includes(record.kind)) {
    if (record.kind === 'generation-create' ? marker.schemaVersion !== 2 || intent.recipe !== 'image-generate/v0' : intent.recipe !== undefined) invalid();
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
  try { record = jsonFile(path.join(requestDirectory(root, marker, 'requests'), id + '.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return copy(validate(record, id, marker));
}
export function listCreationRequests(root) {
  const marker = inspectCreationRoot(root, { allowAbsent: true });
  if (!marker) return [];
  const records = [];
  for (const name of fs.readdirSync(requestDirectory(root, marker, 'requests'))) {
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
  atomicCreatePrivate(path.join(requestDirectory(root, marker, 'requests'), record.id + '.json'), JSON.stringify(record, null, 2) + '\n');
  return copy(record);
}
export function completeCreationRequest(root, record) {
  const current = readCreationRequest(root, record.id);
  if (!current || JSON.stringify(current) !== JSON.stringify(record) || current.state !== 'prepared') invalid();
  const finished = { ...record, state: 'succeeded', completedAt: new Date().toISOString(),
    result: record.kind === 'image-import' ? { artifactId: record.intent.artifactId } : { runId: record.intent.runId } };
  const marker = inspectCreationRoot(root);
  validate(finished, record.id, marker);
  atomicWritePrivate(path.join(requestDirectory(root, marker, 'requests'), record.id + '.json'), JSON.stringify(finished, null, 2) + '\n');
  return copy(finished);
}
export function creationReferences(root) {
  return listCreationRequests(root).filter(record => record.state === 'prepared').map(record => ({
    requestId: record.id, taskIds: record.kind !== 'image-import' ? [record.intent.taskId] : [],
    artifactIds: record.kind === 'image-import' ? [record.intent.artifactId]
      : [record.intent.source?.artifactId, record.intent.comparisonArtifactId].filter(Boolean)
  }));
}
