import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const { root, cleanup } = useTempDshHome('iris-dsh-async-core');
const config = await import('../lib/config.js');
const tasks = await import('../lib/tasks.js');
const { apply } = await import('../lib/index.js');
const { runAction } = await import('../lib/actions.js');
const {
  dshCoreDataRoot,
  inspectProviderTaskForDsh,
  resumeProviderTaskWatchesForDsh,
  stopProviderTaskWatchesForDsh
} = await import('../lib/dsh-core-adapter.js');
const { createCoreRuntime } = await import('../lib/core-runtime.js');
const { activateCoreWatch } = await import('../lib/core-tasks.js');

const registered = [];
const savedImages = [];
const disposers = [];
const services = {
  tools: { register(definition) { registered.push(definition); return () => {}; } },
  skills: { register() { return () => {}; } },
  webServer: { register() { return () => {}; } },
  attachments: {
    async saveImage(input) {
      savedImages.push(input);
      return { attachmentId: 'async-core-image-' + savedImages.length, mediaType: input.mediaType };
    },
    async readImage() { throw new Error('not needed'); }
  }
};
const ctx = {
  tools: services.tools, skills: services.skills,
  get(name) { return services[name]; },
  inject(names, callback) { if (names.every((name) => services[name])) callback(this); },
  effect(callback) {
    const dispose = callback();
    if (typeof dispose === 'function') disposers.push(dispose);
    return () => {};
  }
};

const provider = config.upsert({
  name: 'async fixture', enabled: true, apiKey: 'fixture-secret',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope',
  models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }]
});
config.setAssignmentOrder('image-gen', [provider.id + '::wan2.2-t2i-flash']);

const originalFetch = global.fetch;
const calls = { submit: 0, poll: 0, download: 0 };
const remotes = new Map();
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith('/services/aigc/text2image/image-synthesis')) {
    calls.submit += 1;
    const body = JSON.parse(String(init.body || '{}'));
    assert.equal(body.model, 'wan2.2-t2i-flash');
    assert(new Headers(init.headers).get('authorization'), 'submit must carry provider authorization');
    const id = 'remote-' + calls.submit;
    remotes.set(id, 0);
    return new Response(JSON.stringify({ output: { task_id: id } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  const taskMatch = url.match(/\/api\/v1\/tasks\/(remote-[0-9]+)$/);
  if (taskMatch) {
    calls.poll += 1;
    const id = taskMatch[1];
    const count = (remotes.get(id) || 0) + 1;
    remotes.set(id, count);
    if (id !== 'remote-1' && count === 1) {
      return new Response(JSON.stringify({ output: { task_status: 'RUNNING' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      output: { task_status: 'SUCCEEDED', results: [{ url: 'https://artifact.fixture/' + id + '.png' }] }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (/^https:\/\/artifact\.fixture\/remote-[0-9]+\.png$/.test(url)) {
    calls.download += 1;
    return new Response(FAKE_PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  throw new Error('Unexpected fixture request: ' + url);
};

async function waitForReady(taskId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await inspectProviderTaskForDsh(taskId);
    if (task.outcome === 'succeeded' && task.deliveryState === 'ready') return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Core Task ' + taskId);
}

try {
  await apply(ctx);
  const legacyBefore = tasks.all().length;
  const draw = registered.find((tool) => tool.name === 'iris_draw_image');
  const rendered = await draw.execute({
    prompt: 'fixture async iris', model: provider.id + '::wan2.2-t2i-flash', n: '1'
  }, {});
  assert.equal(calls.submit, 1, 'DSH tool must submit exactly once');
  assert.equal(calls.poll, 1, 'DSH tool background watcher must poll once for immediate success');
  assert.equal(calls.download, 1);
  assert.equal(rendered.blocks.filter((block) => block.type === 'image').length, 1);
  assert.deepEqual(Buffer.from(savedImages[0].data), FAKE_PNG);
  const firstTaskId = rendered.blocks[0].text.match(/task_[a-f0-9]{24}/)?.[0];
  const firstTask = await inspectProviderTaskForDsh(firstTaskId);
  assert.equal(firstTask.attempts.length, 1);
  assert.equal(firstTask.remoteTaskId, 'remote-1');
  assert.equal(firstTask.deliveryState, 'ready');
  assert.match(firstTask.providerBinding, /^sha256:[a-f0-9]{64}$/);
  assert.equal(tasks.all().length, legacyBefore, 'Async DSH image must not create a legacy Task');
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'outputs')), false, 'Async Core image must not dual-write legacy outputs');

  const submitted = await runAction({}, 'image', {
    prompt: 'fixture restart iris', model: provider.id + '::wan2.2-t2i-flash', n: '1'
  });
  assert.equal(submitted.storage, 'core');
  assert.equal(submitted.remoteTaskId, 'remote-2');
  stopProviderTaskWatchesForDsh();
  assert.equal(remotes.get('remote-2'), 0, 'Stopping Host watcher before first tick must not poll');
  const crashed = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'writer' });
  crashed.start();
  await crashed.run('execute', ({ dataRoot }) => activateCoreWatch(dataRoot, submitted.taskId));
  await crashed.dispose();
  assert.equal((await inspectProviderTaskForDsh(submitted.taskId)).watchState, 'active',
    'Fixture must leave a poll-in-flight crash fact');

  const resumed = await resumeProviderTaskWatchesForDsh({ intervalMs: 10, maxWatchMs: 2000 });
  assert.deepEqual(resumed, [submitted.taskId]);
  const recovered = await waitForReady(submitted.taskId);
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.remoteTaskId, 'remote-2');
  assert.equal(remotes.get('remote-2'), 2, 'Restart takeover must resume poll without submit');
  assert.equal(calls.submit, 2);
  assert.equal(calls.download, 2);
  assert.equal(tasks.all().length, legacyBefore);

  const drifted = await runAction({}, 'image', {
    prompt: 'fixture binding drift', model: provider.id + '::wan2.2-t2i-flash', n: '1'
  });
  stopProviderTaskWatchesForDsh();
  const driftFile = path.join(dshCoreDataRoot(), 'task-store/v0/tasks', drifted.taskId + '.json');
  const driftBefore = fs.readFileSync(driftFile, 'utf8');
  const pollsBeforeDrift = calls.poll;
  config.upsert({ id: provider.id, baseUrl: 'https://dashscope-us-east-1.aliyuncs.com/compatible-mode/v1' });
  const rejectedResume = await resumeProviderTaskWatchesForDsh({ intervalMs: 10, maxWatchMs: 2000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(rejectedResume, []);
  assert.equal(calls.poll, pollsBeforeDrift, 'Endpoint drift must fail before poll');
  assert.equal(fs.readFileSync(driftFile, 'utf8'), driftBefore, 'Endpoint drift must not mutate Task facts');

  console.log('DSH async image -> Core watcher -> crash takeover -> attachment/binding tests passed');
} finally {
  stopProviderTaskWatchesForDsh();
  tasks.stopWatchAll();
  for (const dispose of disposers.reverse()) {
    try { dispose(); } catch {}
  }
  global.fetch = originalFetch;
  cleanup();
}
