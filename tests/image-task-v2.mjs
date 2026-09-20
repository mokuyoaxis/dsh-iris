import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-image-task-v2');
const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { runAction } = await import('../lib/actions.js');
const { coreSnapshotForDsh, dshCoreDataRoot, inspectProviderTaskForDsh, readCoreArtifactMediaForDsh, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
function coreTaskRecords() {
  const directory = path.join(dshCoreDataRoot(), 'task-store/v0/tasks');
  return fs.readdirSync(directory).map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}


const first = config.upsert({
  name: 'reject-first', apiKey: 'first-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }]
});
const second = config.upsert({
  name: 'accept-second', apiKey: 'second-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'qwen-image-plus', capabilities: ['image-gen'] }]
});
config.setAssignmentOrder('image-gen', [
  models.modelRef(first.id, 'wan2.2-t2i-flash'),
  models.modelRef(second.id, 'qwen-image-plus')
]);

const originalFetch = global.fetch;
let submitCalls = 0;
let sawWriteAhead = 0;
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes('/text2image/image-synthesis')) {
    submitCalls++;
    const record = coreTaskRecords().find((task) => task.phase === 'submitting');
    const attempt = record && record.attempts && record.attempts.at(-1);
    if (attempt && attempt.acceptance === 'none' && attempt.stage === 'submitting') sawWriteAhead++;
    const auth = init.headers && init.headers.Authorization;
    if (auth === 'Bearer first-secret') {
      return new Response(JSON.stringify({ code: 'Throttling', message: 'rate limited' }), {
        status: 429, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (auth === 'Bearer second-secret') {
      return new Response(JSON.stringify({ output: { task_id: 'remote-accepted' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  if (url.includes('/tasks/remote-accepted')) {
    return new Response(JSON.stringify({
      output: { task_status: 'SUCCEEDED', results: [{ url: 'https://result.invalid/v2.png' }] }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://result.invalid/v2.png') {
    return new Response(Buffer.from('fake-png-v2'), { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  throw new Error('unexpected fetch: ' + url);
};

try {
  const action = await runAction({}, 'image', { prompt: 'safe failover' });
  const submitted = await inspectProviderTaskForDsh(action.taskId);
  assert(submitCalls === 2 && sawWriteAhead === 2, '每次 HTTP 请求前均已有持久化 Attempt', { submitCalls, sawWriteAhead });
  const snapshot = await coreSnapshotForDsh();
  assert(snapshot.tasks.total === 1 && tasks.all().length === 0 && submitted.attempts.length === 2, '一次用户请求只创建一个 Core Task，零 legacy 双写', submitted);
  assert(submitted.attempts[0].acceptance === 'not_accepted' && submitted.attempts[0].error.httpStatus === 429, '429 明确拒绝允许下一候选', submitted.attempts[0]);
  assert(submitted.attempts[1].acceptance === 'accepted' && submitted.remoteTaskId === 'remote-accepted', '第二候选受理事实已落盘', submitted);
  assert(action.providerId === second.id && action.remoteTaskId === 'remote-accepted', '动作返回实际受理供应商');

  await sleep(900);
  const finished = await inspectProviderTaskForDsh(action.taskId);
  assert(finished.outcome === 'succeeded' && finished.deliveryState === 'ready' && finished.status === 'succeeded', '轮询与产物交付按独立事实收口', finished);
  const media = await readCoreArtifactMediaForDsh(finished.artifactIds[0]);
  assert(media.bytes.toString() === 'fake-png-v2' && !fs.existsSync(path.join(config.irisHome(), 'outputs')), '异步图片只落盘 Core Artifact');
  const registry = JSON.stringify(coreTaskRecords());
  assert(!registry.includes('first-secret') && !registry.includes('second-secret'), '任务注册表不持久化 API Key');
} finally {
  tasks.stopWatchAll();
  stopProviderTaskWatchesForDsh();
  global.fetch = originalFetch;
}

console.log('ALL OK —— DashScope 异步图片预写、明确拒绝 failover 与成功交付通过');
