import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CoreArtifactError,
  adoptCoreArtifactFile,
  createCoreArtifact,
  inspectCoreArtifact,
  listCoreArtifacts,
  rebuildCoreArtifactIndex
} from '../lib/core-artifacts.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-artifact-manifest-'));
const store = path.join(root, 'artifact-store', 'v0');
const objects = path.join(store, 'objects');
const records = path.join(store, 'records');
const manifests = path.join(store, 'manifests');
const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : ': ' + JSON.stringify(extra)));
};
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

try {
  const empty = listCoreArtifacts(root);
  assert(empty.total === 0 && !fs.existsSync(path.join(root, 'artifact-store')),
    '已有 dataRoot 的空 reader list 必须返回空列表且零初始化', empty);
  const unsafeRoot = path.join(root, 'unsafe-list');
  fs.mkdirSync(unsafeRoot);
  fs.symlinkSync(root, path.join(unsafeRoot, 'artifact-store'), process.platform === 'win32' ? 'junction' : 'dir');
  let unsafeStore;
  try { listCoreArtifacts(unsafeRoot); } catch (error) { unsafeStore = error; }
  assert(unsafeStore?.code === 'IRIS_ARTIFACT_STORE_INVALID',
    'reader list 必须拒绝软链接 Artifact Store 祖先', unsafeStore?.code);
  const parentBytes = Buffer.from('manifest-parent');
  const parent = createCoreArtifact(root, {
    bytes: parentBytes, mediaType: 'image/png', kind: 'source', metadata: { width: 1 }
  });
  assert(parent.digest.algorithm === 'sha256' && parent.digest.value === sha256(parentBytes),
    '创建结果必须包含内容 SHA-256', parent);

  const child = createCoreArtifact(root, {
    bytes: Buffer.from('manifest-child'), mediaType: 'image/png', kind: 'crop',
    relations: [{ type: 'derived-from', artifactId: parent.id }], metadata: { width: 1 }
  });
  assert(child.relations.length === 1 && child.relations[0].artifactId === parent.id,
    'Manifest 必须保存从当前产物指向既有产物的关系边', child);
  const listed = listCoreArtifacts(root);
  assert(listed.total === 2 && listed.artifacts.some((item) => item.id === child.id),
    '正常提交后 Index 必须可分页读取', listed);

  let danglingRejected;
  try {
    createCoreArtifact(root, {
      bytes: Buffer.from('bad-relation'), mediaType: 'image/png', kind: 'invalid',
      relations: [{ type: 'derived-from', artifactId: 'artifact_aaaaaaaaaaaaaaaaaaaaaaaa' }]
    });
  } catch (error) { danglingRejected = error; }
  assert(danglingRejected?.code === 'IRIS_ARTIFACT_NOT_FOUND', '创建时必须拒绝悬空关系');

  // 同大小篡改也必须由 digest 发现，不能只依赖 stat.size。
  const parentObject = path.join(objects, parent.id + '.png');
  fs.writeFileSync(parentObject, Buffer.alloc(parentBytes.length, 0x78));
  let digestError;
  try { inspectCoreArtifact(root, parent.id); } catch (error) { digestError = error; }
  assert(digestError?.code === 'IRIS_ARTIFACT_DIGEST_MISMATCH', '同大小对象篡改必须稳定失败', digestError);
  fs.writeFileSync(parentObject, parentBytes);

  // Index 是缓存：损坏不影响按 ID 检查，显式 rebuild 可以恢复。
  fs.writeFileSync(path.join(store, 'index.json'), '{broken');
  assert(inspectCoreArtifact(root, child.id).id === child.id, 'Index 损坏不得破坏按 ID 的事实读取');
  let indexError;
  try { listCoreArtifacts(root); } catch (error) { indexError = error; }
  assert(indexError?.code === 'IRIS_ARTIFACT_INDEX_INVALID', '坏 Index 必须要求显式重建');
  const rebuilt = rebuildCoreArtifactIndex(root);
  assert(rebuilt.total === 2 && listCoreArtifacts(root).total === 2, '显式重建必须恢复 Index', rebuilt);

  const truncatedIndex = JSON.parse(fs.readFileSync(path.join(store, 'index.json'), 'utf8'));
  truncatedIndex.artifacts.pop();
  truncatedIndex.count = truncatedIndex.artifacts.length;
  fs.writeFileSync(path.join(store, 'index.json'), JSON.stringify(truncatedIndex));
  let checksumError;
  try { listCoreArtifacts(root); } catch (error) { checksumError = error; }
  assert(checksumError?.code === 'IRIS_ARTIFACT_INDEX_INVALID',
    '语法合法但条目被截断的 Index 必须由自校验发现');
  rebuildCoreArtifactIndex(root);

  // 崩溃窗口 1：object 已原子落盘，manifest/record 尚未写入。
  const objectOnlyId = 'artifact_111111111111111111111111';
  fs.writeFileSync(path.join(objects, objectOnlyId + '.png'), Buffer.from('object-only'));
  // 崩溃窗口 2：manifest 已落盘，record 提交标记尚未写入。
  const manifestOnly = createCoreArtifact(root, {
    bytes: Buffer.from('manifest-only'), mediaType: 'image/png', kind: 'fixture'
  });
  fs.rmSync(path.join(records, manifestOnly.id + '.json'));
  // 早期 Core v0 记录可显式升级，不要求破坏性原地迁移。
  const legacyId = 'artifact_222222222222222222222222';
  const legacyBytes = Buffer.from('legacy-core-record');
  fs.writeFileSync(path.join(objects, legacyId + '.png'), legacyBytes);
  fs.writeFileSync(path.join(records, legacyId + '.json'), JSON.stringify({
    schemaVersion: 0, id: legacyId, kind: 'legacy', mediaType: 'image/png',
    size: legacyBytes.length, createdAt: '2026-09-12T00:00:00.000Z',
    object: legacyId + '.png', metadata: {}
  }));
  fs.rmSync(path.join(store, 'index.json'));

  const recovered = rebuildCoreArtifactIndex(root);
  assert(recovered.recovered === 2 && recovered.legacyUpgraded === 1,
    'rebuild 必须补全 object-only、manifest-only 并升级早期记录', recovered);
  assert(inspectCoreArtifact(root, objectOnlyId).metadata.recovered === true,
    '无法还原来源元数据的 object-only 必须明确标记 recovered');
  assert(inspectCoreArtifact(root, legacyId).digest.value === sha256(legacyBytes),
    '早期记录升级必须计算真实内容哈希');
  assert(JSON.parse(fs.readFileSync(path.join(records, legacyId + '.json'), 'utf8')).schemaVersion === 1,
    '升级后 record 必须成为独立提交标记');

  // 显式接回旧作品只复制，不删除来源，也不把来源路径写入 Manifest。
  const legacyOutput = path.join(root, 'legacy-output.png');
  fs.writeFileSync(legacyOutput, Buffer.from('legacy-output'));
  const adopted = adoptCoreArtifactFile(root, { sourcePath: legacyOutput, kind: 'adopted' });
  assert(fs.existsSync(legacyOutput) && adopted.digest.value === sha256(Buffer.from('legacy-output')),
    '旧作品接回必须非破坏性复制并计算哈希', adopted);
  const storedManifest = fs.readFileSync(path.join(manifests, adopted.id + '.json'), 'utf8');
  assert(!storedManifest.includes(legacyOutput) && !storedManifest.includes('legacy-output.png'),
    'Manifest 不得保存旧作品绝对路径或文件名');

  // 目标作品后续丢失时，关系源仍可用；rebuild 报告 dangling，不级联删除。
  fs.rmSync(path.join(objects, parent.id + '.png'));
  fs.rmSync(path.join(manifests, parent.id + '.json'));
  fs.rmSync(path.join(records, parent.id + '.json'));
  const dangling = rebuildCoreArtifactIndex(root);
  assert(dangling.danglingRelations === 1 && inspectCoreArtifact(root, child.id).id === child.id,
    '悬空关系只进入报告，不得级联删除健康产物', dangling);

  // 未知文件和原子写临时现场不自动删除。
  const unknown = path.join(objects, 'unknown.part');
  fs.writeFileSync(unknown, 'keep-for-audit');
  const unresolved = rebuildCoreArtifactIndex(root);
  assert(unresolved.unresolved >= 1 && fs.existsSync(unknown), '无法证明的孤儿必须保留现场', unresolved);

  console.log('ALL OK —— Artifact Manifest hash、relations、Index 重建、孤儿恢复与崩溃一致性通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
