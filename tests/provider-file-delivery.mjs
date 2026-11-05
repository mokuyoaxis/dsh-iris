import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { inspectCoreArtifact } from '../lib/core-artifacts.js';
import { defineProviderAdapter } from '../lib/provider-adapter.js';
import { providerErrorRecord } from '../lib/provider-contract.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-file-delivery-'));
const chunk = Buffer.alloc(1024 * 1024, 0x5a);
const read = fs.readFileSync, copy = fs.copyFileSync;
const stagingSegment = path.sep + path.join('provider-staging', 'v0') + path.sep;
const cacheSegment = path.sep + path.join('delivery-cache', 'v0') + path.sep;
const materialized = file => String(file).includes(stagingSegment)
  || (String(file).includes(cacheSegment) && String(file).endsWith('.bin'));
let guardedReads = 0, copies = 0, failCopy = false;
fs.readFileSync = (file, ...args) => {
  if (materialized(file)) {
    guardedReads++; throw new Error('whole staging read forbidden');
  }
  return read(file, ...args);
};
fs.copyFileSync = (source, ...args) => {
  if (materialized(source)) {
    copies++;
    if (failCopy) throw Object.assign(new Error('fixture copy failure'), { code: 'ENOSPC' });
  }
  return copy(source, ...args);
};

function fixture(capability, mediaType, blocks = 16) {
  const calls = { submit: 0, poll: 0, download: 0 }, digests = [];
  // Container headers keep this streaming/copy fixture honest; it does not test audio decoding.
  const first = Buffer.from(chunk);
  if (mediaType === 'audio/mpeg') Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]).copy(first);
  if (mediaType === 'audio/wav') { first.write('RIFF'); first.writeUInt32LE(blocks * chunk.length - 8, 4); first.write('WAVE', 8); }
  const artifacts = [{ kind: 'remote-url', url: 'https://fixture.invalid/private-media', mediaType }];
  const adapter = defineProviderAdapter({ id: 'file-' + capability, protocol: 'fixture', capabilities: [capability],
    operations: {
      async submit() {
        calls.submit++;
        return capability === 'tts' ? { kind: 'completed', artifacts }
          : { kind: 'accepted', remoteTaskId: 'remote-file-delivery' };
      },
      async poll() { calls.poll++; return { kind: 'succeeded', artifacts }; },
      async download({ targetPath }) {
        calls.download++; const hash = crypto.createHash('sha256');
        const fd = fs.openSync(targetPath, 'wx', 0o600);
        try { for (let i = 0; i < blocks; i++) { const bytes = i === 0 ? first : chunk; fs.writeSync(fd, bytes); hash.update(bytes); } }
        finally { fs.closeSync(fd); }
        digests.push(hash.digest('hex')); return { bytes: blocks * chunk.length };
      },
      mapError: providerErrorRecord
    }, unsupported: { discover: 'fixture', cancel: 'fixture' }
  });
  return { adapter, calls, digests, size: blocks * chunk.length };
}
function verify(dataRoot, task, item, capability, mediaType, expectedKind) {
  assert.equal(task.acceptance, 'accepted'); assert.equal(task.outcome, 'succeeded');
  assert.equal(task.deliveryState, 'ready'); assert.equal(task.artifactIds.length, 1);
  const artifact = inspectCoreArtifact(dataRoot, task.artifactIds[0]);
  assert.equal(artifact.size, item.size); assert.equal(artifact.mediaType, mediaType);
  assert.equal(artifact.kind, expectedKind); assert.equal(artifact.digest.value, item.digests.at(-1));
  assert.deepEqual(artifact.metadata, { taskId: task.id, capability });
  assert.deepEqual(artifact.relations, []);
  assert.equal(task.attempts.length, 1); assert.equal(item.calls.submit, 1);
  const staging = path.join(dataRoot, 'provider-staging/v0');
  assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], []);
  const manifest = fs.readFileSync(path.join(dataRoot, 'artifact-store/v0/manifests', artifact.id + '.json'), 'utf8');
  assert(!manifest.includes(dataRoot) && !manifest.includes('fixture.invalid'), 'Manifest 不保存来源路径/URL');
  return artifact;
}
try {
  for (const [capability, mediaType, kind] of [
    ['video', 'video/mp4', 'generated-video'], ['tts', 'audio/mpeg', 'generated-audio'],
    ['tts', 'audio/wav', 'generated-audio'], ['transcribe', 'text/plain', 'transcript']
  ]) {
    const dataRoot = path.join(base, capability + '-' + mediaType.replace('/', '-'));
    const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
    try {
      const item = fixture(capability, mediaType, capability === 'transcribe' ? 8 : 16), runner = createProviderTaskRunner(runtime);
      const result = await runner.submit({ capability, candidates: [{ adapter: item.adapter, model: item.adapter.id + '::fixture' }],
        providerInput: { prompt: 'zero-network file delivery' } });
      const task = capability === 'tts' ? result.task : await runner.observe(result.taskId, item.adapter);
      verify(dataRoot, task, item, capability, mediaType, kind);
    } finally { await runtime.dispose(); }
  }
  // A third-party adapter cannot bypass the transcript limit by returning a larger file.
  const oversizedRoot = path.join(base, 'oversized-transcript');
  const oversizedRuntime = createCoreRuntime({ dataRoot: oversizedRoot, mode: 'writer' }); oversizedRuntime.start();
  try {
    const item = fixture('transcribe', 'text/plain'), runner = createProviderTaskRunner(oversizedRuntime);
    const submitted = await runner.submit({ capability: 'transcribe', candidates: [{ adapter: item.adapter, model: item.adapter.id + '::fixture' }] });
    const rejected = await runner.observe(submitted.taskId, item.adapter);
    assert.equal(rejected.outcome, 'succeeded'); assert.equal(rejected.deliveryState, 'failed');
    assert.equal(rejected.lastError.providerCode, 'IRIS_PROVIDER_RESPONSE_TOO_LARGE');
    assert.deepEqual(rejected.artifactIds, []); assert.deepEqual(item.calls, { submit: 1, poll: 1, download: 1 });
    assert(!fs.existsSync(path.join(oversizedRoot, 'artifact-store')));
  } finally { await oversizedRuntime.dispose(); }
  // 本地接收失败保留远端成功；显式重交付仅 poll/download，不再次 submit。
  const failedRoot = path.join(base, 'failed-video'), runtime = createCoreRuntime({ dataRoot: failedRoot, mode: 'writer' }); runtime.start();
  try {
    const item = fixture('video', 'video/mp4'), runner = createProviderTaskRunner(runtime);
    const result = await runner.submit({ capability: 'video', candidates: [{ adapter: item.adapter, model: item.adapter.id + '::fixture' }] });
    failCopy = true;
    const failed = await runner.observe(result.taskId, item.adapter);
    assert.equal(failed.outcome, 'succeeded'); assert.equal(failed.acceptance, 'accepted'); assert.equal(failed.deliveryState, 'failed');
    assert.equal(item.calls.submit, 1); assert.deepEqual(failed.artifactIds, []);
    assert.deepEqual(fs.readdirSync(path.join(failedRoot, 'provider-staging/v0')), []);
    assert.deepEqual(fs.readdirSync(path.join(failedRoot, 'artifact-store/v0/objects')), []);
    failCopy = false;
    const ready = await runner.redeliver(result.taskId, item.adapter);
    verify(failedRoot, ready, item, 'video', 'video/mp4', 'generated-video');
    assert.equal(item.calls.poll, 2); assert.equal(item.calls.download, 2);
  } finally { failCopy = false; await runtime.dispose(); }
  assert.equal(copies, 6); assert.equal(guardedReads, 0, '所有非图片交付不整文件读取 staging');
  console.log('PASS 文件交付：16 MiB 视频/MP3/WAV、8 MiB 文本及超限拒绝、哈希/元数据、复制失败与零重提恢复、staging 零整读');
} finally {
  fs.readFileSync = read; fs.copyFileSync = copy;
  fs.rmSync(base, { recursive: true, force: true });
}
