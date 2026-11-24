import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CORE_ARTIFACT_EXTENSIONS, inspectCoreArtifactMetadata, readCoreArtifactStream } from './core-artifact-store.js';
import { isSafeInboxFilename } from './inbox-store.js';
import { pathsOverlap, resolveMaybeMissing } from './local-directory.js';
import { atomicWritePrivate } from './private-storage.js';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const STAGE = /^\.iris-outbox-[a-f0-9-]{36}\.part$/;
const IDENTITY = /^\d+:\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const identity = stat => stat.dev + ':' + stat.ino;
const sameFile = (stat, expected) => stat?.isFile() && identity(stat) === expected;

function fail(code, message, cause) {
  throw Object.assign(new Error(message, { cause }), { code });
}

function unconfirmed() {
  fail('IRIS_OUTBOX_UNCONFIRMED', '无法核对原出件的落盘归属，请保留原 UUID 并由所有者在 Core 本机检查');
}

function exists() {
  fail('IRIS_OUTBOX_FILE_EXISTS', '出件目录已有同名项，请选择新的文件名');
}

function entry(file) {
  return fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
}

export function resolveOutboxDirectory(directory, forbiddenPaths) {
  let physical, stat;
  try {
    const absolute = path.resolve(directory);
    stat = entry(absolute);
    if (!stat?.isDirectory()) throw new Error('outbox is not a real directory');
    physical = fs.realpathSync.native(absolute);
    fs.accessSync(physical, fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    fail('IRIS_API_CONFIG_INVALID', '出件目录必须是已存在的真实可写目录', error);
  }
  if (forbiddenPaths.filter(Boolean).some(forbidden => pathsOverlap(physical, path.resolve(forbidden))
      || pathsOverlap(physical, resolveMaybeMissing(forbidden)))) {
    fail('IRIS_API_CONFIG_INVALID', '出件目录不能与 Core 数据根、收件目录或私有配置和凭据重叠');
  }
  const fileIdentity = identity(stat);
  return Object.freeze({
    path: physical, fileIdentity,
    id: crypto.createHash('sha256').update(physical + '\0' + fileIdentity).digest('hex')
  });
}

function assertDirectory(directory) {
  const stat = entry(directory.path);
  if (!stat?.isDirectory() || identity(stat) !== directory.fileIdentity
      || fs.realpathSync.native(directory.path) !== directory.path) {
    fail('IRIS_OUTBOX_UNAVAILABLE', '出件目录当前不可访问或身份已变化');
  }
}

function safeName(name) {
  return isSafeInboxFilename(name) && name.isWellFormed() && Buffer.byteLength(name) <= 255
    && !/[<>:"|?*]|[ .]$/.test(name)
    && !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i.test(name.split('.')[0].trimEnd());
}

function matchesExtension(name, mediaType) {
  const extension = path.extname(name).toLowerCase();
  return Object.hasOwn(CORE_ARTIFACT_EXTENSIONS, mediaType) && (extension === CORE_ARTIFACT_EXTENSIONS[mediaType]
    || mediaType === 'image/jpeg' && extension === '.jpeg');
}

function readRecord(file) {
  const stat = entry(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 4096n) unconfirmed();
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) unconfirmed(); throw error; }
  const receipt = record?.receipt;
  if (!['prepared', 'publishing', 'completed'].includes(record?.state) || !SHA256.test(record.directory)
      || !safeName(receipt?.name) || !/^artifact_[a-f0-9]{24}$/.test(receipt.artifactId)
      || !matchesExtension(receipt.name, receipt.mediaType) || !SHA256.test(receipt.sha256)
      || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1
      || record.stage && (!STAGE.test(record.stage.name) || !(record.stage.identity === null || IDENTITY.test(record.stage.identity)))
      || record.state !== 'prepared' && !record.stage?.identity) unconfirmed();
  return record;
}

function removeStage(directory, stage) {
  if (!stage?.identity) return;
  assertDirectory(directory);
  const file = path.join(directory.path, stage.name);
  if (sameFile(entry(file), stage.identity)) fs.unlinkSync(file);
}

async function verifyPublished(target, stage, staged, receipt, signal) {
  if (!sameFile(staged, stage.identity)) unconfirmed();
  const handle = await fs.promises.open(target, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!sameFile(stat, stage.identity) || stat.size !== BigInt(receipt.bytes)) unconfirmed();
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) hash.update(chunk);
    if (hash.digest('hex') !== receipt.sha256) unconfirmed();
  } finally { await handle.close(); }
}

async function writeStage(dataRoot, receipt, handle, signal) {
  const source = readCoreArtifactStream(dataRoot, receipt.artifactId, { signal });
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of source.stream) {
    signal.throwIfAborted();
    await handle.writeFile(chunk);
    size += chunk.length;
    hash.update(chunk);
  }
  if (size !== receipt.bytes || hash.digest('hex') !== receipt.sha256) {
    fail('IRIS_ARTIFACT_DIGEST_MISMATCH', '出件内容与原作品摘要不一致');
  }
  await handle.sync();
}

export function listOutboxFiles(directory, { limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail('IRIS_OUTBOX_INPUT_INVALID', '出件列表 limit 须为 1–100 的整数');
  }
  try {
    assertDirectory(directory);
    const items = [];
    for (const name of fs.readdirSync(directory.path)) {
      if (name.startsWith('.') || STAGE.test(name) || !safeName(name)) continue;
      const stat = entry(path.join(directory.path, name));
      if (!stat?.isFile()) continue;
      items.push({
        name,
        bytes: Number(stat.size),
        updatedAt: new Date(Number(stat.mtimeMs)).toISOString()
      });
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
    return { total: items.length, files: items.slice(0, limit) };
  } catch (error) {
    if (/^E[A-Z0-9]+$/.test(error?.code || '')) {
      fail('IRIS_OUTBOX_UNAVAILABLE', '出件目录当前不可读取，请由所有者检查本机目录', error);
    }
    throw error;
  }
}

// The caller holds the Core writer for the whole request, including recovery.
export async function exportOutboxArtifact(dataRoot, directory, { key, artifactId, name }, { signal, authorize }) {
  if (!safeName(name)) fail('IRIS_OUTBOX_INPUT_INVALID', '出件只接受安全的顶层文件名');
  try {
    authorize();
    assertDirectory(directory);
    const records = path.join(dataRoot, 'outbox-requests-v0');
    const target = path.join(directory.path, name);
    const file = path.join(records, crypto.createHash('sha256').update(key).digest('hex') + '.json');
    const recordDirectory = entry(records);
    if (recordDirectory && !recordDirectory.isDirectory()) unconfirmed();
    let record = recordDirectory ? readRecord(file) : null;
    const replay = Boolean(record);
    if (record && (record.receipt.artifactId !== artifactId || record.receipt.name !== name)) {
      fail('IRIS_OUTBOX_KEY_CONFLICT', '该 UUID 已绑定其他作品或出件文件名');
    }
    if (record && record.directory !== directory.id) unconfirmed();

    const targetEntry = entry(target);
    if (!record) {
      const artifact = inspectCoreArtifactMetadata(dataRoot, artifactId);
      if (!matchesExtension(name, artifact.mediaType)) fail('IRIS_OUTBOX_INPUT_INVALID', '文件扩展名须匹配作品的实际媒体类型');
      if (targetEntry) exists();
      record = { state: 'prepared', directory: directory.id, stage: null, receipt: {
        name, artifactId, mediaType: artifact.mediaType, bytes: artifact.size, sha256: artifact.digest.value
      } };
      atomicWritePrivate(file, JSON.stringify(record));
    }

    const { receipt } = record;
    if (record.state === 'completed') {
      removeStage(directory, record.stage);
      return { receipt, replay: true };
    }
    if (record.state === 'publishing') {
      // Both names must identify the recorded temporary file. Matching bytes alone do not prove publication.
      if (!sameFile(targetEntry, record.stage.identity)) unconfirmed();
      const staged = entry(path.join(directory.path, record.stage.name));
      await verifyPublished(target, record.stage, staged, receipt, signal);
      authorize();
      signal.throwIfAborted();
      assertDirectory(directory);
      if (!sameFile(entry(target), record.stage.identity)) unconfirmed();
      atomicWritePrivate(file, JSON.stringify({ ...record, state: 'completed' }));
      removeStage(directory, record.stage);
      return { receipt, replay: true };
    }
    if (targetEntry) exists();

    if (record.stage) {
      const previous = entry(path.join(directory.path, record.stage.name));
      if (previous && !sameFile(previous, record.stage.identity)) unconfirmed();
      removeStage(directory, record.stage);
    }
    signal.throwIfAborted();
    const stage = { name: '.iris-outbox-' + crypto.randomUUID() + '.part', identity: null };
    const temporary = path.join(directory.path, stage.name);
    const save = state => atomicWritePrivate(file, JSON.stringify({ ...record, stage, state }));
    save('prepared');
    let publicationPending = false;
    try {
      const handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      try {
        stage.identity = identity(await handle.stat({ bigint: true }));
        save('prepared');
        await writeStage(dataRoot, receipt, handle, signal);
      } finally { await handle.close(); }
      signal.throwIfAborted();
      authorize();
      assertDirectory(directory);
      if (!sameFile(entry(temporary), stage.identity)) unconfirmed();
      // Keep the staging link as evidence until the completed receipt is committed.
      save('publishing');
      publicationPending = true;
      try { fs.linkSync(temporary, target); }
      catch (error) {
        save('prepared');
        publicationPending = false;
        if (error.code === 'EEXIST') exists();
        throw error;
      }
      save('completed');
      publicationPending = false;
    } finally {
      if (!publicationPending) removeStage(directory, stage);
    }
    return { receipt, replay };
  } catch (error) {
    if (/^E[A-Z0-9]+$/.test(error?.code || '')) {
      fail('IRIS_OUTBOX_UNAVAILABLE', '无法安全写入或核对出件，请由所有者检查配置目录和文件系统', error);
    }
    throw error;
  }
}
