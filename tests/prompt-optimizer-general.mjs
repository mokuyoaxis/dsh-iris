import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { preparePromptOptimization, runPromptOptimization, assemblePrompt, PROMPT_TARGETS } from '../lib/prompt-optimizer-core.js';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { createDshTextFixture } from './fixtures/dsh-text-model.mjs';
useTempDshHome('iris-prompt-general');
const store = await import('../lib/prompt-optimizer-config.js');
const defaults = store.loadPromptOptimizerConfig().config;
const text = 'artifact_0123456789abcdef01234567：只将右侧的橙色伞改成绿色。保持人物、红方块和构图，不要文字。';
for (const make of [createFakeModelPort, createDshTextFixture]) {
  const fixture = make({ steps: [{ text: '仅将原图右侧橙色伞改为绿色；其余人物、红方块和构图保持不变，不添加文字。' }] });
  const plan = preparePromptOptimization({ text, target: 'image-edit' }, defaults);
  const result = await runPromptOptimization(fixture.port, plan);
  assert.equal(result.target, 'image-edit'); assert.equal(result.original, text);
  assert.equal(result.processing.targetTemplate, defaults.targets['image-edit']);
  assert(plan.prompt.endsWith(JSON.stringify({ target: 'image-edit', prompt: text })));
  assert.equal(fixture.stats.invocations, 1); assert.equal(fixture.stats.active, 0);
  assert.equal(fixture.calls[0].request.prompt, plan.prompt);
}
for (const target of PROMPT_TARGETS) {
  const plan = preparePromptOptimization({ text: '用户明确的原始任务', target }, defaults);
  assert.equal(plan.processing.targetTemplate, defaults.targets[target]);
  assert(plan.system.includes('## 保留用户意图') && plan.system.includes('## 输出'));
  const out = assemblePrompt({ text: '  保留原稿  ', target });
  assert.equal(out.optimized, '  保留原稿  '); assert.equal(out.processing, undefined);
}
assert(defaults.targets.image.includes('iris_draw_image'));
assert(defaults.targets.video.includes('iris_generate_video'));
assert(defaults.targets.s2v.includes('首帧图像与音频') && defaults.targets.s2v.includes('不是首尾帧'));

// 旧 v1 自定义模板保留；缺少的新目标只在内存补齐，读取不能改写原文件。
const custom = { version: 1, enabled: true, systemPrompt: '用户原有系统指令',
  targets: { general: '用户通用', image: '用户画图', video: '用户视频', s2v: '用户自定义 s2v' },
  route: { mode: 'fixed', provider: 'user-provider', model: 'user-model' },
  generation: { temperature: 0.2, reasoningEffort: 'provider-default', maxOutputTokens: 300, timeoutMs: 5000 } };
const file = store.promptOptimizerConfigFile();fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(custom, null, 2), { mode: 0o600 });
const before = fs.readFileSync(file), stat = fs.statSync(file);
store.resetPromptOptimizerConfigCache();const loaded = store.loadPromptOptimizerConfig();
assert.equal(loaded.source, 'custom');assert.equal(loaded.config.systemPrompt, custom.systemPrompt);
for (const target of Object.keys(custom.targets)) assert.equal(loaded.config.targets[target], custom.targets[target]);
assert.equal(loaded.config.targets['image-edit'], defaults.targets['image-edit']);
assert.deepEqual(loaded.config.route, custom.route);assert.deepEqual(loaded.config.generation, custom.generation);
assert.deepEqual(fs.readFileSync(file), before);assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);assert.equal(fs.statSync(file).ino, stat.ino);
const edited = store.normalizePromptOptimizerConfig({ ...custom, targets: { ...custom.targets, 'image-edit': '用户自定义改图' } });
assert.equal(edited.targets['image-edit'], '用户自定义改图');
console.log('PASS 一般功能：改图双端口、五目标隔离、Skills 指令结构、S2V 语义、旧 v1 配置零重写与自定义优先');
