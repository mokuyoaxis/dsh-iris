import fs from 'node:fs';
import path from 'node:path';
import strict from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-prompt-config-home');

const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
};

const config = await import('../lib/prompt-optimizer-config.js');

const initial = config.loadPromptOptimizerConfig();
assert(initial.source === 'default', '首次读取应使用内置默认值');
assert(initial.config.enabled === true, '提示词入口默认应启用');
assert(initial.config.route.mode === 'session', '默认应使用当前会话模型');
assert(initial.config.generation.reasoningEffort === 'off-if-supported', '默认应在模型明确支持时关闭 thinking');
assert(initial.config.systemPrompt.includes('Iris 提示词编辑器'), '缺少内置默认 Prompt');
strict.deepEqual(initial.feedback, { warnings: [] });
assert(Object.keys(initial.config.targets).join(',') === 'general,image,image-edit,video,s2v', '目标模板集合不完整');

const imported = config.importPromptOptimizerConfig({
  version: 1,
  systemPrompt: 'CUSTOM PROMPT',
  targets: { image: 'CUSTOM IMAGE' },
  route: { mode: 'fixed', provider: 'provider-a', model: 'model-b' },
  generation: { temperature: 0.1, reasoningEffort: 'inherit', maxOutputTokens: 300, timeoutMs: 5000 },
  ignored: 'must not persist'
});
assert(imported.source === 'custom', '导入后来源应为 custom');
assert(imported.config.targets.image === 'CUSTOM IMAGE', '自定义目标模板未生效');
assert(imported.config.targets.video.length > 0, '局部 JSON 应补齐默认目标模板');
assert(imported.config.generation.reasoningEffort === 'inherit', '自定义思考策略未生效');
assert(!('ignored' in imported.config), '未知字段不得落盘');
strict.deepEqual(imported.feedback, { warnings: [{ code: 'ignored-fields', count: 1, fields: ['ignored'] }] });
imported.feedback.warnings[0].fields.push('caller-mutated');
strict.equal(config.loadPromptOptimizerConfig().feedback.warnings[0].fields.length, 1, '反馈快照不暴露缓存可变引用');
if (process.platform !== 'win32') {
  assert((fs.statSync(config.promptOptimizerConfigFile()).mode & 0o777) === 0o600, '配置文件权限应为 0600');
}

config.resetPromptOptimizerConfigCache();
const reloaded = config.loadPromptOptimizerConfig();
assert(reloaded.config.route.provider === 'provider-a' && reloaded.config.route.model === 'model-b', '自定义 fixed 路由未持久化');

for (const bad of [
  null,
  { version: 2 },
  { route: { mode: 'other' } },
  { route: { mode: 'fixed', provider: 'p' } },
  { generation: { timeoutMs: 1 } },
  { generation: { reasoningEffort: '' } },
  { enabled: 'yes' }
]) {
  let rejected = false;
  try { config.normalizePromptOptimizerConfig(bad); } catch (_) { rejected = true; }
  assert(rejected, '无效配置必须拒绝：' + JSON.stringify(bad));
}

const disabled = config.setPromptOptimizerEnabled(false);
assert(disabled.config.enabled === false && disabled.source === 'custom', '应能只关闭提示词入口');
const enabled = config.setPromptOptimizerEnabled(true);
assert(enabled.config.enabled === true, '应能重新启用提示词入口');

const reset = config.resetPromptOptimizerConfig();
assert(reset.source === 'default' && reset.config.route.mode === 'session', '恢复默认应回到会话模型路由');
assert(reset.config.systemPrompt !== 'CUSTOM PROMPT', '恢复默认没有替换自定义 Prompt');
config.resetPromptOptimizerConfigCache();
assert(config.loadPromptOptimizerConfig().source === 'default', '重启式重载后仍应识别为内置默认配置');

const selected = config.importPromptOptimizerConfig({ enabled: false, systemPrompt: 'CUSTOM', targets: { image: 'CUSTOM IMAGE', s2v: 'CUSTOM S2V' },
  route: { mode: 'fixed', provider: 'keep-provider', model: 'keep-model' },
  generation: { temperature: 0.1, reasoningEffort: 'inherit', maxOutputTokens: 300, timeoutMs: 5000 } });
const instructions = config.resetPromptOptimizerInstructions();
strict.equal(instructions.config.systemPrompt, initial.config.systemPrompt);
strict.deepEqual(instructions.config.targets, initial.config.targets);
strict.deepEqual(instructions.config.route, selected.config.route);
strict.deepEqual(instructions.config.generation, selected.config.generation);
strict.equal(instructions.config.enabled, false);
strict.equal(instructions.config.version, 1);
strict.equal(instructions.source, 'custom');
strict(!Object.hasOwn(JSON.parse(fs.readFileSync(config.promptOptimizerConfigFile(), 'utf8')), 'feedback'));
config.resetPromptOptimizerConfigCache();
strict.deepEqual(config.loadPromptOptimizerConfig().config, instructions.config, '仅指令恢复持久保存其余设置');

const ignored = config.importPromptOptimizerConfig({ modeTemplates: { faithful: 'private value' }, rules: [{ text: 'private value' }],
  targets: { typo: 'private value' }, route: { mode: 'session', provider: 'unused', model: 'unused' }, generation: { maxTokens: 100 } });
strict.deepEqual(ignored.feedback.warnings[0].fields, ['modeTemplates', 'rules', 'targets.typo', 'route.provider', 'route.model', 'generation.maxTokens']);
strict.equal(ignored.config.generation.maxOutputTokens, 1200, '未知 token 名不擅自转换，保持旧默认补齐语义');
strict(!JSON.stringify(ignored.feedback).includes('private value'));
strict.deepEqual(config.setPromptOptimizerEnabled(false).feedback.warnings, [], '已保存的规范配置没有忽略字段');

const many = config.importPromptOptimizerConfig(Object.fromEntries(Array.from({ length: 40 }, (_, n) => ['unknown-' + n, 'never-echo-values'])));
strict.equal(many.feedback.warnings[0].count, 40);
strict.equal(many.feedback.warnings[0].fields.length, 32, '限制反馈数量，不截断或更改有效配置');

const file = config.promptOptimizerConfigFile();
const captureFallback = action => {
  const original = console.error; const messages = [];
  console.error = (...args) => messages.push(args.join(' '));
  try { return { result: action(), messages }; } finally { console.error = original; }
};
const invalid = '{private-template-value';
fs.writeFileSync(file, invalid); config.resetPromptOptimizerConfigCache();
const bad = captureFallback(() => config.loadPromptOptimizerConfig());
strict.deepEqual(bad.result.feedback.warnings, [{ code: 'config-fallback', reason: 'json-invalid', isolation: 'saved' }]);
strict(!JSON.stringify(bad).includes('private-template-value'));
const backups = fs.readdirSync(path.dirname(file)).filter(name => name.includes('.corrupted'));
strict.equal(backups.length, 1); strict.equal(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'), invalid);
strict.throws(() => config.resetPromptOptimizerInstructions(), /不能保证保留/);
strict.equal(fs.existsSync(file), false, '拒绝仅指令恢复时不新写默认配置');
strict.equal(config.setPromptOptimizerEnabled(false).feedback.warnings[0].code, 'config-fallback', '只切开关不能抹掉之前的回退反馈');
strict.equal(config.resetPromptOptimizerConfig().feedback.warnings.length, 0, '明确全部恢复确认新的有效默认状态');

fs.writeFileSync(file, '{bad-private-value'); config.resetPromptOptimizerConfigCache();
const rename = fs.renameSync;
fs.renameSync = (source, destination) => { if (String(destination).includes('.corrupted')) throw new Error('private-path-injected'); return rename(source, destination); };
try {
  const failed = captureFallback(() => config.loadPromptOptimizerConfig());
  strict.equal(failed.result.feedback.warnings[0].isolation, 'failed');
  strict.equal(fs.readFileSync(file, 'utf8'), '{bad-private-value');
  strict.throws(() => config.resetPromptOptimizerInstructions(), /不能保证保留/);
  strict.throws(() => config.setPromptOptimizerEnabled(false), /尚未隔离保留/);
  strict.equal(fs.readFileSync(file, 'utf8'), '{bad-private-value', '隔离失败不能因入口切换覆盖原文件');
  strict(!JSON.stringify(failed).includes('private-path-injected'));
} finally { fs.renameSync = rename; }
config.resetPromptOptimizerConfig();
config.resetPromptOptimizerConfigCache();
const read = fs.readFileSync;
fs.readFileSync = (target, ...args) => { if (String(target) === file) throw new Error('private-read-path'); return read(target, ...args); };
try {
  const denied = captureFallback(() => config.loadPromptOptimizerConfig());
  strict.deepEqual(denied.result.feedback.warnings, [{ code: 'config-fallback', reason: 'read-failed', isolation: 'not-attempted' }]);
  strict(fs.existsSync(file));
  strict(!JSON.stringify(denied).includes('private-read-path'));
} finally { fs.readFileSync = read; }

config.resetPromptOptimizerConfig();
const stableBefore = config.loadPromptOptimizerConfig();
const persistedBefore = fs.readFileSync(file);
const write = fs.writeFileSync;
fs.writeFileSync = () => { throw new Error('fixture-write-failed'); };
try { strict.throws(() => config.importPromptOptimizerConfig({ systemPrompt: 'new', unsupported: 'new' }), /fixture-write-failed/); }
finally { fs.writeFileSync = write; }
strict.deepEqual(config.loadPromptOptimizerConfig(), stableBefore, '写入失败不会发布新的配置或反馈缓存');
strict.deepEqual(fs.readFileSync(file), persistedBefore);
fs.writeFileSync = () => { throw Object.assign(new Error('private-path-and-content'), { code: 'EACCES', syscall: 'open' }); };
try { strict.throws(() => config.resetPromptOptimizerInstructions(), error => error.code === 'EACCES' && error.message.includes('写入失败') && !error.message.includes('private-path-and-content')); }
finally { fs.writeFileSync = write; }
strict.deepEqual(config.loadPromptOptimizerConfig(), stableBefore);

console.log('ALL OK —— 提示词优化器 JSON 配置默认值、导入、校验、私有落盘与恢复默认通过');
