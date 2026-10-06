import assert from 'node:assert/strict';
import { runModelConformance } from './fixtures/model-conformance.mjs';
import { createDshTextFixture } from './fixtures/dsh-text-model.mjs';
import { createDshTextModelPort, prepareDshTextModelPort } from '../lib/dsh-text-model-adapter.js';
import { invokeModel, createModelOperation } from '../lib/model-invoker.js';

const report = await runModelConformance(createDshTextFixture);
assert(report.ok, JSON.stringify(report));
const options = { budget: { timeoutMs: 1000, maxInputTextBytes: 1024, maxOutputChars: 100 } };
const fixture = createDshTextFixture({ steps: [{ sourceChunks: [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'secret thinking' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'secret thinking' } },
  { type: 'text-delta', index: 1, text: 'body' },
  { type: 'usage', usage: { inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 5, totalTokens: 14, reasoningTokens: 1 } },
  { type: 'finish', reason: { kind: 'stop' } }
] }] });
const output = await invokeModel(fixture.port, { prompt: 'only current draft', system: 'system', generation: { temperature: 0.3, maxOutputTokens: 1200 } }, options);
assert.equal(output.text, 'body');
assert.deepEqual(output.usage, { inputTokens: 9, outputTokens: 5, totalTokens: 14, reasoningTokens: 1 });
assert.equal(fixture.calls[0].source.sessionId, 'fixture-session');
assert.equal(fixture.calls[0].source.maxTokens, 1200);
assert.equal(fixture.calls[0].source.messages.length, 1);
assert.equal(fixture.calls[0].source.tools, undefined);
assert(!JSON.stringify(output).includes('secret thinking'));

for (const chunks of [
  [{ type: 'finish', reason: { kind: 'stop' } }, { type: 'text-delta', index: 0, text: 'late' }],
  [{ type: 'text-delta', index: -1, text: 'bad' }],
  [{ type: 'text-delta', index: 0, text: 'part' }, { type: 'finish', reason: { kind: 'error', failure: { message: 'sk-private /private/input' } } }]
]) {
  const f = createDshTextFixture({ steps: [{ sourceChunks: chunks }] });
  await assert.rejects(invokeModel(f.port, { prompt: 'x' }, options), e => !e.message.includes('private') && ['IRIS_MODEL_PROTOCOL_INVALID', 'IRIS_MODEL_REQUEST_FAILED'].includes(e.code));
  assert.equal(f.stats.cleanedUp, 1);
}
let metadataCalls = 0;
const llm = { stream: fixture.textModel.stream, async resolveModelInfo() {
  metadataCalls++;
  return { provider: 'p', id: 'm', reasoning: { efforts: [{ id: 'none' }, { id: 'high' }] } };
} };
const prepared = await prepareDshTextModelPort(llm, { provider: 'p', model: 'm' });
for (let i = 0; i < 3; i++) prepared.port.describe();
assert.equal(metadataCalls, 1);
assert.equal(prepared.offId, 'none');
assert.equal(prepared.port.describe().reasoning.off, 'supported');
// v0 允许大于原生 timer 上限的预算，不得因 setTimeout 溢出而立即取消。
const largeBudget = createDshTextFixture({ steps: [{ text: '完成' }] });
assert.equal((await invokeModel(largeBudget.port, { prompt: 'x' }, { budget: { ...options.budget, timeoutMs: 2147483648 } })).text, '完成');
const canceled = new AbortController(); canceled.abort();
await assert.rejects(prepareDshTextModelPort(llm, { provider: 'p', model: 'm' }, { signal: canceled.signal }), e => e.code === 'IRIS_MODEL_ABORTED');
assert.equal(metadataCalls, 1);
await assert.rejects(prepareDshTextModelPort(llm, { provider: 'other', model: 'm' }), e => e.code === 'IRIS_MODEL_INCOMPATIBLE');

const operation = createModelOperation({ budget: { timeoutMs: 30, maxInvocations: 1 } });
try {
  await assert.rejects(prepareDshTextModelPort({ stream() { throw new Error('must not call'); }, resolveModelInfo() { return new Promise(() => {}); } },
    { provider: 'p', model: 'm' }, { signal: operation.signal }), e => e.code === 'IRIS_MODEL_TIMEOUT');
  assert.equal(operation.snapshot().invocations, 0);
} finally { operation.dispose(); }
// 不合作的迭代器收到 abort/return；晚到拒绝有处理，本地有界退出。
let receivedSignal, returned = 0, rejectNext;
const stubborn = createDshTextModelPort({ stream(request) {
  receivedSignal = request.signal;
  return { [Symbol.asyncIterator]() { return this; }, next() { return new Promise((_, reject) => { rejectNext = reject; }); }, return() { returned++; return new Promise(() => {}); } };
} }, { provider: 'p', model: 'm' }).port;
await assert.rejects(invokeModel(stubborn, { prompt: 'x' }, { budget: { ...options.budget, timeoutMs: 30 } }), e => e.code === 'IRIS_MODEL_TIMEOUT');
await new Promise(resolve => setImmediate(resolve));
assert(receivedSignal.aborted); assert.equal(returned, 1);
rejectNext(new Error('late private failure'));
await new Promise(resolve => setImmediate(resolve));
console.log(`ALL OK —— DSH Text Model Port ${report.checks.length} 项共用 conformance、reasoning/usage、严格终态、元数据预算与不合作流取消通过`);
