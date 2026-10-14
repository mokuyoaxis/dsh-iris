import assert from 'node:assert/strict';
import { preparePromptOptimization, runPromptOptimization, assemblePrompt, PROMPT_TARGETS } from '../lib/prompt-optimizer-core.js';
import { DEFAULT_PROMPT_OPTIMIZER_CONFIG as config } from '../lib/prompt-optimizer-config.js';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { createDshTextFixture } from './fixtures/dsh-text-model.mjs';

const rule = { id: 'color', label: '只改颜色', kind: 'optimization', text: '只把白色改为黑色，其余逐字保留。' };
const draft = '保持“琉璃色”与 "星辰灰色"。白色丝袜。\n不要改变左右方位。';
const expected = draft.replace('白色', '黑色');
for (const target of PROMPT_TARGETS) {
  const plan = preparePromptOptimization({ text: draft, target, editing: 'rewrite', rules: [rule] }, config);
  assert(plan.system.includes('本次输出协议：改写正文'));
  assert(plan.system.includes('容器中用于编码引号、换行和反斜杠的转义不是正文字符'));
  assert(plan.system.includes('保留原稿实际存在的'));
  for (const make of [createFakeModelPort, createDshTextFixture]) {
    for (const text of [JSON.stringify({ target, prompt: expected }), JSON.stringify({ prompt: expected, target }),
      '```json\n' + JSON.stringify({ target, prompt: expected }) + '\n```',
      '```text\n' + expected + '\n```', '```markdown\n' + expected + '\n```',
      '~~~text\n' + expected + '\n~~~', JSON.stringify(expected)]) {
      const f = make({ steps: [{ text }, { text: expected }] });
      await assert.rejects(runPromptOptimization(f.port, plan), e => e.code === 'IRIS_MODEL_PROTOCOL_INVALID' && e.invocation === 'responded');
      assert.equal(f.stats.invocations, 1, '格式失败没有第二次调用或自动修补');
      assert.equal(f.stats.active, 0);
    }
    const f = make({ steps: [{ text: expected }] });
    assert.equal((await runPromptOptimization(f.port, plan)).optimized, expected);
    assert.equal(f.stats.invocations, 1);
  }
}

// 真实 JSON/代码围栏、路径、引号、实际 LF 和字面反斜杠都是正文。
const literals = [
  JSON.stringify({ target: 'image', prompt: '白色丝袜', path: String.raw`C:\refs\iris`, literal: String.raw`\n | \" | \\ | \u4e00` }),
  '{"target":"image","prompt":"白色丝袜"}',
  '```json\n{"target":"image","prompt":"白色丝袜"}\n```',
  '```text\n白色丝袜\n' + String.raw`C:\refs\iris | \n | \" | \\ | \u4e00` + '\n```',
  '```markdown\n# 白色丝袜\n\n保留原有标题。\n```',
  '```js\nconst color = "白色";\nconst literal = "\\\\n";\n```',
  '引用字段：{"target":"image","prompt":"白色丝袜"}；其余逐字保留。',
  '"白色\\n丝袜"',
  '```json\n"白色\\n丝袜"\n```',
  '白色丝袜。\n' + String.raw`C:\refs\iris | \n | \" | \\ | \u4e00`
];
for (const text of literals) {
  const plan = preparePromptOptimization({ text, editing: 'rewrite', rules: [rule] }, config);
  for (const make of [createFakeModelPort, createDshTextFixture]) {
    const edited = text.replace('白色', '黑色');
    assert.equal((await runPromptOptimization(make({ steps: [{ text: edited }] }).port, plan)).optimized, edited);
  }
  assert.equal(assemblePrompt({ text }).optimized, text, '只组装保持原文');
}

const codeSource = preparePromptOptimization({ text: '```js\nconst color = "白色";\n```', rules: [rule] }, config);
await assert.rejects(runPromptOptimization(createFakeModelPort({ steps: [{ text: '```json\n' + JSON.stringify({ target: 'general', prompt: 'const color = "黑色";' }) + '\n```' }] }).port, codeSource),
  e => e.code === 'IRIS_MODEL_PROTOCOL_INVALID', '有合法代码围栏的原稿仍不能回传输入容器');
const embedded = '保留内部 JSON：{"target":"image","prompt":"白色丝袜"}。';
await assert.rejects(runPromptOptimization(createFakeModelPort({ steps: [{ text: JSON.stringify({ target: 'general', prompt: embedded.replace('白色', '黑色') }) }] }).port,
  preparePromptOptimization({ text: embedded, rules: [rule] }, config)), e => e.code === 'IRIS_MODEL_PROTOCOL_INVALID', '内部引用 JSON 不授权整份正文新加外壳');

const authorizedFormat = preparePromptOptimization({ text: '白色丝袜', rules: [rule,
  { id: 'json', label: 'JSON 格式', kind: 'optimization', text: '使用 {"target":"image","prompt":"正文"} 形状。' }
] }, config);
assert.equal((await runPromptOptimization(createFakeModelPort({ steps: [{ text: '{"target":"image","prompt":"黑色丝袜"}' }] }).port, authorizedFormat)).optimized,
  '{"target":"image","prompt":"黑色丝袜"}', '明确规则中的 JSON 形状不被一概禁止');
const legacy = preparePromptOptimization({ text: draft }, config);
assert.equal(legacy.input.editing, 'rewrite');
assert(legacy.system.includes('本次输出协议：改写正文'), '省略 editing 的旧入口也得到交付约定');
const affixes = preparePromptOptimization({ text: draft, rules: [rule,
  { id: 'prefix', label: '前缀', kind: 'output', position: 'prefix', text: '```text\n前缀\n```' }
] }, config);
assert.equal((await runPromptOptimization(createFakeModelPort({ steps: [{ text: expected }] }).port, affixes)).optimized,
  '```text\n前缀\n```\n\n' + expected, '输出规则不经过模型格式校验');
assert(!affixes.system.includes('前缀'));
for (const editing of ['faithful', 'suggestions']) {
  const plan = preparePromptOptimization({ text: draft, editing }, config);
  assert(!plan.system.includes('本次输出协议：改写正文'));
  const value = editing === 'faithful' ? { groups: [plan.parts.map(p => p.id)] } : { suggestions: [], questions: [] };
  assert.equal((await runPromptOptimization(createFakeModelPort({ steps: [{ text: '```json\n' + JSON.stringify(value) + '\n```' }] }).port, plan)).optimized, draft);
}
console.log('PASS 改写格式：五用途双端口拒绝传输外壳、零重试；合法 JSON/代码/反斜杠、旧入口及其他策略保持');
