import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { defineProviderAdapter } from '../lib/provider-adapter.js';
import { providerErrorRecord } from '../lib/provider-contract.js';
import { inspectCoreTask } from '../lib/core-tasks.js';
import { inspectCoreArtifactMetadata } from '../lib/core-artifacts.js';
import { MAX_VIDEO_BYTES } from '../lib/video-flow-input.js';
import { PROVIDER_RESPONSE_LIMITS } from '../lib/provider-response.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-video-result-limit'), dataRoot = path.join(root, 'core');
const calls = { submit: 0, poll: 0, download: 0 }, read = fs.readFileSync;
const artifact = { kind: 'remote-url', url: 'https://fixture.invalid/video', mediaType: 'video/mp4' };
const adapter = defineProviderAdapter({ id: 'video-limit', protocol: 'fixture', capabilities: ['video'], operations: {
  async submit() { calls.submit++; return { kind: 'accepted', remoteTaskId: 'original-video' }; },
  async poll() { calls.poll++; return { kind: 'succeeded', artifacts: [artifact] }; },
  async download({ targetPath }) {
    calls.download++; const fd = fs.openSync(targetPath, 'wx', 0o600);
    try { fs.ftruncateSync(fd, MAX_VIDEO_BYTES + 1); } finally { fs.closeSync(fd); }
    return { bytes: MAX_VIDEO_BYTES + 1 };
  }, mapError: providerErrorRecord
}, unsupported: { discover: 'fixture', cancel: 'fixture' } });
const binding = 'sha256:' + 'a'.repeat(64);
const options = { dataRoot, resolveVideoCandidates: () => [{ adapter, model: 'video-limit::t2v', providerBinding: binding }],
  resolveTaskAdapter: () => adapter };
let app = createApplicationRuntime(options), buffered = 0;
fs.readFileSync = (file, ...args) => {
  if (String(file).startsWith(path.join(dataRoot, 'artifact-store/v0/objects') + path.sep)) {
    buffered++; throw new Error('oversize video was read into memory');
  }
  return read(file, ...args);
};
try {
  assert.equal(PROVIDER_RESPONSE_LIMITS.video, 1024 * 1024 * 1024, 'general video Tasks retain their 1 GiB limit');
  await app.execute('flow.init', {}); await app.execute('execution.init', { video: true });
  const intent = await app.execute('creation.video', { key: crypto.randomUUID(), value: { modelRef: 'video-limit::t2v', prompt: 'fixture' } });
  const id = intent.flow.run.id;
  await app.execute('flow.continue', { run_id: id });
  await assert.rejects(app.execute('flow.continue', { run_id: id }), { code: 'IRIS_FLOW_RESULT_UNSUPPORTED' });
  const task = inspectCoreTask(dataRoot, intent.flow.run.video.taskId);
  assert.equal(task.outcome, 'succeeded'); assert.equal(task.deliveryState, 'ready');
  assert.equal(inspectCoreArtifactMetadata(dataRoot, task.artifactIds[0]).size, MAX_VIDEO_BYTES + 1);
  await app.dispose(); app = createApplicationRuntime({ dataRoot });
  await assert.rejects(app.execute('flow.continue', { run_id: id }), { code: 'IRIS_FLOW_RESULT_UNSUPPORTED' });
  assert.deepEqual(inspectCoreTask(dataRoot, task.id), task);
  assert.equal(buffered, 0); assert.deepEqual(calls, { submit: 1, poll: 1, download: 1 });
  console.log('PASS video Flow checks metadata before buffering; original successful Task/Artifact survive restart without resubmission');
} finally { fs.readFileSync = read; await app.dispose(); }
