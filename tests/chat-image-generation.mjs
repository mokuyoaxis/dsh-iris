import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
useTempDshHome('iris-chat-images');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { inspectProviderTaskForDsh, readCoreArtifactMediaForDsh, coreSnapshotForDsh, dshCoreDataRoot, projectCoreTaskForDsh } = await import('../lib/dsh-core-adapter.js');
const { defineHostAdapter } = await import('../lib/host-contract.js');
const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
const { invokeProviderOperation, providerAdapterSnapshot } = await import('../lib/provider-adapter.js');
const buffers = {};
for (const format of ['png', 'jpeg', 'webp']) buffers[format] = await sharp({
  create: { width: 12, height: 9, channels: 3, background: '#f00' }
}).toFormat(format).toBuffer();
const account = config.upsert({ name: 'mixed', apiKey: 'mixed-fixture-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'openai-images', models: [
    { id: 'chat-image', capabilities: ['image-gen', 'vision'], imageProtocol: 'openai-chat-images' },
    { id: 'images-image', capabilities: ['image-gen'] },
    { id: 'qwen-image-3.0', capabilities: ['image-gen'], imageProtocol: 'dashscope' }
  ] });
const other = config.upsert({ name: 'other', apiKey: 'other-fixture-key', baseUrl: 'https://other.fixture.invalid/v1',
  models: [{ id: 'chat-image', capabilities: ['image-gen'], imageProtocol: 'openai-chat-images' }] });
config.setAssignmentOrder('image-gen', [account.id + '::chat-image', account.id + '::images-image']);
const calls = [], originalFetch = globalThis.fetch;
let format = 'jpeg', shape = 'markdown', status = 200, downloadOk = true;
let invalidBytes = false, declaredMime = 'image/png';
globalThis.fetch = async (input, options = {}) => {
  const url = String(input), body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url, model: body?.model, stream: body?.stream, auth: new Headers(options.headers).get('authorization') });
  const bytes = invalidBytes ? Buffer.from('not an image') : buffers[format];
  const dataUrl = 'data:' + declaredMime + ';base64,' + bytes.toString('base64');
  if (body?.stream) {
    assert(body.messages[0].content[1].image_url.url.startsWith('data:image/' + format + ';base64,'));
    assert.deepEqual(Buffer.from(body.messages[0].content[1].image_url.url.split(',')[1], 'base64'), buffers[format]);
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '红色矩形' }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (url.endsWith('/chat/completions')) {
    assert.equal(body.messages[0].content, 'fixture prompt');
    assert.equal(body.stream, false); assert(options.signal instanceof AbortSignal);
    if (status !== 200) return Response.json({ error: { message: 'fixture failure' } }, { status });
    const message = shape === 'text' ? { content: 'I cannot generate an image.' }
      : shape === 'bad-base64' ? { content: '![x](data:image/png;base64,%%%invalid)' }
      : shape === 'markdown-url' ? { content: '![x](https://artifact.fixture.invalid/photo.png)' }
      : shape === 'content' ? { content: [{ type: 'text', text: 'generated' }, { type: 'image_url', image_url: { url: dataUrl } }] }
      : shape === 'images' ? { content: null, images: [{ type: 'image_url', image_url: { url: dataUrl } }] }
      : { content: 'Here is your image:\n![result](' + dataUrl + ')' };
    return Response.json({ choices: [{ message }] });
  }
  if (url.endsWith('/images/generations')) return Response.json({ data: shape === 'url'
    ? [{ url: 'https://artifact.fixture.invalid/photo.png' }] : [{ b64_json: bytes.toString('base64') }] });
  if (url.endsWith('/multimodal-generation/generation')) return Response.json({
    output: { choices: [{ message: { content: [{ image: 'https://artifact.fixture.invalid/photo.png' }] } }] }
  });
  if (url === 'https://artifact.fixture.invalid/photo.png') return downloadOk
    ? new Response(bytes, { headers: { 'Content-Type': 'image/png' } }) : new Response('failed', { status: 502 });
  throw new Error('unexpected fixture request');
};
async function generate(modelRef = account.id + '::chat-image') {
  const start = calls.length;
  const result = await runAction({}, 'image', { prompt: 'fixture prompt', model: modelRef });
  const task = await inspectProviderTaskForDsh(result.taskId);
  assert.equal(task.deliveryState, 'ready'); assert.equal(task.attempts.length, 1);
  assert.equal(task.modelRef, modelRef); assert.equal(task.artifactIds.length, 1);
  const media = await readCoreArtifactMediaForDsh(task.artifactIds[0]);
  assert.equal(media.artifact.mediaType, 'image/' + format);
  assert.deepEqual(media.bytes, buffers[format], '不转换原字节');
  assert.equal(media.artifact.digest.value, crypto.createHash('sha256').update(buffers[format]).digest('hex'));
  const objects = fs.readdirSync(path.join(dshCoreDataRoot(), 'artifact-store/v0/objects'));
  assert(objects.includes(media.artifact.id + (format === 'jpeg' ? '.jpg' : '.' + format)));
  assert(!JSON.stringify(task).includes('base64') && !JSON.stringify(task).includes('fixture-key'));
  assert(!JSON.stringify(task).includes('fixture prompt'));
  const submissions = calls.slice(start).filter(call => call.model);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].auth, 'Bearer ' + (modelRef.startsWith(other.id + '::') ? 'other-fixture-key' : 'mixed-fixture-key'));
  if (shape === 'markdown') {
    const count = calls.length;
    const host = defineHostAdapter({ id: 'fixture-host', ports: { attachments: {
      async saveImage(input) {
        assert.equal(input.mediaType, media.artifact.mediaType); assert.deepEqual(Buffer.from(input.data), media.bytes);
        assert(input.name.endsWith(format === 'jpeg' ? '.jpg' : '.' + format));
        return { attachmentId: 'fixture-attachment', mediaType: input.mediaType };
      }
    } } });
    const projected = await projectCoreTaskForDsh(host, task.id);
    assert.equal(projected.blocks.filter(block => block.type === 'image').length, 1);
    assert.equal(calls.length, count, 'DSH 附件展示不重新生成或下载');
  }
  return { task, media, submission: submissions[0] };
}
try {
  for (format of ['png', 'jpeg', 'webp']) {
    for (shape of ['markdown', 'content', 'images', 'markdown-url']) {
      const { submission } = await generate();
      assert(submission.url.endsWith('/chat/completions'));
    }
    for (shape of ['base64', 'url']) {
      const { submission } = await generate(account.id + '::images-image');
      assert(submission.url.endsWith('/images/generations'));
    }
    shape = 'url';
    const { submission } = await generate(account.id + '::qwen-image-3.0');
    assert(submission.url.includes('/api/v1/services/aigc/multimodal-generation/generation'));
  }
  shape = 'markdown'; format = 'jpeg';
  await generate(other.id + '::chat-image');
  const { task } = await generate();
  const beforeLook = await coreSnapshotForDsh();
  const looked = await runAction({}, 'look', { artifact_id: task.artifactIds[0], model: account.id + '::chat-image', question: '描述图片' });
  assert(looked.text.includes('红色'));
  const afterLook = await coreSnapshotForDsh();
  assert.equal(afterLook.tasks.total, beforeLook.tasks.total);
  assert.equal(afterLook.artifacts.total, beforeLook.artifacts.total, '按 ID 看图只读原 Artifact');
  for (const test of [{ shape: 'text', status: 200 }, { shape: 'bad-base64', status: 200 }, { shape: 'markdown', status: 500 }]) {
    ({ shape, status } = test);
    const start = calls.length;
    let error;
    try { await runAction({}, 'image', { prompt: 'fixture prompt' }); } catch (e) { error = e; }
    assert(error?.taskId);
    const task = await inspectProviderTaskForDsh(error.taskId);
    assert.equal(task.acceptance, 'unknown'); assert.equal(task.artifactIds.length, 0);
    assert.equal(task.attempts.length, 1); assert.equal(calls.length, start + 1, '未知结果不扫描 Images 或其他模型');
    if (status === 200) assert.equal(task.attempts[0].error.category, 'protocol');
  }
  shape = 'markdown';
  for (status of [401, 429]) {
    const start = calls.length;
    let error;
    try { await runAction({}, 'image', { prompt: 'fixture prompt', model: account.id + '::chat-image' }); } catch (e) { error = e; }
    const task = await inspectProviderTaskForDsh(error.taskId);
    assert.equal(task.acceptance, 'not_accepted'); assert.equal(task.attempts[0].error.httpStatus, status);
    assert.equal(calls.length, start + 1, '显式模型 HTTP 拒绝不尝试该模型其他协议');
  }
  assert(config.modelHealth(account.id, 'chat-image', 'image-gen').retryAt, '聊天生图复用 429 冷却');
  config.setModelVerified(account.id, 'chat-image', 'image-gen', { ok: true });
  status = 200; shape = 'markdown';
  for (invalidBytes of [true, false]) {
    downloadOk = invalidBytes; shape = invalidBytes ? 'markdown' : 'markdown-url';
    let error;
    try { await runAction({}, 'image', { prompt: 'fixture prompt', model: account.id + '::chat-image' }); } catch (e) { error = e; }
    assert(error?.taskId);
    const task = await inspectProviderTaskForDsh(error.taskId);
    assert.equal(task.outcome, 'succeeded'); assert.equal(task.deliveryState, 'failed');
    assert.equal(task.artifactIds.length, 0, '坏字节或下载失败不创建 Artifact');
  }
  format = 'gif'; buffers.gif = await sharp(buffers.png).gif().toBuffer(); shape = 'markdown'; downloadOk = true;
  let unsupported;
  try { await runAction({}, 'image', { prompt: 'fixture prompt', model: account.id + '::chat-image' }); } catch (e) { unsupported = e; }
  const unsupportedTask = await inspectProviderTaskForDsh(unsupported.taskId);
  assert.equal(unsupportedTask.deliveryState, 'failed'); assert.equal(unsupportedTask.artifactIds.length, 0);
  downloadOk = true; invalidBytes = false;
  const adapter = createConfiguredProviderAdapter({ ...account, mediaProtocol: 'openai-chat-images' });
  const snapshot = providerAdapterSnapshot(adapter);
  assert.equal(snapshot.operations.poll.status, 'unsupported'); assert.equal(snapshot.operations.cancel.status, 'unsupported');
  const start = calls.length;
  const invalidSize = await invokeProviderOperation(adapter, 'submit', {
    capability: 'image', model: 'chat-image', input: { prompt: 'fixture prompt', size: '1024x1024' }
  });
  assert.equal(invalidSize.kind, 'not_accepted'); assert.equal(calls.length, start, '不向聊天接口偷偷塞入 Images size');
  assert.equal(config.providerById(account.id).mediaProtocol, 'openai-images');
  console.log('PASS 聊天生图/Images/百炼 PNG、JPEG、WebP：真实 MIME/后缀/哈希/原字节、混合协议与账号隔离、按 ID 看图、未知零重提、坏图片/下载失败零 Artifact');
} finally { globalThis.fetch = originalFetch; }
