import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-video-task-unknown');
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
  name: 'video-ambiguous', apiKey: 'video-first-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'wan2.2-t2v-flash', capabilities: ['video-gen'] }]
});
const second = config.upsert({
  name: 'video-must-not-run', apiKey: 'video-second-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'wan2.2-t2v-flash', capabilities: ['video-gen'] }]
});
config.setAssignmentOrder('video-gen', [
  models.modelRef(first.id, 'wan2.2-t2v-flash'),
  models.modelRef(second.id, 'wan2.2-t2v-flash')
]);

const originalFetch = global.fetch;
let firstCalls = 0;
let secondCalls = 0;
let writeAhead = false;
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.includes('/video-synthesis')) throw new Error('unexpected fetch: ' + url);
  const disk = JSON.parse(fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8'));
  const current = disk.tasks.at(-1)?.attempts?.at(-1);
  writeAhead = current?.acceptance === 'none' && current?.stage === 'submit';
  const auth = init.headers && init.headers.Authorization;
  if (auth === 'Bearer video-first-secret') {
    firstCalls++;
    return new Response(JSON.stringify({ code: 'InternalError', message: 'response uncertain' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (auth === 'Bearer video-second-secret') secondCalls++;
  return new Response(JSON.stringify({ output: { task_id: 'must-not-exist' } }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};

try {
  let thrown;
  try {
    await runAction({}, 'video', { prompt: 'single billed intent' });
  } catch (error) {
    thrown = error;
  }
  assert(thrown && thrown.taskId && /受理状态未知/.test(thrown.message), '视频 500 返回受理未知与 Task ID', thrown && thrown.message);
  assert(writeAhead && firstCalls === 1 && secondCalls === 0, '视频 500 后禁止自动调用第二供应商', { writeAhead, firstCalls, secondCalls });
  const task = tasks.get(thrown.taskId);
  assert(tasks.all().length === 1 && task.attempts.length === 1, '未知受理只有一个 Task/Attempt', task);
  assert(task.acceptance === 'unknown' && task.outcome === 'unknown' && task.status === 'running', '视频未知事实不伪装为失败', task);
  assert(task.attempts[0].error.httpStatus === 500 && task.attempts[0].stage === 'terminal', 'Attempt 保存脱敏 500 证据', task.attempts[0]);
  const registry = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8');
  assert(!registry.includes('video-first-secret') && !registry.includes('video-second-secret'), '视频任务不持久化 API Key');
} finally {
  tasks.stopWatchAll();
  global.fetch = originalFetch;
}

console.log('ALL OK —— 视频提交 500 保留受理未知且零重复提交');
