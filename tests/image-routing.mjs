import fs from 'node:fs';
import path from 'node:path';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';
useTempDshHome('iris-image-routing');
const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};
const adapters = await import('../lib/adapters.js');
const protocol = await import('../lib/provider-protocol.js');
const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { inspectProviderTaskForDsh, readCoreArtifactMediaForDsh } = await import('../lib/dsh-core-adapter.js');
const { runAction } = await import('../lib/actions.js');
const DS_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

assert(adapters.dashscopeImageMode('wan2.2-t2i-flash') === 'legacy-async', 'Wan 2.2 走旧异步');
assert(adapters.dashscopeImageMode('wan2.5-t2i-preview') === 'legacy-async', 'Wan 2.5 按官方协议仍走旧异步');
assert(adapters.dashscopeImageMode('qwen-image-plus-2026-01-09') === 'legacy-async', 'Qwen Image Plus 走旧异步');
for (const model of ['wan2.6-t2i', 'wan2.7-image', 'qwen-image-2.0-pro', 'qwen-image-3.0', 'qwen-image-max', 'z-image-turbo']) {
  assert(adapters.dashscopeImageMode(model) === 'multimodal-sync', model + ' 走新版多模态');
}


// 尺寸规则住在协议层（provider-protocol.js），调用点不再自带厂商假设。
// 分隔符与边界均取自线上实测：多模态严格要求 `*`（`100x100` → Invalid size format）；
// 旧异步提交期不校验（`100x100`/`auto` 均 200）；OpenAI 兼容端点用 `x` 且集合由网关决定。
assert(protocol.normalizeImageSize({ protocol: 'dashscope', mode: 'multimodal-sync', size: '1024x1536' }) === '1024*1536',
  'DashScope 多模态把 x 归一成 *');
assert(protocol.normalizeImageSize({ protocol: 'openai-images', size: '1024*1536' }) === '1024x1536',
  'OpenAI 兼容把 * 归一成 x');
assert(protocol.normalizeImageSize({ protocol: 'openai-responses-images', size: '1024*1536' }) === '1024x1536',
  'Responses 协议同样归一');
assert(protocol.normalizeImageSize({ protocol: 'dashscope', mode: 'multimodal-sync', size: 'auto' }) === 'auto',
  'auto 这类自由取值原样透传');
assert(protocol.imageSizeViolation({ protocol: 'dashscope', mode: 'multimodal-sync', size: '100*100' }),
  '多模态面积不足须判违规');
assert(protocol.imageSizeViolation({ protocol: 'dashscope', mode: 'multimodal-sync', size: '4096*4096' }),
  '多模态面积超限须判违规');
assert(protocol.imageSizeViolation({ protocol: 'dashscope', mode: 'multimodal-sync', size: '1024*1536' }) === null,
  '多模态 1024*1536 合规');
for (const size of ['1536x2304', '1536x2688', '2688x1536', '2368x1728', '512x512', '2048x2048']) {
  assert(protocol.imageSizeViolation({ protocol: 'dashscope', mode: 'multimodal-sync', size }) === null,
    size + ' 面积合规，不额外限制单边');
}
assert(protocol.imageSizeViolation({ protocol: 'dashscope', mode: 'legacy-async', size: '100*100' }) === null,
  '旧异步无本地规则，不得比服务端更严');
assert(protocol.imageSizeViolation({ protocol: 'openai-images', size: '1024*1536' }) === null,
  'OpenAI 兼容无本地数值白名单');
let sizeThrew = null;
try { adapters.applyImageSize({ protocol: 'dashscope', mode: 'multimodal-sync', size: '100*100' }); } catch (e) { sizeThrew = e; }
assert(sizeThrew && sizeThrew.category === 'invalid_request' && /总像素/.test(sizeThrew.message),
  '违规尺寸须翻译成 invalid_request', sizeThrew && sizeThrew.message);
assert(sizeThrew.stage === 'validate' && sizeThrew.acceptance === 'not_accepted',
  '本地尺寸拒绝明确标记为校验失败、未受理');

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
    return new Response(FAKE_PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  throw new Error('unexpected fetch: ' + url);
};

try {
  const old = await adapters.startImageGeneration({ key: 'k', baseUrl: DS_BASE, model: 'wan2.5-t2i-preview', prompt: 'old' });
  assert(old.remoteTaskId === 'legacy-task' && old.urls.length === 0, '旧协议返回后台 task id', old);
  const oldCall = calls.find((c) => c.url.includes('/text2image/image-synthesis'));
  assert(oldCall && oldCall.body.input.prompt === 'old' && !('size' in oldCall.body.parameters), '旧协议保留 input.prompt，留空尺寸时采用模型默认值', oldCall && oldCall.body);
  assert(oldCall.init.headers['X-DashScope-Async'] === 'enable', '旧协议声明异步头');

  const modern = await adapters.startImageGeneration({ key: 'k', baseUrl: DS_BASE, model: 'qwen-image-2.0-pro', prompt: 'new', size: '2048x2048', n: 2 });
  assert(modern.remoteTaskId === null && modern.urls[0] === 'https://result.invalid/generated.png', '新版协议直接返回 URL', modern);
  const modernCall = calls.find((c) => c.url.includes('/multimodal-generation/generation'));
  assert(modernCall && modernCall.body.input.messages[0].content[0].text === 'new', '新版协议使用 messages/content/text', modernCall && modernCall.body);
  assert(modernCall.body.parameters.n === 2 && !modernCall.init.headers['X-DashScope-Async'], '新版同步协议参数与请求头正确');
  assert(modernCall.body.parameters.size === '2048*2048', 'x 尺寸进 DashScope 请求体前须归一成 *', modernCall.body.parameters);
  for (const size of ['1536x2304', '1536x2688', '2688x1536']) {
    await adapters.generateImageMultimodal({ key: 'k', baseUrl: DS_BASE, model: 'qwen-image-2.0-pro', prompt: 'portrait', size });
    assert(calls.at(-1).body.parameters.size === size.replace('x', '*'),
      size + ' 合法比例到达请求体并归一分隔符');
  }

  const polled = await adapters.pollTask({ key: 'k', baseUrl: DS_BASE, remoteTaskId: 'new-shape' });
  assert(polled.done && polled.ok && polled.urls[0] === 'https://result.invalid/polled.png', '轮询兼容 choices 图片结果', polled);

  const provider = config.upsert({ name: 'modern-image', apiKey: 'modern-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true, models: [{ id: 'wan2.7-image', capabilities: ['image-gen'] }] });
  config.setAssignmentOrder('image-gen', [models.modelRef(provider.id, 'wan2.7-image')]);
  const legacyCount = tasks.all().length;
  const action = await runAction({}, 'image', { prompt: 'blue button', size: '1024*1024' });
  const task = await inspectProviderTaskForDsh(action.taskId);
  assert(action.storage === 'core' && action.remoteTaskId === null && /已完成/.test(action.text), '同步动作返回 Core 完成语义', action);
  assert(task.status === 'succeeded' && task.deliveryState === 'ready' && task.artifactIds.length === 1,
    '新版图片只登记为 Core Task/Artifact', task);
  assert(tasks.all().length === legacyCount && tasks.get(action.taskId) == null, '同步图片不得双写 legacy tasks/outputs');
  const media = await readCoreArtifactMediaForDsh(task.artifactIds[0]);
  assert(media.bytes.equals(FAKE_PNG) && action.imageUrl.endsWith('/' + task.artifactIds[0] + '/media'),
    '动作预览 URL 与 Core Artifact 指向同一字节', { action, artifact: media.artifact });
  const status = await runAction({}, 'status', { task_id: action.taskId });
  assert(status.storage === 'core' && status.text.includes(task.artifactIds[0]) && status.text.includes('Core terminal'),
    'Agent/工作台 status 必须能查询新 Core Task 和 Artifact', status);
} finally {
  tasks.stopWatchAll();
  global.fetch = originalFetch;
}
// fetch failed 本身不能证明长连接或网关问题，提示只陈述已知阶段。
global.fetch = async () => { throw new TypeError('fetch failed'); };
try {
  let linkErr = null;
  try {
    await adapters.generateImageMultimodal({ key: 'k', baseUrl: DS_BASE, model: 'qwen-image-3.0', prompt: 'x', size: '1024*1536' });
  } catch (e) { linkErr = e; }
  assert(linkErr && linkErr.category === 'network' && /尚未收到响应头/.test(linkErr.message)
    && !/长连接|改用异步/.test(linkErr.message),
    '同步生成网络失败保留阶段，不猜测原因或建议切换模型', linkErr && linkErr.message);

  let legacyErr = null;
  try {
    await adapters.submitImage({ key: 'k', baseUrl: DS_BASE, model: 'wan2.2-t2i-flash', prompt: 'x' });
  } catch (e) { legacyErr = e; }
  assert(legacyErr && legacyErr.category === 'network', '旧异步网络失败仍归类 network', legacyErr && legacyErr.message);

  // 超时/取消不能被吞成 network —— 轮询容错与 submitGuard 依赖这个区分
  global.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); };
  let abortErr = null;
  try {
    await adapters.generateImageMultimodal({ key: 'k', baseUrl: DS_BASE, model: 'qwen-image-3.0', prompt: 'x' });
  } catch (e) { abortErr = e; }
  assert(abortErr && abortErr.name === 'TimeoutError', '超时须原样抛出，不得包装成 network', abortErr && abortErr.name);
} finally {
  global.fetch = originalFetch;
}

console.log('ALL OK —— DashScope 图像新旧协议分流 + choices 解析 + 同步动作落盘通过');
