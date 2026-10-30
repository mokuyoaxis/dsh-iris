import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicCreatePrivate, atomicWritePrivate } from './private-storage.js';
import { requestDirectory } from './local-request-root.js';
import { checkedPluginDependency, pluginFields, pluginJson, pluginFail, pluginObject } from './plugin-contract.js';
import { inspectCoreArtifactMetadata, findCoreArtifactMetadata } from './core-artifacts.js';

const ID = /^op_[a-f0-9]{64}$/, ARTIFACT = /^artifact_[a-f0-9]{24}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted'];
const CODES = ['dependency_unavailable', 'permission_denied', 'execution_failed'];
const invalid = () => pluginFail('IRIS_OPERATION_STORE_INVALID', '持久插件 Operation 记录损坏或绑定不一致');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const pluginInputDigest = (id, input, dependency, sourceArtifactIds = []) => 'sha256:' + hash(JSON.stringify(canonical(['plugin.execute/v1', id, input, checkedPluginDependency(dependency), sourceArtifactIds])));
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const ids = value => Array.isArray(value) && value.length <= 16 && new Set(value).size === value.length && value.every(id => typeof id === 'string' && ARTIFACT.test(id));
const fileFor = (root, marker, id) => { if (!ID.test(id)) invalid(); return path.join(requestDirectory(root, marker, 'operations'), id + '.json'); };
const save = (root, marker, record, create = false) => {
  validatePluginOperation(record, record.id, marker);
  (create ? atomicCreatePrivate : atomicWritePrivate)(fileFor(root, marker, record.id), JSON.stringify(record) + '\n');
  return structuredClone(record);
};
const now = record => new Date(Math.max(Date.now(), Date.parse(record.updatedAt))).toISOString();

export function validatePluginOperation(record, id, marker) {
  if (!pluginFields(record, ['schemaVersion', 'id', 'rootId', 'revision', 'action', 'operationId', 'dependency', 'input', 'inputDigest',
    'sourceArtifactIds', 'reservedArtifactIds', 'ownerInstanceId', 'createdAt', 'updatedAt', 'state', 'cancelRequested', 'startedAt', 'finishedAt', 'result', 'failureCode'],
  ['schemaVersion', 'id', 'rootId', 'revision', 'action', 'operationId', 'dependency', 'input', 'inputDigest', 'sourceArtifactIds', 'reservedArtifactIds',
    'ownerInstanceId', 'createdAt', 'updatedAt', 'state', 'cancelRequested']) || record.schemaVersion !== 1 || record.action !== 'plugin.execute'
      || !ID.test(id) || record.id !== id || record.rootId !== marker.rootId || !Number.isSafeInteger(record.revision) || record.revision < 1
      || !UUID.test(record.ownerInstanceId) || !STATES.includes(record.state) || !iso(record.createdAt) || !iso(record.updatedAt) || record.updatedAt < record.createdAt
      || record.cancelRequested !== (record.state === 'canceled') || !ids(record.sourceArtifactIds) || !ids(record.reservedArtifactIds)) invalid();
  const dependency = checkedPluginDependency(record.dependency);
  if (dependency.kind !== 'operations' || dependency.contributionId !== record.operationId
      || !pluginObject(record.input) || record.inputDigest !== pluginInputDigest(record.operationId, record.input, dependency, record.sourceArtifactIds)
      || Buffer.byteLength(JSON.stringify(record.input)) > 65536) invalid();
  if (record.reservedArtifactIds.some((value, i) => value !== 'artifact_' + hash(JSON.stringify([record.id, i])).slice(0, 24))) invalid();
  const active = ['queued', 'running'].includes(record.state), started = Object.hasOwn(record, 'startedAt');
  if (record.state === 'queued' && (record.revision !== 1 || started || record.reservedArtifactIds.length || record.updatedAt !== record.createdAt)
      || record.state === 'running' && !started || started && (!iso(record.startedAt) || record.startedAt < record.createdAt || record.startedAt > record.updatedAt)
      || record.state === 'failed' && !CODES.includes(record.failureCode) || record.state !== 'failed' && Object.hasOwn(record, 'failureCode')) invalid();
  if (active) { if (Object.hasOwn(record, 'finishedAt') || Object.hasOwn(record, 'result')) invalid(); }
  else if (!iso(record.finishedAt) || record.finishedAt !== record.updatedAt || !pluginFields(record.result, ['value', 'artifactIds'])
      || !ids(record.result.artifactIds) || record.result.artifactIds.some(value => !record.reservedArtifactIds.includes(value))
      || record.state === 'succeeded' && (!started || record.result.artifactIds.length !== record.reservedArtifactIds.length)
      || record.state !== 'succeeded' && record.result.value !== null
      || Buffer.byteLength(JSON.stringify(record.result.value)) > 128 * 1024) invalid();
  return record;
}

export function validatePluginBinding(root, record) {
  for (const id of record.sourceArtifactIds) inspectCoreArtifactMetadata(root, id);
  for (const id of record.result?.artifactIds || []) {
    const artifact = inspectCoreArtifactMetadata(root, id);
    if (artifact.kind !== 'plugin-image' || artifact.metadata.pluginOperationId !== record.id
        || JSON.stringify(artifact.relations) !== JSON.stringify(record.sourceArtifactIds.map(artifactId => ({ type: 'derived-from', artifactId })))) invalid();
  }
}
function read(root, marker, id) {
  const file = fileFor(root, marker, id), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) invalid();
  let record; try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { invalid(); }
  return validatePluginOperation(record, id, marker);
}
export function pluginSourceArtifacts(input, fields) {
  const result = [...new Set(fields.flatMap(key => input[key] === undefined ? [] : Array.isArray(input[key]) ? input[key] : [input[key]]))];
  if (!ids(result)) pluginFail('IRIS_PLUGIN_INPUT_INVALID', '业务来源须为最多 16 个有效 Artifact ID');
  return result;
}
export function acceptPluginOperation(root, marker, id, { operationId, input, dependency, ownerInstanceId, sourceArtifactIds }) {
  for (const artifactId of sourceArtifactIds) inspectCoreArtifactMetadata(root, artifactId);
  const time = new Date().toISOString();
  return save(root, marker, { schemaVersion: 1, id, rootId: marker.rootId, revision: 1, action: 'plugin.execute', operationId,
    dependency: checkedPluginDependency(dependency), input: pluginJson(input), inputDigest: pluginInputDigest(operationId, input, dependency, sourceArtifactIds),
    sourceArtifactIds, reservedArtifactIds: [], ownerInstanceId, createdAt: time, updatedAt: time, state: 'queued', cancelRequested: false }, true);
}
export function reservePluginArtifact(root, marker, id) {
  const record = read(root, marker, id);
  if (record.state !== 'running' || record.reservedArtifactIds.length >= 16) pluginFail('IRIS_PLUGIN_OPERATION_DENIED', '当前业务不可导入更多作品');
  const artifactId = 'artifact_' + hash(JSON.stringify([record.id, record.reservedArtifactIds.length])).slice(0, 24);
  save(root, marker, { ...record, revision: record.revision + 1, updatedAt: now(record), reservedArtifactIds: [...record.reservedArtifactIds, artifactId] });
  return artifactId;
}
export function transitionPluginOperation(root, marker, value) {
  const record = read(root, marker, value.id);
  if (record.revision !== value.expectedRevision) pluginFail('IRIS_OPERATION_REVISION_CONFLICT', 'Operation 已改变');
  const allowed = record.state === 'queued' ? ['running', 'failed', 'canceled', 'interrupted'] : record.state === 'running' ? STATES.filter(state => !['queued', 'running'].includes(state)) : [];
  if (!allowed.includes(value.state)) pluginFail('IRIS_OPERATION_TRANSITION_INVALID', '结束业务不重新排队或重放');
  if (value.state === 'failed' ? !CODES.includes(value.failureCode) : value.failureCode !== undefined) pluginFail('IRIS_OPERATION_INPUT_INVALID', '业务失败类别无效');
  const time = now(record), terminal = value.state !== 'running';
  const artifacts = terminal ? record.reservedArtifactIds.filter(id => findCoreArtifactMetadata(root, id)) : [];
  return save(root, marker, { ...record, revision: record.revision + 1, state: value.state, updatedAt: time, cancelRequested: value.state === 'canceled',
    ...(terminal ? { finishedAt: time, result: { value: value.state === 'succeeded' ? pluginJson(value.value) : null, artifactIds: artifacts } } : { startedAt: time }),
    ...(value.failureCode ? { failureCode: value.failureCode } : {}) });
}
export function projectPluginOperation(record) {
  const { schemaVersion: _version, ownerInstanceId: _owner, reservedArtifactIds: _planned, ...value } = record;
  return { contractVersion: 0, ...structuredClone(value) };
}
