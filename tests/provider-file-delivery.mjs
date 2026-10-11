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
let guardedReads = 0, copies = 0, failCopy = false;
fs.readFileSync = (file, ...args) => {
  if (String(file).includes(stagingSegment)) {
    guardedReads++; throw new Error('whole staging read forbidden');
  }
  return read(file, ...args);
};
fs.copyFileSync = (source, ...args) => {
  if (String(source).includes(stagingSegment)) {
    copies++;
    if (failCopy) throw Object.assign(new Error('fixture copy failure'), { code: 'ENOSPC' });
  }
  return copy(source, ...args);
};

function fixture(capability, mediaType, blocks = 16) {
  const calls = { submit: 0, poll: 0, download: 0 }, digests = [];
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
        try { for (let i = 0; i < blocks; i++) { fs.writeSync(fd, chunk); hash.update(chunk); } }
        finally { fs.closeSync(fd); }
        digests.push(hash.digest('hex')); return { bytes: blocks * chunk.length };
      },
      mapError: providerErrorRecord
    }, unsupported: { discover: 'fixture', cancel: 'fixture' }
  });
  return { adapter, calls, digests };
}
function verify(dataRoot, task, item, capability, mediaType, expectedKind) {
  assert.equal(task.acceptance, 'accepted'); assert.equal(task.outcome, 'succeeded');
  assert.equal(task.deliveryState, 'ready'); assert.equal(task.artifactIds.length, 1);
  const artifact = inspectCoreArtifact(dataRoot, task.artifactIds[0]);
  assert.equal(artifact.size, 16 * chunk.length); assert.equal(artifact.mediaType, mediaType);
  assert.equal(artifact.kind, expectedKind); assert.equal(artifact.digest.value, item.digests.at(-1));
  assert.deepEqual(artifact.metadata, { taskId: task.id, capability });
  assert.deepEqual(artifact.relations, []);
  assert.equal(task.attempts.length, 1); assert.equal(item.calls.submit, 1);
  assert.deepEqual(fs.readdirSync(path.join(dataRoot, 'provider-staging/v0')), []);
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
      const item = fixture(capability, mediaType), runner = createProviderTaskRunner(runtime);
      const result = await runner.submit({ capability, candidates: [{ adapter: item.adapter, model: item.adapter.id + '::fixture' }],
        providerInput: { prompt: 'zero-network file delivery' } });
      const task = capability === 'tts' ? result.task : await runner.observe(result.taskId, item.adapter);
      verify(dataRoot, task, item, capability, mediaType, kind);
    } finally { await runtime.dispose(); }
  }
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
  console.log('PASS 文件交付：16 MiB 视频/MP3/WAV/文本、哈希/元数据、复制失败与零重提恢复、staging 零整读');
} finally {
  fs.readFileSync = read; fs.copyFileSync = copy;
  fs.rmSync(base, { recursive: true, force: true });
}
