import {
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  PROVIDER_OPERATIONS,
  ProviderOperationError,
  defineProviderAdapter,
  hasProviderOperation,
  invokeProviderOperation,
  normalizeProviderCancelResult,
  normalizeProviderPollResult,
  providerAdapterSnapshot,
  providerPollTaskView,
  requireProviderOperation
} from '../lib/provider-adapter.js';
import { ProviderContractError, providerErrorRecord } from '../lib/provider-contract.js';

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

assert(PROVIDER_ADAPTER_CONTRACT_VERSION === 0, 'Provider Adapter 首版必须显式为 v0');
assert(PROVIDER_OPERATIONS.join(',') === 'discover,submit,poll,cancel,download,mapError',
  '生命周期操作清单变化必须显式评审', PROVIDER_OPERATIONS);

const secret = 'sk-provider-adapter-secret';
const adapter = defineProviderAdapter({
  id: 'provider-fixture',
  protocol: 'fixture-v0',
  capabilities: ['image', 'video'],
  operations: {
    async discover() {
      return { models: ['m-image', { id: 'm-video', capabilities: ['video'] }, 'm-image', null] };
    },
    async submit(input) {
      if (input.mode === 'accepted') return { kind: 'accepted', remoteTaskId: 'remote-1' };
      if (input.mode === 'completed') return { kind: 'completed', value: { kind: 'urls', items: ['https://result.invalid/a.png'] } };
      if (input.mode === 'rejected') {
        throw new ProviderContractError('quota ' + secret, {
          stage: 'submit', category: 'quota', acceptance: 'not_accepted', httpStatus: 429, retryable: true
        });
      }
      throw new Error('socket ' + secret);
    },
    async poll(input) {
      if (input.mode === 'pending') return { kind: 'pending', progress: '42%' };
      if (input.mode === 'success') {
        return { kind: 'succeeded', artifacts: [{ kind: 'remote-url', url: 'https://result.invalid/a.png' }] };
      }
      if (input.mode === 'text') return { kind: 'succeeded', value: { kind: 'text', text: 'hello' } };
      if (input.mode === 'canceled') return { kind: 'canceled', message: 'remote canceled' };
      if (input.mode === 'unknown') return { kind: 'unknown', message: 'cannot observe' };
      return { kind: 'failed', message: 'provider failed' };
    },
    async cancel(input) {
      if (input.confirmed) return { kind: 'canceled' };
      return { kind: 'unknown', message: 'timeout' };
    },
    async download() { return { bytes: 12 }; },
    mapError(error, context) { return providerErrorRecord(error, context); }
  },
  unsupported: {}
});

const snapshot = providerAdapterSnapshot(adapter);
assert(snapshot.provider.id === 'provider-fixture' && snapshot.provider.protocol === 'fixture-v0',
  '快照必须包含稳定身份', snapshot);
assert(PROVIDER_OPERATIONS.every((name) => snapshot.operations[name].status === 'supported'),
  '完整 fixture 的六项生命周期操作都应可用', snapshot.operations);
assert(!JSON.stringify(snapshot).includes(secret) && !JSON.stringify(snapshot).includes('function'),
  '快照不得包含凭据或 live transport');

const discovery = await invokeProviderOperation(adapter, 'discover', {});
assert(discovery.models.map((item) => item.id).join(',') === 'm-image,m-video',
  'discovery 应规范化、去空并按 id 去重', discovery);
assert(discovery.models[1].capabilities[0] === 'video', 'discovery 可保留安全能力元数据');

const accepted = await invokeProviderOperation(adapter, 'submit', { mode: 'accepted' });
const completed = await invokeProviderOperation(adapter, 'submit', { mode: 'completed' });
assert(accepted.kind === 'accepted' && accepted.acceptance === 'accepted' && accepted.remoteTaskId === 'remote-1',
  '异步 submit 必须返回受理证据', accepted);
assert(completed.kind === 'completed' && completed.acceptance === 'accepted',
  '同步 submit 必须同样视为已受理', completed);

const rejected = await invokeProviderOperation(adapter, 'submit', { mode: 'rejected' });
const ambiguous = await invokeProviderOperation(adapter, 'submit', { mode: 'ambiguous' });
assert(rejected.kind === 'not_accepted' && rejected.error.httpStatus === 429,
  '明确未受理证据不得被默认 unknown 覆盖', rejected);
assert(ambiguous.kind === 'acceptance_unknown' && !JSON.stringify(ambiguous).includes(secret),
  '普通 submit 异常必须保守停止且脱敏', ambiguous);

const pending = await invokeProviderOperation(adapter, 'poll', { mode: 'pending' });
const success = await invokeProviderOperation(adapter, 'poll', { mode: 'success' });
const text = await invokeProviderOperation(adapter, 'poll', { mode: 'text' });
const canceled = await invokeProviderOperation(adapter, 'poll', { mode: 'canceled' });
const unknown = await invokeProviderOperation(adapter, 'poll', { mode: 'unknown' });
const failed = await invokeProviderOperation(adapter, 'poll', { mode: 'failed' });
assert(pending.kind === 'pending' && pending.progress === '42%', 'poll pending 结果');
assert(success.kind === 'succeeded' && success.artifacts[0].kind === 'remote-url', 'poll succeeded 产物');
assert(text.value.kind === 'text' && providerPollTaskView(text).urls[0] === 'hello', '文本 poll 兼容视图');
assert(canceled.kind === 'canceled' && canceled.error.stage === 'cancel', 'poll 远端取消结果');
assert(unknown.kind === 'unknown' && unknown.error.acceptance === 'accepted', 'poll 未知不抹掉受理事实');
assert(failed.kind === 'failed' && failed.error.stage === 'poll', 'poll 明确失败结果');

const cancelConfirmed = await invokeProviderOperation(adapter, 'cancel', { confirmed: true });
const cancelUnknown = await invokeProviderOperation(adapter, 'cancel', { confirmed: false });
assert(cancelConfirmed.kind === 'canceled', '远端 cancel 明确确认');
assert(cancelUnknown.kind === 'unknown' && cancelUnknown.error.stage === 'cancel', '远端 cancel 不确定');
assert((await invokeProviderOperation(adapter, 'download', {})).bytes === 12, 'download 字节数规范化');

const legacyPending = normalizeProviderPollResult({ done: false, status: 'RUNNING' });
const legacySuccess = providerPollTaskView({ done: true, ok: true, urls: ['https://result.invalid/legacy.png'] });
assert(legacyPending.kind === 'pending' && legacySuccess.done && legacySuccess.urls.length === 1,
  '0.1.x 旧 poll 形状在迁移期保持兼容');
assert(normalizeProviderCancelResult({ kind: 'not_supported', reason: 'sync protocol' }).kind === 'not_supported',
  'cancel 不支持必须是显式结果');

const syncAdapter = defineProviderAdapter({
  id: 'sync-fixture',
  protocol: 'sync-only',
  capabilities: ['image'],
  operations: {
    submit: async () => ({ kind: 'completed', value: {} }),
    download: async () => 0,
    mapError: (error, context) => providerErrorRecord(error, context)
  },
  unsupported: {
    discover: '模型列表不可用',
    poll: '同步协议没有远端任务',
    cancel: '同步协议没有可取消任务'
  }
});
assert(!hasProviderOperation(syncAdapter, 'poll') && providerAdapterSnapshot(syncAdapter).operations.poll.status === 'unsupported',
  '不支持的生命周期必须进入显式快照');
let unsupportedError;
try { requireProviderOperation(syncAdapter, 'poll'); } catch (error) { unsupportedError = error; }
assert(unsupportedError instanceof ProviderOperationError
  && unsupportedError.code === 'IRIS_PROVIDER_OPERATION_UNSUPPORTED',
'调用不支持操作必须返回稳定错误');

for (const invalid of [
  { id: 'raw', protocol: 'x', capabilities: ['image'], operations: {}, unsupported: {} },
  { id: 'raw', protocol: 'x', capabilities: ['unknown'], operations: {}, unsupported: {} },
  { id: 'raw', protocol: 'x', capabilities: ['image'], operations: { submit() {}, mapError() {} },
    unsupported: { submit: 'duplicate', discover: 'x', poll: 'x', cancel: 'x', download: 'x' } },
  { id: 'raw', protocol: 'x', capabilities: ['image'], key: secret, operations: {}, unsupported: {} }
]) {
  let invalidError;
  try { defineProviderAdapter(invalid); } catch (error) { invalidError = error; }
  assert(invalidError, '非法或泄密 Adapter 形状必须拒绝', invalid);
}

console.log('ALL OK —— Provider Adapter v0 生命周期、结果规范化、显式 unsupported、错误脱敏与旧 poll 兼容通过');
