import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDeliveryCache, readDeliveryCache, readDeliveryPayload } from '../lib/core-delivery-cache.js';
import { PROVIDER_RESPONSE_LIMITS } from '../lib/provider-response.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { defineProviderAdapter } from '../lib/provider-adapter.js';
import { providerErrorRecord } from '../lib/provider-contract.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { AUDIO_WAV } from './fixtures/audio-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-cache-limits'), from = Buffer.from;
const task = (capability, n) => ({ id: 'task_' + String(n).padStart(24, '0'), activeAttemptId: 'attempt_fixture',
  providerId: 'fixture', modelRef: 'fixture::model', capability });
try {
  for (const [capability, limit, mediaType] of [
    ['image', PROVIDER_RESPONSE_LIMITS.image, 'image/png'], ['transcribe', PROVIDER_RESPONSE_LIMITS.transcript, 'text/plain']
  ]) {
    const length = Math.ceil((limit + 1) / 3) * 4;
    const data = 'A'.repeat(length);
    Buffer.from = (value, ...args) => {
      if (value === data) throw new Error('oversize inline payload reached decoding');
      return from(value, ...args);
    };
    assert.throws(() => createDeliveryCache(root, task(capability, 10 + limit), [{ kind: 'inline-base64', data, mediaType }]),
      { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' }, capability);
    Buffer.from = from;
  }
  // Canonical padding at the exact transcript boundary is valid; +1 must fail.
  const bytes = Buffer.alloc(PROVIDER_RESPONSE_LIMITS.transcript, 65), current = task('transcribe', 2);
  const cache = createDeliveryCache(root, current, [{ kind: 'inline-base64', data: bytes.toString('base64'), mediaType: 'text/plain' }]);
  assert.equal(readDeliveryPayload(root, cache, 0), path.join(root, 'delivery-cache/v0', current.id, cache.items[0].payload.file));
  const over = Buffer.concat([bytes, from('a')]).toString('base64');
  assert.throws(() => createDeliveryCache(root, task('transcribe', 3), [{ kind: 'inline-base64', data: over, mediaType: 'text/plain' }]),
    { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' });
  const file = readDeliveryPayload(root, cache, 0);
  fs.truncateSync(file, PROVIDER_RESPONSE_LIMITS.transcript + 1);
  await assert.rejects(async () => readDeliveryPayload(root, readDeliveryCache(root, current), 0), { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' });
  for (const [capability, limit] of [['tts', PROVIDER_RESPONSE_LIMITS.audio], ['music', PROVIDER_RESPONSE_LIMITS.audio], ['video', PROVIDER_RESPONSE_LIMITS.video]]) {
    const old = task(capability, limit + (capability === 'music' ? 5 : 4));
    const saved = createDeliveryCache(root, old, [{ kind: 'inline-base64', data: 'YQ==', mediaType: capability === 'video' ? 'video/mp4' : 'audio/mpeg' }]);
    const payload = path.join(root, 'delivery-cache/v0', old.id, saved.items[0].payload.file);
    fs.truncateSync(payload, limit + 1); // sparse file: no large allocation or content hashing
    assert.throws(() => readDeliveryPayload(root, saved, 0), { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' });
  }

  // Real synchronous completion retains generation success and never tries another candidate.
  let submits = 0;
  const adapter = defineProviderAdapter({ id: 'inline-limit', protocol: 'fixture', capabilities: ['image'], operations: {
    async submit() { submits++; return { kind: 'completed', artifacts: [{ kind: 'inline-base64', data: 'A'.repeat(Math.ceil((PROVIDER_RESPONSE_LIMITS.image + 1) / 3) * 4), mediaType: 'image/png' }] }; },
    mapError: providerErrorRecord
  }, unsupported: { discover: 'fixture', poll: 'fixture', cancel: 'fixture', download: 'fixture' } });
  const runtime = createCoreRuntime({ dataRoot: path.join(root, 'sync'), mode: 'writer' }); runtime.start();
  try {
    const result = await createProviderTaskRunner(runtime).submit({ capability: 'image', candidates: [{ adapter, model: 'inline-limit::image' }] });
    assert.equal(result.task.acceptance, 'accepted'); assert.equal(result.task.outcome, 'succeeded');
    assert.equal(result.task.deliveryState, 'failed'); assert.equal(result.task.lastError.providerCode, 'IRIS_PROVIDER_RESPONSE_TOO_LARGE');
    assert.equal(submits, 1); assert.equal(result.task.attempts.length, 1);
    assert(!fs.existsSync(path.join(root, 'sync/artifact-store')));
  } finally { await runtime.dispose(); }

  // A Flow's successful poll has the same generation facts when its inline cache is rejected.
  let polls = 0;
  const flowAdapter = defineProviderAdapter({ id: 'poll-limit', protocol: 'fixture', capabilities: ['transcribe'], operations: {
    async submit() { return { kind: 'accepted', remoteTaskId: 'fixture' }; },
    async poll() { polls++; return { kind: 'succeeded', artifacts: [{ kind: 'inline-base64', data: over, mediaType: 'text/plain' }] }; },
    mapError: providerErrorRecord
  }, prepareInput: async () => ({ url: 'https://fixture.invalid/audio' }),
  unsupported: { discover: 'fixture', cancel: 'fixture', download: 'fixture' } });
  const flow = createApplicationRuntime({ dataRoot: path.join(root, 'flow'),
    resolveAudioCandidates: () => [{ adapter: flowAdapter, model: 'poll-limit::transcribe', providerBinding: 'sha256:' + 'b'.repeat(64) }],
    resolveTaskAdapter: () => flowAdapter });
  try {
    await flow.execute('flow.init', {}); await flow.execute('execution.init', { audio: true });
    const source = await flow.execute('creation.audio', { key: crypto.randomUUID(), bytes: AUDIO_WAV, mediaType: 'audio/wav' });
    const intent = await flow.execute('creation.transcribe', { key: crypto.randomUUID(), value: { modelRef: 'poll-limit::transcribe', sourceArtifactId: source.artifact.id } });
    await flow.execute('flow.continue', { run_id: intent.flow.run.id });
    const result = await flow.execute('flow.continue', { run_id: intent.flow.run.id });
    assert.equal(result.task.outcome, 'succeeded'); assert.equal(result.task.deliveryState, 'failed');
    assert.equal(result.task.lastError.providerCode, 'IRIS_PROVIDER_RESPONSE_TOO_LARGE');
    assert.equal(result.task.remoteTaskId, 'fixture'); assert.equal(polls, 1); assert.equal(result.task.attempts.length, 1);
  } finally { await flow.dispose(); }
  console.log('PASS inline media pre-decode limits, exact padding boundary, oversized persisted payload and successful Task preservation');
} finally { Buffer.from = from; }
