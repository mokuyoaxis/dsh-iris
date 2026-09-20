/**
 * /iris/api/core/snapshot 用户侧只读投影门禁：
 * userTasks 安全 DTO、刷新零写入零网络、损坏记录/媒体缺失局部降级。
 * 运行：node tests/core-snapshot-user-tasks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { listCoreTasks, createCoreTask } from '../lib/core-tasks.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root, cleanup } = useTempDshHome('iris-core-snapshot-user-tasks');
const {
  coreSnapshotForDsh,
  dshCoreDataRoot,
  observeProviderTaskForDsh,
  submitProviderTaskForDsh
} = await import('../lib/dsh-core-adapter.js');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

function treeBytes(directory) {
  const out = new Map();
  if (!fs.existsSync(directory)) return out;
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (fs.statSync(file).isDirectory()) {
      for (const [key, value] of treeBytes(file)) out.set(path.join(name, key), value);
    } else {
      out.set(name, fs.readFileSync(file, 'utf8'));
    }
  }
  return out;
}

function assertTreeBytes(directory, before, label) {
  const after = treeBytes(directory);
  assert(after.size === before.size, `${label}：文件数量变化`, { before: [...before.keys()], after: [...after.keys()] });
  for (const [name, bytes] of before) {
    assert(after.get(name) === bytes, `${label}：${name} 字节发生变化`);
  }
}

function apiResponder() {
  return {
    headersSent: false, destroyed: false, writableEnded: false, status: 0, body: '',
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = body === undefined ? '' : String(body); this.writableEnded = true; }
  };
}

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (...args) => { fetchCalls += 1; return originalFetch(...args); };

try {
  /* ---------- Core 根缺失：available:false，零写入，插件加载路径不抛 ---------- */
  const empty = await coreSnapshotForDsh({ limit: 200 });
  assert(empty.available === false && empty.degraded === false && empty.droppedTasks === 0
      && empty.userTasks.length === 0 && !fs.existsSync(dshCoreDataRoot()),
    'Core 根缺失必须返回空快照且零写入', empty);

  /* ---------- 生成一条已完成任务 + 一条排队任务 ---------- */
  const fake = createFakeLifecycleProvider({
    id: 'snapshot-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-snapshot' }],
    pollSteps: [{
      kind: 'succeeded',
      artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/snapshot.png', mediaType: 'image/png' }]
    }]
  });
  const submitted = await submitProviderTaskForDsh({
    capability: 'image',
    candidates: [{ adapter: fake.adapter, model: 'snapshot-fake::image-v0' }],
    providerInput: { prompt: 'user projection snapshot' }
  });
  const completed = await observeProviderTaskForDsh({ taskId: submitted.taskId, adapter: fake.adapter });
  assert(completed.outcome === 'succeeded' && completed.deliveryState === 'ready', 'fixture 任务必须先完成交付', completed);
  const queued = createCoreTask(dshCoreDataRoot(), { capability: 'image' });
  const callsBefore = {
    submit: fake.calls.submit.length, poll: fake.calls.poll.length, download: fake.calls.download.length
  };

  /* ---------- userTasks：五类安全 DTO，顺序与 tasks.recent 一致 ---------- */
  const snapshot = await coreSnapshotForDsh({ limit: 200 });
  assert(snapshot.available && snapshot.readOnly && snapshot.degraded === false && snapshot.droppedTasks === 0,
    '健康快照不得误报降级', snapshot.degraded);
  assert(snapshot.userTasks.length === snapshot.tasks.recent.length
      && snapshot.userTasks.every((row, index) => row.id === snapshot.tasks.recent[index].id),
    'userTasks 必须逐条对应 tasks.recent 的顺序');
  const doneRow = snapshot.userTasks.find((row) => row.id === completed.id);
  const liveRow = snapshot.userTasks.find((row) => row.id === queued.id);
  assert(doneRow && doneRow.userState === 'succeeded' && doneRow.label === '已完成，作品可用'
      && doneRow.mediaReady === true && doneRow.model === 'image-v0',
    '已完成任务的投影必须是 succeeded 且携带去前缀模型与 mediaReady', doneRow);
  assert(liveRow && liveRow.userState === 'running' && liveRow.label === '运行中'
      && liveRow.mediaReady === false,
    '排队任务的投影必须是 running', liveRow);
  const dtoText = JSON.stringify(snapshot.userTasks);
  for (const leak of ['providerId', 'providerBinding', 'sha256:', 'remoteTaskId', 'remote-snapshot',
    'safeMessage', 'lastError', dshCoreDataRoot()]) {
    assert(!dtoText.includes(leak), 'userTasks 不得含供应商身份/binding/错误/路径：' + leak);
  }

  /* ---------- 只读投影：刷新前后 Task/Index/Manifest 字节一致，Provider 调用计数不变、零网络 ---------- */
  const filesBefore = {
    tasks: treeBytes(path.join(dshCoreDataRoot(), 'task-store')),
    artifacts: treeBytes(path.join(dshCoreDataRoot(), 'artifact-store'))
  };
  const fetchBefore = fetchCalls;
  const { serveApi } = await import('../lib/api.js');
  await coreSnapshotForDsh({ limit: 200 });
  await coreSnapshotForDsh({ limit: 12 });
  const response = apiResponder();
  await serveApi({ method: 'GET', url: '/iris/api/core/snapshot?limit=200' }, response);
  assert(response.status === 200, 'snapshot API 必须 200', response.status);
  const apiSnapshot = JSON.parse(response.body);
  assert(apiSnapshot.userTasks.length === snapshot.userTasks.length
      && apiSnapshot.userTasks.find((row) => row.id === completed.id).model === 'image-v0',
    'API 透传的 userTasks 必须与直接快照一致');
  assert(fetchCalls === fetchBefore, '只读投影不得触发任何网络调用', { fetchCalls, fetchBefore });
  assert(fake.calls.submit.length === callsBefore.submit
      && fake.calls.poll.length === callsBefore.poll
      && fake.calls.download.length === callsBefore.download,
    'refresh/open/close 不得变成 poll/submit/download（Provider 调用计数增量必须为 0）');
  assertTreeBytes(path.join(dshCoreDataRoot(), 'task-store'), filesBefore.tasks, '快照读取');
  assertTreeBytes(path.join(dshCoreDataRoot(), 'artifact-store'), filesBefore.artifacts, '快照读取');

  /* ---------- 单条记录损坏：默认严格，投影局部降级 ---------- */
  const corruptId = 'task_' + 'f'.repeat(24);
  fs.writeFileSync(path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks', corruptId + '.json'), '{broken json', { mode: 0o600 });
  let strictError;
  try { listCoreTasks(dshCoreDataRoot(), { limit: 200 }); } catch (error) { strictError = error; }
  assert(strictError?.code === 'IRIS_TASK_INVALID', '默认 listCoreTasks 必须保持严格（损坏即失败）', strictError?.code);
  const degraded = await coreSnapshotForDsh({ limit: 200 });
  assert(degraded.available && degraded.degraded === true && degraded.droppedTasks === 1,
    '损坏记录必须触发 degraded + droppedTasks 局部降级', { degraded: degraded.degraded, dropped: degraded.droppedTasks });
  assert(degraded.userTasks.length === snapshot.userTasks.length
      && !degraded.userTasks.some((row) => row.id === corruptId)
      && degraded.userTasks.some((row) => row.id === completed.id),
    '损坏记录被跳过，其余条目照常投影');
  const degradedResponse = apiResponder();
  await serveApi({ method: 'GET', url: '/iris/api/core/snapshot?limit=200' }, degradedResponse);
  assert(degradedResponse.status === 200 && JSON.parse(degradedResponse.body).degraded === true,
    '记录损坏时 snapshot API 仍须 200 返回局部降级快照');

  /* ---------- 媒体文件丢失：Artifact 列表整体降级，不拖垮任务投影 ---------- */
  const objects = path.join(dshCoreDataRoot(), 'artifact-store', 'v0', 'objects');
  const mediaFile = fs.readdirSync(objects).find((name) => name.startsWith(completed.artifactIds[0]));
  assert(mediaFile, 'fixture 必须已落盘媒体对象', fs.readdirSync(objects));
  fs.rmSync(path.join(objects, mediaFile));
  const mediaDegraded = await coreSnapshotForDsh({ limit: 200 });
  assert(mediaDegraded.available && mediaDegraded.degraded === true
      && mediaDegraded.artifacts.total === 0 && mediaDegraded.artifacts.recent.length === 0
      && mediaDegraded.userTasks.some((row) => row.id === completed.id),
    '媒体丢失只能降级 Artifact 列表，任务投影必须照常');
  const missingMediaRow = mediaDegraded.userTasks.find((row) => row.id === completed.id);
  assert(missingMediaRow.mediaReady === false, '媒体丢失后不得继续宣称作品可用', missingMediaRow);
  const mediaResponse = apiResponder();
  await serveApi({ method: 'GET', url: '/iris/api/core/snapshot?limit=200' }, mediaResponse);
  assert(mediaResponse.status === 200, '媒体丢失时 snapshot API 仍须 200');
  assert(!mediaResponse.body.includes(dshCoreDataRoot()), '任何降级分支都不得泄漏数据根绝对路径');

  console.log('ALL OK —— snapshot 用户投影：安全 DTO、零写入零网络、损坏记录与媒体缺失局部降级全部通过');
} finally {
  globalThis.fetch = originalFetch;
  cleanup();
}
