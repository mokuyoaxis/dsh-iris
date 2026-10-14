import assert from 'node:assert/strict';
import { preparePromptOptimization, runPromptOptimization, PROMPT_TARGETS } from '../lib/prompt-optimizer-core.js';
import { DEFAULT_PROMPT_OPTIMIZER_CONFIG as config } from '../lib/prompt-optimizer-config.js';
import { PROMPT_REWRITE_CASES, PROMPT_FAITHFUL_CASE, PROMPT_SUGGESTIONS_CASE, PROMPT_LIVE_CASES } from './fixtures/prompt-optimizer-cases.mjs';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { createDshTextFixture } from './fixtures/dsh-text-model.mjs';
assert.equal(PROMPT_LIVE_CASES.length, 12);
for (const target of PROMPT_TARGETS) assert.deepEqual(PROMPT_REWRITE_CASES.filter(c => c.target === target).map(c => c.language), ['zh', 'en']);
for (const make of [createFakeModelPort, createDshTextFixture]) {
  for (const c of PROMPT_LIVE_CASES) {
    const plan = preparePromptOptimization(c, config);
    const groups = c.editing === 'faithful' ? plan.parts.map(p => [p.id]) : undefined;
    const text = c.editing === 'rewrite' ? c.expected : c.editing === 'faithful' ? JSON.stringify({ groups }) : '{"suggestions":[],"questions":[]}';
    const f = make({ steps: [{ text }] });
    const out = await runPromptOptimization(f.port, plan);
    assert.equal(f.stats.invocations, 1, c.id);
    assert.equal(f.stats.active, 0);
    assert.equal(out.original, c.text);
    assert.deepEqual(out.processing.request, { system: plan.system, prompt: plan.prompt });
    if (c.editing === 'rewrite') assert.equal(out.optimized, c.expected, '合法样例不会被格式校验误拒绝：' + c.id);
    else if (c.editing === 'faithful') assert.equal(out.optimized, plan.parts.map(p => p.text).join('\n\n'));
    else assert.equal(out.optimized, c.text, '建议不混入正文');
  }
}
assert.equal(PROMPT_FAITHFUL_CASE.editing, 'faithful');
assert.equal(PROMPT_SUGGESTIONS_CASE.editing, 'suggestions');
console.log('PASS 固定样例：五用途 × 中英文授权精确编辑、JSON/代码/路径/反斜杠及方位数量否定时序；双端口机械验证，不代表真实模型质量');
