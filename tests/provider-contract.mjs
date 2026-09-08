/** 最小 Provider 提交契约：写前记录、受理边界、脱敏与零网络候选调度。 */
import {
  ProviderContractError,
  normalizeSubmissionResult,
  providerErrorRecord,
  submitWithAcceptanceBoundary
} from '../lib/provider-contract.js';
import { FakeSubmitProvider } from './fixtures/fake-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

const completed = normalizeSubmissionResult({ kind: 'completed', value: { files: ['x.png'] } });
assert(completed.acceptance === 'accepted' && completed.value.files[0] === 'x.png', '同步完成必须视为已受理');
const accepted = normalizeSubmissionResult({ kind: 'accepted', remoteTaskId: 'remote-1' });
assert(accepted.acceptance === 'accepted' && accepted.remoteTaskId === 'remote-1', '异步受理结果');
let invalidAccepted = false;
try { normalizeSubmissionResult({ kind: 'accepted' }); } catch (_) { invalidAccepted = true; }
assert(invalidAccepted, 'accepted 缺少 remoteTaskId 必须拒绝');

const leaked = providerErrorRecord(new Error(
  'Authorization: Bearer topsecret https://example.test/result?token=abc123 apiKey=sk-secret123456'
));
assert(!JSON.stringify(leaked).includes('topsecret'), 'Bearer 不得进入安全错误');
assert(!JSON.stringify(leaked).includes('abc123'), '查询 token 不得进入安全错误');
assert(!JSON.stringify(leaked).includes('sk-secret123456'), 'API Key 不得进入安全错误');
const pathLeak = providerErrorRecord(new Error('disk full at /home/alice/private/file or C:\\Users\\Alice\\secret.txt'));
assert(!JSON.stringify(pathLeak).includes('/home/alice'), 'POSIX 私有路径不得进入安全错误');
assert(!JSON.stringify(pathLeak).includes('Users'), 'Windows 私有路径不得进入安全错误');
assert(!('stack' in leaked) && !('cause' in leaked), '持久错误不得包含 stack/cause');

const events = [];
const rejected = new FakeSubmitProvider({
  id: 'p1', model: 'p1::image-a',
  steps: [{ throw: new ProviderContractError('明确拒绝', { acceptance: 'not_accepted', category: 'quota', httpStatus: 429, retryable: true }) }]
});
const winner = new FakeSubmitProvider({
  id: 'p2', model: 'p2::image-b',
  steps: [{ result: { kind: 'accepted', remoteTaskId: 'remote-2' } }]
});
const failover = await submitWithAcceptanceBoundary([rejected, winner], { prompt: 'x' }, {
  beforeAttempt: async (attempt) => {
    events.push(`before:${attempt.providerId}`);
    return { id: `a-${attempt.ordinal}` };
  },
  afterResult: async (attempt) => events.push(`after:${attempt.providerId}:${attempt.acceptance}`)
});
assert(rejected.calls.length === 1 && winner.calls.length === 1, '明确未受理后应只切换一次');
assert(failover.result.kind === 'accepted' && failover.attempts.length === 2, '第二候选应被受理');
assert(events.join(',') === 'before:p1,after:p1:not_accepted,before:p2,after:p2:accepted', '写前/结果顺序错误', events);

const ambiguous = new FakeSubmitProvider({
  id: 'p3', model: 'p3::image-c',
  steps: [{ throw: new Error('socket reset after request write') }]
});
const mustNotRun = new FakeSubmitProvider({
  id: 'p4', model: 'p4::image-d',
  steps: [{ result: { kind: 'accepted', remoteTaskId: 'duplicate' } }]
});
const stopped = await submitWithAcceptanceBoundary([ambiguous, mustNotRun], {}, {
  beforeAttempt: async (attempt) => ({ id: `u-${attempt.ordinal}` })
});
assert(stopped.result.kind === 'acceptance_unknown', '普通传输异常必须保守归为受理未知');
assert(ambiguous.calls.length === 1 && mustNotRun.calls.length === 0, '受理未知后禁止自动提交下一候选');

const retryableUnknown = new FakeSubmitProvider({
  id: 'p5', model: 'p5::image-e',
  steps: [{ throw: new ProviderContractError('timeout', { acceptance: 'unknown', category: 'timeout', retryable: true }) }]
});
const retryTarget = new FakeSubmitProvider({
  id: 'p6', model: 'p6::image-f',
  steps: [{ result: { kind: 'completed', value: 'duplicate' } }]
});
await submitWithAcceptanceBoundary([retryableUnknown, retryTarget], {}, {
  beforeAttempt: async (attempt) => ({ id: `r-${attempt.ordinal}` })
});
assert(retryTarget.calls.length === 0, 'retryable 不能覆盖受理未知边界');

const persistedAccepted = new FakeSubmitProvider({
  id: 'p7', model: 'p7::video-a',
  steps: [{ result: { kind: 'accepted', remoteTaskId: 'remote-7' } }]
});
const duplicateAfterPersistFailure = new FakeSubmitProvider({
  id: 'p8', model: 'p8::video-b',
  steps: [{ result: { kind: 'accepted', remoteTaskId: 'duplicate-8' } }]
});
const persistFailed = await submitWithAcceptanceBoundary([persistedAccepted, duplicateAfterPersistFailure], {}, {
  beforeAttempt: async (attempt) => ({ id: `p-${attempt.ordinal}` }),
  afterResult: async () => { throw new Error('disk full at /private/path'); }
});
assert(persistFailed.localError?.stage === 'persist', '结果落盘失败应作为本地错误返回');
assert(persistFailed.result.acceptance === 'accepted', '落盘失败不得抹掉已受理事实');
assert(duplicateAfterPersistFailure.calls.length === 0, '受理后落盘失败禁止提交下一候选');

const neverCalled = new FakeSubmitProvider({
  id: 'p9', model: 'p9::image-g',
  steps: [{ result: { kind: 'completed', value: 'unexpected' } }]
});
let writeAheadFailed = false;
try {
  await submitWithAcceptanceBoundary([neverCalled], {}, {
    beforeAttempt: async () => { throw new Error('cannot persist attempt'); }
  });
} catch (_) { writeAheadFailed = true; }
assert(writeAheadFailed && neverCalled.calls.length === 0, '写前记录失败时不得调用供应商');

const missingAttemptId = new FakeSubmitProvider({
  id: 'p10', model: 'p10::image-h',
  steps: [{ result: { kind: 'completed', value: 'unexpected' } }]
});
let missingIdRejected = false;
try {
  await submitWithAcceptanceBoundary([missingAttemptId], {}, { beforeAttempt: async () => ({}) });
} catch (_) { missingIdRejected = true; }
assert(missingIdRejected && missingAttemptId.calls.length === 0, '没有稳定 Attempt ID 时不得调用供应商');

const immutableIdentity = new FakeSubmitProvider({
  id: 'p11', model: 'p11::image-i',
  steps: [(_input, context) => ({ kind: 'completed', value: context.attempt })]
});
const immutable = await submitWithAcceptanceBoundary([immutableIdentity], {}, {
  beforeAttempt: async () => ({ id: 'a-immutable', providerId: 'evil', model: 'evil::model', ordinal: 99 })
});
assert(immutable.result.value.providerId === 'p11', 'Hook 不得覆盖 Provider 身份');
assert(immutable.result.value.model === 'p11::image-i' && immutable.result.value.ordinal === 1, 'Hook 不得覆盖模型或 ordinal');

console.log('ALL OK —— Provider 提交契约、写前记录、受理边界、脱敏与零网络 Fake Provider 通过');
