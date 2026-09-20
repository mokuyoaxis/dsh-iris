import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { inspectCoreTask } from '../lib/core-tasks.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createFakeLifecycleProvider, FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : ': ' + JSON.stringify(extra)));
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-stage-timestamps-'));
const runtime = createCoreRuntime({ dataRoot: root, mode: 'writer' });
runtime.start();

try {
  const fake = createFakeLifecycleProvider({
    id: 'timing-fake',
    submitSteps: [{ kind: 'accepted', remoteTaskId: 'remote-timing' }],
    pollSteps: [{
      kind: 'succeeded',
      artifacts: [{ kind: 'remote-url', url: 'https://fixture.invalid/timing.png', mediaType: 'image/png' }]
    }],
    downloadSteps: [FAKE_PNG]
  });
  const runner = createProviderTaskRunner(runtime);
  const submitted = await runner.submit({
    capability: 'image',
    candidates: [{ adapter: fake.adapter, model: 'timing-fake::image-v0' }]
  });
  const completed = await runner.observe(submitted.taskId, fake.adapter);
  const stages = completed.attempts[0].stageTimestamps;
  const names = [
    'queuedAt', 'submitStartedAt', 'submittedAt', 'remoteCompletedAt',
    'downloadStartedAt', 'downloadedAt', 'localProcessedAt'
  ];
  assert(Object.keys(stages).join(',') === names.join(','),
    '成功交付必须记录完整且稳定排序的阶段时间戳', stages);
  const millis = names.map((name) => Date.parse(stages[name]));
  assert(millis.every(Number.isFinite) && millis.every((value, index) => index === 0 || value >= millis[index - 1]),
    '各阶段时间戳必须单调不减', stages);
  assert(stages.queuedAt === completed.createdAt,
    '首个 Attempt 的排队起点必须复用 Task 创建事实', stages);

  const file = path.join(root, 'task-store', 'v0', 'tasks', submitted.taskId + '.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const legacy = structuredClone(original);
  delete legacy.attempts[0].stageTimestamps;
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2) + '\n');
  assert(inspectCoreTask(root, submitted.taskId).attempts[0].stageTimestamps === undefined,
    '旧记录缺少可选阶段时间戳时仍必须可读');

  const invalid = structuredClone(original);
  invalid.attempts[0].stageTimestamps.submittedAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(invalid, null, 2) + '\n');
  let error;
  try { inspectCoreTask(root, submitted.taskId); } catch (caught) { error = caught; }
  assert(error?.code === 'IRIS_TASK_INVALID', '逆序阶段时间戳必须被稳定拒绝', error?.code);

  console.log('ALL OK —— Attempt 阶段时间戳完整、单调且兼容旧记录');
} finally {
  await runtime.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
