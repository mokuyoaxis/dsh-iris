import assert from 'node:assert/strict';
import { invokeModel } from '../../lib/model-invoker.js';
import { modelPortSnapshot } from '../../lib/model-port-contract.js';

/** 可供后续协议 fixture 复用的单次调用矩阵；factory 提供场景与调用计数。 */
export async function runModelConformance(createFixture, { kind = 'text' } = {}) {
  const request = { prompt: ' 中文原文 ', ...(kind === 'vision'
    ? { image: { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' } } : {}) };
  const options = { budget: { timeoutMs: 1000, maxInputTextBytes: 1024, maxOutputChars: 8,
    ...(kind === 'vision' ? { maxImageBytes: 16 } : {}) } };
  const checks = [];
  const check = async (name, run) => {
    try { await run(); checks.push(Object.freeze({ name, ok: true })); }
    catch (_) { checks.push(Object.freeze({ name, ok: false })); }
  };
  const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

  await check('describe.zero-invocations', () => {
    const fixture = createFixture({ kind });
    const snapshot = modelPortSnapshot(fixture.port);
    assert.equal(snapshot.kind, kind);
    assert.equal(fixture.stats.invocations, 0);
    assert.equal(snapshot.features.reasoning, 'unknown');
    assert(!JSON.stringify(snapshot).includes('prompt'));
  });
  await check('complete.exact-input-and-output', async () => {
    const fixture = createFixture({ kind, steps: [{ text: '完整正文', usage: { outputTokens: 2 } }] });
    const result = await invokeModel(fixture.port, request, options);
    assert.equal(result.text, '完整正文');
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, { outputTokens: 2 });
    assert.equal(fixture.calls[0].request.prompt, request.prompt);
    if (kind === 'vision') assert.deepEqual(fixture.calls[0].request.image.bytes, request.image.bytes);
    assert.equal(fixture.stats.invocations, 1);
    assert.equal(fixture.stats.active, 0);
    assert.equal(fixture.stats.cleanedUp, 1);
  });
  await check('invalid-input.zero-invocations', async () => {
    const fixture = createFixture({ kind });
    await rejects(invokeModel(fixture.port, { ...request, prompt: ' ' }, options), 'IRIS_MODEL_INPUT_INVALID');
    assert.equal(fixture.stats.invocations, 0);
  });
  await check('unsupported-reasoning.zero-invocations', async () => {
    const fixture = createFixture({ kind });
    await rejects(invokeModel(fixture.port, { ...request, generation: { reasoning: { mode: 'off' } } }, options), 'IRIS_MODEL_UNSUPPORTED');
    assert.equal(fixture.stats.invocations, 0);
  });
  await check('pre-abort.zero-invocations', async () => {
    const fixture = createFixture({ kind });
    const controller = new AbortController();
    controller.abort(new Error('private abort reason'));
    await rejects(invokeModel(fixture.port, request, { ...options, signal: controller.signal }), 'IRIS_MODEL_ABORTED');
    assert.equal(fixture.stats.invocations, 0);
    assert.equal(fixture.calls.length, 0);
  });
  await check('stream.replace-not-duplicate', async () => {
    const fixture = createFixture({ kind, steps: [{ chunks: [
      { type: 'append', text: 'part', blockId: 'a' },
      { type: 'replace', text: '完成', blockId: 'a' },
      { type: 'append', text: '正文', blockId: 'b' },
      { type: 'finish', reason: 'stop' }
    ] }] });
    assert.equal((await invokeModel(fixture.port, request, options)).text, '完成正文');
  });
  for (const [name, step, code, invocation] of [
    ['missing-finish', { chunks: [{ type: 'append', text: 'partial' }] }, 'IRIS_MODEL_INCOMPLETE'],
    ['mid-stream-error', { chunks: [{ type: 'append', text: 'partial' },
      { type: 'error', error: new Error('private stream failure') }] }, 'IRIS_MODEL_REQUEST_FAILED', 'responded'],
    ['empty', { text: ' \n' }, 'IRIS_MODEL_EMPTY_RESULT'],
    ['max-tokens', { finishReason: 'max-tokens', text: 'partial' }, 'IRIS_MODEL_OUTPUT_LIMIT'],
    ['tool-calls', { finishReason: 'tool-calls', text: 'partial' }, 'IRIS_MODEL_UNEXPECTED_TOOL'],
    ['blocked', { finishReason: 'content-blocked', text: 'partial' }, 'IRIS_MODEL_CONTENT_BLOCKED'],
    ['unknown-finish', { finishReason: 'unknown', text: 'partial' }, 'IRIS_MODEL_PROTOCOL_INVALID'],
    ['unknown-event', { chunks: [{ type: 'unknown', text: 'private' }] }, 'IRIS_MODEL_PROTOCOL_INVALID'],
    ['raw-error', { error: new Error('private prompt sk-fake-secret-123456 /private/input') }, 'IRIS_MODEL_REQUEST_FAILED']
  ]) await check(`failure.${name}.single-invocation`, async () => {
    const fixture = createFixture({ kind, steps: [step, { text: 'no retry' }] });
    await assert.rejects(invokeModel(fixture.port, request, options), error => error.code === code
      && (invocation === undefined || error.invocation === invocation));
    assert.equal(fixture.stats.invocations, 1);
    assert.equal(fixture.stats.cleanedUp, 1);
  });
  await check('output-limit.stops-read', async () => {
    const fixture = createFixture({ kind, steps: [{ chunks: [
      { type: 'append', text: '123456' }, { type: 'append', text: '789' },
      { type: 'append', text: 'not consumed' }, { type: 'finish', reason: 'stop' }
    ] }] });
    await rejects(invokeModel(fixture.port, request, options), 'IRIS_MODEL_OUTPUT_LIMIT');
    assert.equal(fixture.stats.chunksRead, 2);
    assert.equal(fixture.stats.active, 0);
  });
  await check('timeout.abort-and-cleanup', async () => {
    const fixture = createFixture({ kind, steps: [{ waitForAbort: true }] });
    await rejects(invokeModel(fixture.port, request, { budget: { ...options.budget, timeoutMs: 30 } }), 'IRIS_MODEL_TIMEOUT');
    assert.equal(fixture.stats.aborted, 1);
    assert.equal(fixture.stats.invocations, 1);
    assert.equal(fixture.stats.active, 0);
    assert.equal(fixture.stats.cleanedUp, 1);
  });
  return Object.freeze({ kind, checks: Object.freeze(checks), ok: checks.every(item => item.ok) });
}
