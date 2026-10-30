import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner } from '../lib/operation-runner.js';
import { readOperation, projectOperation } from '../lib/operation-store.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { ProviderContractError } from '../lib/provider-contract.js';
import { createOpenAiImagesProviderAdapter } from '../lib/provider-adapters.js';
import { loadCorePluginRegistry } from '../lib/plugins.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-audit-operation'), checks = [];
const registry = await loadCorePluginRegistry({ entries: [path.resolve('plugins/contact-sheet/index.mjs')] });
const dataRoot = path.join(root, 'business'), app = createApplicationRuntime({ dataRoot });
let runner;
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  let writerCalls = 0;
  const application = { snapshot: app.snapshot, run(mode, ...args) {
    if (mode === 'writer' && ++writerCalls === 3) {
      return Promise.reject(Object.assign(Error('writer busy fixture'), { code: 'IRIS_CORE_DATA_ROOT_BUSY' }));
    }
    return app.run(mode, ...args);
  } };
  const operationId = 'community.contact-sheet.create';
  runner = createOperationRunner({ dataRoot, application, pluginRegistry: registry, allowedOperations: [operationId] });
  await runner.start();
  const request = { key: crypto.randomUUID(), operationId, dependency: registry.dependency('operations', operationId),
    input: { artifactIds: [source.id], columns: 1, cellSize: 128 } };
  const accepted = await runner.submit(request); await runner.idle();
  assert.equal(readOperation(path.join(root, 'business'), accepted.operation.id).state, 'queued');
  assert.equal(runner.snapshot().queued, 1); assert.equal(runner.snapshot().failed, false);
  const replay = await runner.submit(request); assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.operation.id, accepted.operation.id); await runner.idle();
  const finished = readOperation(path.join(root, 'business'), accepted.operation.id);
  assert.equal(finished.state, 'succeeded'); assert.equal(finished.result.artifactIds.length, 1);
  const again = await runner.submit(request); await runner.idle();
  assert.deepEqual(again.operation, projectOperation(finished)); assert.deepEqual(readOperation(dataRoot, finished.id), finished);
  checks.push('an accepted plugin job paused by a busy writer resumes only after explicit replay of the same UUID, without duplicate artifacts');

  const runtime = createCoreRuntime({ dataRoot: path.join(root, 'delivery'), mode: 'writer' }); runtime.start();
  try {
    for (const category of ['network', 'timeout', 'provider', 'local_io', 'ENOSPC', 'EACCES']) {
      const adapter = createOpenAiImagesProviderAdapter({ id: 'delivery-' + category, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only' },
        { transport: { async openAiGenerateImage() { return [{ url: 'https://fixture.invalid/image.png' }]; },
          async downloadTo() {
            if (['ENOSPC', 'EACCES'].includes(category)) throw Object.assign(Error('filesystem failure fixture'), { code: category });
            throw new ProviderContractError('fixture download failure', {
            stage: 'download', category, acceptance: 'accepted', ...(category === 'provider' ? { httpStatus: 503 } : {}) }); } } });
      const result = await createProviderTaskRunner(runtime).submit({ capability: 'image', candidates: [{ adapter, model: adapter.id + '::image' }], providerInput: { prompt: 'fixture' } });
      assert.equal(result.task.outcome, 'succeeded'); assert.equal(result.task.deliveryState, 'failed');
      assert.equal(result.task.lastError.category, ['ENOSPC', 'EACCES'].includes(category) ? 'local_io' : category);
      assert.equal(result.task.attempts.length, 1);
    }
  } finally { await runtime.dispose(); }
  checks.push('network, timeout, upstream and local delivery failures retain their distinct categories without resubmitting generation');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally { await runner?.dispose(); await app.dispose(); await registry.dispose(); }
