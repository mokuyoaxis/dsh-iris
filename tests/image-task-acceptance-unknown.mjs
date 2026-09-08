import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-image-task-unknown');
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

const first = config.upsert({
  name: 'ambiguous-first', apiKey: 'ambiguous-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }]
});
const second = config.upsert({
  name: 'must-not-run', apiKey: 'unused-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'qwen-image-plus', capabilities: ['image-gen'] }]
});
config.setAssignmentOrder('image-gen', [
  models.modelRef(first.id, 'wan2.2-t2i-flash'),
  models.modelRef(second.id, 'qwen-image-plus')
]);

const originalFetch = global.fetch;
let firstCalls = 0;
let secondCalls = 0;
let writeAhead = false;
let scenario = 'server';
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.includes('/text2image/image-synthesis')) throw new Error('unexpected fetch: ' + url);
  const persisted = JSON.parse(fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8'));
  writeAhead = persisted.tasks.at(-1)?.attempts?.at(-1)?.acceptance === 'none';
  const auth = init.headers && init.headers.Authorization;
  if (auth === 'Bearer ambiguous-secret') {
    firstCalls++;
    if (scenario === 'network') throw new TypeError('fetch failed');
    if (scenario === 'missing-id') {
      return new Response(JSON.stringify({ output: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ code: 'InternalError', message: 'gateway failed after forwarding' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (auth === 'Bearer unused-secret') secondCalls++;
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

async function expectUnknown(kind) {
  scenario = kind;
  const beforeCalls = firstCalls;
  let thrown;
  try {
    await runAction({}, 'image', { prompt: 'do not duplicate: ' + kind });
  } catch (error) {
    thrown = error;
  }
  assert(thrown && thrown.taskId && /受理状态未知/.test(thrown.message), kind + ' 以受理未知错误返回 Task ID', thrown && { message: thrown.message, taskId: thrown.taskId });
  assert(writeAhead && firstCalls === beforeCalls + 1 && secondCalls === 0, kind + ' 时禁止调用下一候选', { writeAhead, firstCalls, secondCalls });
  const task = tasks.get(thrown.taskId);
  assert(task.attempts.length === 1 && task.acceptance === 'unknown' && task.outcome === 'unknown', kind + ' 保留未知事实而非失败', task);
  assert(task.phase === 'terminal' && task.status === 'running', kind + ' 的兼容状态不伪造确定终态', task);
  return task;
}

try {
  const serverTask = await expectUnknown('server');
  assert(serverTask.lastError.httpStatus === 500 && serverTask.lastError.category === 'provider', '500 分类为供应商错误', serverTask.lastError);
  const networkTask = await expectUnknown('network');
  assert(networkTask.lastError.category === 'network', '原生 fetch 失败分类为网络错误', networkTask.lastError);
  const missingTask = await expectUnknown('missing-id');
  assert(missingTask.lastError.category === 'protocol', '200 缺 task_id 分类为协议错误', missingTask.lastError);
  const registry = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8');
  assert(!registry.includes('ambiguous-secret') && !registry.includes('unused-secret'), '未知错误记录不泄露 API Key');
} finally {
  tasks.stopWatchAll();
  global.fetch = originalFetch;
}

console.log('ALL OK —— DashScope 500、网络失败与缺 task_id 均停止 failover 且保留证据');
