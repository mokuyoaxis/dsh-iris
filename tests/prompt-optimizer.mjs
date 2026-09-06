import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-prompt-optimizer-home');

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

const { optimizePrompt, resolvePromptOptimizerRoute, MAX_PROMPT_INPUT_BYTES } = await import('../lib/prompt-optimizer.js');
const configStore = await import('../lib/prompt-optimizer-config.js');

let captured = null;
const ctx = {
  get(name) {
    if (name === 'llm') return {
      async resolveModelInfo() {
        return { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } };
      },
      async *stream(request) {
        captured = request;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '优化后的' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '优化后的提示词' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) };
  }
};

const output = await optimizePrompt(ctx, {
  text: '画一只猫',
  target: 'image',
  sessionId: 'session-1',
  route: { provider: 'session-p', model: 'session-m', reasoningEffort: 'low' }
});
assert(output.optimized === '优化后的提示词', '应采用 block-end 的完整文本且不得重复 delta', output);
assert(output.route.source === 'current-session' && output.route.provider === 'session-p', '应优先使用当前会话模型', output.route);
assert(captured.sessionId === 'session-1' && captured.reasoningEffort === 'off', '优化器默认应独立关闭会话 High/Low thinking');
assert(output.route.reasoningPolicy === 'off-if-supported' && output.route.reasoningEffort === 'off', '结果应报告实际思考策略', output.route);
assert(captured.system.includes(configStore.DEFAULT_PROMPT_OPTIMIZER_CONFIG.targets.image), '缺少 image 目标模板');
assert(captured.messages[0].content[0].text.includes(JSON.stringify({ target: 'image', prompt: '画一只猫' })), '草稿必须以 JSON 数据封装');
assert(captured.tools === undefined, '提示词优化请求不得开放工具');

configStore.importPromptOptimizerConfig({ generation: { reasoningEffort: 'inherit' } });
await optimizePrompt(ctx, {
  text: '继承测试',
  target: 'general',
  route: { provider: 'session-p', model: 'session-m', reasoningEffort: 'high' }
});
assert(captured.reasoningEffort === 'high', '只有 JSON 显式选择 inherit 时才应继承会话思考档位');
configStore.resetPromptOptimizerConfig();

const fallback = resolvePromptOptimizerRoute(ctx, configStore.DEFAULT_PROMPT_OPTIMIZER_CONFIG, null);
assert(fallback.source === 'host-default' && fallback.model === 'default-m', '会话无选择时应回退 DSH 默认模型');

configStore.importPromptOptimizerConfig({ route: { mode: 'fixed', provider: 'fixed-p', model: 'fixed-m' } });
const fixed = await optimizePrompt(ctx, { text: '  hello  ', target: 'general', route: { provider: 'ignored', model: 'ignored' } });
assert(fixed.route.source === 'iris-fixed' && fixed.route.provider === 'fixed-p' && fixed.route.model === 'fixed-m', 'JSON fixed 路由应覆盖会话模型');
assert(fixed.original === '  hello  ', '返回的 original 必须保留草稿首尾空白，避免写回时误报并支持精确恢复');
assert(captured.messages[0].content[0].text.includes(JSON.stringify({ target: 'general', prompt: 'hello' })), '发给模型的提示词应去除无意义首尾空白');

configStore.importPromptOptimizerConfig({ generation: { reasoningEffort: 'provider-default' } });
await optimizePrompt(ctx, { text: '默认推理测试', target: 'general', route: { provider: 'session-p', model: 'session-m', reasoningEffort: 'high' } });
assert(captured.reasoningEffort === undefined, 'provider-default 应忽略会话思考档位且不向 DSH 传 effort');
configStore.resetPromptOptimizerConfig();

let noOffCaptured = null;
const noOffCtx = { get: (name) => name === 'llm' ? {
  async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'high', name: 'High' }] } }; },
  async *stream(request) {
    noOffCaptured = request;
    yield { type: 'text-delta', index: 0, text: '无需思考档位' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
} : undefined };
const noOff = await optimizePrompt(noOffCtx, { text: 'x', target: 'general', route: { provider: 'p', model: 'm', reasoningEffort: 'high' } });
assert(noOffCaptured.reasoningEffort === undefined && noOff.route.reasoningEffort === 'provider-default', '模型未声明关闭档位时应忽略会话 High 并安全回退供应商默认');

let maxTokenMessage = '';
const maxTokenCtx = { get: (name) => name === 'llm' ? {
  async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off', name: 'Off' }] } }; },
  async *stream() { yield { type: 'reasoning-delta', index: 0, text: 'internal' }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; }
} : undefined };
try { await optimizePrompt(maxTokenCtx, { text: 'x', target: 'general', route: { provider: 'p', model: 'm' } }); } catch (err) { maxTokenMessage = err.message; }
assert(maxTokenMessage.includes('1200') && maxTokenMessage.includes('off') && maxTokenMessage.includes('未携带会话历史'), '输出上限错误应报告预算、实际思考策略和上下文边界', maxTokenMessage);

let rejectedTool = false;
const toolCtx = { get: (name) => name === 'llm' ? { async *stream() {
  yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'x', argumentsDelta: '{}' };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
} } : undefined };
try { await optimizePrompt(toolCtx, { text: 'x', target: 'general', route: { provider: 'tool-p', model: 'tool-m' } }); } catch (err) { rejectedTool = /工具/.test(err.message); }
assert(rejectedTool, '模型工具调用必须被拒绝');

let rejectedLarge = false;
try { await optimizePrompt(ctx, { text: 'a'.repeat(MAX_PROMPT_INPUT_BYTES + 1), target: 'general' }); } catch (err) { rejectedLarge = /超过/.test(err.message); }
assert(rejectedLarge, '超长草稿必须在模型调用前拒绝');

console.log('ALL OK —— 提示词优化的会话/默认/fixed 路由、原文保真、JSON 封装、流组装与安全边界通过');
