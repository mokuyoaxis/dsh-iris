'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWritePrivate,
  chmodPrivateFile,
  ensurePrivateDir,
  privateSibling
} from './private-storage.js';

const STORE_DIR = 'artifact-store';
const STORE_VERSION = 'v0';
const ID = /^artifact_[a-f0-9]{24}$/;
const HASH = /^[a-f0-9]{64}$/;
const RELATION_TYPES = new Set(['derived-from', 'preview-of', 'frame-of', 'transcript-of', 'audio-for']);
const MEDIA_EXTENSION = Object.freeze({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm',
  'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/flac': '.flac',
  'text/plain': '.txt', 'application/json': '.json'
});
const EXTENSION_MEDIA = Object.freeze(Object.fromEntries(
  Object.entries(MEDIA_EXTENSION).map(([mediaType, extension]) => [extension, mediaType])
));

export class CoreArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoreArtifactError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoreArtifactError(code, message);
}

function dirs(dataRoot) {
  const storeRoot = path.join(dataRoot, STORE_DIR);
  const base = path.join(storeRoot, STORE_VERSION);
  return {
    storeRoot,
    base,
    objects: path.join(base, 'objects'),
    records: path.join(base, 'records'),
    manifests: path.join(base, 'manifests'),
    index: path.join(base, 'index.json')
  };
}

function checkedDirectory(directory, create = false) {
  try {
    if (create) ensurePrivateDir(directory);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a managed directory');
  } catch (_) { fail('IRIS_ARTIFACT_STORE_INVALID', 'Artifact Store 目录缺失或不安全'); }
}

function checkStore(dataRoot, { create = false, manifests = false } = {}) {
  const out = dirs(dataRoot);
  for (const directory of [out.storeRoot, out.base, out.objects, out.records]) {
    checkedDirectory(directory, create);
  }
  if (create || manifests) checkedDirectory(out.manifests, create);
  return out;
}

function ensureStore(dataRoot) {
  return checkStore(dataRoot, { create: true, manifests: true });
}

function stableId(value) {
  const id = String(value || '');
  if (!ID.test(id)) fail('IRIS_ARTIFACT_ID_INVALID', 'Artifact ID 格式无效');
  return id;
}

function recordPath(dataRoot, id) {
  return path.join(dirs(dataRoot).records, stableId(id) + '.json');
}

function manifestPath(dataRoot, id) {
  return path.join(dirs(dataRoot).manifests, stableId(id) + '.json');
}

function regularFile(file, code = 'IRIS_ARTIFACT_INVALID') {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(code, 'Artifact 文件不是普通文件');
    return stat;
  } catch (error) {
    if (error instanceof CoreArtifactError) throw error;
    fail(code, 'Artifact 文件缺失或无法读取');
  }
}

function jsonFile(file, code) {
  regularFile(file, code);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { fail(code, 'Artifact JSON 记录无效'); }
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    do {
      read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read) hash.update(chunk.subarray(0, read));
    } while (read);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function jsonClone(value, field) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('IRIS_ARTIFACT_INPUT_INVALID', field + ' 必须是 JSON 对象');
  }
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_) { fail('IRIS_ARTIFACT_INPUT_INVALID', field + ' 必须可序列化'); }
}

function normalizedRelations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('IRIS_ARTIFACT_INPUT_INVALID', 'relations 必须是数组');
  const seen = new Set();
  return value.map((edge) => {
    const type = String(edge?.type || '').trim();
    const artifactId = stableId(edge?.artifactId);
    const key = type + ':' + artifactId;
    if (!RELATION_TYPES.has(type) || seen.has(key)) {
      fail('IRIS_ARTIFACT_INPUT_INVALID', 'Artifact relation 类型无效或重复');
    }
    seen.add(key);
    return { type, artifactId };
  });
}

function validateManifest(manifest, id) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.schemaVersion !== 0 || manifest.id !== id
      || typeof manifest.kind !== 'string' || !manifest.kind.trim()
      || !MEDIA_EXTENSION[manifest.mediaType]
      || !Number.isSafeInteger(manifest.size) || manifest.size <= 0
      || typeof manifest.createdAt !== 'string'
      || manifest.object !== id + MEDIA_EXTENSION[manifest.mediaType]
      || manifest.digest?.algorithm !== 'sha256' || !HASH.test(String(manifest.digest?.value || ''))
      || !manifest.metadata || typeof manifest.metadata !== 'object' || Array.isArray(manifest.metadata)
      || !Array.isArray(manifest.relations)) {
    fail('IRIS_ARTIFACT_MANIFEST_INVALID', 'Artifact Manifest 结构无效');
  }
  normalizedRelations(manifest.relations);
  return manifest;
}

function publicArtifact(manifest) {
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    kind: manifest.kind,
    mediaType: manifest.mediaType,
    size: manifest.size,
    createdAt: manifest.createdAt,
    digest: Object.freeze({ ...manifest.digest }),
    relations: Object.freeze(manifest.relations.map((edge) => Object.freeze({ ...edge }))),
    metadata: Object.freeze({ ...manifest.metadata })
  });
}

function verifyObject(dataRoot, manifest) {
  const object = path.join(dirs(dataRoot).objects, manifest.object);
  const stat = regularFile(object);
  if (stat.size !== manifest.size) fail('IRIS_ARTIFACT_DIGEST_MISMATCH', 'Artifact 大小与 Manifest 不一致');
  if (hashFile(object) !== manifest.digest.value) {
    fail('IRIS_ARTIFACT_DIGEST_MISMATCH', 'Artifact 内容哈希与 Manifest 不一致');
  }
  return object;
}

function legacyManifest(dataRoot, record, id) {
  if (!record || record.schemaVersion !== 0 || record.id !== id
      || typeof record.kind !== 'string' || !MEDIA_EXTENSION[record.mediaType]
      || !Number.isSafeInteger(record.size) || record.size <= 0
      || record.object !== id + MEDIA_EXTENSION[record.mediaType]
      || !record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
    fail('IRIS_ARTIFACT_INVALID', '早期 Core Artifact 记录结构无效');
  }
  const object = path.join(dirs(dataRoot).objects, record.object);
  const stat = regularFile(object);
  if (stat.size !== record.size) fail('IRIS_ARTIFACT_DIGEST_MISMATCH', '早期 Core Artifact 大小不一致');
  return {
    schemaVersion: 0,
    id,
    kind: record.kind,
    mediaType: record.mediaType,
    size: record.size,
    createdAt: record.createdAt,
    object: record.object,
    digest: { algorithm: 'sha256', value: hashFile(object) },
    relations: [],
    metadata: { ...record.metadata }
  };
}

function readArtifact(dataRoot, id, { allowLegacy = true } = {}) {
  checkStore(dataRoot);
  const stable = stableId(id);
  let record;
  try { record = jsonFile(recordPath(dataRoot, stable), 'IRIS_ARTIFACT_NOT_FOUND'); }
  catch (error) {
    if (error.code === 'IRIS_ARTIFACT_NOT_FOUND') throw error;
    throw error;
  }
  let manifest;
  if (record?.schemaVersion === 1 && record.id === stable && record.manifest === stable + '.json') {
    checkedDirectory(dirs(dataRoot).manifests);
    manifest = validateManifest(
      jsonFile(manifestPath(dataRoot, stable), 'IRIS_ARTIFACT_MANIFEST_INVALID'), stable
    );
  } else if (allowLegacy) manifest = legacyManifest(dataRoot, record, stable);
  else fail('IRIS_ARTIFACT_INVALID', 'Artifact 提交记录无效');
  const object = verifyObject(dataRoot, manifest);
  return { manifest, object, legacy: record.schemaVersion === 0 };
}

function commitRecord(dataRoot, id) {
  atomicWritePrivate(recordPath(dataRoot, id), JSON.stringify({
    schemaVersion: 1, id, manifest: id + '.json'
  }, null, 2) + '\n');
}

function writeManifest(dataRoot, manifest) {
  validateManifest(manifest, manifest.id);
  atomicWritePrivate(manifestPath(dataRoot, manifest.id), JSON.stringify(manifest, null, 2) + '\n');
}

function readIndexRevision(file) {
  try {
    const index = jsonFile(file, 'IRIS_ARTIFACT_INDEX_INVALID');
    return Number.isSafeInteger(index.revision) && index.revision >= 0 ? index.revision : 0;
  } catch (_) { return 0; }
}

function committedIds(dataRoot) {
  const directory = dirs(dataRoot).records;
  try {
    return fs.readdirSync(directory)
      .map((name) => name.endsWith('.json') ? name.slice(0, -5) : '')
      .filter((id) => ID.test(id));
  } catch (_) { return []; }
}

function writeIndex(dataRoot, manifests) {
  const file = dirs(dataRoot).index;
  const revision = readIndexRevision(file) + 1;
  const artifacts = manifests
    .map((manifest) => ({
      id: manifest.id,
      createdAt: manifest.createdAt,
      mediaType: manifest.mediaType,
      size: manifest.size,
      digest: manifest.digest.value
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
  const inventoryDigest = crypto.createHash('sha256').update(JSON.stringify(artifacts)).digest('hex');
  atomicWritePrivate(file, JSON.stringify({
    schemaVersion: 0, revision, count: artifacts.length, inventoryDigest, artifacts
  }, null, 2) + '\n');
  return { revision, artifacts };
}

function refreshIndex(dataRoot) {
  const manifests = [];
  for (const id of committedIds(dataRoot)) {
    try { manifests.push(readArtifact(dataRoot, id).manifest); } catch (_) { /* rebuild 会报告坏记录 */ }
  }
  return writeIndex(dataRoot, manifests);
}

function validateRelationTargets(dataRoot, relations) {
  for (const edge of relations) readArtifact(dataRoot, edge.artifactId);
}

function finishObject(dataRoot, input) {
  const mediaType = String(input.mediaType || '');
  const extension = MEDIA_EXTENSION[mediaType];
  if (!extension) fail('IRIS_ARTIFACT_INPUT_INVALID', 'Artifact 媒体类型不受支持');
  const kind = String(input.kind || '').trim();
  if (!kind) fail('IRIS_ARTIFACT_INPUT_INVALID', 'Artifact kind 不能为空');
  const relations = normalizedRelations(input.relations);
  validateRelationTargets(dataRoot, relations);
  const metadata = jsonClone(input.metadata, 'metadata');
  const id = 'artifact_' + crypto.randomBytes(12).toString('hex');
  const store = ensureStore(dataRoot);
  const objectName = id + extension;
  const object = path.join(store.objects, objectName);
  let stat;
  try {
    input.writeObject(object);
    stat = regularFile(object);
  } catch (_) {
    try { fs.rmSync(object, { force: true }); } catch (_) { /* 当前随机 ID */ }
    fail('IRIS_ARTIFACT_WRITE_FAILED', 'Artifact 对象无法安全写入');
  }
  if (!stat.size) {
    try { fs.rmSync(object, { force: true }); } catch (_) { /* 只清理当前随机 ID */ }
    fail('IRIS_ARTIFACT_INPUT_INVALID', 'Artifact 内容不能为空');
  }
  const manifest = {
    schemaVersion: 0,
    id,
    kind,
    mediaType,
    size: stat.size,
    createdAt: input.createdAt || new Date().toISOString(),
    object: objectName,
    digest: { algorithm: 'sha256', value: hashFile(object) },
    relations,
    metadata
  };
  try {
    writeManifest(dataRoot, manifest);
    commitRecord(dataRoot, id);
  } catch (_) {
    try { fs.rmSync(object, { force: true }); } catch (_) { /* 当前 ID */ }
    try { fs.rmSync(manifestPath(dataRoot, id), { force: true }); } catch (_) { /* 当前 ID */ }
    fail('IRIS_ARTIFACT_WRITE_FAILED', 'Artifact 无法安全提交');
  }
  try { refreshIndex(dataRoot); } catch (_) { /* index 是可重建缓存，不撤销已提交 Artifact */ }
  return publicArtifact(manifest);
}

export function createCoreArtifact(dataRoot, input = {}) {
  let bytes;
  try { bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes || []); }
  catch (_) { fail('IRIS_ARTIFACT_INPUT_INVALID', 'Artifact 内容必须是字节数据'); }
  if (!bytes.length) fail('IRIS_ARTIFACT_INPUT_INVALID', 'Artifact 内容不能为空');
  return finishObject(dataRoot, {
    ...input,
    writeObject(object) { atomicWritePrivate(object, bytes); }
  });
}

/** 显式复制旧作品；不移动、不删除来源，也不保存来源路径或文件名。 */
export function adoptCoreArtifactFile(dataRoot, input = {}) {
  const source = String(input.sourcePath || '').trim();
  if (!path.isAbsolute(source)) fail('IRIS_ARTIFACT_INPUT_INVALID', '旧作品路径必须是绝对路径');
  const stat = regularFile(source, 'IRIS_ARTIFACT_INPUT_INVALID');
  if (!stat.size) fail('IRIS_ARTIFACT_INPUT_INVALID', '旧作品不能为空');
  const mediaType = String(input.mediaType || EXTENSION_MEDIA[path.extname(source).toLowerCase()] || '');
  return finishObject(dataRoot, {
    ...input,
    mediaType,
    kind: input.kind || 'adopted',
    writeObject(object) {
      const tmp = privateSibling(object, 'adopt');
      try {
        fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL);
        chmodPrivateFile(tmp);
        fs.renameSync(tmp, object);
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* rename 后已不存在 */ }
      }
    }
  });
}

export function inspectCoreArtifact(dataRoot, id) {
  return publicArtifact(readArtifact(dataRoot, id).manifest);
}

/** 供宿主投影层读取已经校验过内容哈希的字节；不暴露 Core 内部路径。 */
export function readCoreArtifactBytes(dataRoot, id) {
  const hit = readArtifact(dataRoot, id);
  return Object.freeze({
    artifact: publicArtifact(hit.manifest),
    bytes: Buffer.from(fs.readFileSync(hit.object))
  });
}

export function exportCoreArtifact(dataRoot, id, outputPath) {
  const destination = String(outputPath || '').trim();
  if (!destination || !path.isAbsolute(destination)) {
    fail('IRIS_ARTIFACT_EXPORT_INVALID', '导出路径必须是绝对路径');
  }
  try {
    if (!fs.statSync(path.dirname(destination)).isDirectory()) throw new Error('not directory');
  } catch (_) { fail('IRIS_ARTIFACT_EXPORT_INVALID', '导出目录不存在或不可访问'); }
  const hit = readArtifact(dataRoot, id);
  try { fs.copyFileSync(hit.object, destination, fs.constants.COPYFILE_EXCL); }
  catch (error) {
    if (error?.code === 'EEXIST') fail('IRIS_ARTIFACT_EXPORT_EXISTS', '导出目标已经存在；不会覆盖文件');
    fail('IRIS_ARTIFACT_EXPORT_FAILED', 'Artifact 导出失败');
  }
  return Object.freeze({ artifact: publicArtifact(hit.manifest), exported: true, bytes: hit.manifest.size });
}

export function listCoreArtifacts(dataRoot, { offset = 0, limit = 50 } = {}) {
  try { fs.lstatSync(dirs(dataRoot).storeRoot); }
  catch (error) {
    if (error?.code !== 'ENOENT') fail('IRIS_ARTIFACT_STORE_INVALID', 'Artifact Store 无法读取');
    return Object.freeze({
      schemaVersion: 0, revision: 0, total: 0, offset: 0, limit: Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50))),
      artifacts: Object.freeze([])
    });
  }
  checkStore(dataRoot, { manifests: true });
  const index = jsonFile(dirs(dataRoot).index, 'IRIS_ARTIFACT_INDEX_INVALID');
  const inventoryDigest = Array.isArray(index?.artifacts)
    ? crypto.createHash('sha256').update(JSON.stringify(index.artifacts)).digest('hex') : '';
  if (!index || index.schemaVersion !== 0 || !Number.isSafeInteger(index.revision)
      || !Array.isArray(index.artifacts) || index.count !== index.artifacts.length
      || !HASH.test(String(index.inventoryDigest || '')) || index.inventoryDigest !== inventoryDigest) {
    fail('IRIS_ARTIFACT_INDEX_INVALID', 'Artifact Index 结构或自校验无效');
  }
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  const size = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50)));
  const artifacts = [];
  for (const entry of index.artifacts.slice(start, start + size)) {
    if (!entry || !ID.test(String(entry.id || ''))) fail('IRIS_ARTIFACT_INDEX_INVALID', 'Artifact Index 条目无效');
    try {
      const artifact = inspectCoreArtifact(dataRoot, entry.id);
      if (entry.createdAt !== artifact.createdAt || entry.mediaType !== artifact.mediaType
          || entry.size !== artifact.size || entry.digest !== artifact.digest.value) {
        fail('IRIS_ARTIFACT_INDEX_INVALID', 'Artifact Index 条目与 Manifest 不一致');
      }
      artifacts.push(artifact);
    } catch (error) {
      if (error?.code === 'IRIS_ARTIFACT_INDEX_INVALID') throw error;
      fail('IRIS_ARTIFACT_INDEX_INVALID', 'Artifact Index 与存储事实不一致；请显式重建');
    }
  }
  return Object.freeze({
    schemaVersion: 0,
    revision: index.revision,
    total: index.artifacts.length,
    offset: start,
    limit: size,
    artifacts: Object.freeze(artifacts)
  });
}

function names(directory) {
  try { return fs.readdirSync(directory); } catch (_) { return []; }
}

/** 只读盘点，复用 Manifest/对象/Index 校验；不接回孤儿、不升级旧记录。 */
export function inspectCoreArtifactStore(dataRoot) {
  const store = dirs(dataRoot);
  try { fs.lstatSync(store.storeRoot); }
  catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', total: 0, invalid: 0, orphanObjects: 0, orphanManifests: 0, unresolved: 0, index: 'absent' };
    fail('IRIS_ARTIFACT_STORE_INVALID', 'Artifact Store 无法读取');
  }
  checkStore(dataRoot, { manifests: true });
  const records = fs.readdirSync(store.records);
  const manifests = fs.readdirSync(store.manifests);
  const objects = fs.readdirSync(store.objects);
  const recordIds = new Set(records.filter((name) => /^artifact_[a-f0-9]{24}\.json$/.test(name)).map((name) => name.slice(0, -5)));
  const manifestIds = new Set(manifests.filter((name) => /^artifact_[a-f0-9]{24}\.json$/.test(name)).map((name) => name.slice(0, -5)));
  const healthy = new Set();
  const referencedObjects = new Set();
  let invalid = 0;
  let orphanManifests = 0;
  let orphanObjects = 0;
  let unresolved = records.length - recordIds.size + manifests.length - manifestIds.size;
  for (const id of recordIds) {
    try {
      const hit = readArtifact(dataRoot, id);
      healthy.add(id);
      referencedObjects.add(hit.manifest.object);
    }
    catch (_) { invalid++; }
  }
  for (const id of manifestIds) {
    if (recordIds.has(id)) continue;
    try {
      const manifest = validateManifest(jsonFile(manifestPath(dataRoot, id), 'IRIS_ARTIFACT_MANIFEST_INVALID'), id);
      verifyObject(dataRoot, manifest);
      referencedObjects.add(manifest.object);
      orphanManifests++;
    } catch (_) { invalid++; }
  }
  for (const name of objects) {
    const id = name.slice(0, name.lastIndexOf('.'));
    const mediaType = EXTENSION_MEDIA[path.extname(name).toLowerCase()];
    if (!ID.test(id) || !mediaType || name !== id + MEDIA_EXTENSION[mediaType]) { unresolved++; continue; }
    try { regularFile(path.join(store.objects, name)); }
    catch (_) { unresolved++; continue; }
    if (!recordIds.has(id) && !manifestIds.has(id)) orphanObjects++;
    else if (!referencedObjects.has(name)) unresolved++;
  }
  let index = 'valid';
  try {
    const indexed = new Set();
    let page;
    let offset = 0;
    do {
      page = listCoreArtifacts(dataRoot, { offset, limit: 200 });
      for (const artifact of page.artifacts) indexed.add(artifact.id);
      offset += page.artifacts.length;
    } while (offset < page.total);
    if (indexed.size !== page.total || indexed.size !== healthy.size
        || [...healthy].some((id) => !indexed.has(id))) index = 'invalid';
  } catch (_) { index = 'invalid'; }
  return { status: 'present', total: healthy.size, invalid, orphanObjects, orphanManifests, unresolved, index };
}

function inferredOrphanManifest(dataRoot, id, objectName) {
  const mediaType = EXTENSION_MEDIA[path.extname(objectName).toLowerCase()];
  if (!mediaType || objectName !== id + MEDIA_EXTENSION[mediaType]) return null;
  const object = path.join(dirs(dataRoot).objects, objectName);
  const stat = regularFile(object);
  if (!stat.size) return null;
  return {
    schemaVersion: 0, id, kind: 'recovered', mediaType, size: stat.size,
    createdAt: new Date(stat.mtimeMs || Date.now()).toISOString(),
    object: objectName,
    digest: { algorithm: 'sha256', value: hashFile(object) },
    relations: [], metadata: { recovered: true }
  };
}

/**
 * writer/recover 专用：升级早期 Core 记录、补全可证明的孤儿提交并重建缓存索引。
 * 不删除任何对象；无法证明完整性的文件只计入报告。
 */
export function rebuildCoreArtifactIndex(dataRoot) {
  const store = ensureStore(dataRoot);
  const report = { recovered: 0, legacyUpgraded: 0, invalid: 0, unresolved: 0, danglingRelations: 0 };
  const records = new Set(committedIds(dataRoot));
  const manifests = new Set(names(store.manifests)
    .filter((name) => name.endsWith('.json') && ID.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5)));
  const objects = names(store.objects);

  for (const id of [...records]) {
    try {
      const hit = readArtifact(dataRoot, id);
      if (hit.legacy) {
        writeManifest(dataRoot, hit.manifest);
        commitRecord(dataRoot, id);
        report.legacyUpgraded++;
      }
    } catch (_) { report.invalid++; }
  }

  for (const id of manifests) {
    if (records.has(id)) continue;
    try {
      const manifest = validateManifest(jsonFile(manifestPath(dataRoot, id), 'IRIS_ARTIFACT_MANIFEST_INVALID'), id);
      verifyObject(dataRoot, manifest);
      commitRecord(dataRoot, id);
      records.add(id);
      report.recovered++;
    } catch (_) { report.invalid++; }
  }

  for (const objectName of objects) {
    const id = objectName.slice(0, objectName.lastIndexOf('.'));
    if (!ID.test(id) || records.has(id) || manifests.has(id)) {
      if (!records.has(id) && !manifests.has(id)) report.unresolved++;
      continue;
    }
    try {
      const manifest = inferredOrphanManifest(dataRoot, id, objectName);
      if (!manifest) { report.unresolved++; continue; }
      writeManifest(dataRoot, manifest);
      commitRecord(dataRoot, id);
      records.add(id);
      report.recovered++;
    } catch (_) { report.invalid++; }
  }

  const healthy = [];
  for (const id of committedIds(dataRoot)) {
    try { healthy.push(readArtifact(dataRoot, id).manifest); }
    catch (_) { /* 已在上面报告或属于竞态损坏；不会进入 index */ }
  }
  const healthyIds = new Set(healthy.map((item) => item.id));
  for (const manifest of healthy) {
    for (const edge of manifest.relations) if (!healthyIds.has(edge.artifactId)) report.danglingRelations++;
  }
  const index = writeIndex(dataRoot, healthy);
  return Object.freeze({
    schemaVersion: 0,
    total: healthy.length,
    ...report,
    indexRevision: index.revision
  });
}
