import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner } from '../lib/operation-runner.js';
import { createVisionProviderAdapter } from '../lib/vision-provider-adapter.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { readDeliveryCache } from '../lib/core-delivery-cache.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-vision-ocr-flow');
let count = 0, mode = 'complete', reached;
const modelRef = 'ocr-fixture::vision';
const makeAdapter = () => createVisionProviderAdapter({ id: 'ocr-fixture', type: 'openai', baseUrl: 'https://ocr.invalid/v1', apiKey: 'PRIVATE_OCR_KEY' }, {
  fetchPort: async (_url, init) => {
    const index = ++count;
    if (mode === 'failed' || mode === 'partial' && index === 2) return new Response('{"error":{"message":"PRIVATE_OCR_KEY"}}', { status: 429 });
    if (mode === 'stop' && index === 2) return new Promise((_resolve, reject) => {
      reached(); init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '第' + index + '块文字' }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  }
});
let adapter = makeAdapter();
const ports = { resolveVisionCandidates: () => [{ adapter, model: modelRef, providerBinding: 'sha256:' + 'f'.repeat(64), selectionReason: 'explicit' }],
  resolveTaskAdapter: () => adapter };
let app = createApplicationRuntime({ dataRoot: root, ...ports }), runner;
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { vision: true });
  const bytes = await sharp({ create: { width: 100, height: 250, channels: 3, background: 'white' } }).png().toBuffer();
  const source = (await app.execute('artifact.import', { image_bytes: bytes })).artifact;
  const value = { sourceArtifactId: source.id, modelRef, chunkHeight: 100, overlap: 0 };
  for (const scenario of ['complete', 'partial', 'budget', 'failed']) {
    mode = scenario; count = 0; adapter = makeAdapter();
    const key = crypto.randomUUID(), input = scenario === 'budget' ? { ...value, maxInvocations: 1 } : value;
    const created = await app.execute('creation.ocr', { key, value: input });
    assert.equal(count, 0); assert.equal(created.flow.run.plan.totalChunks, 3);
    assert.equal((await app.execute('creation.ocr', { key, value: input })).flow.run.id, created.flow.run.id);
    const facts = await app.execute('flow.continue', { run_id: created.flow.run.id });
    assert.equal(count, scenario === 'budget' ? 1 : 3);
    if (scenario === 'failed') {
      assert.equal(facts.task.acceptance, 'not_accepted'); assert.equal(facts.run.output, undefined); assert.equal(facts.run.report, undefined);
    } else {
      const report = JSON.parse(readCoreArtifactBytes(root, facts.run.report.artifactId).bytes);
      assert.equal(report.status, scenario === 'complete' ? 'complete' : 'partial');
      assert.equal(facts.status, scenario === 'complete' ? 'ready' : 'needs_attention');
      assert.equal(report.invocations, count); assert.deepEqual(report.chunks.map(chunk => chunk.index), [1, 2, 3]);
      assert.deepEqual(report.chunks.map(chunk => chunk.y), [0, 100, 200]);
      assert.deepEqual(report.chunks.map(chunk => chunk.status), scenario === 'complete' ? ['succeeded', 'succeeded', 'succeeded']
        : scenario === 'partial' ? ['succeeded', 'failed', 'succeeded'] : ['succeeded', 'skipped', 'skipped']);
      if (scenario === 'budget') assert.equal(report.stopCode, 'IRIS_MODEL_CALL_LIMIT');
      assert(!JSON.stringify(report).includes('PRIVATE_'));
      const text = readCoreArtifactBytes(root, facts.run.output.artifactId);
      assert.equal(text.artifact.mediaType, 'text/plain'); assert(text.bytes.includes(Buffer.from('第1块文字')));
      assert.deepEqual(readCoreArtifactBytes(root, source.id).bytes, bytes);
    }
    const previous = count;
    await app.dispose(); app = createApplicationRuntime({ dataRoot: root, ...ports });
    const saved = await app.execute('flow.continue', { run_id: facts.run.id });
    assert.equal(saved.task.id, facts.task.id); assert.equal(count, previous);
  }
  mode = 'complete'; count = 0; adapter = makeAdapter();
  const recoverable = await app.execute('creation.ocr', { key: crypto.randomUUID(), value });
  const copy = fs.copyFileSync; let remaining = 2, failed;
  fs.copyFileSync = (sourcePath, targetPath, ...args) => {
    if (String(targetPath).includes(path.join('artifact-store', 'v0', 'objects')) && --remaining === 0) throw Object.assign(new Error('fixture ENOSPC'), { code: 'ENOSPC' });
    return copy(sourcePath, targetPath, ...args);
  };
  try { failed = await app.execute('flow.continue', { run_id: recoverable.flow.run.id }); }
  finally { fs.copyFileSync = copy; }
  assert.equal(failed.status, 'delivery_failed'); assert.equal(failed.task.acceptance, 'accepted'); assert.equal(count, 3);
  const artifactIds = readDeliveryCache(root, failed.task).items.map(item => item.artifactId);
  await app.dispose(); app = createApplicationRuntime({ dataRoot: root });
  const recovered = await app.execute('flow.continue', { run_id: failed.run.id });
  assert.equal(recovered.status, 'ready'); assert.equal(count, 3, 'redelivery requires neither model configuration nor another POST');
  assert.deepEqual([recovered.run.output.artifactId, recovered.run.report.artifactId], artifactIds);
  await app.dispose(); app = createApplicationRuntime({ dataRoot: root, ...ports });
  mode = 'stop'; count = 0; adapter = makeAdapter();
  const draft = await app.execute('creation.ocr', { key: crypto.randomUUID(), value });
  const waiting = new Promise(resolve => { reached = resolve; });
  runner = createOperationRunner({ dataRoot: root, application: app, ...ports }); await runner.start();
  const operation = await runner.submit({ key: crypto.randomUUID(), runId: draft.flow.run.id, expectedRunRevision: draft.flow.run.revision });
  await waiting; await runner.stop(operation.operation.id);
  const stopped = await app.execute('flow.inspect', { run_id: draft.flow.run.id });
  assert.equal(count, 2); assert.equal(stopped.task.acceptance, 'unknown');
  assert.equal(stopped.run.output, undefined); assert.equal(stopped.run.report, undefined);
  await app.execute('flow.continue', { run_id: draft.flow.run.id }); assert.equal(count, 2);
  console.log('PASS durable OCR complete/partial/budget, stable coordinates, explicit rejection, restart and cancellation without partial delivery');
} finally { await runner?.dispose(); await app.dispose(); }
