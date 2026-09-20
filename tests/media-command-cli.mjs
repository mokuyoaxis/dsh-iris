import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createCoreArtifact } from '../lib/core-artifacts.js';
import { ffmpegAvailable } from '../lib/media-probe.js';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : ': ' + JSON.stringify(extra)));
};
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-media-command-'));
const dataRoot = path.join(root, 'data');
const env = {
  ...process.env,
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: ''
};

function cli(args) {
  return spawnSync(process.execPath, ['bin/dsh-iris.js', ...args], {
    cwd: repo, env, encoding: 'utf8', shell: false
  });
}

try {
  const imageA = path.join(root, 'a.png');
  const imageB = path.join(root, 'b.png');
  await sharp({ create: { width: 16, height: 12, channels: 3, background: '#ff0000' } })
    .png().toFile(imageA);
  await sharp({ create: { width: 16, height: 12, channels: 3, background: '#0000ff' } })
    .png().toFile(imageB);

  const diffRun = cli(['media', 'diff', '--data-root', dataRoot, '--input', JSON.stringify({
    image_a_path: imageA,
    image_b_path: imageB,
    grid: 4,
    top_regions: 2
  })]);
  assert(diffRun.status === 0, 'media diff CLI 必须成功且不需要 Provider 配置', diffRun.stderr);
  const diff = JSON.parse(diffRun.stdout);
  assert(diff.command === 'media.diff' && diff.metrics.ratio === 1
      && diff.metrics.worstRegions.length === 2
      && diff.artifact.kind === 'pixel-diff' && diff.artifact.mediaType === 'image/png',
    'media.diff 必须返回指标和热力图 Artifact', diff);
  const diffManifest = fs.readFileSync(
    path.join(dataRoot, 'artifact-store', 'v0', 'manifests', diff.artifact.id + '.json'), 'utf8'
  );
  assert(!diffManifest.includes(root) && !diffManifest.includes('a.png') && !diffManifest.includes('b.png'),
    'media.diff Manifest 不得保存宿主输入路径', diffManifest);

  const invalidRun = cli(['media', 'diff', '--data-root', dataRoot, '--input', JSON.stringify({
    image_a_path: imageA,
    image_b_path: imageB,
    provider_url: 'https://must-not-cross.invalid'
  })]);
  assert(invalidRun.status === 1 && invalidRun.stderr.includes('IRIS_COMMAND_INPUT_INVALID'),
    'media.diff 必须拒绝未声明字段且不尝试网络', invalidRun.stderr);

  if (ffmpegAvailable()) {
    const video = path.join(root, 'clip.mp4');
    const generated = spawnSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=96x64:rate=8',
      '-pix_fmt', 'yuv420p', '-y', video
    ], { encoding: 'utf8', shell: false });
    assert(generated.status === 0, '测试视频必须生成成功', generated.stderr);
    const source = createCoreArtifact(dataRoot, {
      bytes: fs.readFileSync(video),
      mediaType: 'video/mp4',
      kind: 'fixture-video',
      metadata: {}
    });
    const framesRun = cli(['media', 'frames', '--data-root', dataRoot, '--input', JSON.stringify({
      artifact_id: source.id,
      max_frames: 3,
      target_width: 48,
      format: 'png'
    })]);
    assert(framesRun.status === 0, 'media frames CLI 必须从 Core Artifact 本地抽帧', framesRun.stderr);
    const frames = JSON.parse(framesRun.stdout);
    assert(frames.command === 'media.frames' && frames.artifacts.length === 3
        && frames.media.width === 96 && frames.media.height === 64,
      'media.frames 必须返回视频元数据和请求数量的帧 Artifact', frames);
    for (const [index, artifact] of frames.artifacts.entries()) {
      assert(artifact.kind === 'video-frame' && artifact.mediaType === 'image/png'
          && artifact.metadata.frameIndex === index + 1
          && artifact.relations.length === 1
          && artifact.relations[0].type === 'frame-of'
          && artifact.relations[0].artifactId === source.id,
        '每个帧 Artifact 必须携带序号、时间和 frame-of 关系', artifact);
    }
    const stored = frames.artifacts.map((artifact) => fs.readFileSync(
      path.join(dataRoot, 'artifact-store', 'v0', 'manifests', artifact.id + '.json'), 'utf8'
    )).join('\n');
    assert(!stored.includes(root) && !stored.includes('clip.mp4'),
      'media.frames Manifest 不得保存宿主或临时路径', stored);
  } else {
    const unavailable = cli(['media', 'frames', '--data-root', dataRoot, '--input', JSON.stringify({
      video_path: path.join(root, 'missing.mp4')
    })]);
    assert(unavailable.status === 1, '无 ffmpeg/输入时 media.frames 必须稳定失败');
  }

  console.log('ALL OK —— media.diff / media.frames CLI 本地 Artifact 闭环与零 Provider 配置通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
