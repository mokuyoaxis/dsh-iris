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
const ctx = {
  get(name) {
    if (name === 'llm') return { async *stream() {
      yield { type: 'text-delta', index: 0, text: 'API 优化结果' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'api-p', model: 'api-m' }) };
  }
};
const server = http.createServer((req, res) => serveApi(req, res, ctx));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  let res = await fetch(base + '/iris/api/prompt-optimizer/config');
  let json = await res.json();
  assert(res.status === 200 && json.source === 'default' && json.config.route.mode === 'session', 'GET config 应返回默认配置', json);

  res = await fetch(base + '/iris/api/prompt-optimizer/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { systemPrompt: 'API CUSTOM', route: { mode: 'session' } } })
  });
  json = await res.json();
  assert(res.status === 200 && json.ok && json.source === 'custom' && json.config.systemPrompt === 'API CUSTOM', 'POST import 应导入 JSON', json);

  res = await fetch(base + '/iris/api/prompt-optimizer/optimize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '原始提示词', target: 'general' })
  });
  json = await res.json();
  assert(res.status === 200 && json.optimized === 'API 优化结果', 'POST optimize 应调用 DSH LLM', json);
  assert(json.route.provider === 'api-p' && json.route.source === 'host-default', 'API 无会话模型时应使用宿主默认', json.route);

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
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('ALL OK —— 提示词优化器 config/import/optimize/disable/enable/reset HTTP API 通过');
