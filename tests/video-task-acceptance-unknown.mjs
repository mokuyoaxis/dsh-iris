/**
 * 视频受理未知边界（E 阶段：Core Task 版）。
 * 运行：node tests/video-task-acceptance-unknown.mjs
 *
 * 验证 t2v 视频提交收到 500（受理响应不确定）时：写前 Attempt 证据已在 Core
 * 持久化、受理未知停止候选链（零 failover）、不伪装失败、零 legacy 双写、
 * 记录不持久化 API Key。
 */
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
const { dshCoreDataRoot, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const { inspectCoreTask } = await import('../lib/core-tasks.js');

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

const taskStoreDir = () => path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks');
function coreRecords() {
  try {
    return fs.readdirSync(taskStoreDir()).map((name) => fs.readFileSync(path.join(taskStoreDir(), name), 'utf8'));
  } catch (_) {
    return [];
  }
}

const originalFetch = global.fetch;
let firstCalls = 0;
let secondCalls = 0;
let writeAhead = false;
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.includes('/video-synthesis')) throw new Error('unexpected fetch: ' + url);
  const records = coreRecords();
  const current = records.length ? JSON.parse(records[0]).attempts?.at(-1) : undefined;
  writeAhead = current?.acceptance === 'none' && current?.stage === 'submitting';
  const auth = init.headers && (init.headers.Authorization || init.headers.authorization);
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
  const legacyBefore = tasks.all().length;
  let thrown;
  try {
    await runAction({}, 'video', { prompt: 'single billed intent' });
  } catch (error) {
    thrown = error;
  }
  stopProviderTaskWatchesForDsh();
  assert(thrown && thrown.taskId && /受理状态未知/.test(thrown.message), '视频 500 返回受理未知与 Task ID', thrown && thrown.message);
  assert(/^task_[a-f0-9]{24}$/.test(thrown.taskId), '受理未知暴露的是 Core Task ID', thrown.taskId);
  assert(writeAhead && firstCalls === 1 && secondCalls === 0,
    'Core 写前 Attempt 证据必须在受理响应前落盘，且 500 后禁止调用第二供应商', { writeAhead, firstCalls, secondCalls });
  const task = inspectCoreTask(dshCoreDataRoot(), thrown.taskId);
  assert(task.attempts.length === 1 && task.capability === 'video', '未知受理只有一个 Core Task/Attempt', task);
  assert(task.acceptance === 'unknown' && task.outcome === 'unknown' && task.phase === 'terminal',
    '视频未知事实不伪装为失败：无远端 ID 时如实收口为终态未知', task);
  assert(task.attempts[0].error.httpStatus === 500, 'Attempt 保存脱敏 500 证据', task.attempts[0]);
  assert(tasks.all().length === legacyBefore, 'Core 视频受理未知零 legacy 双写', tasks.all().length);
  for (const record of coreRecords()) {
    assert(!record.includes('video-first-secret') && !record.includes('video-second-secret'),
      'Core 视频任务不持久化 API Key');
  }
} finally {
  stopProviderTaskWatchesForDsh();
  tasks.stopWatchAll();
  global.fetch = originalFetch;
}

console.log('ALL OK —— 视频提交 500 保留 Core 受理未知、写前证据且零重复提交零 legacy 双写');
