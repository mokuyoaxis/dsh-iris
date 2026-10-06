import assert from 'node:assert/strict';
import { runModelConformance } from './fixtures/model-conformance.mjs';
import { createHttpVisionFixture, createDshVisionFixture } from './fixtures/vision-models.mjs';
import { invokeModel, createModelOperation } from '../lib/model-invoker.js';
import { createDshVisionModelPort, prepareDshVisionModelPort } from '../lib/dsh-vision-model-adapter.js';
import { createHttpVisionModelPort } from '../lib/http-vision-model-adapter.js';

for (const [factory, supportsReplace] of [[createDshVisionFixture, true], [createHttpVisionFixture, false]]) {
  const report = await runModelConformance(factory, { kind: 'vision', supportsReplace });
  assert(report.ok, JSON.stringify(report));
  console.log(`${supportsReplace ? 'DSH' : 'HTTP'} Vision: ${report.checks.length} shared conformance checks passed`);
}

const request = { prompt: '图中是什么？', image: { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' } };
const options = { budget: { timeoutMs: 1000, maxInputTextBytes: 1024, maxOutputChars: 100, maxImageBytes: 16 } };
const rejects = (work, code) => assert.rejects(work, error => error.code === code && !error.message.includes('private'));
const finish = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
const text = 'data: {"choices":[{"index":0,"delta":{"content":"正文"},"finish_reason":null}]}\n\n';
for (const [parts, code] of [
  [[text, 'data: [DONE]\n\n'], 'IRIS_MODEL_INCOMPLETE'],
  [[text, 'data: bad-json-private\n\n'], 'IRIS_MODEL_PROTOCOL_INVALID'],
  [[text, 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'], 'IRIS_MODEL_OUTPUT_LIMIT'],
  [[text, 'data: {"choices":[{"delta":{"tool_calls":[]},"finish_reason":null}]}\n\n'], 'IRIS_MODEL_UNEXPECTED_TOOL'],
  [[text, finish, text], 'IRIS_MODEL_PROTOCOL_INVALID'],
  [[text, finish.slice(0, -1)], 'IRIS_MODEL_INCOMPLETE'],
  [[new Uint8Array([0xff])], 'IRIS_MODEL_PROTOCOL_INVALID'],
  [['data: ' + 'a'.repeat(1024 * 1024 + 1)], 'IRIS_MODEL_PROTOCOL_INVALID']
]) {
  const fixture = createHttpVisionFixture({ steps: [{ rawParts: parts }] });
  await rejects(invokeModel(fixture.port, request, options), code);
  assert.equal(fixture.stats.invocations, 1);
}
// CRLF、多行 data、Unicode 分片、usage 只保留真实语义；无 tools 或 history。
const wire = ': ping\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"中文"},"finish_reason":null}]}\r\n\r\n'
  + finish + 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n'
  + 'data: [DONE]\n\n';
const bytes = new TextEncoder().encode(wire);
const http = createHttpVisionFixture({ steps: [{ rawParts: Array.from(bytes, byte => new Uint8Array([byte])) }] });
const result = await invokeModel(http.port, { ...request, system: 'system', generation: { temperature: 0.2, maxOutputTokens: 100 } }, options);
assert.equal(result.text, '中文');
assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5, reasoningTokens: 1 });
assert.equal(http.calls[0].body.messages.length, 2);
assert.equal(http.calls[0].body.tools, undefined);
assert.equal(http.calls[0].body.max_tokens, 100);
assert(!JSON.stringify(http.port.describe()).includes('private-fixture-key'));

// 保存/读回不一致、缺桥接或文本模型均在生成前拒绝。
const dsh = createDshVisionFixture();
const binding = { provider: 'fixture', model: 'vision-v0' };
const metadata = { provider: 'fixture', id: 'vision-v0', inputModalities: ['image'] };
assert.throws(() => createDshVisionModelPort(dsh.textModel, null, binding, { metadata }), e => e.code === 'IRIS_MODEL_UNAVAILABLE');
for (const invalid of [undefined, { ...metadata, inputModalities: ['text'] }, { ...metadata, id: 'other' }]) {
  assert.throws(() => createDshVisionModelPort(dsh.textModel, dsh.attachments, binding, { metadata: invalid }), e => e.code === 'IRIS_MODEL_INCOMPATIBLE');
}
const drift = createDshVisionModelPort(dsh.textModel, { ...dsh.attachments, async readImage() { return { data: new Uint8Array([9, 9, 9]) }; } }, binding, { metadata });
await rejects(invokeModel(drift, request, options), 'IRIS_MODEL_INCOMPATIBLE');
assert.equal(dsh.stats.invocations, 0);
const operation = createModelOperation({ budget: { timeoutMs: 30 } });
try {
  await rejects(prepareDshVisionModelPort({ ...dsh.textModel, currentSelection: () => binding, resolveModelInfo: () => new Promise(() => {}) },
    dsh.attachments, { signal: operation.signal }), 'IRIS_MODEL_TIMEOUT');
} finally { operation.dispose(); }
let finishSave;
const late = createDshVisionModelPort(dsh.textModel, { ...dsh.attachments, saveImage: () => new Promise(resolve => { finishSave = resolve; }) }, binding, { metadata });
await rejects(invokeModel(late, request, { budget: { ...options.budget, timeoutMs: 30 } }), 'IRIS_MODEL_TIMEOUT');
finishSave({ attachmentId: 'late', mediaType: 'image/png' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(dsh.stats.invocations, 0, '迟到图片桥接不得启动模型');

// 元数据源的原始异常不伪造已生成；并且不会泄露供应商原文。
await assert.rejects(prepareDshVisionModelPort({ ...dsh.textModel, currentSelection: () => binding,
  resolveModelInfo() { throw new Error('private metadata sk-private'); } }, dsh.attachments), e =>
  e.code === 'IRIS_MODEL_REQUEST_FAILED' && e.invocation === 'not_invoked' && e.stage === 'prepare' && !e.message.includes('private'));

// 两个真实协议适配器在读取部分正文时取消：保留 responded，abort/return 传到底层。
for (const kind of ['http', 'dsh']) {
  const controller = new AbortController();
  let signal, returned = 0, rejectNext, first = true;
  const iterator = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (first) {
        first = false;
        return { done: false, value: kind === 'http' ? new TextEncoder().encode(text)
          : { type: 'text-delta', index: 0, text: '正文' } };
      }
      queueMicrotask(() => controller.abort());
      return new Promise((_, reject) => { rejectNext = reject; });
    },
    return() { returned++; return new Promise(() => {}); }
  };
  const port = kind === 'http' ? createHttpVisionModelPort({ providerId: 'fixture', modelId: 'vision', baseUrl: 'https://fixture.invalid',
    async fetch(_url, source) { signal = source.signal; return { ok: true, headers: new Headers({ 'Content-Type': 'text/event-stream' }), body: iterator }; } })
    : createDshVisionModelPort({ stream(source) { signal = source.signal; return iterator; } }, dsh.attachments, binding, { metadata });
  await assert.rejects(invokeModel(port, request, { ...options, signal: controller.signal }), e => e.code === 'IRIS_MODEL_ABORTED' && e.invocation === 'responded');
  await new Promise(resolve => setImmediate(resolve));
  assert(signal.aborted); assert.equal(returned, 1);
  rejectNext(new Error('private late read failure'));
  await new Promise(resolve => setImmediate(resolve));
}
// 不合作 fetch 取消后才返回 body：迟到的 body 仍释放，结果不再被消费。
let resolveFetch, canceledBody = 0;
const lateHttp = createHttpVisionModelPort({ providerId: 'fixture', modelId: 'vision', baseUrl: 'https://fixture.invalid',
  fetch: () => new Promise(resolve => { resolveFetch = resolve; }) });
await rejects(invokeModel(lateHttp, request, { budget: { ...options.budget, timeoutMs: 30 } }), 'IRIS_MODEL_TIMEOUT');
resolveFetch({ body: { async cancel() { canceledBody++; } } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(canceledBody, 1);
console.log('ALL OK —— 两类视觉协议、终态/工具/超限/UTF-8/SSE/usage、图片完整性与准备预算通过');
