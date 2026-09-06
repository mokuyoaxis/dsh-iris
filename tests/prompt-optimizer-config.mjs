import fs from 'node:fs';
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
assert(Object.keys(initial.config.targets).join(',') === 'general,image,video,s2v', '目标模板集合不完整');

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

console.log('ALL OK —— 提示词优化器 JSON 配置默认值、导入、校验、私有落盘与恢复默认通过');
