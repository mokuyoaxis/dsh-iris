import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCommandService } from '../lib/command-service.js';
import { listCoreArtifacts, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { readImageEditArtifact } from '../lib/image-edit-input.js';
import { MAX_IMPORT_IMAGE_BYTES } from '../lib/image-import.js';

const { root } = useTempDshHome('iris-image-import');
const dataRoot = path.join(root, 'core');
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
const commands = createCommandService(runtime);
const originals = [];
const beforeFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('图片导入不允许网络'); };
try {
  for (const [format, mediaType] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const bytes = await sharp({ create: { width: 13, height: 9, channels: 3, background: '#517ac2' } })[format]().toBuffer();
    const file = path.join(root, 'source-' + format + '.bin');
    fs.writeFileSync(file, bytes);
    const mtimeMs = fs.statSync(file).mtimeMs;
    const { artifact } = await commands.execute('artifact.import', { image_path: file });
    assert.equal(artifact.kind, 'imported-image');
    assert.equal(artifact.mediaType, mediaType, '按内容识别，不按扩展名猜测');
    assert.deepEqual(artifact.metadata, { width: 13, height: 9 });
    assert.deepEqual(readCoreArtifactBytes(dataRoot, artifact.id).bytes, bytes);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mtimeMs, mtimeMs);
    assert.deepEqual(Buffer.from((await readImageEditArtifact(dataRoot, artifact.id)).bytes), bytes, '导入ID可直接进入改图');
    originals.push({ artifact, file, bytes });
  }
  const fromBytes = await commands.execute('artifact.import', { image_bytes: new Uint8Array(originals[0].bytes) });
  assert.deepEqual(readCoreArtifactBytes(dataRoot, fromBytes.artifact.id).bytes, originals[0].bytes);
  const count = listCoreArtifacts(dataRoot).total;
  await assert.rejects(commands.execute('artifact.import', { image_path: originals[0].file, image_bytes: originals[0].bytes }),
    { code: 'IRIS_COMMAND_INPUT_INVALID' });
  await assert.rejects(commands.execute('artifact.import', { image_bytes: Buffer.from('not an image') }),
    { code: 'IRIS_IMAGE_IMPORT_INVALID' });
  const animated = await sharp(Buffer.concat([Buffer.alloc(300), Buffer.alloc(300, 255)]),
    { raw: { width: 10, height: 20, channels: 3, pageHeight: 10 } }).webp().toBuffer();
  await assert.rejects(commands.execute('artifact.import', { image_bytes: animated }), /不支持动画/);
  const oversized = path.join(root, 'too-large.png');
  fs.writeFileSync(oversized, 'x'); fs.truncateSync(oversized, MAX_IMPORT_IMAGE_BYTES + 1);
  await assert.rejects(commands.execute('artifact.import', { image_path: oversized }), /20 MiB/);
  await assert.rejects(commands.execute('artifact.import', { image_bytes: new Uint8Array() }), /非空/);
  assert.equal(listCoreArtifacts(dataRoot).total, count, '无效输入不提交作品');
  assert.equal(listCoreTasks(dataRoot).tasks.length, 0, '本地导入不创建生成任务');
  await runtime.dispose();

  const run = args => {
    const r = spawnSync(process.execPath, ['bin/dsh-iris.js', ...args], { encoding: 'utf8', shell: false });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const imported = run(['artifact', 'import', '--data-root', dataRoot, '--input', JSON.stringify({ image_path: originals[0].file })]);
  const id = imported.artifact.id;
  fs.writeFileSync(originals[0].file, 'source changed after explicit import');
  const output = path.join(root, 'export.png');
  run(['artifact', 'export', id, '--data-root', dataRoot, '--output', output]);
  assert.deepEqual(fs.readFileSync(output), originals[0].bytes, '跨进程导出独立于原文件后续变化');
  assert.equal(run(['artifact', 'inspect', id, '--data-root', dataRoot]).artifact.digest.value, imported.artifact.digest.value);
  const crop = run(['run', 'crop', '--data-root', dataRoot, '--input', JSON.stringify({ artifact_id: id, left: 1, top: 1, width: 5, height: 4 })]);
  assert.deepEqual(crop.artifact.relations, [{ type: 'derived-from', artifactId: id }]);
  for (const { artifact } of originals) assert(!JSON.stringify(artifact).includes(root), '作品记录不含宿主路径');
  assert(!fs.existsSync(path.join(root, 'iris')), '显式CLI不初始化个人DSH配置');
  assert(!fs.existsSync(path.join(dataRoot, '.iris-runtime-writer-v0')));
  console.log('PASS 图片导入：三格式原字节、真实MIME、大小/动画拒绝、无任务、改图输入及跨进程裁剪/导出');
} finally { await runtime.dispose(); globalThis.fetch = beforeFetch; }
