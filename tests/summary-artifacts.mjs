import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
import { createDshVisionFixture } from './fixtures/vision-models.mjs';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createDshHostAdapter } from '../lib/dsh-host-adapter.js';
import { createCoreArtifact } from '../lib/core-artifacts.js';
import { buildContactSheet } from '../lib/summarize.js';
import { readSummaryFrames } from '../lib/summary-input.js';
import { ffmpegAvailable } from '../lib/media-probe.js';

const { root } = useTempDshHome('iris-summary-artifacts');
const repo = fileURLToPath(new URL('../', import.meta.url));
const config = await import('../lib/config.js');
const iris = await import('../lib/index.js');
const { runAction } = await import('../lib/actions.js');
const { dshCoreDataRoot, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const dataRoot = dshCoreDataRoot(), providers = path.join(root, 'providers.json'), stateFile = path.join(root, 'state.json');
const noTools = path.join(root, 'empty-path'); fs.mkdirSync(noTools);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function snapshot(directory) {
  const files = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    files[entry.name] = entry.isDirectory() ? snapshot(file) : { hash: hash(fs.readFileSync(file)), mtime: fs.statSync(file).mtimeMs };
  }
  return files;
}
fs.writeFileSync(providers, JSON.stringify({ providers: [{ id: 'fixture', type: 'openai', enabled: true,
  baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key',
  models: [{ id: 'vision', capabilities: ['vision'] }] }], assignments: { vision: ['fixture::vision'] } }), { mode: 0o600 });
const catalogBefore = fs.readFileSync(providers);
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const reset = extra => fs.writeFileSync(stateFile, JSON.stringify({ submit: 0, poll: 0, download: 0, tasks: {}, ...extra }));
let cliChecks = 0;
function cli(input, extra = [], expected = 0) {
  const result = spawnSync(process.execPath, ['bin/dsh-iris.js', 'vision', 'summarize', '--provider-config', providers,
    '--input', JSON.stringify(input), ...extra], { cwd: repo, encoding: 'utf8', timeout: 15000, shell: false,
    env: { ...process.env, PATH: noTools, DSH_HOME: path.join(root, 'unused-dsh'),
      NODE_OPTIONS: '--import=' + pathToFileURL(path.join(repo, 'tests/fixtures/headless-vision-fetch.mjs')).href,
      IRIS_ASYNC_FIXTURE_STATE: stateFile } });
  assert.ifError(result.error); assert.equal(result.status, expected, result.stderr + result.stdout);
  assert(!result.stdout.includes(root) && !result.stderr.includes(root));
  assert(!result.stdout.includes('fixture-key') && !result.stderr.includes('fixture-key'));
  assert(!fs.existsSync(path.join(root, 'unused-dsh'))); assert.deepEqual(fs.readFileSync(providers), catalogBefore);
  cliChecks++; return result;
}

const writer = createCoreRuntime({ dataRoot, mode: 'writer' }); writer.start();
const sourceFrames = [], artifacts = [], disposers = [];
const definitions = new Map();
const dsh = createDshVisionFixture();
const ctx = { get: name => ({
  tools: { register(def) { definitions.set(def.name, def); return () => {}; } }, attachments: dsh.attachments,
  agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'vision-v0' }) },
  llm: { ...dsh.textModel, currentSelection: () => ({ provider: 'fixture', model: 'vision-v0' }),
    async resolveModelInfo() { return { provider: 'fixture', id: 'vision-v0', inputModalities: ['image'] }; } }
})[name], inject() {}, effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); } };
try {
  for (let i = 0; i < 12; i++) {
    const buffer = await sharp({ create: { width: 160, height: 100, channels: 3,
      background: ['red', 'green', 'blue'][i % 3] } }).png().toBuffer();
    const frame = { buffer, atSec: 0.25 + i * 2, frameIndex: i + 1, width: 160, height: 100 };
    sourceFrames.push(frame);
    artifacts.push(await writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, {
      bytes: buffer, mediaType: 'image/png', kind: 'video-frame', metadata: { ...frame, buffer: undefined }
    })));
  }
  const wrongKind = await writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, {
    bytes: sourceFrames[0].buffer, mediaType: 'image/png', kind: 'generated-image', metadata: {}
  }));
  const noTimestamp = await writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, {
    bytes: sourceFrames[0].buffer, mediaType: 'image/png', kind: 'video-frame', metadata: { width: 160, height: 100, frameIndex: 1 }
  }));
  const corrupt = await writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, {
    bytes: sourceFrames[0].buffer, mediaType: 'image/png', kind: 'video-frame', metadata: artifacts[0].metadata
  }));
  fs.writeFileSync(path.join(dataRoot, 'artifact-store/v0/objects', corrupt.id + '.png'), Buffer.alloc(corrupt.size));
  const reader = createCoreRuntime({ dataRoot, mode: 'reader' }); reader.start();
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(readSummaryFrames(reader, [artifacts[0].id], canceled.signal), { code: 'IRIS_MODEL_ABORTED' });
  await reader.dispose();
  const ids = artifacts.map(a => a.id), input = { frame_artifact_ids: [...ids].reverse() };
  const rootArgs = ['--data-root', dataRoot], before = snapshot(dataRoot);
  const reference = await buildContactSheet({ frames: sourceFrames });
  reset();
  const sheetPath = path.join(root, 'sheet.png'), resultPath = path.join(root, 'result.json');
  const summarized = JSON.parse(cli(input, [...rootArgs, '--model-ref', 'fixture::vision', '--output', resultPath, '--sheet-output', sheetPath]).stdout);
  assert.equal(summarized.modelRef, 'fixture::vision'); assert.equal(summarized.selectionReason, 'explicit');
  assert.equal(summarized.transcription.status, 'disabled');
  assert.deepEqual(summarized.frames.map(f => f.artifactId), ids);
  assert.deepEqual(summarized.frames.map(f => f.frameIndex), sourceFrames.map(f => f.frameIndex));
  assert.deepEqual(summarized.frames.map(f => f.atSec), sourceFrames.map(f => f.atSec));
  assert.deepEqual(summarized.meta, { source: 'core-artifacts', startSec: 0.25, endSec: 22.25 });
  assert.equal(state().vision.length, 1); assert.equal(state().submit, 0);
  assert.deepEqual(fs.readFileSync(sheetPath), reference.buffer);
  assert.equal(summarized.contactSheet.sha256, state().vision[0].imageSha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath)), summarized);
  assert.deepEqual(snapshot(dataRoot), before, '无 ffmpeg 且另一个 writer 持租约时，CLI 应只读原帧');

  reset();
  const subset = JSON.parse(cli({ frame_artifact_ids: [ids[10], ids[1]], transcribe_text: 'fixture 转写正文' }, rootArgs).stdout);
  assert.deepEqual(subset.frames.map(f => f.frameIndex), [2, 11]);
  assert.deepEqual(subset.frames.map(f => f.atSec), [2.25, 20.25]);
  assert.equal(subset.transcription.status, 'provided'); assert.equal(state().submit, 0);
  assert(state().vision[0].prompt.includes('fixture 转写正文'));

  for (const invalid of [{}, { frame_artifact_ids: [] }, { frame_artifact_ids: [ids[0], ids[0]] },
    { frame_artifact_ids: Array(21).fill(ids[0]) }, { frame_artifact_ids: ['bad-id'] },
    { ...input, video_path: '/does-not-exist.mp4' }, { ...input, max_frames: 2 }, { ...input, target_width: 80 },
    { ...input, transcribe: true }, { frame_artifact_ids: [wrongKind.id] }, { frame_artifact_ids: [noTimestamp.id] },
    { frame_artifact_ids: ['artifact_' + '0'.repeat(24)] }]) {
    reset(); cli(invalid, rootArgs, 1); assert(!state().vision);
  }
  reset();
  assert(cli({ frame_artifact_ids: [corrupt.id] }, rootArgs, 1).stderr.includes('IRIS_ARTIFACT_DIGEST_MISMATCH'));
  assert(!state().vision);
  reset(); cli(input, [], 2); assert(!state().vision);
  const nonexistent = path.join(root, 'missing-core');
  reset(); cli(input, ['--data-root', nonexistent], 1); assert(!state().vision); assert(!fs.existsSync(nonexistent));
  reset({ mode: 'hang' });
  assert(cli({ frame_artifact_ids: [ids[0]] }, [...rootArgs, '--timeout-ms', '1000'], 1).stderr.includes('IRIS_MODEL_TIMEOUT'));
  assert.equal(state().vision.length, 1); assert.equal(state().visionAborted, true);
  assert.deepEqual(snapshot(dataRoot), before, '输入错误、损坏和超时不改写 Core');

  await iris.apply(ctx);
  const legacyBefore = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'));
  const tool = definitions.get('iris_media_summarize');
  const originalPath = process.env.PATH;
  process.env.PATH = noTools;
  try {
    const summary = await tool.execute(input, { signal: new AbortController().signal });
    assert.deepEqual(summary.frames, summarized.frames); assert(summary.blocks[0].text.includes('0.3–22.3s 已选帧'));
    const published = await dsh.attachments.readImage(summary.blocks[1].attachment);
    assert.deepEqual(Buffer.from(published.data), reference.buffer);
    assert.deepEqual(Buffer.from(dsh.calls.at(-1).request.image.bytes), reference.buffer);
    assert.equal(dsh.stats.invocations, 1);
    const gui = await runAction(createDshHostAdapter(ctx), 'media_summarize', { ...input, transcribe_text: '已有台词' });
    assert.deepEqual(gui.frames, summarized.frames); assert.equal(dsh.stats.invocations, 2);
    assert.deepEqual(Buffer.from(gui.imageDataUrl.split(',')[1], 'base64'), reference.buffer);
    assert(dsh.calls.at(-1).request.prompt.includes('已有台词'));
    await assert.rejects(tool.execute({ frame_artifact_ids: [wrongKind.id] }, {}));
    await assert.rejects(tool.execute({ ...input, transcribe: true }, {}), { code: 'IRIS_COMMAND_INPUT_INVALID' });
    await assert.rejects(tool.execute(input, { signal: canceled.signal }));
    assert.equal(dsh.stats.invocations, 2);
  } finally { process.env.PATH = originalPath; }
  assert.deepEqual(snapshot(dataRoot), before, 'DSH Agent 与动作不创建/修改 Core Task、Artifact 或租约');
  assert.deepEqual(fs.readFileSync(path.join(config.irisHome(), 'tasks.json')), legacyBefore);
  await writer.dispose();

  // 有可选工具时再验证真实 media.frames 提交物；上面的已有帧路径所有平台都运行。
  if (ffmpegAvailable()) {
    const clip = path.join(root, 'clip.mp4');
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x100:d=1:r=4', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const extracted = await definitions.get('iris_video_frames').execute({ video_path: clip, max_frames: 3, format: 'jpeg' }, {});
    assert(extracted.blocks[0].text.includes(JSON.stringify(extracted.artifactIds)), '渲染给 Agent 的结果必须提供可复用的 Core 帧 ID');
    fs.renameSync(clip, clip + '.unavailable');
    const extractedBefore = snapshot(dataRoot);
    reset();
    const actual = JSON.parse(cli({ frame_artifact_ids: [...extracted.artifactIds].reverse() }, rootArgs).stdout);
    assert.deepEqual(actual.frames.map(f => f.artifactId), extracted.artifactIds);
    assert(actual.frames.every((f, i) => f.frameIndex === i + 1));
    assert.deepEqual(snapshot(dataRoot), extractedBefore);
  } else console.log('SKIP —— 无 ffmpeg/ffprobe，仅跳过真实视频抽帧构造；已有 Artifact 摘要已完整验证');
  console.log(`ALL OK —— Core 帧摘要：${cliChecks} 次真实 CLI、DSH 工具/动作、乱序与子集、无 ffmpeg、writer 共存、同拼图字节、错误/超时零写入`);
} finally {
  stopProviderTaskWatchesForDsh();
  for (const dispose of disposers.reverse()) await dispose();
  await writer.dispose();
}
