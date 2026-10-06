import assert from 'node:assert/strict';
import { completeVision, VISION_BUDGET } from '../lib/vision-core.js';
import { ModelPortError } from '../lib/model-port-contract.js';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { createHttpVisionFixture } from './fixtures/vision-models.mjs';
import { createModelOperation } from '../lib/model-invoker.js';

const request = { prompt: 'fixture question', image: { bytes: new Uint8Array([1]), mediaType: 'image/png' } };
const budget = { ...VISION_BUDGET, timeoutMs: 500, maxOutputChars: 10 };
const fake = options => createFakeModelPort({ kind: 'vision', ...options });
for (const error of [
  new ModelPortError('IRIS_MODEL_AUTH_FAILED', { stage: 'invoke', invocation: 'rejected', status: 401 }),
  new ModelPortError('IRIS_MODEL_RATE_LIMITED', { stage: 'invoke', invocation: 'rejected', status: 429 })
]) {
  const first = fake({ backendId: 'fixture:first', steps: [{ error }] }), second = fake({ backendId: 'fixture:second', steps: [{ text: 'complete' }] });
  const result = await completeVision([first.port, second.port], request, { budget });
  assert.equal(result.text, 'complete'); assert.equal(result.errors[0].code, error.code);
  assert.equal(first.stats.invocations, 1); assert.equal(second.stats.invocations, 1);
}
const unavailable = fake({ availability: 'unavailable', reasonCode: 'IRIS_MODEL_UNAVAILABLE' }), empty = fake({ steps: [{ text: ' ' }] }), success = fake({ steps: [{ text: 'complete' }] });
assert.equal((await completeVision([unavailable.port, empty.port, success.port], request, { budget })).text, 'complete');
assert.equal(unavailable.stats.invocations, 0); assert.equal(empty.stats.invocations, 1);

for (const step of [
  { finishReason: 'length', text: 'partial' }, { finishReason: 'tool-calls', text: 'partial' },
  { finishReason: 'content-blocked', text: 'partial' }, { finishReason: 'unknown', text: 'partial' },
  { error: new Error('private fixture input /private/image sk-private') },
  { error: new ModelPortError('IRIS_MODEL_AUTH_FAILED', { stage: 'read', invocation: 'unknown' }) }
]) {
  const first = fake({ steps: [step] }), second = fake();
  await assert.rejects(completeVision([first.port, second.port], request, { budget }), e => !JSON.stringify(e).includes('private'));
  assert.equal(first.stats.invocations, 1); assert.equal(second.stats.invocations, 0);
}
for (const factory of [fake, createHttpVisionFixture]) {
  const first = factory({ steps: [{ waitForAbort: true }] }), second = fake();
  await assert.rejects(completeVision([first.port, second.port], request, { budget: { ...budget, timeoutMs: 30 } }), e => e.code === 'IRIS_MODEL_TIMEOUT');
  assert.equal(first.stats.aborted, 1); assert.equal(second.stats.invocations, 0);
}
const pre = new AbortController(); pre.abort();
const first = fake(), second = fake();
await assert.rejects(completeVision([first.port, second.port], request, { signal: pre.signal, budget }), e => e.code === 'IRIS_MODEL_ABORTED');
assert.equal(first.stats.invocations + second.stats.invocations, 0);
const operation = createModelOperation({ budget: { timeoutMs: 500, maxInvocations: 1 } });
try {
  const a = fake({ steps: [{ text: ' ' }] }), b = fake();
  await assert.rejects(completeVision([a.port, b.port], request, { operation, budget }), e => e.code === 'IRIS_MODEL_CALL_LIMIT');
  assert.equal(operation.snapshot().invocations, 1); assert.equal(b.stats.invocations, 0);
} finally { operation.dispose(); }
console.log('ALL OK —— 单图业务候选策略、调用次数、取消/超时、部分结果拒绝与安全错误通过');
