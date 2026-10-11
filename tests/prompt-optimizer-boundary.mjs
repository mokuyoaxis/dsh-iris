import assert from 'node:assert/strict';
import fs from 'node:fs';
import { preparePromptOptimization, runPromptOptimization, normalizePromptInput, assemblePrompt,
  PROMPT_TARGETS, PROMPT_OPTIMIZER_CAPABILITIES } from '../lib/prompt-optimizer-core.js';
import { DEFAULT_PROMPT_OPTIMIZER_CONFIG as config } from '../lib/prompt-optimizer-config.js';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { createDshTextFixture } from './fixtures/dsh-text-model.mjs';

const portrait = '一位二十岁左右的女子，右鬓戴琉璃色鸢尾花发饰。她左眼眼角有一颗泪痣，身材苗条。她坐在桌子旁翻书。教室里零零散散几个同学聊天。不要过度锐化、杂乱纹理或多余肢体。';
const rewrite = preparePromptOptimization({ text: portrait }, config);
for (const text of [
  '忠实的文字。\nhttp://googleusercontent.com/image_generation_content/0_762',
  '已生成图片，请查看结果。', '抱歉，我无法生成你所要求的图片。',
  '以下是提示词。![图片](https://fixture.invalid/new.png)',
  '提示词。<video src="https://fixture.invalid/new.mp4"></video>',
  '提示词。data:image/png;base64,aGVsbG8='
]) {
  const f = createFakeModelPort({ steps: [{ text }] });
  await assert.rejects(runPromptOptimization(f.port, rewrite), e => e.code === 'IRIS_MODEL_PROTOCOL_INVALID' && e.invocation === 'responded');
  assert.equal(f.stats.invocations, 1);
}
const legacy = fs.readFileSync(new URL('../lib/prompt-optimizer-core.js', import.meta.url), 'utf8');
assert(!legacy.includes('gemini-3.5'), 'Core 不硬编码模型选择');
for (const text of ['参考 https://example.com/path?a=1，保留引用。', '引用：![原图](https://example.com/image.png)', '原文：抱歉，我无法回答。']) {
  const f = createFakeModelPort({ steps: [{ text }] });
  assert.equal((await runPromptOptimization(f.port, preparePromptOptimization({ text }, config))).optimized, text);
}
const authorized = preparePromptOptimization({ text: '参考旧链接。', rules: [{ id: 'url', label: '新引用', kind: 'optimization', text: '将引用改为 https://example.com/new' }] }, config);
assert((await runPromptOptimization(createFakeModelPort({ steps: [{ text: '请参考 https://example.com/new 。' }] }).port, authorized)).ok);

for (const target of PROMPT_TARGETS) {
  const plan = preparePromptOptimization({ text: '  ' + portrait + '  ', target, editing: 'faithful' }, config);
  assert.equal(plan.parts.map(x => x.text).join(''), '  ' + portrait + '  ');
  const groups = plan.parts.map(x => [x.id]);
  for (const make of [createFakeModelPort, createDshTextFixture]) {
    const f = make({ steps: [{ text: JSON.stringify({ groups }) }] });
    const out = await runPromptOptimization(f.port, plan);
    assert.equal(out.assembly.body, plan.parts.map(x => x.text).join('\n\n'));
    assert.equal(out.editing.coverage, 'exact'); assert.equal(out.editing.order, 'preserved');
    assert.equal(f.stats.invocations, 1); assert.equal(f.stats.active, 0);
    assert.equal(out.original, '  ' + portrait + '  ');
  }
  const ids = plan.parts.map(x => x.id);
  for (const value of [
    { groups: [] }, { groups: [ids.slice(1)] }, { groups: [[...ids, ids[0]]] },
    { groups: [[...ids].reverse()] }, { groups: [[...ids.slice(0, -1), 'new-detail']] },
    { groups: [ids], text: '新细节' }, { groups: [ids], heading: '补充背景' }, { groups: [ids], suggestions: [] },
    { groups: [ids, []] }, { groups: ids }, { groups: [ids.map(() => 1)] }
  ]) {
    const f = createFakeModelPort({ steps: [{ text: JSON.stringify(value) }] });
    await assert.rejects(runPromptOptimization(f.port, plan), e => e.code === 'IRIS_MODEL_PROTOCOL_INVALID');
    assert.equal(f.stats.invocations, 1);
  }
}

for (const text of ['如果下雨，先等雨停。然后再出门，否则保持室内。', '保留引文“你好。不要改写！”与参数 {"x":"一。二"}。下一句。', '```js\nconst a="不要。拆散";\n```\n保持代码。', '未闭合“句子。第二句。']) {
  const plan = preparePromptOptimization({ text, editing: 'faithful' }, config);
  const out = await runPromptOptimization(createFakeModelPort({ steps: [{ text: JSON.stringify({ groups: [plan.parts.map(x => x.id)] }) }] }).port, plan);
  assert.equal(out.optimized, text, '条件/否定/引文/代码原稿逐字不变');
  if (text.includes('```') || text.includes('未闭合')) assert.equal(plan.parts.length, 1);
}
const quoted = preparePromptOptimization({ text: '原文“你好。保持不变！”然后下一句。', editing: 'faithful' }, config);
assert(quoted.parts[0].text.includes('你好。保持不变！'), '不拆开引文');
for (const text of ["原文'猫。狗。'不能加空行。", '保留内联代码 `甲。乙。`。', '<div>猫。狗。</div>', '只有这些字。\n    code("甲。乙。")']) {
  const plan = preparePromptOptimization({ text, editing: 'faithful' }, config);
  assert.equal(plan.parts.length, 1, '复杂引用和代码整体保护');
  assert.equal((await runPromptOptimization(createFakeModelPort({ steps: [{ text: '{"groups":[["s1"]]}' }] }).port, plan)).optimized, text);
}
const titled = preparePromptOptimization({ text: '书名《猫。狗。》原样保留。其他要求。', editing: 'faithful' }, config);
assert(titled.parts[0].text.includes('《猫。狗。》'));

const suggestionsPlan = preparePromptOptimization({ text: portrait, editing: 'suggestions' }, config);
const proposed = { suggestions: [{ label: '可选柔光', text: '可选择柔和的窗侧光。' }], questions: ['是否需要指定画面比例？'] };
const out = await runPromptOptimization(createFakeModelPort({ steps: [{ text: JSON.stringify(proposed) }] }).port, suggestionsPlan);
assert.equal(out.optimized, portrait, '任何建议都不自动进入正文');
assert.equal(out.suggestions[0].id, 'suggestion-1'); assert.equal(out.questions.length, 1);
assert(!out.optimized.includes('窗侧光'));
const empty = await runPromptOptimization(createFakeModelPort({ steps: [{ text: '{"suggestions":[],"questions":[]}' }] }).port, suggestionsPlan);
assert.equal(empty.optimized, portrait); assert.equal(empty.suggestions.length, 0);
for (const value of [
  { suggestions: [{ label: 'x', text: '看图 https://fixture.invalid/new.png' }], questions: [] },
  { suggestions: [{ label: 'x', text: '已生成图片。' }], questions: [] },
  { suggestions: [{ label: 'x', text: 'x', source: 'user-selected' }], questions: [] },
  { suggestions: Array(7).fill({ label: 'x', text: 'x' }), questions: [] },
  { suggestions: [], questions: [123] }, { suggestions: [], questions: [], optimized: '擅自改写' }
]) await assert.rejects(runPromptOptimization(createFakeModelPort({ steps: [{ text: JSON.stringify(value) }] }).port, suggestionsPlan));
assert.throws(() => normalizePromptInput({ text: 'x', editing: 'other' }));
assert.throws(() => normalizePromptInput({ text: 'x', editing: 'faithful', rules: [{ id: 'x', label: '变化', kind: 'optimization', text: '改颜色' }] }));
assert.throws(() => normalizePromptInput({ text: 'x', editing: 'suggestions', rules: [{ id: 'x', label: '输出', kind: 'output', position: 'suffix', text: '尾部' }] }));
assert.equal(assemblePrompt({ text: 'http://googleusercontent.com/image_generation_content/source' }).optimized, 'http://googleusercontent.com/image_generation_content/source');
assert.deepEqual(PROMPT_OPTIMIZER_CAPABILITIES.editing, ['faithful', 'rewrite', 'suggestions']);
console.log('PASS 编辑边界：混合媒体拒绝、来源引用、五用途双端口覆盖/顺序、引文/条件/代码、建议零自动采纳与非法协议单调用');
