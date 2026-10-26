// Private request containers. Version selection is explicit; readers never initialize or migrate.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicCreatePrivate } from './private-storage.js';
import { inspectFlowRoot } from './flow-store.js';
import { WRITER_LEASE_DIR, WRITER_INTENT_FILE } from './core-writer-lease.js';
import { inspectRunnerArea } from './execution-ownership.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function requestRootFail(code, message) { throw Object.assign(new Error(message), { code }); }
const invalid = () => requestRootFail('IRIS_CREATION_STORE_INVALID', '创建请求区未知、损坏或尚未完整初始化');
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
export function requestDirectory(root, marker, leaf) {
  return directory(root, ['creation-requests', 'v' + marker.schemaVersion, ...(leaf ? [leaf] : [])]);
}
export function inspectLocalRequestRoot(root, { allowAbsent = false } = {}) {
  let base;
  try { base = directory(root, ['creation-requests']); }
  catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(path.join(root, 'creation-requests'))) {
      if (allowAbsent) return null;
      requestRootFail('IRIS_CREATION_ROOT_REQUIRED', '请先在空的专用 Flow 根显式执行 api init 或 execution init');
    }
    if (error.code === 'ENOENT') invalid();
    throw error;
  }
  try {
    const versions = fs.readdirSync(base);
    if (versions.length !== 1 || !['v0', 'v1', 'v2'].includes(versions[0])) invalid();
    const schemaVersion = Number(versions[0].slice(1)), version = directory(root, ['creation-requests', versions[0]]);
    const allowed = schemaVersion === 0 ? ['root.json', 'requests'] : ['root.json', 'requests', 'operations', 'runner'];
    if (fs.readdirSync(version).some(name => !allowed.includes(name) && !/^root\.json\.tmp-[1-9][0-9]*-[a-f0-9]{12}$/.test(name))) invalid();
    const file = path.join(version, 'root.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) invalid();
    let marker;
    try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { invalid(); }
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
        || Object.keys(marker).length !== 4 || !['schemaVersion', 'kind', 'rootId', 'createdAt'].every(key => Object.hasOwn(marker, key))
        || marker.schemaVersion !== schemaVersion || marker.kind !== (schemaVersion === 0 ? 'iris-creation-requests' : 'iris-execution-requests')
        || !UUID.test(marker.rootId) || typeof marker.createdAt !== 'string'
        || !Number.isFinite(Date.parse(marker.createdAt)) || new Date(marker.createdAt).toISOString() !== marker.createdAt) invalid();
    directory(root, ['creation-requests', versions[0], 'requests']);
    if (schemaVersion >= 1) {
      inspectFlowRoot(root);
      directory(root, ['creation-requests', versions[0], 'operations']);
      // A separate, fully checked Core lease owns execution; it does not occupy the business writer.
      try { inspectRunnerArea(directory(root, ['creation-requests', versions[0], 'runner'])); }
      catch (error) { if (error.code === 'IRIS_EXECUTION_LEASE_INVALID') invalid(); throw error; }
    }
    return structuredClone(marker);
  } catch (error) { if (error.code === 'ENOENT') invalid(); throw error; }
}

export function initializeLocalRequestRoot(root, schemaVersion) {
  if (![0, 1, 2].includes(schemaVersion)) throw new TypeError('未知请求容器版本');
  const existing = inspectLocalRequestRoot(root, { allowAbsent: true });
  if (existing) {
    if (existing.schemaVersion !== schemaVersion) requestRootFail('IRIS_CREATION_ROOT_VERSION_CONFLICT', '请求根版本不同；不自动升级、降级或迁移，请使用新的专用根');
    return existing;
  }
  inspectFlowRoot(root);
  if (fs.readdirSync(root).some(name => !['flow-store', WRITER_LEASE_DIR, WRITER_INTENT_FILE].includes(name))
      || fs.readdirSync(path.join(root, 'flow-store')).some(name => name !== 'v0')
      || fs.readdirSync(path.join(root, 'flow-store/v0')).some(name => !['root.json', 'runs'].includes(name))
      || fs.readdirSync(path.join(root, 'flow-store/v0/runs')).length) {
    requestRootFail('IRIS_CREATION_ROOT_NOT_EMPTY', '请求区仅在新的空 Flow 根初始化；不转换已有创作数据');
  }
  const version = 'v' + schemaVersion;
  for (const leaf of schemaVersion === 0 ? ['requests'] : ['requests', 'operations', 'runner']) {
    directory(root, ['creation-requests', version, leaf], true);
  }
  const marker = { schemaVersion, kind: schemaVersion === 0 ? 'iris-creation-requests' : 'iris-execution-requests',
    rootId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  atomicCreatePrivate(path.join(root, 'creation-requests', version, 'root.json'), JSON.stringify(marker, null, 2) + '\n');
  return structuredClone(marker);
}
