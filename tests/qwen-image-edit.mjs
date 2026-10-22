import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-qwen-edit');
const config = await import('../lib/config.js');
const { runAction } = await import('./fixtures/dsh-runtime-fixture.mjs');
const { supportsImageEdit } = await import('../lib/provider-protocol.js');
const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
const { invokeProviderOperation } = await import('../lib/provider-adapter.js');
const { createCoreArtifact, readCoreArtifactBytes } = await import('../lib/core-artifacts.js');
const { listCoreTasks } = await import('../lib/core-tasks.js');
const { dshCoreDataRoot, inspectProviderTaskForDsh, readCoreArtifactMediaForDsh } = await import('./fixtures/dsh-runtime-fixture.mjs');
const { apply } = await import('./fixtures/dsh-runtime-fixture.mjs');
const dataRoot = dshCoreDataRoot();
const original = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#f00' } }).png().toBuffer();
const output = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#0f0' } }).png().toBuffer();
const source = createCoreArtifact(dataRoot, { kind: 'imported-image', mediaType: 'image/png', bytes: original });
const provider = config.upsert({ name: 'mixed', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: 'qwen-fixture-key', mediaProtocol: 'openai-images', models: [
    { id: 'qwen-image-plus', capabilities: ['image-gen'], imageProtocol: 'dashscope' },
    { id: 'qwen-image-edit-max', capabilities: ['image-gen'], imageProtocol: 'dashscope', visionInput: { maxDimension: 64 } },
    { id: 'qwen-image-2.0-pro', capabilities: ['image-gen'], imageProtocol: 'dashscope', visionInput: { maxDimension: 32 } }
  ] });
const ref = id => provider.id + '::' + id;
config.setAssignmentOrder('image-gen', provider.models.map(model => ref(model.id)));
for (const id of ['qwen-image-edit', 'qwen-image-edit-max', 'qwen-image-edit-plus-2025-12-15', 'qwen-image-2.0-pro-2026-04-22']) assert(supportsImageEdit('dashscope', id));
for (const id of ['qwen-image-plus', 'qwen-image-max', 'wan2.6-image', 'qwen-image-3.0-pro', 'unconfigured']) assert(!supportsImageEdit('dashscope', id));
const calls = [], saved = [], tools = [];
let mode = 'success';
const beforeFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url === 'https://artifact.fixture.invalid/qwen.png') return new Response(output, { headers: { 'Content-Type': 'image/png' } });
  assert.equal(url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(new Headers(options.headers).get('authorization'), 'Bearer qwen-fixture-key');
  const body = JSON.parse(options.body), content = body.input.messages[0].content;
  assert.equal(content.length, 2); assert.equal(content[1].text, 'change red to green');
  assert.match(content[0].image, /^data:image\/png;base64,/);
  const metadata = await sharp(Buffer.from(content[0].image.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.width, body.model === 'qwen-image-edit-max' ? 64 : 32);
  if (body.parameters.size !== undefined) assert.equal(body.parameters.size, '1024*1024');
  assert.equal(listCoreTasks(dataRoot).tasks.find(task => task.phase === 'submitting').sourceArtifactId, source.id);
  calls.push(body.model);
  if (mode === 'fallback' && body.model === 'qwen-image-edit-max') return Response.json({ code: 'InvalidApiKey', message: 'unauthorized' }, { status: 401 });
  if (mode === 'unknown') return Response.json({ code: 'InternalError', message: 'uncertain' }, { status: 500 });
  return Response.json({ output: { choices: [{ message: { content: [{ image: 'https://artifact.fixture.invalid/qwen.png' }] } }] } });
};
const edit = extra => runAction({}, 'image_edit', { source_artifact_id: source.id, prompt: 'change red to green', size: '1024x1024', ...extra });
try {
  const projection = await runAction({}, 'providers_list', {});
  assert.deepEqual(projection.providers[0].models.map(model => model.imageRouting.editSupported), [false, true, true]);
  const assignments = await runAction({}, 'assignments_get', {});
  assert.deepEqual(assignments.poolByCapability['image-gen'].map(model => model.imageRouting.editSupported), [false, true, true]);
  const result = await edit();
  const task = await inspectProviderTaskForDsh(result.taskId);
  assert.equal(task.deliveryState, 'ready'); assert.equal(task.modelRef, ref('qwen-image-edit-max'));
  assert.equal(task.sourceArtifactId, source.id); assert.equal(calls.length, 1);
  const media = await readCoreArtifactMediaForDsh(task.artifactIds[0]);
  assert.deepEqual(media.bytes, output); assert.deepEqual(media.artifact.relations, [{ type: 'derived-from', artifactId: source.id }]);
  assert(!JSON.stringify(task).includes('change red') && !JSON.stringify(task).includes('base64') && !JSON.stringify(task).includes('fixture-key'));
  const taskCount = listCoreTasks(dataRoot).total;
  await assert.rejects(edit({ model: ref('qwen-image-plus') }), { code: 'IRIS_IMAGE_EDIT_INPUT_INVALID' });
  assert.equal(listCoreTasks(dataRoot).total, taskCount); assert.equal(calls.length, 1);
  const adapter = createConfiguredProviderAdapter({ ...provider, mediaProtocol: 'dashscope' });
  const unsupported = await invokeProviderOperation(adapter, 'submit', { capability: 'image', model: 'qwen-image-plus',
    input: { prompt: 'change red to green', image: { bytes: original, mediaType: 'image/png' } } });
  assert.equal(unsupported.kind, 'not_accepted'); assert.equal(calls.length, 1, '适配器不可丢弃原图而误发文生图');
  mode = 'fallback';
  const fallback = await inspectProviderTaskForDsh((await edit()).taskId);
  assert.equal(fallback.modelRef, ref('qwen-image-2.0-pro')); assert.equal(fallback.attempts.length, 2);
  assert.deepEqual(calls.slice(1), ['qwen-image-edit-max', 'qwen-image-2.0-pro']);
  mode = 'unknown'; const count = calls.length;
  await assert.rejects(edit(), error => Boolean(error.taskId));
  assert.equal(calls.length, count + 1, '未知受理停止，不自动重提或切换模型');
  mode = 'success';
  const services = { tools: { register(tool) { tools.push(tool); return () => {}; } }, skills: { register() { return () => {}; } },
    webServer: { register() { return () => {}; } }, attachments: { async saveImage(input) { saved.push(input); return { attachmentId: 'qwen-edited', mediaType: input.mediaType }; }, async readImage() { throw new Error('unused fixture reader'); } } };
  const ctx = { ...services, get(name) { return services[name]; }, inject(names, fn) { if (names.every(name => services[name])) fn(this); }, effect(fn) { fn(); return () => {}; } };
  await apply(ctx);
  const toolResult = await tools.find(tool => tool.name === 'iris_edit_image').execute({ source_artifact_id: source.id,
    prompt: 'change red to green', model: ref('qwen-image-edit-max') }, {});
  assert.equal(toolResult.blocks.filter(block => block.type === 'image').length, 1);
  assert.deepEqual(Buffer.from(saved[0].data), output);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, source.id).bytes, original);
} finally { globalThis.fetch = beforeFetch; }

const state = path.join(root, 'cli-calls.jsonl'), cliRoot = path.join(root, 'cli-core');
const sourcePath = path.join(root, 'source.png'); fs.writeFileSync(sourcePath, original);
function cli(args) {
  const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/qwen-image-edit-fetch.mjs', import.meta.url).href,
    'bin/dsh-iris.js', ...args, '--data-root', cliRoot], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, IRIS_QWEN_FIXTURE_STATE: state } });
  assert.equal(result.status, 0, result.stderr); assert(!result.stdout.includes('qwen-fixture-key'));
  return JSON.parse(result.stdout);
}
const imported = cli(['artifact', 'import', '--input', JSON.stringify({ image_path: sourcePath })]);
const edited = cli(['run', 'image', '--provider-config', path.join(config.irisHome(), 'providers.json'),
  '--input', JSON.stringify({ source_artifact_id: imported.artifact.id, prompt: 'change red to green', size: '1024x1024', model_ref: ref('qwen-image-edit-max') })]);
assert.equal(edited.task.deliveryState, 'ready'); assert.equal(edited.task.sourceArtifactId, imported.artifact.id);
assert.equal(edited.task.modelRef, ref('qwen-image-edit-max')); assert.equal(edited.task.attempts.length, 1);
const trace = fs.readFileSync(state, 'utf8').trim().split('\n').map(line => JSON.parse(line));
assert.equal(trace.length, 1); assert.equal(trace[0].width, 64);
const artifact = cli(['artifact', 'inspect', edited.task.artifactIds[0]]).artifact;
assert.deepEqual(artifact.relations, [{ type: 'derived-from', artifactId: imported.artifact.id }]);
assert.deepEqual(fs.readFileSync(sourcePath), original);
console.log('PASS 原生 Qwen 改图：协议与预算、Core 来源/原图保留、名单过滤、明确未受理切换与未知停止、界面投影、DSH 附件、真实 CLI 导入再编辑');
