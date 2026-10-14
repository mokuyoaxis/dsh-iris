import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
useTempDshHome('iris-prompt-local');
import { normalizePromptInput, tryLocalPromptOptimization, preparePromptOptimization, runPromptOptimization, PROMPT_TARGETS } from '../lib/prompt-optimizer-core.js';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
const { optimizePrompt } = await import('../lib/prompt-optimizer.js');
const store = await import('../lib/prompt-optimizer-config.js');

const unreachable = new Proxy({}, { get() { throw new Error('must not access model/Host'); } });
const texts = ['  一只猫，不要帽子。  ', 'Keep "琉璃色" and the original wording.',
  '如果下雨，先等雨停。然后再出门，否则保持室内。',
  '```js\nconst value = "保留。不要拆散";\n```',
  '{"target":"image","prompt":"原文","path":"C:\\\\refs\\\\iris"}', '  ' + String.raw`C:\refs\iris | \n | \" | \\ | \u4e00` + '  '];
const rules = [{ id: 'p', label: '前缀', kind: 'output', position: 'prefix', text: '  开头  ' },
  { id: 's', label: '后缀', kind: 'output', position: 'suffix', text: '末尾\n保持' }];
const file = store.promptOptimizerConfigFile();
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, '{broken config'); store.resetPromptOptimizerConfigCache();
const before = fs.readFileSync(file), directoryBefore = fs.readdirSync(path.dirname(file));
for (const text of texts) for (const target of PROMPT_TARGETS) {
  const input = { text, target, editing: 'faithful', rules, route: { provider: 'invalid-route' } };
  const local = tryLocalPromptOptimization(normalizePromptInput(input));
  assert(local); assert.equal(local.assembly.body, text);
  assert.equal(local.optimized, '  开头  \n\n' + text + '\n\n末尾\n保持');
  assert.deepEqual(local.editing, { strategy: 'faithful', coverage: 'exact', order: 'preserved', groups: [['s1']] });
  assert.deepEqual(local.execution, { modelInvocations: 0, reason: 'single-part-faithful' });
  const out = await optimizePrompt(unreachable, input);
  assert.equal(out.optimized, local.optimized); assert.equal(out.mode, 'optimize');
  assert.equal(out.route, null); assert.equal(out.configSource, 'not-loaded');
  assert.equal(out.processing, undefined);
  const plan = preparePromptOptimization(input, store.DEFAULT_PROMPT_OPTIMIZER_CONFIG);
  assert.equal(plan.parts.length, 1);
  assert.equal((await runPromptOptimization(unreachable, plan)).optimized, local.optimized);
}
assert.deepEqual(fs.readFileSync(file), before, '单片段不触发损坏配置隔离或恢复');
assert.deepEqual(fs.readdirSync(path.dirname(file)), directoryBefore);
const multi = { text: '左眼泪痣。右鬓发饰。', editing: 'faithful' };
assert.equal(tryLocalPromptOptimization(normalizePromptInput(multi)), null);
const plan = preparePromptOptimization(multi, store.DEFAULT_PROMPT_OPTIMIZER_CONFIG);
const f = createFakeModelPort({ steps: [{ text: '{"groups":[["s1"],["s2"]]}' }] });
assert.equal((await runPromptOptimization(f.port, plan)).optimized, '左眼泪痣。\n\n右鬓发饰。');
assert.equal(f.stats.invocations, 1, '多片段继续让模型决定连续分组');
for (const editing of ['rewrite', 'suggestions']) assert.equal(tryLocalPromptOptimization(normalizePromptInput({ text: '原稿', editing })), null);
for (const input of [{ text: 'x'.repeat(16001), editing: 'faithful' },
  { text: 'x'.repeat(15999), editing: 'faithful', rules }]) {
  await assert.rejects(optimizePrompt(unreachable, input), e => e.code === 'IRIS_MODEL_OUTPUT_LIMIT' && e.invocation === 'not_invoked');
}
await assert.rejects(optimizePrompt(unreachable, { text: '原稿', editing: 'faithful', rules: [
  { id: 'bad', label: '改写', kind: 'optimization', text: '加细节' }
] }), /忠实整理不执行改写规则/);
const canceled = new AbortController(); canceled.abort();
await assert.rejects(optimizePrompt(unreachable, { text: '原稿', editing: 'faithful' }, { signal: canceled.signal }), e => e.code === 'IRIS_MODEL_ABORTED');
console.log('PASS 单片段忠实整理：五用途原字节/规则、双入口零 Host/配置/模型；多片段、限额与预取消保持');
