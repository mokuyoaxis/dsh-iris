/** 工作台管理：真实 HTTP、原字节 ZIP、只读预览及同一 Core 隔离/恢复。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempDshHome } from './test-env.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCoreArtifact, inspectCoreArtifact } from '../lib/core-artifacts.js';
import { createCoreTask, beginCoreAttempt, recordCoreAttemptResult, beginCoreDelivery, completeCoreDelivery, inspectCoreTask } from '../lib/core-tasks.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const { root } = useTempDshHome('iris-workbench-management');
const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const { downloadWorkbenchSelection, workbenchTransactions, MAX_WORKBENCH_DOWNLOAD_BYTES } = await import('../lib/workbench-management.js');
const { serveApi } = await import('../lib/api.js');
const { guarded } = await import('../lib/guard.js');
const legacy = await import('../lib/artifacts.js');
const dataRoot = dshCoreDataRoot(), hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
assert.deepEqual((await workbenchTransactions()).transactions, []);
assert(!fs.existsSync(dataRoot), '空回收区读取不初始化 Core');
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
const fixture = await runtime.run('execute', ({ dataRoot }) => {
  const task = createCoreTask(dataRoot, { capability: 'image' });
  const attempt = beginCoreAttempt(dataRoot, task.id, { providerId: 'fixture', model: 'fixture::image' });
  recordCoreAttemptResult(dataRoot, task.id, { id: attempt.id, providerId: 'fixture', model: 'fixture::image', acceptance: 'accepted', resultKind: 'completed' });
  beginCoreDelivery(dataRoot, task.id);
  const generated = createCoreArtifact(dataRoot, { bytes: FAKE_PNG, mediaType: 'image/png', kind: 'generated-image',
    metadata: { taskId: task.id, width: 8, height: 6, prompt: 'PRIVATE PROMPT', provider: 'PRIVATE PROVIDER', path: root, apiKey: 'PRIVATE KEY' } });
  completeCoreDelivery(dataRoot, task.id, [generated.id]);
  const source = createCoreArtifact(dataRoot, { bytes: Buffer.from('123456789'), mediaType: 'text/plain', kind: 'transcript' });
  const derived = createCoreArtifact(dataRoot, { bytes: Buffer.from('文字 → 结果'), mediaType: 'application/json', kind: 'structured',
    relations: [{ type: 'derived-from', artifactId: source.id }] });
  const webm = createCoreArtifact(dataRoot, { bytes: Buffer.from('webm fixture'), mediaType: 'video/webm', kind: 'generated-video' });
  const active = createCoreTask(dataRoot, { capability: 'image' });
  const activeArtifact = createCoreArtifact(dataRoot, { bytes: FAKE_PNG, mediaType: 'image/png', kind: 'generated-image', metadata: { taskId: active.id } });
  // 合法但尚未结束的任务引用，用于验证 UI/API 不放宽现有 Task 门。
  const taskFile = path.join(dataRoot, 'task-store/v0/tasks', active.id + '.json');
  const activeRecord = JSON.parse(fs.readFileSync(taskFile)); activeRecord.artifactIds = [activeArtifact.id];
  fs.writeFileSync(taskFile, JSON.stringify(activeRecord));
  inspectCoreTask(dataRoot, active.id);
  return { generated, task: task.id, source, derived, webm, active: active.id, activeArtifact };
});
const outputs = path.join(root, 'iris/v1/outputs'); fs.mkdirSync(outputs, { recursive: true });
const legacyBytes = Buffer.from('原旧版 PNG\n'); fs.writeFileSync(path.join(outputs, '旧作品.png'), legacyBytes);
const legacyItem = legacy.register(path.join(outputs, '旧作品.png'));
const big = path.join(outputs, 'big.mp4'); fs.writeFileSync(big, ''); fs.truncateSync(big, MAX_WORKBENCH_DOWNLOAD_BYTES + 1);
const bigItem = legacy.register(big);
const server = http.createServer(guarded((req, res) => serveApi(req, res)));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  assert(String(url).startsWith(base), '本测试不允许外部请求');
  return nativeFetch(url, ...args);
};
function snapshot() {
  const result = {};
  for (const relative of ['artifact-store/v0', 'task-store/v0']) {
    const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file); else result[path.relative(dataRoot, file)] = { digest: hash(fs.readFileSync(file)), mtime: fs.statSync(file).mtimeMs };
    } };
    walk(path.join(dataRoot, relative));
  }
  result.legacy = hash(fs.readFileSync(path.join(root, 'iris/v1/artifacts.json')));
  return result;
}
const get = url => fetch(base + url);
const post = (url, input, options = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(input), signal: options.signal });
async function json(response, status = 200) {
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
  const encoded = JSON.stringify(value);
  for (const secret of [root, 'PRIVATE PROMPT', 'PRIVATE PROVIDER', 'PRIVATE KEY', 'apiKey']) assert(!encoded.includes(secret));
  return value;
}
const coreItems = [fixture.generated, fixture.source, fixture.derived, fixture.webm].map(artifact => ({ source: 'core', id: artifact.id }));
function cli(args) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url)), ...args, '--data-root', dataRoot], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
try {
  const before = snapshot();
  const detail = await json(await get('/iris/api/works/core/' + fixture.generated.id));
  assert.equal(detail.item.digest, fixture.generated.digest.value);
  assert.deepEqual(detail.item.metadata, { width: 8, height: 6, taskId: fixture.task });
  assert.equal((await json(await get('/iris/api/works/legacy/' + legacyItem.id))).item.file, '旧作品.png');
  for (const artifact of [fixture.derived, fixture.webm]) {
    const media = await get('/iris/api/core/artifact/' + artifact.id + '/media'); assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), artifact.mediaType);
  }
  const selection = { items: [...coreItems, { source: 'legacy', id: legacyItem.id }] };
  const download = await post('/iris/api/works/download', selection);
  assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await download.arrayBuffer());
  const expected = new Map([['core/' + fixture.generated.id + '.png', FAKE_PNG], ['core/' + fixture.source.id + '.txt', Buffer.from('123456789')],
    ['core/' + fixture.derived.id + '.json', Buffer.from('文字 → 结果')], ['core/' + fixture.webm.id + '.webm', Buffer.from('webm fixture')],
    ['legacy/' + legacyItem.id + '.png', legacyBytes]]);
  const archived = new Map(); let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18), nameSize = zip.readUInt16LE(offset + 26), extraSize = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameSize).toString('utf8'), start = offset + 30 + nameSize + extraSize;
    archived.set(name, zip.subarray(start, start + size));
    if (name.endsWith('.txt')) assert.equal(zip.readUInt32LE(offset + 14), 0xcbf43926, 'IEEE CRC32 标准向量');
    offset = start + size;
  }
  assert.equal(archived.size, expected.size + 1);
  for (const [name, bytes] of expected) assert.deepEqual(archived.get(name), bytes);
  const manifest = JSON.parse(archived.get('works.json')); assert.equal(manifest.items.length, expected.size);
  assert(!archived.get('works.json').toString().includes(root));
  assert(!archived.get('works.json').toString().includes('/iris/media/'), '下载清单不携带授权 token 链接');
  const zipFile = path.join(root, 'works.zip'); fs.writeFileSync(zipFile, zip);
  const decoded = spawnSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert len(z.namelist())==6; print("PASS Python zipfile decoding and CRC checks")', zipFile], { encoding: 'utf8' });
  if (decoded.error?.code === 'ENOENT') console.log('Python 不可用，独立 ZIP 解码待验；标准 CRC 向量与字节核验通过');
  else { assert.equal(decoded.status, 0, decoded.stderr); console.log(decoded.stdout.trim()); }
  for (const input of [{ items: [] }, { items: [coreItems[0], coreItems[0]] }, { items: [{ source: 'core', id: legacyItem.id }] },
    { items: [{ source: 'legacy', id: fixture.source.id }] }, { items: Array.from({ length: 201 }, () => coreItems[0]) }, { items: coreItems, path: root }]) {
    await json(await post('/iris/api/works/download', input), 400);
  }
  await json(await post('/iris/api/works/download', { items: [{ source: 'core', id: 'artifact_' + 'f'.repeat(24) }] }), 404);
  await json(await post('/iris/api/works/download', { items: [{ source: 'legacy', id: bigItem.id }] }), 413);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadWorkbenchSelection(selection, { signal: controller.signal }), { name: 'AbortError' });
  const underway = new AbortController(); setImmediate(() => underway.abort());
  await assert.rejects(downloadWorkbenchSelection(selection, { signal: underway.signal }), { name: 'AbortError' });
  await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.derived.id], confirm_delete: true }, { headers: { Origin: 'http://evil.example' } }), 403);
  const denied = await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.source.id] }));
  assert(!denied.allowed && denied.blockers.some(item => item.reason === 'artifact_relation'));
  const taskPreview = await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.generated.id] }));
  assert(!taskPreview.allowed); assert.deepEqual(taskPreview.referencingTasks, [{ id: fixture.task, settled: true }]);
  const withTask = { artifact_ids: [fixture.generated.id], task_ids: [fixture.task] };
  assert((await json(await post('/iris/api/works/delete', withTask))).allowed);
  assert(!(await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.activeArtifact.id], task_ids: [fixture.active] }))).allowed);
  const activePreview = await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.activeArtifact.id] }));
  assert.deepEqual(activePreview.referencingTasks, [{ id: fixture.active, settled: false }]);
  await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.activeArtifact.id], task_ids: [fixture.active], confirm_delete: true }), 409);
  await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.generated.id], task_ids: [fixture.active], confirm_delete: true }), 400);
  await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.derived.id], confirm_delete: 'true' }), 400);
  await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.derived.id], confirm_delete: true }), 409); // writer 租约仍被持有。
  assert.deepEqual(snapshot(), before, '详情/ZIP/预览/所有拒绝均零事实写入');
  assert(!fs.existsSync(path.join(dataRoot, 'maintenance')));
  await runtime.dispose();
  const selectionIds = [fixture.source.id, fixture.derived.id];
  const deleted = await json(await post('/iris/api/works/delete', { artifact_ids: selectionIds, confirm_delete: true }));
  assert(deleted.recoverable); assert.equal(deleted.files, 6);
  assert.throws(() => inspectCoreArtifact(dataRoot, fixture.source.id));
  const transactions = await json(await get('/iris/api/works/transactions'));
  assert.equal(transactions.transactions[0].transactionId, deleted.transactionId);
  await json(await post('/iris/api/works/restore', { transaction_id: deleted.transactionId }), 400);
  await json(await post('/iris/api/works/restore', { transaction_id: deleted.transactionId, confirm_restore: true }));
  for (const id of selectionIds) assert.equal(inspectCoreArtifact(dataRoot, id).id, id);
  const removedTask = await json(await post('/iris/api/works/delete', { ...withTask, confirm_delete: true }));
  assert.throws(() => inspectCoreTask(dataRoot, fixture.task));
  assert(cli(['core', 'transactions']).transactions.some(item => item.transactionId === removedTask.transactionId && item.state === 'committed'));
  assert.equal(cli(['core', 'restore', removedTask.transactionId]).state, 'restored', '同一 Host 隔离事务可以由独立 CLI 恢复');
  assert.equal((await json(await get('/iris/api/works/core/' + fixture.generated.id))).item.digest, fixture.generated.digest.value);
  assert.equal(inspectCoreTask(dataRoot, fixture.task).artifactIds[0], fixture.generated.id);
  const again = await json(await post('/iris/api/works/delete', { artifact_ids: [fixture.derived.id], confirm_delete: true }));
  const target = path.join(dataRoot, 'artifact-store/v0/objects', fixture.derived.id + '.json'); fs.writeFileSync(target, 'user data');
  await json(await post('/iris/api/works/restore', { transaction_id: again.transactionId, confirm_restore: true }), 409);
  assert.equal(fs.readFileSync(target, 'utf8'), 'user data');
  fs.renameSync(target, path.join(root, 'conflict-preserved.json'));
  await json(await post('/iris/api/works/restore', { transaction_id: again.transactionId, confirm_restore: true }));
  const tamper = path.join(dataRoot, 'artifact-store/v0/objects', fixture.generated.id + '.png');
  fs.writeFileSync(tamper, Buffer.alloc(FAKE_PNG.length, 8));
  await json(await post('/iris/api/works/download', { items: [coreItems[0], { source: 'legacy', id: legacyItem.id }] }), 409);
  fs.writeFileSync(tamper, FAKE_PNG);
  assert.equal(legacy.all().length, 2); assert.deepEqual(fs.readFileSync(path.join(outputs, '旧作品.png')), legacyBytes);
  console.log('ALL OK —— 真实工作台 HTTP：混合 ZIP 原字节/CRC/限额/取消、详情脱敏、引用/活跃任务门、预览零写入、隔离恢复/任务显式选择、冲突不覆盖');
} finally {
  globalThis.fetch = nativeFetch; await runtime.dispose();
  await new Promise(resolve => server.close(resolve));
}
