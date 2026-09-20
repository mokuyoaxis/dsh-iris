import fs from 'node:fs';
import path from 'node:path';
import { createDshHostAdapter } from '../lib/dsh-host-adapter.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root, cleanup } = useTempDshHome('iris-dsh-provider-projection-v0');
const {
  coreSnapshotForDsh,
  dshCoreDataRoot,
  inspectProviderTaskForDsh,
  observeProviderTaskForDsh,
  projectCoreTaskForDsh,
  submitProviderTaskForDsh
} = await import('../lib/dsh-core-adapter.js');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};
const success = () => ({
  kind: 'succeeded',
  artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/generated.png', mediaType: 'image/png' }]
});

try {
  const emptySnapshot = await coreSnapshotForDsh();
  assert(emptySnapshot.available === false && emptySnapshot.tasks.total === 0
      && emptySnapshot.artifacts.total === 0 && !fs.existsSync(dshCoreDataRoot()),
    '未初始化 profile 的工作台 Core 快照必须零写入', emptySnapshot);
  const unsafeRoot = path.join(root, 'unsafe-task-list');
  fs.mkdirSync(unsafeRoot);
  fs.symlinkSync(root, path.join(unsafeRoot, 'task-store'), process.platform === 'win32' ? 'junction' : 'dir');
  let unsafeTasks;
  try { listCoreTasks(unsafeRoot); } catch (error) { unsafeTasks = error; }
  assert(unsafeTasks?.code === 'IRIS_TASK_STORE_INVALID',
    'reader list 必须拒绝软链接 Task Store 祖先', unsafeTasks?.code);
  const saved = [];
  const ctx = {
    get(name) {
      if (name !== 'attachments') return undefined;
      return {
        async saveImage(input) {
          saved.push(input);
          return {
            attachmentId: 'host-image-' + saved.length,
            mediaType: input.mediaType,
            name: input.name
          };
        },
        async readImage() { throw new Error('本测试不读取宿主 attachment'); }
      };
    }
  };
  const host = createDshHostAdapter(ctx, { version: 'fixture-v0' });
  const fake = createFakeLifecycleProvider({
    id: 'dsh-projection-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-dsh-projection' }],
    pollSteps: [success()]
  });

  const submitted = await submitProviderTaskForDsh({
    capability: 'image',
    candidates: [{ adapter: fake.adapter, model: 'dsh-projection-fake::image-v0' }],
    providerInput: { prompt: 'zero-network DSH projection' }
  });
  assert(submitted.task.acceptance === 'accepted' && submitted.task.attempts.length === 1,
    'DSH 提交必须复用 Core Task/Attempt 写前事实', submitted.task);
  assert(!fs.existsSync(path.join(dshCoreDataRoot(), '.iris-runtime-writer-v0')),
    'submit 完成后必须释放短 writer 租约');

  const completed = await observeProviderTaskForDsh({
    taskId: submitted.taskId,
    adapter: fake.adapter
  });
  assert(completed.outcome === 'succeeded' && completed.deliveryState === 'ready'
      && completed.artifactIds.length === 1,
    '单步 observe 必须完成 FakeProvider download → Core Artifact', completed);
  assert(fake.calls.submit.length === 1 && fake.calls.poll.length === 1 && fake.calls.download.length === 1,
    '生成闭环只能各调用一次 submit/poll/download', fake.calls);

  const inspected = await inspectProviderTaskForDsh(submitted.taskId);
  assert(inspected.id === completed.id && inspected.revision === completed.revision,
    'DSH reader 必须读取同一 Core Task 事实', inspected);
  const taskFile = path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks', submitted.taskId + '.json');
  const indexFile = path.join(dshCoreDataRoot(), 'artifact-store', 'v0', 'index.json');
  const taskBeforeProjection = fs.readFileSync(taskFile, 'utf8');
  const indexBeforeProjection = fs.readFileSync(indexFile, 'utf8');

  const projected = await projectCoreTaskForDsh(host, submitted.taskId);
  assert(saved.length === 1 && saved[0].data instanceof Uint8Array && saved[0].mediaType === 'image/png',
    'Core Artifact 必须通过规范化 attachments 端口投影', saved[0]);
  assert(projected.blocks.length === 2 && projected.blocks[0].type === 'text'
      && projected.blocks[0].text.includes('\nartifact: ')
      && projected.blocks[1].attachment.attachmentId === 'host-image-1',
    '投影必须形成稳定的 DSH text/image blocks', projected.blocks);
  assert(fs.readFileSync(taskFile, 'utf8') === taskBeforeProjection
      && fs.readFileSync(indexFile, 'utf8') === indexBeforeProjection,
    '只读展示不得修改 Core Task 或 Artifact Index');
  assert(!taskBeforeProjection.includes('host-image-1') && !indexBeforeProjection.includes('host-image-1'),
    'DSH attachment id 不得反向持久化进 Core');
  const snapshot = await coreSnapshotForDsh();
  assert(snapshot.available && snapshot.readOnly && snapshot.tasks.total === 1
      && snapshot.tasks.recent[0].id === submitted.taskId
      && snapshot.artifacts.total === 1
      && snapshot.artifacts.recent[0].id === completed.artifactIds[0],
    '工作台快照必须只读列出 Core Task/Artifact 元数据', snapshot);
  assert(fs.readFileSync(taskFile, 'utf8') === taskBeforeProjection
      && fs.readFileSync(indexFile, 'utf8') === indexBeforeProjection,
    '读取工作台快照不得修改 Core 事实');

  const { serveApi } = await import('../lib/api.js');
  const response = {
    headersSent: false, destroyed: false, writableEnded: false, status: 0, body: '',
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = body === undefined ? '' : String(body); this.writableEnded = true; }
  };
  await serveApi({ method: 'GET', url: '/iris/api/core/snapshot' }, response);
  const apiSnapshot = JSON.parse(response.body);
  assert(response.status === 200 && apiSnapshot.readOnly === true
      && apiSnapshot.tasks.recent[0].id === submitted.taskId
      && !response.body.includes(dshCoreDataRoot()),
    '工作台 API 必须返回无路径的 Core 只读快照', apiSnapshot);
  const clientSource = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert(clientSource.includes('function CoreRuntimePanel()')
      && clientSource.includes("fetch('/iris/api/core/snapshot?limit=200')")
      && clientSource.includes("'高级诊断'")
      && clientSource.includes("'Core 任务事实'")
      && clientSource.includes('不会重新提交、删除或修改既有任务')
      && clientSource.includes("'打开作品'"),
    '工作台必须把 Core 图片纳入作品区，并把 Task 明确为只读开发事实');

  await projectCoreTaskForDsh(host, submitted.taskId);
  assert(saved.length === 2 && fake.calls.submit.length === 1
      && fake.calls.poll.length === 1 && fake.calls.download.length === 1,
    '重复展示只能新建宿主投影，不得重复 Provider 生命周期', fake.calls);

  const pendingFake = createFakeLifecycleProvider({
    id: 'dsh-pending-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-pending' }]
  });
  const pending = await submitProviderTaskForDsh({
    capability: 'image',
    candidates: [{ adapter: pendingFake.adapter, model: 'dsh-pending-fake::image-v0' }]
  });
  let notReady;
  try { await projectCoreTaskForDsh(host, pending.taskId); } catch (error) { notReady = error; }
  assert(notReady?.code === 'IRIS_DSH_TASK_NOT_READY' && saved.length === 2,
    '尚未完成的 Task 不得伪造 DSH 产物', notReady?.code);

  const controller = new AbortController();
  controller.abort();
  let aborted;
  try {
    await submitProviderTaskForDsh({
      capability: 'image',
      candidates: [{ adapter: pendingFake.adapter, model: 'dsh-pending-fake::image-v0' }],
      signal: controller.signal
    });
  } catch (error) { aborted = error; }
  assert(aborted?.name === 'AbortError' && pendingFake.calls.submit.length === 1,
    '排队前取消不得创建 Task 或调用 Provider', aborted?.name);
  assert(!fs.existsSync(path.join(dshCoreDataRoot(), '.iris-runtime-writer-v0')),
    '阶段结束后不得遗留 writer 租约');

  const missingHost = createDshHostAdapter({}, { version: 'fixture-missing' });
  let missingPort;
  try { await projectCoreTaskForDsh(missingHost, submitted.taskId); } catch (error) { missingPort = error; }
  assert(missingPort?.code === 'IRIS_HOST_CAPABILITY_UNAVAILABLE',
    '缺 attachments 端口必须复用 Host 契约错误', missingPort?.code);

  const invalidHost = createDshHostAdapter({
    get(name) {
      if (name !== 'attachments') return undefined;
      return { saveImage: async () => ({}), readImage: async () => ({}) };
    }
  }, { version: 'fixture-invalid-attachment' });
  let invalidAttachment;
  try { await projectCoreTaskForDsh(invalidHost, submitted.taskId); } catch (error) { invalidAttachment = error; }
  assert(invalidAttachment?.code === 'IRIS_DSH_PROJECTION_FAILED'
      && fs.readFileSync(taskFile, 'utf8') === taskBeforeProjection,
    '无效宿主 attachment 必须失败且不改写 Core 事实', invalidAttachment?.code);

  console.log('ALL OK —— FakeProvider Task/Attempt/Artifact 经 DSH Host 只读投影，重复展示零重复生成');
} finally {
  cleanup();
}
