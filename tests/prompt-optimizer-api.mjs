import http from 'node:http';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-prompt-api-home');

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

const { serveApi } = await import('../lib/api.js');
const { createDshHostAdapter } = await import('../lib/dsh-host-adapter.js');
let modelCalls = 0;
let available = true;
let responseText = 'API 优化结果';
const ctx = {
  get(name) {
    if (name === 'llm' && available) return { async *stream() {
      modelCalls++;
      yield { type: 'text-delta', index: 0, text: responseText };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'api-p', model: 'api-m' }) };
  }
};
const server = http.createServer((req, res) => serveApi(req, res, createDshHostAdapter(ctx)));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  let res = await fetch(base + '/iris/api/prompt-optimizer/config');
  let json = await res.json();
  assert(res.status === 200 && json.source === 'default' && json.config.route.mode === 'session', 'GET config 应返回默认配置', json);
  assert(json.capabilities.rules && json.capabilities.assemble, 'GET config 声明规则与只组装能力');
  assert(json.capabilities.targets.includes('image-edit') && json.config.targets['image-edit'].includes('iris_edit_image'), 'GET config 声明改图目标与独立模板');

  res = await fetch(base + '/iris/api/prompt-optimizer/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { systemPrompt: 'API CUSTOM', route: { mode: 'session' } } })
  });
  json = await res.json();
  assert(res.status === 200 && json.ok && json.source === 'custom' && json.config.systemPrompt === 'API CUSTOM', 'POST import 应导入 JSON', json);

  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '原始提示词', target: 'image-edit' })
  });
  json = await res.json();
  assert(res.status === 200 && json.optimized === 'API 优化结果', 'POST optimize 应调用 DSH LLM', json);
  assert(json.target === 'image-edit' && json.processing.targetTemplate.includes('iris_edit_image'), '改图请求采用独立模板');
  assert(json.route.provider === 'api-p' && json.route.source === 'host-default', 'API 无会话模型时应使用宿主默认', json.route);

  responseText = 'http://googleusercontent.com/image_generation_content/0_752';
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '保留原稿', target: 'image' }) });
  json = await res.json();
  assert(res.status === 400 && json.optimized === undefined && json.error.includes('不符合协议'), '媒体链接不能冒充优化成功', json);
  assert(modelCalls === 2, '无效正文不自动重试');
  responseText = 'API 优化结果';

  const before = modelCalls;
  available = false;
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', {
    method: 'POST', body: JSON.stringify({ text: '  原稿  ', mode: 'assemble', rules: [
      { id: 'end', label: '约束', kind: 'output', position: 'suffix', text: '不要水印' }
    ] })
  });
  json = await res.json();
  assert(res.status === 200 && json.optimized === '  原稿  \n\n不要水印' && json.route === null, '没有模型服务仍可只组装', json);
  assert(modelCalls === before, '只组装不能进入生成入口');
  available = true;
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', {
    method: 'POST', body: JSON.stringify({ text: '原稿', rules: [{ id: 'bad', label: '坏规则', kind: 'output', text: '规则' }] })
  });
  assert(res.status === 400 && modelCalls === before, '非法规则在模型调用前返回 400');

  res = await fetch(base + '/iris/api/prompt-optimizer/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  json = await res.json();
  assert(res.status === 200 && json.ok && json.config.enabled === false, 'POST enabled 应能独立关闭入口', json);

  res = await fetch(base + '/iris/api/prompt-optimizer/config');
  json = await res.json();
  assert(res.status === 200 && json.config.enabled === false, '关闭状态必须可经 GET config 持久读取', json);

  res = await fetch(base + '/iris/api/prompt-optimizer/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  json = await res.json();
  assert(res.status === 200 && json.ok && json.config.enabled === true, 'POST enabled 应能从工作台重新启用入口', json);

  res = await fetch(base + '/iris/api/prompt-optimizer/reset', { method: 'POST', body: '{}' });
  json = await res.json();
  assert(res.status === 200 && json.ok && json.source === 'default' && json.config.systemPrompt !== 'API CUSTOM', 'POST reset 应恢复默认', json);

  res = await fetch(base + '/iris/api/prompt-optimizer/import', { method: 'POST', body: '{bad' });
  assert(res.status === 400, '无效 JSON 应返回 400', res.status);

  const countBeforeBoundary = modelCalls;
  responseText = '{"groups":[["s1"],["s2"]]}';
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '左眼泪痣。右鬓发饰。', editing: 'faithful' }) });
  json = await res.json();
  assert(res.status === 200 && json.optimized === '左眼泪痣。\n\n右鬓发饰。' && json.editing.coverage === 'exact', 'HTTP 忠实整理由原文片段拼回', json);
  responseText = '{"groups":[["s2","s1"]]}';
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '先站起来。然后离开。', editing: 'faithful' }) });
  json = await res.json();
  assert(res.status === 400 && json.optimized === undefined && json.code === 'IRIS_MODEL_PROTOCOL_INVALID', '调换时序拒绝且无成功预览', json);
  responseText = '{"suggestions":[{"label":"可选光线","text":"可选择侧面柔光。"}],"questions":["是否指定比例？"]}';
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '  原稿。  ', editing: 'suggestions' }) });
  json = await res.json();
  assert(res.status === 200 && json.optimized === '  原稿。  ' && json.suggestions.length === 1 && json.questions.length === 1, 'HTTP 建议不自动混入原稿', json);
  responseText = '原文描述。\nhttp://googleusercontent.com/image_generation_content/0_762';
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '原文描述。' }) });
  json = await res.json();
  assert(res.status === 400 && json.optimized === undefined, '媒体结果混入不冒充文字优化', json);
  assert(modelCalls === countBeforeBoundary + 4, '各案例一次调用，无隐藏重试');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('ALL OK —— 提示词优化器 config/import/optimize/disable/enable/reset、能力声明与无模型只组装 HTTP API 通过');
