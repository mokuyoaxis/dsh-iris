import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-image-task-mixed-v2');
const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};
const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { runAction } = await import('../lib/actions.js');

const asyncProvider = config.upsert({
  name: 'dashscope-async', apiKey: 'async-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }]
});
const syncProvider = config.upsert({
  name: 'openai-sync', apiKey: 'sync-secret', baseUrl: 'https://images.example.invalid/v1',
  mediaProtocol: 'openai-images', enabled: true,
  models: [{ id: 'gpt-image-1', capabilities: ['image-gen'] }]
});
const asyncRef = models.modelRef(asyncProvider.id, 'wan2.2-t2i-flash');
const syncRef = models.modelRef(syncProvider.id, 'gpt-image-1');
config.setAssignmentOrder('image-gen', [asyncRef, syncRef]);

const originalFetch = global.fetch;
let mode = 'mixed-success';
let asyncCalls = 0;
let syncCalls = 0;
let writeAhead = 0;
global.fetch = async (input, init = {}) => {
  const url = String(input);
  const auth = init.headers && init.headers.Authorization;
  if (url.includes('/text2image/image-synthesis')) {
    asyncCalls++;
    const disk = JSON.parse(fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8'));
    if (disk.tasks.at(-1)?.attempts?.at(-1)?.acceptance === 'none') writeAhead++;
    if (mode === 'auth-fail') {
      return new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ code: 'Throttling', message: 'not accepted' }), {
      status: 429, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (url === 'https://images.example.invalid/v1/images/generations') {
    syncCalls++;
    const disk = JSON.parse(fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8'));
    if (disk.tasks.at(-1)?.attempts?.at(-1)?.acceptance === 'none') writeAhead++;
    if (mode === 'delivery-fail') {
      return new Response(JSON.stringify({ data: [{ url: 'https://result.invalid/unavailable.png' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('sync-png').toString('base64') }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (url === 'https://result.invalid/unavailable.png') {
    return new Response('down', { status: 502 });
  }
  throw new Error('unexpected fetch: ' + url + ' ' + auth);
};

try {
  const action = await runAction({}, 'image', { prompt: 'mixed providers' });
  const finished = tasks.get(action.taskId);
  assert(asyncCalls === 1 && syncCalls === 1 && writeAhead === 2, '异步拒绝后同步候选也先预写 Attempt', { asyncCalls, syncCalls, writeAhead });
  assert(tasks.all().length === 1 && finished.attempts.length === 2, '混合协议仍只有一个 Task', finished);
  assert(finished.attempts[0].acceptance === 'not_accepted', '异步 429 明确未受理');
  assert(finished.attempts[1].resultKind === 'completed' && finished.attempts[1].acceptance === 'accepted', '同步成功记录为 completed/accepted');
  assert(finished.outcome === 'succeeded' && finished.deliveryState === 'ready' && finished.status === 'succeeded', '同步生成与交付完整收口', finished);
  assert(action.providerId === syncProvider.id && action.remoteTaskId === null, '动作返回实际同步候选');
  assert(fs.existsSync(path.join(config.irisHome(), 'outputs', finished.files[0])), '同步 base64 产物已落盘');
  const health = config.providerHealthSnapshot();
  const imageHealth = health.capabilities['image-gen'];
  const rejectedHealth = imageHealth.candidates.find((item) => item.providerId === asyncProvider.id);
  const completedHealth = imageHealth.candidates.find((item) => item.providerId === syncProvider.id);
  assert(imageHealth.status === 'verified' && rejectedHealth.status === 'configured'
    && completedHealth.status === 'verified',
  '真实提交把成功候选标绿，429 候选保持蓝色', imageHealth);

  mode = 'delivery-fail';
  let thrown;
  try {
    await runAction({}, 'image', { prompt: 'delivery failure', model: syncRef });
  } catch (error) {
    thrown = error;
  }
  assert(thrown && thrown.taskId && /已生成.*交付失败/.test(thrown.message), '同步交付失败返回准确错误与 Task ID', thrown && thrown.message);
  const failedDelivery = tasks.get(thrown.taskId);
  assert(failedDelivery.attempts.length === 1 && failedDelivery.attempts[0].resultKind === 'completed', '交付失败不创建第二 Attempt', failedDelivery);
  assert(failedDelivery.outcome === 'succeeded' && failedDelivery.deliveryState === 'failed', '交付失败保留生成成功事实', failedDelivery);
  assert(failedDelivery.status === 'running' && failedDelivery.lastError.stage === 'download', '旧 status 保守且错误阶段为 download', failedDelivery);
  assert(asyncCalls === 1, '显式同步模型交付失败后不回到异步供应商');

  mode = 'auth-fail';
  let authThrown;
  try {
    await runAction({}, 'image', { prompt: 'auth failure', model: asyncRef });
  } catch (error) {
    authThrown = error;
  }
  const afterAuth = config.providerHealthSnapshot().capabilities['image-gen'];
  const authHealth = afterAuth.candidates.find((item) => item.providerId === asyncProvider.id);
  assert(authThrown && authHealth.status === 'failed' && authHealth.httpStatus === 401,
    '真实动作的明确 401 应把对应候选标为暗红', { error: authThrown && authThrown.message, authHealth });
  assert(syncCalls === 2, '显式认证失败不得调用另一个候选');

  const registry = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8');
  assert(!registry.includes('async-secret') && !registry.includes('sync-secret'), '混合路径不持久化 API Key');
} finally {
  tasks.stopWatchAll();
  global.fetch = originalFetch;
}

console.log('ALL OK —— 混合异步/同步图片共用 Task v2，且交付失败不重新生成');
