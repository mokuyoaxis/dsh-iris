/** 统一作品查询：跨 200 条分页、混合来源、只读目录与原内容核验。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCoreArtifact, readCoreArtifactBytes, listCoreArtifacts } from '../lib/core-artifacts.js';
import { useTempDshHome } from './test-env.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const { root } = useTempDshHome('iris-workbench-artifacts');
const { workbenchArtifacts } = await import('../lib/workbench-artifacts.js');
const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const { serveApi } = await import('../lib/api.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const dataRoot = dshCoreDataRoot();
assert.equal((await workbenchArtifacts({ source: 'core' })).total, 0);
assert.equal(listCoreArtifacts(dataRoot, { offset: 24 }).offset, 0, '原空 Store 列表语义保持');
assert(!fs.existsSync(dataRoot), '空目录查询不初始化 Core');
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('作品查询不应请求网络'); };
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const file = path.join(directory, entry.name);
    return [entry.name, entry.isDirectory() ? snapshot(file) : { hash: hash(fs.readFileSync(file)), mtime: fs.statSync(file).mtimeMs }];
  }));
}
function responder() {
  return { status: 0, body: '', writeHead(status) { this.status = status; this.headersSent = true; }, end(body) { this.body = body; this.writableEnded = true; } };
}
try {
  const seed = await runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, {
    bytes: FAKE_PNG, mediaType: 'image/png', kind: 'generated-image', metadata: {} }));
  const store = path.join(dataRoot, 'artifact-store/v0');
  const template = JSON.parse(fs.readFileSync(path.join(store, 'manifests', seed.id + '.json')));
  const catalog = [{ id: seed.id, createdAt: seed.createdAt, mediaType: seed.mediaType, size: seed.size, digest: seed.digest.value }];
  const definitions = [['generated-image', 'image/png', '.png'], ['generated-video', 'video/mp4', '.mp4'],
    ['generated-audio', 'audio/wav', '.wav'], ['transcript', 'text/plain', '.txt'],
    ['crop', 'image/png', '.png'], ['host-input', 'image/png', '.png'], ['structured-result', 'application/json', '.json']];
  const expected = [{ id: seed.id, createdAt: seed.createdAt, mime: seed.mediaType, source: 'core', kind: seed.kind }];
  // 以已验收的提交格式构建 >200 条目录，避免每个 fixture 写入都重新扫描历史对象。
  for (let i = 1; i <= 224; i++) {
    const id = 'artifact_' + i.toString(16).padStart(24, '0');
    const [kind, mediaType, ext] = definitions[i % definitions.length];
    const createdAt = new Date(Date.UTC(2026, 8, 1, 0, 0, Math.floor(i / 2))).toISOString();
    const manifest = { ...template, id, kind, mediaType, createdAt, object: id + ext };
    fs.writeFileSync(path.join(store, 'objects', manifest.object), FAKE_PNG);
    fs.writeFileSync(path.join(store, 'manifests', id + '.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(store, 'records', id + '.json'), JSON.stringify({ schemaVersion: 1, id, manifest: id + '.json' }));
    catalog.push({ id, createdAt, mediaType, size: manifest.size, digest: manifest.digest.value });
    if (kind !== 'host-input') expected.push({ id, createdAt, mime: mediaType, source: 'core', kind });
  }
  catalog.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const indexFile = path.join(store, 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify({ schemaVersion: 0, revision: 2, count: catalog.length,
    inventoryDigest: hash(JSON.stringify(catalog)), artifacts: catalog }));
  const legacyHome = path.join(root, 'iris/v1');
  const legacy = [];
  for (let i = 1; i <= 42; i++) {
    const entry = { id: 'a_' + i.toString(16).padStart(24, '0'), file: 'legacy-' + i + '.png', token: 'a'.repeat(32),
      mime: i % 2 ? 'image/png' : 'audio/wav', size: 50, createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i * 2)).toISOString() };
    if (i === 1) delete entry.mime; // 旧索引允许缺少 MIME，沿用原作品库的扩展名推断。
    legacy.push(entry); expected.push({ ...entry, mime: entry.mime || 'image/png', source: 'legacy', kind: 'legacy-output' });
  }
  fs.writeFileSync(path.join(legacyHome, 'artifacts.json'), JSON.stringify({ version: 1, artifacts: legacy }));
  expected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.source + ':' + a.id).localeCompare(b.source + ':' + b.id));
  const before = snapshot(dataRoot), legacyBefore = fs.readFileSync(path.join(legacyHome, 'artifacts.json'));
  const open = fs.openSync;
  let objectReads = 0;
  fs.openSync = function (file, ...args) {
    if (String(file).includes(path.join('v0', 'objects') + path.sep)) { objectReads++; throw new Error('列表不得读取媒体内容'); }
    return open.call(this, file, ...args);
  };
  try {
    const seen = [];
    for (let offset = 0; offset < expected.length; offset += 24) {
      const page = await workbenchArtifacts({ offset });
      assert.equal(page.total, expected.length); assert.equal(page.limit, 24); assert.equal(page.offset, offset);
      assert.deepEqual(page.items.map(item => item.id), expected.slice(offset, offset + 24).map(item => item.id));
      assert.equal(page.counts.core, 193); assert.equal(page.counts.legacy, 42);
      seen.push(...page.items.map(item => item.source + ':' + item.id));
      assert(!JSON.stringify(page).includes(root));
    }
    assert.equal(new Set(seen).size, expected.length);
    for (const source of ['all', 'core', 'legacy']) for (const media_type of ['all', 'image', 'video', 'audio', 'text']) {
      const matched = expected.filter(item => (source === 'all' || item.source === source)
        && (media_type === 'all' || (media_type === 'text' ? item.mime.startsWith('text/') || item.mime === 'application/json' : item.mime.startsWith(media_type + '/'))));
      const page = await workbenchArtifacts({ source, media_type, limit: 7 });
      assert.equal(page.total, matched.length);
      assert.deepEqual(page.items.map(item => item.id), matched.slice(0, 7).map(item => item.id));
    }
    const cropped = await workbenchArtifacts({ source: 'core', media_type: 'image', kind: 'crop' });
    assert.equal(cropped.total, 32); assert(cropped.items.every(item => item.kind === 'crop'));
    assert.equal((await workbenchArtifacts({ kind: 'missing-kind' })).total, 0);
    assert.equal((await workbenchArtifacts({ offset: 9999 })).offset, 216, '删除后空尾页收敛到最后一页');
    assert.equal(objectReads, 0);
  } finally { fs.openSync = open; }
  assert.deepEqual(snapshot(dataRoot), before); assert.deepEqual(fs.readFileSync(path.join(legacyHome, 'artifacts.json')), legacyBefore);

  const response = responder();
  await serveApi({ method: 'GET', url: '/iris/api/works?source=core&media_type=audio&offset=0&limit=7' }, response);
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).total, 32);
  for (const query of ['offset=-1', 'limit=0', 'limit=61', 'source=bad', 'media_type=bad', 'kind=', 'unknown=x']) {
    const response = responder(); await serveApi({ method: 'GET', url: '/iris/api/works?' + query }, response);
    assert.equal(response.status, 400, query); assert(!String(response.body).includes(root));
  }
  // 元数据目录不是内容验收；同长度篡改仍必须在原媒体读取层被拒绝。
  const object = path.join(store, 'objects', seed.id + '.png');
  fs.writeFileSync(object, Buffer.alloc(seed.size, 7));
  assert((await workbenchArtifacts({ source: 'core' })).items.some(item => item.id === seed.id));
  assert.throws(() => readCoreArtifactBytes(dataRoot, seed.id), { code: 'IRIS_ARTIFACT_DIGEST_MISMATCH' });
  assert.throws(() => listCoreArtifacts(dataRoot), { code: 'IRIS_ARTIFACT_INDEX_INVALID' }, '既有 CLI list 的哈希语义保持');
  const unavailable = responder(); await serveApi({ method: 'GET', url: '/iris/api/core/artifact/' + seed.id + '/media' }, unavailable);
  assert.equal(unavailable.status, 404);
  const manifestFile = path.join(store, 'manifests', seed.id + '.json');
  const manifestBefore = fs.readFileSync(manifestFile); fs.writeFileSync(manifestFile, '{}');
  const degraded = await workbenchArtifacts({ source: 'core' });
  assert.equal(degraded.droppedCore, 1); assert.equal(degraded.total, 192);
  fs.writeFileSync(manifestFile, manifestBefore);
  const indexBefore = fs.readFileSync(indexFile); fs.writeFileSync(indexFile, '{}');
  const legacyOnly = await workbenchArtifacts({});
  assert.equal(legacyOnly.total, 42); assert.equal(legacyOnly.coreError, 'IRIS_ARTIFACT_INDEX_INVALID');
  fs.writeFileSync(indexFile, indexBefore);
  console.log('ALL OK —— 工作台作品：225 Core + 42 legacy，完整分页/过滤/总数、零媒体内容读取/写入、损坏降级与原哈希保护');
} finally { globalThis.fetch = originalFetch; await runtime.dispose(); }
