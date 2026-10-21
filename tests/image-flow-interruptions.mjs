import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { readDeliveryCache } from '../lib/core-delivery-cache.js';
import { listCoreArtifacts } from '../lib/core-artifacts.js';
import { readFlowRun } from '../lib/flow-store.js';
import { useTempDshHome } from './test-env.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';

if (process.platform === 'win32') {
  console.log('SKIP Image Flow POSIX SIGKILL 窗口；普通绑定/引用/CLI 测试仍执行');
} else {
  const { root } = useTempDshHome('iris-flow-crash');
  const childFile = fileURLToPath(new URL('./fixtures/image-flow-crash-child.mjs', import.meta.url));
  const stages = ['task-created', 'intent-claimed', 'attempt-written', 'request-sent', 'result-cached', 'artifact-object',
    'artifact-manifest', 'task-delivered', 'run-output', 'compare-object', 'compare-committed', 'run-comparison', 'async-accepted', 'async-cache'];
  for (const stage of stages) {
    const dataRoot = path.join(root, stage), fixture = imageFlowFixture(dataRoot);
    let app = createApplicationRuntime({ dataRoot, ...fixture });
    await app.execute('flow.init', {});
    const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
    const original = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'Crash-safe green rectangle' });
    await app.dispose();
    const crash = spawnSync(process.execPath, [childFile, stage, dataRoot, original.run.id], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
    assert.equal(crash.signal, 'SIGKILL', stage + ': ' + crash.stderr);
    assert(crash.stdout.includes('CHECKPOINT ' + stage), stage + ': checkpoint must have been reached');
    const interrupted = listCoreTasks(dataRoot).tasks[0];
    assert.equal(interrupted.id, original.run.edit.taskId);
    const lease = inspectCoreWriterLease(dataRoot);
    app = createApplicationRuntime({ dataRoot, ...fixture });
    await assert.rejects(app.execute('flow.continue', { run_id: original.run.id }), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
    await app.dispose();
    assert.equal(inspectCoreWriterLease(dataRoot).pid, lease.pid);
    recoverCoreWriterLease(dataRoot, { confirmStalePid: lease.pid });
    const before = readFlowEvents(dataRoot);
    const cache = readDeliveryCache(dataRoot, interrupted, { allowAbsent: true });
    let candidateResolutions = 0, adapterResolutions = 0;
    app = createApplicationRuntime({ dataRoot,
      resolveImageCandidates: request => { candidateResolutions++; return fixture.resolveImageCandidates(request); },
      resolveTaskAdapter: task => { adapterResolutions++; return fixture.resolveTaskAdapter(task); } });
    try {
      const resumed = await app.execute('flow.continue', { run_id: original.run.id });
      assert.equal(resumed.task.id, original.run.edit.taskId, stage);
      assert.equal(listCoreTasks(dataRoot).total, 1, stage);
      const after = readFlowEvents(dataRoot), submitCount = after.filter(event => event.kind === 'submit').length;
      if (['attempt-written', 'request-sent'].includes(stage)) {
        assert.equal(resumed.status, 'needs_attention', stage);
        assert.equal(resumed.task.acceptance, 'unknown', stage);
        assert.equal(submitCount, before.filter(event => event.kind === 'submit').length, stage);
      } else {
        assert.equal(resumed.status, 'awaiting_selection', stage);
        assert.equal(submitCount, 1, stage);
        assert.equal(resumed.run.comparison.artifactId, original.run.compare.artifactId, stage);
        assert.equal(listCoreArtifacts(dataRoot).total, 3, stage);
        if (cache) assert.equal(resumed.run.output.artifactId, cache.items[0].artifactId, stage);
      }
      assert.equal(candidateResolutions, ['task-created', 'intent-claimed'].includes(stage) ? 1 : 0, stage);
      assert.equal(adapterResolutions, stage === 'async-accepted' ? 1 : 0, stage);
      if (stage === 'async-cache') assert.deepEqual(after, before, '已缓存 poll 结果恢复不再联网');
      const events = readFlowEvents(dataRoot), repeated = await app.execute('flow.continue', { run_id: original.run.id });
      assert.equal(repeated.task.id, resumed.task.id);
      assert.equal(readFlowRun(dataRoot, original.run.id).edit.taskId, original.run.edit.taskId);
      assert.deepEqual(readFlowEvents(dataRoot), events, '再次继续不能产生额外提交或观察');
    } finally { await app.dispose(); }
    assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
    console.log('PASS Flow SIGKILL ' + stage + ': 同一 Task、真实 submit 计数、稳定作品、显式租约恢复');
  }
  console.log('PASS Image Flow 14 个真实进程中断窗口；unknown 不重提，缓存/比较提交可重入');
}
