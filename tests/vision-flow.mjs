import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createOperationRunner } from '../lib/operation-runner.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { ProviderContractError } from '../lib/provider-contract.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-vision-flow');
const apps = [], runners = [], calls = [], modelRef = 'vision-fixture::vision', binding = 'sha256:' + 'e'.repeat(64);
let adapter, mode = 'normal', entered;
const ports = {
  resolveVisionCandidates({ modelRef: requested, signal }) {
    signal.throwIfAborted(); assert.equal(requested, modelRef);
    return [{ adapter, model: modelRef, providerBinding: binding, selectionReason: 'explicit' }];
  }, resolveTaskAdapter() { return adapter; }
};
async function setup(name, version = 5) {
  const dataRoot = path.join(root, name), app = createApplicationRuntime({ dataRoot, ...ports }); apps.push(app);
  await app.execute('flow.init', {});
  await app.execute(version === 0 ? 'creation.init' : 'execution.init', version === 5 ? { vision: true }
    : version === 4 ? { video: true } : version === 3 ? { audio: true } : version === 2 ? { imageGeneration: true } : {});
  return { dataRoot, app };
}
try {
  const sample = await setup('normal');
  assert.equal((await sample.app.execute('creation.root', {})).vision, true);
  const { createVisionProviderAdapter } = await import('../lib/vision-provider-adapter.js');
  const makeAdapter = () => createVisionProviderAdapter({ id: 'vision-fixture', type: 'openai', baseUrl: 'https://vision.fixture.invalid/v1', apiKey: 'PRIVATE_VISION_FIXTURE_KEY' }, {
    fetchPort: async (url, init) => {
      assert.equal(url, 'https://vision.fixture.invalid/v1/chat/completions');
      const body = JSON.parse(init.body); calls.push(body);
      assert.equal(body.model, 'vision'); assert.equal(body.stream, true);
      const activeRoot = mode === 'stop' ? path.join(root, 'stop') : sample.dataRoot;
      const files = fs.readdirSync(path.join(activeRoot, 'task-store/v0/tasks'));
      assert(files.some(file => JSON.parse(fs.readFileSync(path.join(activeRoot, 'task-store/v0/tasks', file))).attempts.at(-1)?.acceptance === 'none'), 'Attempt precedes HTTP');
      if (mode === 'reject') return new Response(JSON.stringify({ error: { message: 'PRIVATE_VISION_FIXTURE_KEY private endpoint' } }), { status: 429 });
      if (mode === 'preflight') throw new ProviderContractError('fixture admission refused before dispatch', { stage: 'prepare', category: 'network', acceptance: 'not_accepted' });
      if (mode === 'disconnect') throw new TypeError('PRIVATE_VISION_FIXTURE_KEY disconnected');
      if (mode === 'stop') return new Promise((resolve, reject) => {
        entered(); init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      const events = [{ choices: [{ index: 0, delta: { content: 'A purple iris. <script>text only</script>' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
      return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
  });
  adapter = makeAdapter();
  const source = (await sample.app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const sourceBefore = readCoreArtifactBytes(sample.dataRoot, source.id).bytes;
  const key = crypto.randomUUID(), value = { sourceArtifactId: source.id, modelRef, question: 'Describe the flower' };
  const created = await sample.app.execute('creation.vision', { key, value });
  assert.equal(created.flow.run.recipe, 'vision/v0'); assert.equal(created.flow.status, 'not_started'); assert.equal(calls.length, 0);
  assert.equal((await sample.app.execute('creation.vision', { key, value })).flow.run.id, created.flow.run.id);
  await assert.rejects(sample.app.execute('creation.vision', { key, value: { ...value, question: 'another question' } }), { code: 'IRIS_CREATION_KEY_CONFLICT' });
  const complete = await sample.app.execute('flow.continue', { run_id: created.flow.run.id });
  assert.equal(complete.status, 'ready'); assert.equal(complete.task.capability, 'vision');
  assert.equal(complete.task.id, created.flow.run.analyze.taskId); assert.equal(complete.task.attempts.length, 1);
  const text = readCoreArtifactBytes(sample.dataRoot, complete.run.output.artifactId);
  assert.equal(text.artifact.mediaType, 'text/plain'); assert.equal(text.bytes.toString(), 'A purple iris. <script>text only</script>');
  assert(text.artifact.relations.some(edge => edge.type === 'derived-from' && edge.artifactId === source.id));
  assert.deepEqual(readCoreArtifactBytes(sample.dataRoot, source.id).bytes, sourceBefore);
  assert(!JSON.stringify(complete.task).includes('PRIVATE_'));
  await assert.rejects(sample.app.execute('flow.select', { run_id: complete.run.id, artifact_id: complete.run.output.artifactId }), { code: 'IRIS_FLOW_SELECTION_INVALID' });
  await sample.app.dispose();
  const reopened = createApplicationRuntime({ dataRoot: sample.dataRoot, ...ports }); apps.push(reopened);
  assert.equal((await reopened.execute('flow.continue', { run_id: complete.run.id })).task.id, complete.task.id);
  assert.equal(calls.length, 1, 'Restart never reruns a completed vision request');
  for (const version of [0, 1, 2, 3, 4]) {
    const old = await setup('v' + version, version);
    const before = fs.readdirSync(old.dataRoot, { recursive: true }).sort();
    await assert.rejects(old.app.execute('creation.vision', { key: crypto.randomUUID(), value }), { code: 'IRIS_FLOW_VISION_ROOT_REQUIRED' });
    await assert.rejects(old.app.execute('execution.init', { vision: true }), { code: 'IRIS_CREATION_ROOT_VERSION_CONFLICT' });
    assert.deepEqual(fs.readdirSync(old.dataRoot, { recursive: true }).sort(), before);
  }
  for (const failure of ['reject', 'disconnect', 'preflight']) {
    mode = failure; adapter = makeAdapter();
    const draft = await reopened.execute('creation.vision', { key: crypto.randomUUID(), value });
    const failed = await reopened.execute('flow.continue', { run_id: draft.flow.run.id });
    assert.equal(failed.task.acceptance, failure === 'disconnect' ? 'unknown' : 'not_accepted');
    assert.equal(failed.run.output, undefined); assert(!JSON.stringify(failed.task).includes('PRIVATE_'));
    const count = calls.length;
    await reopened.execute('flow.continue', { run_id: draft.flow.run.id }); assert.equal(calls.length, count);
  }
  mode = 'stop'; adapter = makeAdapter();
  const stopping = await setup('stop');
  const stoppingSource = (await stopping.app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const draft = await stopping.app.execute('creation.vision', { key: crypto.randomUUID(), value: { ...value, sourceArtifactId: stoppingSource.id } });
  const sent = new Promise(resolve => { entered = resolve; });
  const runner = createOperationRunner({ dataRoot: stopping.dataRoot, application: stopping.app, ...ports }); runners.push(runner);
  await runner.start();
  const command = { key: crypto.randomUUID(), runId: draft.flow.run.id, expectedRunRevision: draft.flow.run.revision };
  const queued = await runner.submit(command); await sent;
  assert.equal((await stopping.app.execute('operation.lookup', { key: command.key })).operation.id, queued.operation.id);
  const stopped = await runner.stop(queued.operation.id);
  assert.equal(stopped.operation.state, 'canceled'); assert.equal(stopped.remoteCancellation, 'not_requested');
  const saved = await stopping.app.execute('flow.inspect', { run_id: draft.flow.run.id }); assert.equal(saved.task.acceptance, 'unknown');
  const count = calls.length;
  await runner.submit({ ...command, key: crypto.randomUUID(), expectedRunRevision: saved.run.revision }); await runner.idle();
  assert.equal(calls.length, count); assert.equal(saved.run.output, undefined);
  console.log('PASS durable vision root, real SSE port, original UUID/Task/Artifact, no retry, old-root gates and local stop');
} finally {
  for (const runner of runners.reverse()) await runner.dispose();
  for (const app of apps.reverse()) await app.dispose();
}
