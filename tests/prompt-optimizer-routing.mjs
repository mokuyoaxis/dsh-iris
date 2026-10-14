import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';
useTempDshHome('iris-prompt-routing');
const { optimizePrompt, resolvePromptOptimizerRoute } = await import('../lib/prompt-optimizer.js');
const store = await import('../lib/prompt-optimizer-config.js');
const { createDshHostAdapter } = await import('../lib/dsh-host-adapter.js');
const config = store.DEFAULT_PROMPT_OPTIMIZER_CONFIG;
const input = { text: '保留原稿。', editing: 'rewrite', target: 'image' };

function fixture({ selection = { provider: 'default-p', model: 'default-m' }, metadata, metadataError, noLookup = false, streamError } = {}) {
  const stats = { selections: 0, lookups: [], generated: [], signals: [] };
  const llm = {
    ...(noLookup ? {} : { async resolveModelInfo(provider, model, signal) {
      stats.lookups.push({ provider, model }); stats.signals.push(signal);
      if (metadataError) throw metadataError;
      return metadata;
    } }),
    async *stream(request) {
      stats.generated.push(request);
      if (streamError) throw streamError;
      yield { type: 'text-delta', index: 0, text: input.text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  };
  const host = createDshHostAdapter({ get(name) {
    if (name === 'llm') return llm;
    if (name === 'agentDefaultModel') return { currentSelection() { stats.selections++; return selection; } };
  } });
  return { host, stats };
}

for (const requested of [undefined, null]) {
  const f = fixture({ metadata: { provider: 'default-p', id: 'default-m', inputModalities: ['text', 'image'] } });
  const out = await optimizePrompt(f.host, { ...input, route: requested });
  assert.equal(out.route.source, 'host-default');
  assert.equal(out.route.reason, '未提供当前会话模型，使用宿主默认模型');
  assert.equal(out.route.textInput, 'supported');
  assert.deepEqual(f.stats.lookups, [{ provider: 'default-p', model: 'default-m' }]);
  assert.equal(f.stats.generated.length, 1);
  assert.equal(f.stats.generated[0].tools, undefined);
  assert.equal(f.stats.generated[0].messages.length, 1);
  assert(f.stats.signals[0] instanceof AbortSignal);
}
const route = { provider: 'session-p', model: 'session-m' };
for (const metadata of [undefined, { provider: route.provider, id: route.model }, { inputModalities: ['text'] }]) {
  const f = fixture({ metadata });
  const out = await optimizePrompt(f.host, { ...input, route });
  assert.equal(out.route.source, 'current-session');
  assert.equal(out.route.reason, '使用当前会话明确选择的模型');
  assert.equal(out.route.textInput, metadata?.inputModalities ? 'supported' : 'unknown');
  assert.equal(f.stats.selections, 0, '有明确会话选择时不读取宿主默认');
  assert.equal(f.stats.generated.length, 1);
  assert.deepEqual(f.stats.lookups, [route]);
}
const uninspected = fixture({ noLookup: true });
assert.equal((await optimizePrompt(uninspected.host, { ...input, route })).route.textInput, 'unknown');
assert.equal(uninspected.stats.lookups.length, 0);
assert.equal(uninspected.stats.generated.length, 1);

for (const bad of [{}, { provider: 'chosen' }, { model: 'chosen' }, false, [], 'provider/model',
  { provider: 'p', model: ' ' }, { provider: 'p', model: '/private/path' },
  { provider: 'https://fixture.invalid', model: 'm' }, { provider: 'p', model: 'm\nother' },
  { provider: 'p', model: 'm'.repeat(257) }, { ...route, reasoningEffort: 42 },
  { ...route, reasoningEffort: 'x'.repeat(129) }]) {
  const f = fixture();
  await assert.rejects(optimizePrompt(f.host, { ...input, route: bad }), /请求路由/);
  assert.equal(f.stats.selections, 0, '无效显式选择不变成宿主默认');
  assert.equal(f.stats.lookups.length, 0);
  assert.equal(f.stats.generated.length, 0);
}
for (const selection of [{ provider: 'default-p' }, false]) {
  const f = fixture({ selection });
  await assert.rejects(optimizePrompt(f.host, input), /宿主默认路由/);
  assert.equal(f.stats.generated.length, 0);
}
const empty = fixture({ selection: null });
assert.throws(() => resolvePromptOptimizerRoute(empty.host, config), /找不到可用文本模型/);

for (const metadata of [{ inputModalities: ['image'] }, { inputModalities: [] }, { inputModalities: ['audio', 'video'] }]) {
  const f = fixture({ metadata });
  await assert.rejects(optimizePrompt(f.host, { ...input, route }), e => e.code === 'IRIS_MODEL_UNSUPPORTED' && e.invocation === 'not_invoked');
  assert.equal(f.stats.lookups.length, 1);
  assert.equal(f.stats.generated.length, 0);
  assert.equal(f.stats.selections, 0, '能力不适用不自动切换模型');
}
for (const metadata of [{ inputModalities: 'text' }, { inputModalities: ['text', null] },
  { provider: 'other', id: route.model, inputModalities: ['text'] }, { provider: route.provider, id: 'other' }]) {
  const f = fixture({ metadata });
  await assert.rejects(optimizePrompt(f.host, { ...input, route }), e => ['IRIS_MODEL_PROTOCOL_INVALID', 'IRIS_MODEL_INCOMPATIBLE'].includes(e.code));
  assert.equal(f.stats.generated.length, 0);
  assert.equal(f.stats.selections, 0);
}
const lookupFailure = fixture({ metadataError: new Error('private-token /private/path provider not registered') });
await assert.rejects(optimizePrompt(lookupFailure.host, { ...input, route }), e => e.code === 'IRIS_MODEL_UNAVAILABLE'
  && e.stage === 'prepare' && e.invocation === 'not_invoked' && !e.message.includes('private'));
assert.equal(lookupFailure.stats.generated.length, 0, '元数据查询失败不冒充未知能力继续生成');
assert.equal(lookupFailure.stats.lookups.length, 1);
assert.equal(lookupFailure.stats.selections, 0);

store.importPromptOptimizerConfig({ route: { mode: 'fixed', provider: 'fixed-p', model: 'fixed-m' } });
const fixed = fixture({ metadata: { provider: 'fixed-p', id: 'fixed-m', inputModalities: ['text'] } });
const out = await optimizePrompt(fixed.host, { ...input, route: { provider: 'invalid-session' } });
assert.equal(out.route.source, 'iris-fixed');
assert.equal(out.route.reason, '固定配置优先于当前会话和宿主默认模型');
assert.deepEqual(fixed.stats.lookups, [{ provider: 'fixed-p', model: 'fixed-m' }]);
assert.equal(fixed.stats.selections, 0);
assert.equal(fixed.stats.generated.length, 1);
const fixedBadCapability = fixture({ metadata: { inputModalities: ['image'] } });
await assert.rejects(optimizePrompt(fixedBadCapability.host, { ...input, route }), e => e.code === 'IRIS_MODEL_UNSUPPORTED');
assert.equal(fixedBadCapability.stats.selections, 0);
assert.equal(fixedBadCapability.stats.generated.length, 0);
store.resetPromptOptimizerConfig();

const failure = fixture({ streamError: new Error('generation failed') });
await assert.rejects(optimizePrompt(failure.host, { ...input, route }), e => e.code === 'IRIS_MODEL_REQUEST_FAILED');
assert.equal(failure.stats.generated.length, 1, '生成失败不重试');
assert.equal(failure.stats.selections, 0);
const local = fixture();
const assembled = await optimizePrompt(local.host, { ...input, mode: 'assemble', route: {} });
assert.equal(assembled.route, null);
assert.equal(local.stats.lookups.length, 0);
assert.equal(local.stats.generated.length, 0);
const canceled = new AbortController(); canceled.abort();
await assert.rejects(optimizePrompt(local.host, { ...input, route }, { signal: canceled.signal }), e => e.code === 'IRIS_MODEL_ABORTED');
assert.equal(local.stats.lookups.length, 0);
console.log('PASS 路由选择：fixed/会话/默认优先级与原因；显式错误、能力否定、查询失败零生成；未知不猜测、失败不切换');
