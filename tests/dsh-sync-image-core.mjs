import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const { root, cleanup } = useTempDshHome('iris-dsh-sync-core');
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = await import('../lib/config.js');
const tasks = await import('../lib/tasks.js');
const { apply } = await import('../lib/index.js');
const { runAction } = await import('../lib/actions.js');
const { dshCoreDataRoot, inspectProviderTaskForDsh, readCoreArtifactMediaForDsh } = await import('../lib/dsh-core-adapter.js');
const registered = [];
const savedImages = [];
const services = {
  tools: { register(definition) { registered.push(definition); return () => {}; } },
  skills: { register() { return () => {}; } },
  webServer: { register() { return () => {}; } },
  attachments: {
    async saveImage(input) {
      savedImages.push(input);
      return { attachmentId: 'core-image-' + savedImages.length, mediaType: input.mediaType };
    },
    async readImage() { throw new Error('not needed'); }
  }
};
const ctx = {
  tools: services.tools, skills: services.skills,
  get(name) { return services[name]; },
  inject(names, callback) { if (names.every((name) => services[name])) callback(this); },
  effect(callback) { callback(); return () => {}; }
};
const first = config.upsert({ name: 'rejected', enabled: true, apiKey: 'fixture-first', baseUrl: 'https://first.fixture.invalid/v1',
  mediaProtocol: 'openai-images', models: [{ id: 'same-image', capabilities: ['image-gen'] }] });
const second = config.upsert({ name: 'completed', enabled: true, apiKey: 'fixture-second', baseUrl: 'https://second.fixture.invalid/v1',
  mediaProtocol: 'openai-images', models: [{ id: 'same-image', capabilities: ['image-gen'] }] });
config.setAssignmentOrder('image-gen', [first.id + '::same-image', second.id + '::same-image']);
const originalFetch = global.fetch;
const calls = [];
let mode = 'ready';
global.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  if (url.endsWith('/images/generations')) {
    assert.equal(body.model, 'same-image', 'Provider must receive raw model ID');
    const records = fs.readdirSync(path.join(dshCoreDataRoot(), 'task-store/v0/tasks'));
    const recordsOnDisk = records.map((name) => JSON.parse(fs.readFileSync(path.join(dshCoreDataRoot(), 'task-store/v0/tasks', name), 'utf8')));
    assert(recordsOnDisk.some((task) => task.attempts.at(-1)?.acceptance === 'none'), 'Core Attempt must be durable before HTTP');
    if (url.includes('first.fixture.invalid')) {
      return new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), { status: mode === 'unknown' ? 500 : 429 });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: FAKE_PNG.toString('base64') }] }), { status: 200 });
  }
  throw new Error('Unexpected fixture request');
};

try {
  await apply(ctx);
  const legacyBefore = tasks.all().length;
  const draw = registered.find((tool) => tool.name === 'iris_draw_image');
  const result = await draw.execute({ prompt: 'fixture iris flower', n: '1' }, {});
  assert.equal(calls.length, 2, 'Only explicit nonacceptance permits a second candidate');
  assert.equal(savedImages.length, 1);
  assert.deepEqual(Buffer.from(savedImages[0].data), FAKE_PNG);
  assert.equal(result.blocks.filter((block) => block.type === 'image').length, 1);
  const taskId = result.blocks[0].text.match(/task_[a-f0-9]{24}/)?.[0];
  const artifactId = result.blocks[0].text.match(/artifact_[a-f0-9]{24}/)?.[0];
  const task = await inspectProviderTaskForDsh(taskId);
  assert.equal(task.modelRef, second.id + '::same-image');
  assert.equal(task.attempts.length, 2);
  assert.deepEqual(task.attempts.map((attempt) => attempt.selectionReason), ['assignment', 'assignment'],
    '按 assignment 顺序切换候选时，每个 Attempt 都必须保留提交时的选择来源');
  assert.match(task.providerBinding, /^sha256:[a-f0-9]{64}$/);
  assert(task.attempts.every((attempt) => /^sha256:[a-f0-9]{64}$/.test(attempt.providerBinding)),
    'Every DSH Core attempt must retain a non-secret endpoint binding');
  assert.deepEqual(task.artifactIds, [artifactId]);
  assert.equal(task.deliveryState, 'ready');
  assert.equal(tasks.all().length, legacyBefore, 'DSH tool must not create a legacy Task');
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'outputs')), false, 'Core generation must not dual-write outputs');
  assert.equal(config.modelHealth(first.id, 'same-image', 'image-gen').status, 'configured');
  assert.equal(config.modelHealth(second.id, 'same-image', 'image-gen').status, 'verified');

  const taskPath = path.join(dshCoreDataRoot(), 'task-store/v0/tasks', taskId + '.json');
  const taskBefore = fs.readFileSync(taskPath, 'utf8');
  const media = await readCoreArtifactMediaForDsh(artifactId);
  assert.deepEqual(media.bytes, FAKE_PNG);
  const statusTool = registered.find((tool) => tool.name === 'iris_task_status');
  assert((await statusTool.execute({ task_id: taskId })).includes(artifactId));
  assert((await statusTool.execute({})).includes(taskId));
  assert.equal(fs.readFileSync(taskPath, 'utf8'), taskBefore, 'Status and projection must not change Core facts');
  assert.equal(calls.length, 2, 'Read-only views must not call Provider');

  const output = path.join(root, 'cli-export.png');
  const exported = spawnSync(process.execPath, ['bin/dsh-iris.js', 'artifact', 'export', artifactId,
    '--data-root', dshCoreDataRoot(), '--output', output], { cwd: repo, env: process.env, encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(fs.readFileSync(output), FAKE_PNG, 'CLI must export the DSH Core Artifact unchanged');
  assert.equal(JSON.parse(exported.stdout).artifact.digest.value, media.artifact.digest.value);

  mode = 'unknown';
  const beforeUnknown = calls.length;
  let unknown;
  try { await runAction({}, 'image', { prompt: 'fixture unknown acceptance' }); } catch (error) { unknown = error; }
  assert(unknown?.taskId && unknown.message.includes('禁止自动重提'));
  assert.equal(calls.length, beforeUnknown + 1, '500 must stop candidate failover and legacy fallback');
  assert.equal((await inspectProviderTaskForDsh(unknown.taskId)).acceptance, 'unknown');
  assert.equal(tasks.all().length, legacyBefore);
  assert(!taskBefore.includes('fixture iris flower') && !taskBefore.includes('fixture-first')
    && !taskBefore.includes('fixture.invalid'), 'Core facts must not persist prompt, secrets, or Provider URL');
  console.log('DSH synchronous tool -> Core -> preview/status -> CLI export tests passed');
} finally {
  global.fetch = originalFetch;
  tasks.stopWatchAll();
  cleanup();
}
