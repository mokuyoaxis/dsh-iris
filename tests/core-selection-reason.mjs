import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandService } from '../lib/command-service.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { beginCoreAttempt, createCoreTask, inspectCoreTask } from '../lib/core-tasks.js';
import { imageCandidatesFromCatalog } from '../lib/provider-catalog.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-selection-reason-'));
const runtime = createCoreRuntime({ dataRoot: root, mode: 'writer' });
runtime.start();

try {
  const catalog = {
    providers: [
      {
        id: 'assigned-fake', auth: 'none', enabled: true,
        baseUrl: 'http://assigned.invalid/v1', mediaProtocol: 'openai-images',
        models: [{ id: 'image-v0', capabilities: ['image-gen'] }]
      },
      {
        id: 'pool-fake', auth: 'none', enabled: true,
        baseUrl: 'http://pool.invalid/v1', mediaProtocol: 'openai-images',
        models: [{ id: 'image-v0', capabilities: ['image-gen'] }]
      }
    ],
    assignments: { 'image-gen': ['assigned-fake::image-v0'] }
  };
  const routes = imageCandidatesFromCatalog(catalog);
  assert.deepEqual(routes.map((route) => [route.modelRef, route.selectionReason]), [
    ['assigned-fake::image-v0', 'assignment'],
    ['pool-fake::image-v0', 'pool']
  ], '候选链必须在构造时区分 assignment 与池序补齐');
  const explicitRoutes = imageCandidatesFromCatalog(catalog, 'pool-fake::image-v0');
  assert.deepEqual(explicitRoutes.map((route) => [route.modelRef, route.selectionReason]), [
    ['pool-fake::image-v0', 'explicit']
  ], '显式 model_ref 必须覆盖同一模型的配置来源');

  const rejected = createFakeLifecycleProvider({
    id: 'assigned-fake',
    submitSteps: [{
      kind: 'not_accepted',
      error: { category: 'quota', acceptance: 'not_accepted' }
    }]
  });
  const accepted = createFakeLifecycleProvider({
    id: 'pool-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-pool' }]
  });
  const runner = createProviderTaskRunner(runtime);
  const failover = await runner.submit({
    capability: 'image',
    candidates: [
      {
        adapter: rejected.adapter,
        model: routes[0].modelRef,
        selectionReason: routes[0].selectionReason
      },
      {
        adapter: accepted.adapter,
        model: routes[1].modelRef,
        selectionReason: routes[1].selectionReason
      }
    ]
  });
  assert.deepEqual(
    failover.task.attempts.map((attempt) => [attempt.ordinal, attempt.selectionReason]),
    [[1, 'assignment'], [2, 'pool']],
    'failover 的每个 Attempt 必须保存各自真实来源，ordinal 独立表达降级顺序'
  );

  const explicitFake = createFakeLifecycleProvider({
    id: 'explicit-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-explicit' }]
  });
  const explicit = await runner.submit({
    capability: 'image',
    candidates: [{
      adapter: explicitFake.adapter,
      model: 'explicit-fake::image-v0',
      selectionReason: 'explicit'
    }]
  });
  const inspected = await createCommandService(runtime).execute('task.inspect', {
    task_id: explicit.taskId
  });
  assert.equal(inspected.task.attempts[0].selectionReason, 'explicit',
    'task.inspect 必须返回写前持久化的选择原因，而非读取当前配置重算');

  let invalidInput;
  await runtime.run('execute', ({ dataRoot }) => {
    const task = createCoreTask(dataRoot, { capability: 'image' });
    try {
      beginCoreAttempt(dataRoot, task.id, {
        providerId: 'invalid-fake',
        model: 'invalid-fake::image-v0',
        selectionReason: 'dynamic'
      });
    } catch (error) {
      invalidInput = error;
    }
  });
  assert.equal(invalidInput?.code, 'IRIS_ATTEMPT_INPUT_INVALID',
    '未知选择原因必须在写入前稳定拒绝');

  const file = path.join(root, 'task-store', 'v0', 'tasks', explicit.taskId + '.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const legacy = structuredClone(original);
  delete legacy.attempts[0].selectionReason;
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2) + '\n');
  assert.equal(inspectCoreTask(root, explicit.taskId).attempts[0].selectionReason, undefined,
    '旧记录缺失可选 selectionReason 时必须继续可读');

  legacy.attempts[0].selectionReason = 'current-config-guess';
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2) + '\n');
  assert.throws(
    () => inspectCoreTask(root, explicit.taskId),
    (error) => error?.code === 'IRIS_TASK_INVALID',
    '损坏或越界的持久化选择原因必须被拒绝'
  );

  console.log('ALL OK —— Attempt 选择原因：explicit/assignment/pool 写前事实、failover、inspect 与旧记录兼容');
} finally {
  await runtime.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
