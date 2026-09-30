import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { createModelOperation, invokeModel } from '../lib/model-invoker.js';
import { ModelPortError, modelErrorRecord } from '../lib/model-port-contract.js';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { runModelConformance } from './fixtures/model-conformance.mjs';

const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error('Model Port tests must be offline'); };
const request = { prompt: 'draft-private-123' };
const options = { budget: { timeoutMs: 1000, maxInputTextBytes: 1024, maxOutputChars: 128 } };
const rejects = (promise, code, invocation) => assert.rejects(promise,
  e => e instanceof ModelPortError && e.code === code && (invocation === undefined || e.invocation === invocation));
const authFailure = () => new ModelPortError('IRIS_MODEL_AUTH_FAILED', { stage: 'invoke', invocation: 'rejected', status: 401 });
const rejectedPolicy = { allowRejected: true };

try {
  for (const kind of ['text', 'vision']) {
    const report = await runModelConformance(createFakeModelPort, { kind });
    assert(report.ok, JSON.stringify(report));
    console.log(`Model conformance ${kind}: ${report.checks.length} checks passed`);
  }

  for (const policy of [null, { retry: true }, { allowRejected: 'true' }, { allowRejected: true, ctx: {} }]) {
    const op = createModelOperation({ budget: { timeoutMs: 1000, maxInvocations: 2 } });
    const fake = createFakeModelPort();
    try {
      await rejects(op.runCandidates([fake.port], request, options, policy), 'IRIS_MODEL_INPUT_INVALID');
      assert.equal(fake.stats.invocations, 0);
    } finally { op.dispose(); }
  }

  // 默认不切换；明确拒绝、明确策略与足够整体次数同时成立才允许下一候选。
  for (const [maxInvocations, policy, expected] of [
    [2, {}, 'IRIS_MODEL_AUTH_FAILED'], [1, rejectedPolicy, 'IRIS_MODEL_CALL_LIMIT'], [2, rejectedPolicy, null]
  ]) {
    const first = createFakeModelPort({ backendId: 'fixture:first', steps: [{ error: authFailure() }] });
    const next = createFakeModelPort({ backendId: 'fixture:next' });
    const op = createModelOperation({ budget: { timeoutMs: 1000, maxInvocations } });
    try {
      const work = op.runCandidates([first.port, next.port], request, options, policy);
      if (expected) await rejects(work, expected);
      else assert.equal((await work).identity.backendId, 'fixture:next');
      assert.equal(first.stats.invocations, 1);
      assert.equal(next.stats.invocations, expected ? 0 : 1);
      assert.equal(op.snapshot().invocations, expected ? 1 : 2);
      assert.equal(op.snapshot().pending, 0);
    } finally { op.dispose(); }
  }

  const unavailable = createFakeModelPort({ availability: 'unavailable', reasonCode: 'IRIS_MODEL_UNAVAILABLE' });
  const available = createFakeModelPort();
  const skip = createModelOperation({ budget: { timeoutMs: 1000 } });
  try {
    await skip.runCandidates([unavailable.port, available.port], request, options, { skipUnavailable: true });
    assert.equal(unavailable.stats.invocations, 0);
    assert.equal(available.stats.invocations, 1);
    assert.equal(skip.snapshot().invocations, 1);
  } finally { skip.dispose(); }

  // unknown、截断、工具、内容阻断与部分流中断永远不能被宽候选策略重试。
  for (const step of [
    { error: new Error('network failed sk-secret-123 /private') },
    { text: 'partial', finishReason: 'length' }, { text: 'partial', finishReason: 'tool-calls' },
    { text: 'partial', finishReason: 'content-blocked' }, { chunks: [{ type: 'append', text: 'partial' }] }
  ]) {
    const first = createFakeModelPort({ steps: [step] });
    const next = createFakeModelPort({ backendId: 'fixture:next' });
    const op = createModelOperation({ budget: { timeoutMs: 1000, maxInvocations: 2 } });
    try {
      await assert.rejects(op.runCandidates([first.port, next.port], request, options,
        { skipUnavailable: true, allowRejected: true, allowEmptyResult: true }), ModelPortError);
      assert.equal(first.stats.invocations, 1);
      assert.equal(next.stats.invocations, 0);
    } finally { op.dispose(); }
  }

  for (const allowEmptyResult of [false, true]) {
    const empty = createFakeModelPort({ steps: [{ text: ' ' }] });
    const next = createFakeModelPort({ backendId: 'fixture:next' });
    const op = createModelOperation({ budget: { timeoutMs: 1000, maxInvocations: 2 } });
    try {
      const work = op.runCandidates([empty.port, next.port], request, options, { allowEmptyResult });
      if (allowEmptyResult) await work;
      else await rejects(work, 'IRIS_MODEL_EMPTY_RESULT', 'responded');
      assert.equal(next.stats.invocations, allowEmptyResult ? 1 : 0);
    } finally { op.dispose(); }
  }

  // 整体预算跨连续调用，不因下一块拥有更长单次 timeout 而重置。
  const totalBudget = createModelOperation({ budget: { timeoutMs: 200, maxInvocations: 3 } });
  const slow = createFakeModelPort({ steps: [{ delayMs: 15, text: 'first' }, { waitForAbort: true }] });
  try {
    await totalBudget.invoke(slow.port, request, options);
    await rejects(totalBudget.invoke(slow.port, request, options), 'IRIS_MODEL_TIMEOUT');
    assert.equal(slow.stats.invocations, 2);
    assert.equal(slow.stats.aborted, 1);
    await rejects(totalBudget.invoke(slow.port, request, options), 'IRIS_MODEL_TIMEOUT', 'not_invoked');
    assert.equal(slow.stats.invocations, 2);
  } finally { totalBudget.dispose(); }

  // 在途取消或单次超时停止整个操作，下一候选和下一块均不能再次调用。
  for (const reason of ['abort', 'timeout', 'dispose']) {
    const controller = new AbortController();
    const op = createModelOperation({ budget: { timeoutMs: 1000, maxInvocations: 3 }, signal: controller.signal });
    let started;
    const began = new Promise(resolve => { started = resolve; });
    const first = createFakeModelPort({ steps: [async ({ options: call }) => {
      started();
      await new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }));
    }] });
    const next = createFakeModelPort({ backendId: 'fixture:next' });
    const code = reason === 'timeout' ? 'IRIS_MODEL_TIMEOUT' : 'IRIS_MODEL_ABORTED';
    try {
      const work = op.runCandidates([first.port, next.port], request,
        { ...options, budget: { ...options.budget, timeoutMs: reason === 'timeout' ? 30 : 1000 } },
        { skipUnavailable: true, allowRejected: true, allowEmptyResult: true });
      const failed = rejects(work, code, 'unknown');
      await began;
      if (reason === 'abort') controller.abort(new Error('private reason'));
      if (reason === 'dispose') op.dispose();
      await failed;
      assert.equal(first.stats.aborted, 1);
      assert.equal(first.stats.active, 0);
      assert.equal(next.stats.invocations, 0);
      await rejects(op.invoke(next.port, request, options), code, 'not_invoked');
      assert.equal(next.stats.invocations, 0);
    } finally { op.dispose(); }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }

  // 并发共享最后一个额度，第二个调用在生成入口前被拒绝。
  const concurrent = createModelOperation({ budget: { timeoutMs: 1000, maxInvocations: 1 } });
  const one = createFakeModelPort({ steps: [{ delayMs: 20, text: 'done' }] });
  try {
    const first = concurrent.invoke(one.port, request, options);
    await rejects(concurrent.invoke(one.port, request, options), 'IRIS_MODEL_CALL_LIMIT', 'not_invoked');
    await first;
    assert.equal(one.stats.invocations, 1);
    assert.equal(concurrent.snapshot().invocations, 1);
  } finally { concurrent.dispose(); }

  // reserve 与真正进入 complete 之间取消，不应消耗生成额度。
  const queuedParent = new AbortController();
  const queued = createModelOperation({ budget: { timeoutMs: 1000 }, signal: queuedParent.signal });
  const queuedFake = createFakeModelPort();
  try {
    const work = queued.invoke(queuedFake.port, request, options);
    queuedParent.abort();
    await rejects(work, 'IRIS_MODEL_ABORTED', 'not_invoked');
    assert.equal(queuedFake.stats.invocations, 0);
    assert.equal(queued.snapshot().invocations, 0);
    assert.equal(queued.snapshot().pending, 0);
  } finally { queued.dispose(); }

  // 调用开始时捕获方法；调度前入口对象变化不能更换本次后端。
  const boundFake = createFakeModelPort();
  const mutablePort = { ...boundFake.port };
  const captured = invokeModel(mutablePort, request, options);
  let replacementCalls = 0;
  mutablePort.complete = async () => { replacementCalls++; throw new Error('unexpected changed backend'); };
  await captured;
  assert.equal(boundFake.stats.invocations, 1);
  assert.equal(replacementCalls, 0);

  // 明确 preparation 未调用可返还额度；伪造的普通 Error.code 不被信任。
  for (const typed of [true, false]) {
    const pretend = typed
      ? new ModelPortError('IRIS_MODEL_UNAVAILABLE', { stage: 'prepare', invocation: 'not_invoked' })
      : Object.assign(new Error('private'), { code: 'IRIS_MODEL_UNAVAILABLE', invocation: 'not_invoked' });
    const first = createFakeModelPort({ steps: [{ prepareError: pretend }] });
    const next = createFakeModelPort({ backendId: 'fixture:next' });
    const op = createModelOperation({ budget: { timeoutMs: 1000, maxInvocations: 1 } });
    try {
      const work = op.runCandidates([first.port, next.port], request, options, { skipUnavailable: true });
      if (typed) await work;
      else await rejects(work, 'IRIS_MODEL_REQUEST_FAILED', 'unknown');
      assert.equal(next.stats.invocations, typed ? 1 : 0);
      assert.equal(first.stats.invocations, 0);
      assert.equal(first.stats.completeCalls, 1);
      assert.equal(op.snapshot().invocations, 1);
    } finally { op.dispose(); }
  }

  // 不合作的端口可晚到，但不能覆盖超时/取消，也不能留下未处理的晚到拒绝。
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const lateReject of [false, true]) {
      let release;
      const completion = new Promise((resolve, reject) => {
        release = () => lateReject ? reject(new Error('late private failure'))
          : resolve({ contractVersion: 0, text: 'late success', finishReason: 'stop', identity: late.port.describe().identity });
      });
      const late = createFakeModelPort({ steps: [() => completion] });
      const parent = new AbortController();
      await rejects(invokeModel(late.port, request, { signal: parent.signal, budget: { ...options.budget, timeoutMs: 30 } }), 'IRIS_MODEL_TIMEOUT', 'unknown');
      assert.equal(late.stats.aborted, 1);
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
      assert.equal(late.stats.active, 1);
      release();
      await delay(0);
      assert.equal(late.stats.active, 0);
      assert.equal(late.stats.cleanedUp, 1);
    }
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener('unhandledRejection', onUnhandled); }

  // 正常完成同样释放上层 listener；巨大的合法 timeout 不发生 32-bit timer 溢出。
  const parent = new AbortController();
  const normal = createFakeModelPort();
  await invokeModel(normal.port, request, { signal: parent.signal, budget: { ...options.budget, timeoutMs: Number.MAX_SAFE_INTEGER } });
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  assert.equal(normal.stats.aborted, 0);
  assert.equal(parent.signal.aborted, false);

  for (const maxInvocations of [null, 0, -1, 0.5, Infinity]) {
    assert.throws(() => createModelOperation({ budget: { timeoutMs: 1000, maxInvocations } }), e => e.code === 'IRIS_MODEL_INPUT_INVALID');
  }

  let failure;
  try { await invokeModel(createFakeModelPort({ steps: [{ error: new Error('sk-secret-123456 /private/file prompt-private') }] }).port, request, options); }
  catch (error) { failure = error; }
  const safe = JSON.stringify(modelErrorRecord(failure));
  for (const marker of ['sk-secret', '/private', 'prompt-private', request.prompt]) assert(!safe.includes(marker));
  assert.equal(networkCalls, 0);
  console.log('ALL OK —— Model 调用次数、显式候选、整体预算、取消/超时、并发与晚到结果通过');
} finally { globalThis.fetch = originalFetch; }
