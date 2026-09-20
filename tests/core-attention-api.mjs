/**
 * 注意力处置 API 验收：POST /iris/api/core/task/:id/(acknowledge|restore|hide|unhide)。
 * 运行：node tests/core-attention-api.mjs
 *
 * 关键：四个动作都是 Host 偏好——任务存在即可；零 Provider 调用、零 Core 写入
 * （记录字节不变）；幂等（重复同动作 200 且偏好不变）；坏 ID 400 / 未知 404 /
 * 全程无路径无 Key。
 */
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

const { root, cleanup } = useTempDshHome('iris-core-attention-api');
const config = await import('../lib/config.js');
const { useTempDshHomeGuard } = {};
void useTempDshHomeGuard;
const { upsert } = config;
const { createCoreRuntime } = await import('../lib/core-runtime.js');
const { createCoreTask } = await import('../lib/core-tasks.js');
const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const { createFakeLifecycleProvider, FAKE_PNG } = await import('./fixtures/fake-lifecycle-provider.mjs');
const { createProviderTaskRunner } = await import('../lib/provider-task-runner.js');
const { serveApi } = await import('../lib/api.js');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

function apiResponse() {
  return {
    headersSent: false, destroyed: false, writableEnded: false, status: 0, body: '',
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = body === undefined ? '' : String(body); this.writableEnded = true; }
  };
}

async function postAction(action, taskId) {
  const res = apiResponse();
  serveApi({ method: 'POST', url: '/iris/api/core/task/' + taskId + '/' + action, on() { return this; } }, res);
  for (let i = 0; i < 200 && !res.writableEnded; i++) await new Promise((resolve) => setImmediate(resolve));
  assert(res.writableEnded, action + ' 路由必须结束响应', res.status);
  let json = null;
  try { json = JSON.parse(res.body); } catch (_) { /* 下面统一断言 */ }
  return { status: res.status, body: res.body, json };
}

function assertSafeBody(body, label) {
  assert(!String(body).includes(root) && !String(body).includes('providerId')
      && !String(body).includes('providerBinding'),
    label + ' 响应不得携带绝对路径或供应商身份', body);
}

/** 用 FakeProvider FakeProvider 生成一个终态失败任务（attention 状态）；全程零网络。 */
async function seedFailedTask(fake) {
  const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'writer' });
  runtime.start();
  try {
    const result = await createProviderTaskRunner(runtime).submit({
      capability: 'image',
      candidates: [{ adapter: fake.adapter, model: 'attention-fake::image-v0' }]
    });
    assert(result.task.phase === 'terminal' && result.task.outcome === 'failed',
      '前置：任务必须终态失败', result.task);
    return result.taskId;
  } finally {
    await runtime.dispose();
  }
}

const fake = createFakeLifecycleProvider({
  id: 'attention-fake',
  submitSteps: [{ kind: 'not_accepted', error: 'fixture rejected' }, { kind: 'not_accepted', error: 'fixture rejected again' }]
});
const callsOf = () => [fake.calls.submit.length, fake.calls.poll.length, fake.calls.cancel.length, fake.calls.download.length].join(':');
const prefFile = () => path.join(config.irisHome(), 'core-attention.json');

try {
  const taskId = await seedFailedTask(fake);
  const secondTaskId = await seedFailedTask(fake);
  assert(callsOf() === '2:0:0:0', '两个 fixture 任务各一次 submit', fake.calls);
  const taskFile = path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks', taskId + '.json');
  const taskBytes = () => fs.readFileSync(taskFile, 'utf8');
  const secondFile = path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks', secondTaskId + '.json');
  const secondBytes = () => fs.readFileSync(secondFile, 'utf8');
  const beforeTask = taskBytes();
  const beforeSecond = secondBytes();

  /* 门：坏 ID 400 / 未知 404；零调用零写入 */
  const badShape = await postAction('acknowledge', 'not-a-task-id');
  assert(badShape.status === 400 && badShape.json?.error?.code === 'IRIS_DSH_TASK_INVALID'
      && callsOf() === '2:0:0:0',
    '坏 ID 必须 400 且零调用', badShape);
  assertSafeBody(badShape.body, '坏 ID');
  const missing = await postAction('hide', 'task_' + '0'.repeat(24));
  assert(missing.status === 404 && missing.json?.error?.code === 'IRIS_TASK_NOT_FOUND'
      && callsOf() === '2:0:0:0',
    '未知 Task 必须 404 且零调用', missing);
  assertSafeBody(missing.body, '未知 Task');
  const unknownAction = await postAction('obliterate', taskId);
  assert(unknownAction.status !== 200, '未知动作不得成功', unknownAction.status);

  /* 受理：200、command 标注、行 DTO 有 disposition；重复受理幂等 */
  const acked = await postAction('acknowledge', taskId);
  assert(acked.status === 200 && acked.json?.ok === true
      && acked.json.command === 'attention.acknowledge'
      && acked.json.task?.id === taskId
      && acked.json.task?.disposition === 'acknowledged'
      && acked.json.task?.suppressed === false,
    '受理必须返回装饰后的投影行', acked.json);
  assertSafeBody(JSON.stringify(acked.json), '受理响应');
  const ackBytes = taskBytes();
  assert(ackBytes === beforeTask && callsOf() === '2:0:0:0',
    '受理不得写 Core 记录、不得产生 Provider 调用');
  const ackAgain = await postAction('acknowledge', taskId);
  assert(ackAgain.status === 200 && ackAgain.json.task.disposition === 'acknowledged'
      && taskBytes() === ackBytes
      && fs.readFileSync(prefFile(), 'utf8') === fs.readFileSync(prefFile(), 'utf8'),
    '重复受理必须幂等返回 200', ackAgain.json);
  const prefBytesAfterAck = fs.readFileSync(prefFile(), 'utf8');
  await postAction('acknowledge', taskId);
  assert(fs.readFileSync(prefFile(), 'utf8') === prefBytesAfterAck,
    '第三次受理连偏好文件都不得变化');

  /* 隐藏：hidden 覆盖 acknowledged；unhide 回到 acknowledged；restore 清空 */
  const hidden = await postAction('hide', taskId);
  assert(hidden.status === 200 && hidden.json.task.disposition === 'hidden'
      && taskBytes() === ackBytes && secondBytes() === beforeSecond,
    '隐藏必须零 Core 写入', hidden.json);
  const unhide = await postAction('unhide', taskId);
  assert(unhide.status === 200 && unhide.json.task.disposition === 'acknowledged',
    'unhide 必须回到 acknowledged（hide 撤销、受理保留）', unhide.json);
  const restored = await postAction('restore', taskId);
  assert(restored.status === 200 && restored.json.task.disposition === null
      && taskBytes() === ackBytes,
    'restore 必须清空受理且零 Core 写入', restored.json);
  assert(!fs.existsSync(prefFile())
      || !JSON.parse(fs.readFileSync(prefFile(), 'utf8')).entries?.[taskId],
    'restore 后偏好条目必须移除');

  /* 第二个任务不受影响；隐藏第二个后第一个仍恢复原状 */
  await postAction('hide', secondTaskId);
  assert(secondBytes() === beforeSecond && taskBytes() === ackBytes,
    '处置第二个任务不得影响第一个任务记录');
  assert(JSON.parse(fs.readFileSync(prefFile(), 'utf8')).entries[secondTaskId].hiddenAt,
    '第二个任务的隐藏偏好独立存在');

  console.log('ALL OK —— 注意力处置 API：门矩阵、零 Provider/零 Core、幂等、响应脱敏');
} finally {
  cleanup();
}
