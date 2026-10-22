import http from 'node:http';
import fs from 'node:fs';
import strict from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-prompt-api-home');

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

const { serveApi, fixtureRuntime } = await import('./fixtures/dsh-runtime-fixture.mjs');
const { createDshHostAdapter } = await import('../lib/dsh-host-adapter.js');
const configStore = await import('../lib/prompt-optimizer-config.js');
let modelCalls = 0;
let available = true;
let responseText = 'API 优化结果';
let modelInfo;
let metadataFailure = false;
let lastModelRequest;
const ctx = {
  get(name) {
    if (name === 'llm' && available) return { async resolveModelInfo() {
      if (metadataFailure) throw new Error('private lookup failure');
      return modelInfo;
    }, async *stream(request) {
      lastModelRequest = request;
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
  assert(json.capabilities.localFaithful === true, 'GET config 明确声明单片段零调用，不进入配置导出');
  assert(json.capabilities.resetInstructions === true && Array.isArray(json.feedback.warnings), 'GET config 声明反馈与仅指令恢复能力');
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
  assert(json.route.reason === '未提供当前会话模型，使用宿主默认模型' && json.route.textInput === 'unknown', 'API 返回选择原因及未知能力', json.route);
  assert(json.processing.request.system === lastModelRequest.system && json.processing.request.prompt === lastModelRequest.messages[0].content[0].text, 'HTTP 快照包含实际完整指令');
  assert(Array.isArray(json.configFeedback.warnings), '模型结果可追溯本次加载的配置反馈');

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
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', {
    method: 'POST', body: JSON.stringify({ text: '  一只猫，不要帽子。  ', editing: 'faithful', route: {}, rules: [
      { id: 'end', label: '约束', kind: 'output', position: 'suffix', text: '不要水印' }
    ] })
  });
  json = await res.json();
  assert(res.status === 200 && json.optimized === '  一只猫，不要帽子。  \n\n不要水印' && json.mode === 'optimize'
    && json.route === null && json.configSource === 'not-loaded' && json.execution.modelInvocations === 0 && json.processing === undefined,
  '无 Host 模型的单片段忠实整理零调用，不加载配置/路由或伪造请求', json);
  assert(modelCalls === before);
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
  strict.deepEqual(await res.json(), { error: 'invalid JSON' }, 'JSON 请求体解析错误不回显原文片段');

  const countBeforeBoundary = modelCalls;
  responseText = '{"groups":[["s1"],["s2"]]}';
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '左眼泪痣。右鬓发饰。', editing: 'faithful' }) });
  json = await res.json();
  assert(res.status === 200 && json.optimized === '左眼泪痣。\n\n右鬓发饰。' && json.editing.coverage === 'exact', 'HTTP 忠实整理由原文片段拼回', json);
  responseText = '{"groups":[["s2","s1"]]}';
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '左眼泪痣。右鬓发饰。', editing: 'faithful' }) });
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

  const countBeforeRoute = modelCalls;
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '原稿', route: { provider: 'chosen' } }) });
  json = await res.json();
  assert(res.status === 400 && json.error.includes('请求路由') && modelCalls === countBeforeRoute, '无效显式路由不得静默使用默认');
  modelInfo = { inputModalities: ['image'] };
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '原稿' }) });
  json = await res.json();
  assert(res.status === 400 && json.code === 'IRIS_MODEL_UNSUPPORTED' && modelCalls === countBeforeRoute, '已知无文本输入能力在生成前拒绝');
  metadataFailure = true;
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '原稿' }) });
  json = await res.json();
  assert(res.status === 400 && json.code === 'IRIS_MODEL_UNAVAILABLE' && modelCalls === countBeforeRoute && !JSON.stringify(json).includes('private'), '查询失败不继续生成，错误脱敏');
  metadataFailure = false;
  modelInfo = { provider: 'api-p', id: 'api-m', inputModalities: ['text'] };
  responseText = '{"target":"general","prompt":"改写后正文"}';
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: '原稿' }) });
  json = await res.json();
  assert(res.status === 400 && json.code === 'IRIS_MODEL_PROTOCOL_INVALID' && json.optimized === undefined && modelCalls === countBeforeRoute + 1, '旧入口也拒绝新增输入外壳，无重试');
  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', { method: 'POST', body: JSON.stringify({ text: responseText }) });
  json = await res.json();
  assert(res.status === 200 && json.optimized === responseText && json.route.textInput === 'supported' && modelCalls === countBeforeRoute + 2, 'JSON 原稿保持合法并展示文本能力');

  const beforeConfig = modelCalls;
  const selected = { enabled: false, systemPrompt: 'API RESET PROMPT', targets: { image: 'API IMAGE' },
    route: { mode: 'fixed', provider: 'keep-p', model: 'keep-m' },
    generation: { temperature: 0.1, maxOutputTokens: 300, timeoutMs: 5000 },
    modeTemplates: { rewrite: 'never-echo' }, generationIgnored: 'never-echo' };
  res = await fetch(base + '/iris/api/prompt-optimizer/import', { method: 'POST', body: JSON.stringify({ config: selected }) });
  json = await res.json();
  assert(res.status === 200 && json.feedback.warnings[0].fields.includes('modeTemplates'), 'HTTP 导入反馈不支持字段');
  assert(!JSON.stringify(json.feedback).includes('never-echo'), '忽略字段值不进入反馈');
  const saved = json.config;
  res = await fetch(base + '/iris/api/prompt-optimizer/reset', { method: 'POST', body: JSON.stringify({ scope: 'instructions' }) });
  json = await res.json();
  assert(res.status === 200 && json.config.enabled === false && json.config.systemPrompt !== 'API RESET PROMPT', '仅指令恢复不重启用入口');
  strict.deepEqual(json.config.route, saved.route); strict.deepEqual(json.config.generation, saved.generation);
  assert(json.feedback.warnings.length === 0, '有效规范化恢复清除已解决字段反馈');
  const preserved = fs.readFileSync(configStore.promptOptimizerConfigFile());
  res = await fetch(base + '/iris/api/prompt-optimizer/reset', { method: 'POST', body: JSON.stringify({ scope: 'other' }) });
  assert(res.status === 400); strict.deepEqual(fs.readFileSync(configStore.promptOptimizerConfigFile()), preserved);
  res = await fetch(base + '/iris/api/prompt-optimizer/reset', { method: 'POST', body: '{}' });
  json = await res.json(); assert(res.status === 200 && json.config.enabled && json.config.route.mode === 'session', '旧 reset 不传 scope 仍全部恢复');
  const broken = '{never-echo-private-content'; fs.writeFileSync(configStore.promptOptimizerConfigFile(), broken); configStore.resetPromptOptimizerConfigCache();
  const log = console.error; console.error = () => {};
  try { res = await fetch(base + '/iris/api/prompt-optimizer/config'); json = await res.json(); }
  finally { console.error = log; }
  assert(json.source === 'default' && json.feedback.warnings[0].reason === 'json-invalid' && json.feedback.warnings[0].isolation === 'saved', '默认与损坏回退可区别');
  assert(!JSON.stringify(json).includes('never-echo-private-content'), 'HTTP 损坏反馈不泄露内容');
  res = await fetch(base + '/iris/api/prompt-optimizer/reset', { method: 'POST', body: JSON.stringify({ scope: 'instructions' }) });
  json = await res.json(); assert(res.status === 400 && json.error.includes('不能保证保留'), '回退状态不可假称仅指令保留预算');
  res = await fetch(base + '/iris/api/prompt-optimizer/reset', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
  json = await res.json(); assert(res.status === 200 && json.feedback.warnings.length === 0, '显式全部恢复修复当前状态');
  assert(modelCalls === beforeConfig, '配置反馈与恢复不生成模型请求');

  // A JSON body admitted before unload must not write configuration after its owner closes.
  const beforeClose = fs.readFileSync(configStore.promptOptimizerConfigFile());
  const admitted = new Promise(resolve => server.once('request', resolve));
  let delayed;
  const lateResponse = new Promise((resolve, reject) => {
    delayed = http.request(base + '/iris/api/prompt-optimizer/enabled', { method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    delayed.once('error', reject); delayed.flushHeaders();
  });
  await admitted; await fixtureRuntime().dispose();
  delayed.end(JSON.stringify({ enabled: false }));
  strict.equal(await lateResponse, 503);
  strict.deepEqual(fs.readFileSync(configStore.promptOptimizerConfigFile()), beforeClose);
  strict.equal(modelCalls, beforeConfig);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('ALL OK —— 提示词优化器 config/import/optimize/disable/enable/reset、能力声明与无模型只组装 HTTP API 通过');
