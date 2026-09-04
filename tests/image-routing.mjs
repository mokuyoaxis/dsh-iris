import fs from 'node:fs';
import path from 'node:path';
process.env.DSH_HOME = '/tmp/iris-image-routing-' + Date.now();
const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};
const adapters = await import('../lib/adapters.js');
const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { runAction } = await import('../lib/actions.js');

assert(adapters.dashscopeImageMode('wan2.2-t2i-flash') === 'legacy-async', 'Wan 2.2 走旧异步');
assert(adapters.dashscopeImageMode('wan2.5-t2i-preview') === 'legacy-async', 'Wan 2.5 按官方协议仍走旧异步');
assert(adapters.dashscopeImageMode('qwen-image-plus-2026-01-09') === 'legacy-async', 'Qwen Image Plus 走旧异步');
for (const model of ['wan2.6-t2i', 'wan2.7-image', 'qwen-image-2.0-pro', 'qwen-image-3.0', 'qwen-image-max', 'z-image-turbo']) {
  assert(adapters.dashscopeImageMode(model) === 'multimodal-sync', model + ' 走新版多模态');
}

const calls = [];
const originalFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url, init, body });
  if (url.includes('/text2image/image-synthesis')) {
    return new Response(JSON.stringify({ output: { task_id: 'legacy-task' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/multimodal-generation/generation')) {
    return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ type: 'image', image: 'https://result.invalid/generated.png' }] } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/tasks/')) {
    return new Response(JSON.stringify({ output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image: 'https://result.invalid/polled.png', type: 'image' }] } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://result.invalid/generated.png') {
    return new Response(Buffer.from('fake-png'), { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  throw new Error('unexpected fetch: ' + url);
};

try {
  const old = await adapters.startImageGeneration({ key: 'k', model: 'wan2.5-t2i-preview', prompt: 'old' });
  assert(old.remoteTaskId === 'legacy-task' && old.urls.length === 0, '旧协议返回后台 task id', old);
  const oldCall = calls.find((c) => c.url.includes('/text2image/image-synthesis'));
  assert(oldCall && oldCall.body.input.prompt === 'old' && !('size' in oldCall.body.parameters), '旧协议保留 input.prompt，留空尺寸时采用模型默认值', oldCall && oldCall.body);
  assert(oldCall.init.headers['X-DashScope-Async'] === 'enable', '旧协议声明异步头');

  const modern = await adapters.startImageGeneration({ key: 'k', model: 'qwen-image-2.0-pro', prompt: 'new', size: '2048*2048', n: 2 });
  assert(modern.remoteTaskId === null && modern.urls[0] === 'https://result.invalid/generated.png', '新版协议直接返回 URL', modern);
  const modernCall = calls.find((c) => c.url.includes('/multimodal-generation/generation'));
  assert(modernCall && modernCall.body.input.messages[0].content[0].text === 'new', '新版协议使用 messages/content/text', modernCall && modernCall.body);
  assert(modernCall.body.parameters.n === 2 && !modernCall.init.headers['X-DashScope-Async'], '新版同步协议参数与请求头正确');

  const polled = await adapters.pollTask({ key: 'k', remoteTaskId: 'new-shape' });
  assert(polled.done && polled.ok && polled.urls[0] === 'https://result.invalid/polled.png', '轮询兼容 choices 图片结果', polled);

  const provider = config.upsert({ name: 'modern-image', apiKey: 'modern-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true, models: [{ id: 'wan2.7-image', capabilities: ['image-gen'] }] });
  config.setAssignmentOrder('image-gen', [models.modelRef(provider.id, 'wan2.7-image')]);
  const action = await runAction({}, 'image', { prompt: 'blue button', size: '1024*1024' });
  const task = tasks.get(action.taskId);
  assert(action.remoteTaskId === null && /已完成/.test(action.text), '同步动作返回完成语义', action);
  assert(task.status === 'succeeded' && task.files.length === 1, '新版图片已转存并登记任务', task);
  assert(fs.existsSync(path.join(config.irisHome(), 'outputs', task.files[0])), '新版图片产物已落盘');
} finally {
  tasks.stopWatchAll();
  global.fetch = originalFetch;
}
console.log('ALL OK —— DashScope 图像新旧协议分流 + choices 解析 + 同步动作落盘通过');
