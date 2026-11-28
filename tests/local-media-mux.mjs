import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreArtifact, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { inspectArtifactLineage } from '../lib/core-lineage.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { extractFrames, ffmpegAvailable, muxVideoAudio, normalizeFramesOptions, normalizeMuxOptions, probeVideo } from '../lib/media-probe.js';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-local-media-mux');
const uuid = () => crypto.randomUUID();
const apps = [], services = [];

function runFfmpegFixture(args) {
  const res = spawnSync('ffmpeg', ['-v', 'error', ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, 'fixture ffmpeg failed: ' + (res.stderr || ''));
  return res.stdout.trim();
}

function videoStreamHash(inputPath) {
  return runFfmpegFixture(['-i', inputPath, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-']);
}

try {
  // Pure option validation checks (always run regardless of ffmpeg availability).
  assert.deepEqual(normalizeFramesOptions({ mode: 'last' }), {
    maxFrames: 1, targetWidth: 640, quality: 85, format: 'jpeg', mode: 'last'
  });
  assert.throws(() => normalizeFramesOptions({ mode: 'last', maxFrames: 2 }), /last 模式/);
  assert.throws(() => normalizeFramesOptions({ mode: 'invalid' }), /mode/);
  assert.deepEqual(normalizeMuxOptions({}), { audioFit: 'shortest', audioMode: 'replace', audioVolume: 1 });
  assert.throws(() => normalizeMuxOptions({ audioFit: 'stretch' }), /audioFit/);
  assert.throws(() => normalizeMuxOptions({ audioMode: 'stereo' }), /audioMode/);
  assert.throws(() => normalizeMuxOptions({ audioVolume: 0.05 }), /audioVolume/);
  assert.throws(() => normalizeMuxOptions({ audioVolume: 2.5 }), /audioVolume/);

  if (!ffmpegAvailable()) {
    console.log('SKIP ffmpeg-dependent checks (ffmpeg/ffprobe unavailable)');
    process.exit(0);
  }

  const fixtureDir = path.join(root, 'fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const redBlueMp4 = path.join(fixtureDir, 'red-blue.mp4');
  const longTrackMp4 = path.join(fixtureDir, 'long-track.mp4');
  const shortTrackMp4 = path.join(fixtureDir, 'short-track.mp4');
  const shiftedMp4 = path.join(fixtureDir, 'shifted.mp4');
  const shortWav = path.join(fixtureDir, 'short.wav');
  const longMp3 = path.join(fixtureDir, 'long.mp3');

  runFfmpegFixture([
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1:r=10',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=1:r=10',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', redBlueMp4
  ]);
  runFfmpegFixture([
    '-i', redBlueMp4, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-y', longTrackMp4
  ]);
  runFfmpegFixture([
    '-f', 'lavfi', '-i', 'color=c=green:s=160x120:d=2:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', shortTrackMp4
  ]);
  runFfmpegFixture([
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=5:r=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-output_ts_offset', '10', '-y', shiftedMp4
  ]);
  runFfmpegFixture(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.8', '-y', shortWav]);
  runFfmpegFixture(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=3.2', '-c:a', 'libmp3lame', '-y', longMp3]);

  // 1. Direct media-probe checks: last-frame extraction truly captures the blue ending frame.
  const lastFrames = await extractFrames({ inputPath: longTrackMp4, mode: 'last', targetWidth: 160, format: 'png' });
  assert.equal(lastFrames.length, 1);
  assert.equal(lastFrames[0].sampleMode, 'last');
  assert.equal(lastFrames[0].atSec, 1.9, 'last frame is at 1.9s even when the audio ends later');
  const { data: rgb } = await sharp(lastFrames[0].buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const centerIdx = (Math.floor(lastFrames[0].height / 2) * lastFrames[0].width + Math.floor(lastFrames[0].width / 2)) * 3;
  assert.ok(rgb[centerIdx + 2] > 180 && rgb[centerIdx] < 80,
    `expected blue last frame RGB, got (${rgb[centerIdx]},${rgb[centerIdx + 1]},${rgb[centerIdx + 2]})`);
  const [shiftedLast] = await extractFrames({ inputPath: shiftedMp4, mode: 'last' });
  assert.equal(shiftedLast.atSec, 4.9, 'tail seek preserves the frame time relative to the video file start');

  // 2. Direct muxVideoAudio checks across all audioFit / audioMode / maxOutputBytes options.
  const muxShortest = await muxVideoAudio({ videoPath: redBlueMp4, audioPath: shortWav, audioFit: 'shortest', audioMode: 'replace' });
  assert.equal(muxShortest.mediaType, 'video/mp4');
  assert.equal(muxShortest.media.hasAudio, true);
  assert.ok(muxShortest.media.durationSec >= 0.6 && muxShortest.media.durationSec <= 1.2,
    'shortest duration should match 0.8s audio: ' + muxShortest.media.durationSec);

  const muxLoop = await muxVideoAudio({ videoPath: redBlueMp4, audioPath: shortWav, audioFit: 'loop_audio', audioMode: 'replace', audioVolume: 0.5 });
  assert.equal(muxLoop.media.hasAudio, true);
  assert.equal(muxLoop.options.audioVolume, 0.5);
  assert.ok(muxLoop.media.durationSec >= 1.7 && muxLoop.media.durationSec <= 2.3,
    'loop_audio duration should match 2.0s video: ' + muxLoop.media.durationSec);

  const muxPad = await muxVideoAudio({ videoPath: redBlueMp4, audioPath: shortWav, audioFit: 'pad_silence', audioMode: 'mix' });
  assert.equal(muxPad.options.audioMode, 'replace', 'mix on silent video degrades safely to replace');
  assert.ok(muxPad.media.durationSec >= 1.7 && muxPad.media.durationSec <= 2.3,
    'pad_silence duration should match 2.0s video: ' + muxPad.media.durationSec);

  const originalVideoHash = videoStreamHash(shortTrackMp4);
  for (const audioFit of ['loop_audio', 'pad_silence']) {
    const muxMix = await muxVideoAudio({ videoPath: shortTrackMp4, audioPath: shortWav, audioFit, audioMode: 'mix', audioVolume: 1.5 });
    assert.equal(muxMix.options.audioMode, 'mix');
    assert.equal(muxMix.media.hasAudio, true);
    assert.ok(Math.abs(muxMix.media.durationSec - 2) <= 0.1,
      `${audioFit} must preserve the 2s video: ${muxMix.media.durationSec}s`);
    const mixedFile = path.join(fixtureDir, audioFit + '.mp4');
    fs.writeFileSync(mixedFile, muxMix.buffer);
    assert.equal(videoStreamHash(mixedFile), originalVideoHash, `${audioFit} must preserve every video packet`);
  }
  const mixShortest = await muxVideoAudio({ videoPath: shortTrackMp4, audioPath: shortWav, audioFit: 'shortest', audioMode: 'mix' });
  assert.ok(Math.abs(mixShortest.media.durationSec - 0.8) <= 0.1,
    'shortest uses the added audio, even when the original audio ends earlier');
  const shortestFile = path.join(fixtureDir, 'shortest.mp4');
  fs.writeFileSync(shortestFile, mixShortest.buffer);
  const [shortestLast] = await extractFrames({ inputPath: shortestFile, mode: 'last' });
  assert.equal(shortestLast.atSec, 0.7, 'shortest keeps the last video frame before the 0.8s cut');

  const muxTrimLong = await muxVideoAudio({ videoPath: longTrackMp4, audioPath: longMp3, audioFit: 'shortest' });
  assert.ok(muxTrimLong.media.durationSec >= 1.7 && muxTrimLong.media.durationSec <= 2.3,
    'longer audio is trimmed to 2.0s video: ' + muxTrimLong.media.durationSec);
  const trimmedAudioFile = path.join(fixtureDir, 'trimmed-audio.mp4');
  fs.writeFileSync(trimmedAudioFile, muxTrimLong.buffer);
  assert.equal(videoStreamHash(trimmedAudioFile), videoStreamHash(longTrackMp4),
    'shortest keeps the video stream when only the audio needs trimming');

  await assert.rejects(
    muxVideoAudio({ videoPath: redBlueMp4, audioPath: shortWav, maxOutputBytes: 128 }),
    { code: 'IRIS_COMMAND_OUTPUT_TOO_LARGE' }
  );

  // 3. Full Core + HTTP API + Outbox + MCP authorization checks on a v4 video/audio root.
  const dataRoot = path.join(root, 'core-v4');
  const outboxDir = path.join(root, 'outbox');
  const connectionStore = path.join(root, 'connections');
  fs.mkdirSync(outboxDir, { recursive: true });
  const app = createApplicationRuntime({ dataRoot }); apps.push(app);
  await app.execute('flow.init', {});
  await app.execute('execution.init', { video: true });

  const videoArt = await app.run('writer', rt => rt.run('execute', ({ dataRoot: r }) =>
    createCoreArtifact(r, { bytes: fs.readFileSync(redBlueMp4), mediaType: 'video/mp4', kind: 'generated-video' })));
  const audioArt = await app.run('writer', rt => rt.run('execute', ({ dataRoot: r }) =>
    createCoreArtifact(r, { bytes: fs.readFileSync(shortWav), mediaType: 'audio/wav', kind: 'generated-music' })));

  const api = createLocalReadApi({
    dataRoot,
    allowLocalWrites: true,
    allowConnectionManagement: true,
    connectionStore,
    allowMcp: true,
    outboxDir
  });
  services.push(api);
  const started = await api.start();
  const ownerHeaders = { Authorization: 'Bearer ' + started.accessToken, 'Content-Type': 'application/json' };
  const ownerGet = async route => {
    const res = await fetch(started.origin + route, { headers: { Authorization: 'Bearer ' + started.accessToken } });
    return { status: res.status, body: await res.json() };
  };
  const ownerPost = async (route, body, extraHeaders = {}) => {
    const res = await fetch(started.origin + route, {
      method: 'POST', headers: { ...ownerHeaders, ...extraHeaders }, body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };

  // Owner session exposes local-media.mux and outbox.export.
  const session = (await ownerGet('/api/v0/session')).body;
  assert.equal(session.outbox, true);
  assert.ok(session.operations.includes('local-media.mux'));
  assert.ok(session.operations.includes('outbox.export'));

  // HTTP POST /api/v0/local-media/frames with mode: 'last'.
  const badLast = await ownerPost('/api/v0/local-media/frames', { artifactId: videoArt.id, mode: 'last', maxFrames: 3 });
  assert.equal(badLast.status, 400);
  const lastRes = await ownerPost('/api/v0/local-media/frames', { artifactId: videoArt.id, mode: 'last', targetWidth: 160, format: 'png' });
  assert.equal(lastRes.status, 201);
  assert.equal(lastRes.body.frames.length, 1);
  assert.equal(lastRes.body.frames[0].sampleMode, 'last');
  assert.equal(lastRes.body.frames[0].atSec, 1.9);

  // HTTP POST /api/v0/local-media/mux creates muxed-video with dual derived-from lineage.
  const muxRes = await ownerPost('/api/v0/local-media/mux', {
    videoArtifactId: videoArt.id, audioArtifactId: audioArt.id, audioFit: 'loop_audio', audioMode: 'replace', audioVolume: 0.8
  });
  assert.equal(muxRes.status, 201, JSON.stringify(muxRes.body));
  const muxId = muxRes.body.artifact.artifactId;
  assert.equal(muxRes.body.artifact.mediaType, 'video/mp4');
  assert.deepEqual(muxRes.body.artifact.sourceArtifactIds, [videoArt.id, audioArt.id]);
  const storedMux = readCoreArtifactBytes(dataRoot, muxId);
  assert.equal(storedMux.artifact.kind, 'muxed-video');
  const lineage = inspectArtifactLineage(dataRoot, muxId);
  assert.deepEqual(lineage.parents.map(p => p.artifactId).sort(), [videoArt.id, audioArt.id].sort());
  assert.ok(lineage.parents.every(p => p.relation === 'derived-from'));

  // Owner exports muxed MP4 to controlled outbox and observes it in GET /api/v0/outbox/files.
  const outboxKey = uuid();
  const expRes = await ownerPost('/api/v0/outbox/export', { artifactId: muxId, name: 'final-mux.mp4' }, { 'Idempotency-Key': outboxKey });
  assert.equal(expRes.status, 201);
  assert.equal(expRes.body.name, 'final-mux.mp4');
  const listed = await ownerGet('/api/v0/outbox/files');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.files.some(f => f.name === 'final-mux.mp4' && f.bytes === storedMux.bytes.length));
  const exportedMux = path.join(outboxDir, 'final-mux.mp4');
  assert.equal(probeVideo(exportedMux).hasAudio, true);
  assert.equal(videoStreamHash(exportedMux), videoStreamHash(redBlueMp4), 'muxing from an H.264 Artifact preserves the video stream');

  // 4. MCP authorization checks: video+music+local-media succeeds; video+local-media without audio group is denied 403.
  const createGrant = async (label, capabilities, tools) => {
    const key = uuid();
    const res = await ownerPost('/api/v0/connection-management/connections', { key, label, scopes: ['read', 'create'], capabilities, tools });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return JSON.parse(fs.readFileSync(path.join(connectionStore, 'profiles', key + '.json'), 'utf8'));
  };

  const fullGrant = await createGrant(
    'Mux full grant',
    ['video-generate', 'music', 'local-media'],
    ['iris_core_video', 'iris_core_video_frames', 'iris_core_mux_video_audio', 'iris_core_image']
  );
  const fullMcp = httpMcpClient(started.origin, fullGrant.accessToken);
  await fullMcp.initialize();
  const mcpMux = await fullMcp.call('iris_core_mux_video_audio', {
    videoArtifactId: videoArt.id, audioArtifactId: audioArt.id, audioFit: 'pad_silence'
  });
  const mcpMuxBody = JSON.parse(mcpMux.content.find(c => c.type === 'text').text);
  assert.equal(mcpMuxBody.artifact.mediaType, 'video/mp4');
  const mcpVideoRead = await fullMcp.call('iris_core_video', { artifactId: mcpMuxBody.artifact.artifactId });
  assert.ok(mcpVideoRead.content.some(c => c.type === 'resource_link' && c.uri.includes(mcpMuxBody.artifact.artifactId)));

  // Video-only grant MUST NOT mux with a music audio artifact or read the muxed output derived from music.
  const videoOnlyGrant = await createGrant(
    'Video only grant',
    ['video-generate', 'local-media'],
    ['iris_core_video', 'iris_core_mux_video_audio']
  );
  const videoOnlyMcp = httpMcpClient(started.origin, videoOnlyGrant.accessToken);
  await videoOnlyMcp.initialize();
  const deniedMux = await videoOnlyMcp.call('iris_core_mux_video_audio', {
    videoArtifactId: videoArt.id, audioArtifactId: audioArt.id
  });
  assert.equal(deniedMux.isError, true);
  assert.match(deniedMux.content[0].text, /IRIS_CONNECTION_CAPABILITY_DENIED/);
  const deniedRead = await videoOnlyMcp.call('iris_core_video', { artifactId: mcpMuxBody.artifact.artifactId });
  assert.equal(deniedRead.isError, true);
  assert.match(deniedRead.content[0].text, /IRIS_CONNECTION_CAPABILITY_DENIED/);

  // 5. CLI `dsh-iris media mux` smoke check on an isolated root.
  const cliRoot = path.join(root, 'cli-root');
  const cliApp = createApplicationRuntime({ dataRoot: cliRoot }); apps.push(cliApp);
  await cliApp.execute('flow.init', {});
  const cliMux = spawnSync(process.execPath, [
    path.resolve('bin/dsh-iris.js'), 'media', 'mux',
    '--data-root', cliRoot,
    '--input', JSON.stringify({ video_path: redBlueMp4, audio_path: shortWav, audio_fit: 'loop_audio' })
  ], { encoding: 'utf8' });
  assert.equal(cliMux.status, 0, cliMux.stderr || cliMux.stdout);
  const cliOut = JSON.parse(cliMux.stdout);
  assert.equal(cliOut.command, 'media.mux');
  assert.equal(cliOut.artifact.kind, 'muxed-video');
  assert.equal(cliOut.media.hasAudio, true);

  console.log('PASS local-media-mux: last-frame extraction, ffmpeg mux modes, dual lineage, outbox export, MCP capability isolation, and CLI media mux verified');
} finally {
  for (const service of services) await service.dispose().catch(() => {});
  for (const app of apps) await app.dispose().catch(() => {});
}
