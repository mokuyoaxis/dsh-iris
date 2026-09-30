import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
import { ffmpegAvailable } from '../lib/media-probe.js';
import { listCoreArtifacts, readCoreArtifactBytes } from '../lib/core-artifacts.js';

const { root } = useTempDshHome('iris-dsh-media-commands');
const repo = fileURLToPath(new URL('../', import.meta.url));
const { apply } = await import('../lib/index.js');
const { runAction } = await import('../lib/actions.js');
const { dshCoreDataRoot, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const config = await import('../lib/config.js');
const tasks = await import('../lib/tasks.js');
const registered = new Map();
const saved = new Map();
const disposers = [];
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('本地媒体 Command 禁止网络'); };
const a = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#ff0000' } }).png().toBuffer();
const b = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#0000ff' } }).png().toBuffer();
const aPath = path.join(root, 'a.png');
const bPath = path.join(root, 'b.png');
fs.writeFileSync(aPath, a);
fs.writeFileSync(bPath, b);
const sourceAttachments = new Map([['input-a', a], ['input-b', b]]);
const services = {
  tools: { register(definition) { registered.set(definition.name, definition); return () => {}; } },
  attachments: {
    async saveImage(input) {
      const ref = { attachmentId: 'saved-' + (saved.size + 1), mediaType: input.mediaType, name: input.name };
      saved.set(ref.attachmentId, Buffer.from(input.data));
      return ref;
    },
    async readImage(ref) { return { data: sourceAttachments.get(ref.attachmentId), mediaType: 'image/png' }; }
  },
  sessionQuery: { async readSession() {
    return { events: [...sourceAttachments.keys()].map((attachmentId) => ({
      type: 'image', attachment: { attachmentId, mediaType: 'image/png' }
    })) };
  } }
};
const ctx = {
  tools: services.tools,
  get(name) { return services[name]; },
  inject(names, callback) { if (names.every((name) => services[name])) callback(this); },
  effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); }
};
function exportMatches(artifactId, expected, label) {
  const output = path.join(root, label + '.png');
  const exported = spawnSync(process.execPath, ['bin/dsh-iris.js', 'artifact', 'export', artifactId,
    '--data-root', dshCoreDataRoot(), '--output', output], { cwd: repo, encoding: 'utf8', shell: false });
  assert.equal(exported.status, 0, exported.stderr);
  const bytes = fs.readFileSync(output);
  assert.deepEqual(bytes, expected, 'CLI 导出必须与 DSH 展示的字节相同');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),
    JSON.parse(exported.stdout).artifact.digest.value);
}

try {
  await apply(ctx);
  const diffTool = registered.get('iris_pixel_diff');
  const diff = await diffTool.execute({ image_a_path: aPath, image_b_path: bPath, grid: 4, top_regions: 2 }, {});
  const diffMedia = readCoreArtifactBytes(dshCoreDataRoot(), diff.artifactIds[0]);
  assert.equal(diffMedia.artifact.kind, 'pixel-diff');
  assert.equal(diffMedia.artifact.metadata.ratio, 1);
  assert.equal(diffMedia.artifact.relations.length, 2, '工具的两份图片输入必须保留 derived-from 来源');
  assert(diffMedia.artifact.relations.every((relation) => relation.type === 'derived-from'));
  const diffAttachment = saved.get(diff.blocks[1].attachment.attachmentId);
  assert.deepEqual(diffAttachment, diffMedia.bytes);
  exportMatches(diff.artifactIds[0], diffAttachment, 'tool-diff');

  const fromAttachments = await diffTool.execute({ attachment_a_id: 'input-a', attachment_b_id: 'input-b' }, {
    agent: { session: { id: 'fixture-session' } }
  });
  assert.equal(readCoreArtifactBytes(dshCoreDataRoot(), fromAttachments.artifactIds[0]).artifact.metadata.ratio, 1,
    '会话附件输入仍须能解析并经 Core Command 处理');
  const guiDiff = await runAction({}, 'diff', { image_a_path: aPath, image_b_path: bPath });
  assert.equal(readCoreArtifactBytes(dshCoreDataRoot(), guiDiff.artifactIds[0]).artifact.kind, 'pixel-diff');
  assert.deepEqual(Buffer.from(guiDiff.imageDataUrl.split(',')[1], 'base64'),
    readCoreArtifactBytes(dshCoreDataRoot(), guiDiff.artifactIds[0]).bytes);

  if (ffmpegAvailable()) {
    const videoPath = path.join(root, 'clip.mp4');
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      'testsrc=duration=1:size=96x64:rate=8', '-pix_fmt', 'yuv420p', '-y', videoPath], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const frameArgs = { video_path: videoPath, max_frames: 3, target_width: 48, format: 'png' };
    const frames = await registered.get('iris_video_frames').execute(frameArgs, {});
    assert.equal(frames.artifactIds.length, 3);
    for (const [index, id] of frames.artifactIds.entries()) {
      const media = readCoreArtifactBytes(dshCoreDataRoot(), id);
      assert.equal(media.artifact.kind, 'video-frame');
      assert.equal(media.artifact.metadata.frameIndex, index + 1);
      assert.equal(media.artifact.metadata.width, 48);
      assert.deepEqual(saved.get(frames.blocks[index + 1].attachment.attachmentId), media.bytes);
    }
    exportMatches(frames.artifactIds[0], saved.get(frames.blocks[1].attachment.attachmentId), 'tool-frame');
    const guiFrames = await runAction({}, 'video_frames', frameArgs);
    assert.equal(guiFrames.artifactIds.length, 3);
    assert.deepEqual(Buffer.from(guiFrames.imageDataUrl.split(',')[1], 'base64'),
      readCoreArtifactBytes(dshCoreDataRoot(), guiFrames.artifactIds[0]).bytes);
    const guiDefaultFormat = await runAction({}, 'video_frames', { ...frameArgs, format: '' });
    assert.equal(readCoreArtifactBytes(dshCoreDataRoot(), guiDefaultFormat.artifactIds[0]).artifact.mediaType,
      'image/jpeg', '工作台清空可选格式应沿用 JPEG 缺省值');
  } else {
    console.log('SKIP —— ffmpeg 不可用，DSH 抽帧实际字节验证跳过');
  }
  const count = listCoreArtifacts(dshCoreDataRoot()).total;
  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(runAction({}, 'diff', { image_a_path: aPath, image_b_path: bPath }, {
    signal: abortController.signal
  }), { name: 'AbortError' });
  assert.equal(listCoreArtifacts(dshCoreDataRoot()).total, count, '预先取消的动作不得提交 Artifact');
  assert.equal(fetchCalls, 0);
  assert.equal(tasks.all().length, 0, '本地媒体处理不得创建 legacy Task');
  assert(!fs.existsSync(path.join(config.irisHome(), 'outputs')), 'diff/抽帧不得双写 legacy outputs');
  assert(!fs.existsSync(path.join(dshCoreDataRoot(), '.iris-runtime-writer-v0')), 'DSH 处理和 CLI 导出后必须释放租约');
  for (const artifact of listCoreArtifacts(dshCoreDataRoot()).artifacts) {
    const manifest = fs.readFileSync(path.join(dshCoreDataRoot(), 'artifact-store', 'v0', 'manifests', artifact.id + '.json'), 'utf8');
    assert(!manifest.includes(root), 'Manifest 不得泄露宿主路径');
  }
  console.log('ALL OK —— DSH diff/抽帧工具与 GUI 经 Core，附件/CLI 导出字节一致、零网络零 legacy 双写');
} finally {
  stopProviderTaskWatchesForDsh();
  tasks.stopWatchAll();
  for (const dispose of disposers.reverse()) dispose();
  globalThis.fetch = originalFetch;
}
