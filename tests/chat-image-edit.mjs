import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
const { root } = useTempDshHome('iris-chat-edit');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { apply } = await import('../lib/index.js');
const { dshCoreDataRoot, inspectProviderTaskForDsh, readCoreArtifactMediaForDsh, retryProviderTaskForDsh } = await import('../lib/dsh-core-adapter.js');
const { createCoreArtifact, readCoreArtifactBytes } = await import('../lib/core-artifacts.js');
const { listCoreTasks } = await import('../lib/core-tasks.js');
const { planCoreDeletion } = await import('../lib/core-maintenance.js');
const { deleteWorkbenchArtifacts } = await import('../lib/workbench-management.js');
const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
const { invokeProviderOperation } = await import('../lib/provider-adapter.js');
const { createCoreRuntime } = await import('../lib/core-runtime.js');
const { createProviderTaskRunner } = await import('../lib/provider-task-runner.js');
const dataRoot = dshCoreDataRoot();
const original = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#f00' } }).png().toBuffer();
const source = createCoreArtifact(dataRoot, { kind: 'generated-image', mediaType: 'image/png', bytes: original });
const buffers = {};
for (const format of ['png', 'jpeg', 'webp']) buffers[format] = await sharp({ create: { width: 100, height: 60, channels: 3, background: '#0f0' } }).toFormat(format).toBuffer();
const first = config.upsert({ name: 'mixed', apiKey: 'first-fixture-key', baseUrl: 'https://first.fixture.invalid/v1', mediaProtocol: 'openai-images',
  models: [{ id: 'ordinary', capabilities: ['image-gen'] }, { id: 'same-image', capabilities: ['image-gen'], imageProtocol: 'openai-chat-images', visionInput: { maxDimension: 64 } }] });
const second = config.upsert({ name: 'other', apiKey: 'second-fixture-key', baseUrl: 'https://second.fixture.invalid/v1', mediaProtocol: 'openai-chat-images',
  models: [{ id: 'same-image', capabilities: ['image-gen'], visionInput: { maxDimension: 32 } }] });
config.setAssignmentOrder('image-gen', [first.id + '::ordinary', first.id + '::same-image', second.id + '::same-image']);
const calls = [], saved = [], registered = [];
const services = { tools: { register(tool) { registered.push(tool); return () => {}; } }, skills: { register() { return () => {}; } }, webServer: { register() { return () => {}; } },
  attachments: { async saveImage(input) { saved.push(input); return { attachmentId: 'edited-' + saved.length, mediaType: input.mediaType }; }, async readImage() { throw new Error('unused fixture reader'); } } };
const ctx = { ...services, get(name) { return services[name]; }, inject(names, callback) { if (names.every(name => services[name])) callback(this); }, effect(callback) { callback(); return () => {}; } };
let format = 'png', mode = 'success';
const beforeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert(String(url).endsWith('/chat/completions'), '编辑只走配置的聊天接口');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'same-image'); assert.equal(body.stream, false);
  const content = body.messages[0].content;
  assert.equal(content[0].text, 'change red to green'); assert.equal(content[1].type, 'image_url');
  assert(content[1].image_url.url.startsWith('data:image/png;base64,'));
  const meta = await sharp(Buffer.from(content[1].image_url.url.split(',')[1], 'base64')).metadata();
  const account = String(url).includes('first.') ? first : second;
  assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + account.apiKey);
  assert.equal(meta.width, account === first ? 64 : 32, '每个实际候选应用自己的输入预算');
  const pending = listCoreTasks(dataRoot).tasks.find(task => task.phase === 'submitting');
  assert.equal(pending.sourceArtifactId, source.id, 'HTTP 前源 ID 与 Attempt 已持久化');
  calls.push({ account: account.id, width: meta.width });
  if (mode === 'fallback' && account === first) return Response.json({ error: { message: 'unauthorized' } }, { status: 401 });
  if (mode === 'unknown') return Response.json({ error: { message: 'server uncertain' } }, { status: 500 });
  if (mode === 'text') return Response.json({ choices: [{ message: { content: 'No image here.' } }] });
  return Response.json({ choices: [{ message: { content: '![edited](data:image/png;base64,' + buffers[format].toString('base64') + ')' } }] });
};
const edit = (extra = {}) => runAction({}, 'image_edit', { source_artifact_id: source.id, prompt: 'change red to green', ...extra });
const count = () => listCoreTasks(dataRoot).total;
try {
  for (format of ['png', 'jpeg', 'webp']) {
    const start = calls.length;
    const result = await edit();
    assert.equal(calls.length, start + 1, '跳过普通 Images 候选，单次生成');
    const task = await inspectProviderTaskForDsh(result.taskId);
    assert.equal(task.sourceArtifactId, source.id); assert.equal(task.deliveryState, 'ready');
    const media = await readCoreArtifactMediaForDsh(task.artifactIds[0]);
    assert.equal(media.artifact.mediaType, 'image/' + format);
    assert.deepEqual(media.bytes, buffers[format], '输出按真实格式和原字节交付');
    assert.deepEqual(media.artifact.relations, [{ type: 'derived-from', artifactId: source.id }]);
    assert.notEqual(media.artifact.id, source.id);
    assert(!JSON.stringify(task).includes('change red') && !JSON.stringify(task).includes('base64') && !JSON.stringify(task).includes('fixture-key'));
    assert.deepEqual(readCoreArtifactBytes(dataRoot, source.id).bytes, original);
  }
  let requests = calls.length, tasks = count();
  await assert.rejects(edit({ model: first.id + '::ordinary' }), /协议不支持/);
  await assert.rejects(edit({ source_artifact_id: 'artifact_' + 'a'.repeat(24) }), error => error.code === 'IRIS_ARTIFACT_NOT_FOUND');
  const text = createCoreArtifact(dataRoot, { kind: 'transcript', mediaType: 'text/plain', bytes: Buffer.from('not an image') });
  await assert.rejects(edit({ source_artifact_id: text.id }), /静态/);
  const mismatch = createCoreArtifact(dataRoot, { kind: 'image', mediaType: 'image/jpeg', bytes: original });
  await assert.rejects(edit({ source_artifact_id: mismatch.id }), /真实格式/);
  const oversized = createCoreArtifact(dataRoot, { kind: 'image', mediaType: 'image/png', bytes: Buffer.alloc(20 * 1024 * 1024 + 1) });
  await assert.rejects(edit({ source_artifact_id: oversized.id }), /20 MiB/);
  const animatedBytes = await sharp(Buffer.concat([Buffer.alloc(300), Buffer.alloc(300, 255)]), { raw: { width: 10, height: 20, channels: 3, pageHeight: 10 } }).webp().toBuffer();
  assert.equal((await sharp(animatedBytes).metadata()).pages, 2);
  const animated = createCoreArtifact(dataRoot, { kind: 'image', mediaType: 'image/webp', bytes: animatedBytes });
  await assert.rejects(edit({ source_artifact_id: animated.id }), /不能是动画/);
  const sourceFile = path.join(dataRoot, 'artifact-store/v0/objects', source.id + '.png');
  fs.writeFileSync(sourceFile, Buffer.alloc(original.length));
  try { await assert.rejects(edit(), error => error.code === 'IRIS_ARTIFACT_DIGEST_MISMATCH'); }
  finally { fs.writeFileSync(sourceFile, original); }
  assert.equal(calls.length, requests); assert.equal(count(), tasks, '无效来源或协议不创建 Task，不发 HTTP');
  mode = 'fallback';
  const fallback = await edit();
  const fallbackTask = await inspectProviderTaskForDsh(fallback.taskId);
  assert.deepEqual(fallbackTask.attempts.map(attempt => attempt.providerId), [first.id, second.id]);
  assert.deepEqual(calls.slice(requests).map(call => call.width), [64, 32]);
  for (mode of ['unknown', 'text']) {
    requests = calls.length;
    await assert.rejects(edit(), error => Boolean(error.taskId));
    assert.equal(calls.length, requests + 1, '未知受理或纯文字禁止自动重提');
  }
  const unknown = listCoreTasks(dataRoot).tasks.find(task => task.acceptance === 'unknown');
  assert(planCoreDeletion(dataRoot, { artifact_ids: [source.id] }).blockers.some(blocker => blocker.reason === 'task_input_reference' && blocker.referencedBy === unknown.id));
  const preview = await deleteWorkbenchArtifacts({ artifact_ids: [source.id] });
  assert(preview.referencingTasks.some(task => task.id === unknown.id && !task.settled), '工作台展示编辑输入引用，并禁止选择未知任务');
  requests = calls.length; tasks = count();
  await assert.rejects(retryProviderTaskForDsh({ taskId: unknown.id, prompt: 'change red to green', confirmBilling: true }), /重新提供 source_artifact_id/);
  assert.equal(calls.length, requests); assert.equal(count(), tasks);
  mode = 'success';
  const retry = await retryProviderTaskForDsh({ taskId: unknown.id, sourceArtifactId: source.id, prompt: 'change red to green', confirmBilling: true });
  const retryTask = await inspectProviderTaskForDsh(retry.taskId);
  assert.equal(retryTask.retriedFrom, unknown.id); assert.equal(retryTask.sourceArtifactId, source.id);
  assert.equal(retry.row.sourceArtifactId, source.id);
  await apply(ctx);
  const tool = registered.find(entry => entry.name === 'iris_edit_image');
  assert.deepEqual(tool.parameters.required, ['source_artifact_id', 'prompt']);
  const toolResult = await tool.execute({ source_artifact_id: source.id, prompt: 'change red to green', model: second.id + '::same-image' }, {});
  assert.equal(toolResult.blocks.filter(block => block.type === 'image').length, 1);
  assert(toolResult.blocks[0].text.includes(source.id));
  assert.equal(saved.at(-1).mediaType, 'image/webp'); assert.deepEqual(Buffer.from(saved.at(-1).data), buffers.webp);
  // 适配器本身也拒绝将带图编辑误发到普通生图接口。
  const unsupported = await invokeProviderOperation(createConfiguredProviderAdapter(first), 'submit', {
    capability: 'image', model: 'ordinary', input: { prompt: 'change red to green', image: { bytes: original, mediaType: 'image/png' } }
  });
  assert.equal(unsupported.kind, 'not_accepted'); assert.match(unsupported.error.safeMessage, /不支持聊天改图/);
  const runtime = createCoreRuntime({ mode: 'writer', dataRoot: path.join(root, 'other-core') });
  await runtime.start();
  try {
    const adapter = createConfiguredProviderAdapter({ ...second, visionInput: { maxBytes: 1 }, models: [{ id: 'same-image', capabilities: ['image-gen'] }] });
    const tinySource = createCoreArtifact(path.join(root, 'other-core'), { kind: 'image', mediaType: 'image/png', bytes: original });
    requests = calls.length;
    const result = await createProviderTaskRunner(runtime).submit({ capability: 'image', sourceArtifactId: tinySource.id,
      candidates: [{ adapter, model: second.id + '::same-image' }], providerInput: { prompt: 'fixture' } });
    assert.equal(result.task.acceptance, 'not_accepted'); assert.equal(calls.length, requests, '无法满足发送预算时零 HTTP');
  } finally { await runtime.dispose(); }
  assert.deepEqual(readCoreArtifactBytes(dataRoot, source.id).bytes, original);
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'outputs')), false);
} finally { globalThis.fetch = beforeFetch; }
console.log('PASS 聊天改图：三种输出格式、原图只读/来源关系、混合账号协议与逐候选预算、未知零重提、来源删除保护、显式重试、DSH 工具附件');
