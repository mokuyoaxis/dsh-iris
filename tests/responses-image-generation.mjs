import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
useTempDshHome('iris-responses-images');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { inspectProviderTaskForDsh, readCoreArtifactMediaForDsh, dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
const { providerForImageModel } = await import('../lib/provider-protocol.js');
const { providerTaskBinding } = await import('../lib/provider-catalog.js');
const { invokeProviderOperation, providerAdapterSnapshot } = await import('../lib/provider-adapter.js');
const buffers = {};
for (const format of ['png', 'jpeg', 'webp']) buffers[format] = await sharp({
  create: { width: 12, height: 9, channels: 3, background: '#f00' }
}).toFormat(format).toBuffer();
const account = config.upsert({ name: 'mixed', apiKey: 'responses-fixture-key',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'openai-images', models: [
    { id: 'responses-image', capabilities: ['image-gen'], imageProtocol: 'openai-responses-images' },
    { id: 'chat-image', capabilities: ['image-gen'], imageProtocol: 'openai-chat-images' },
    { id: 'images-image', capabilities: ['image-gen'] },
    { id: 'qwen-image-3.0', capabilities: ['image-gen'], imageProtocol: 'dashscope' }
  ] });
const other = config.upsert({ name: 'other', apiKey: 'other-fixture-key', baseUrl: 'https://other.fixture.invalid/v1',
  models: [{ id: 'responses-image', capabilities: ['image-gen'], imageProtocol: 'openai-responses-images' }] });
config.setAssignmentOrder('image-gen', [account.id + '::responses-image', account.id + '::images-image']);
const calls = [], originalFetch = globalThis.fetch;
let format = 'jpeg', shape = 'tool', status = 200;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input), body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url, body, auth: new Headers(options.headers).get('authorization') });
  const b64 = buffers[format].toString('base64'), imageUrl = 'data:image/png;base64,' + b64;
  if (url.endsWith('/responses')) {
    assert.equal(body.input, 'fixture prompt'); assert.equal(body.stream, false);
    assert.equal(body.background, false); assert.equal(body.store, false);
    assert.deepEqual(body.tool_choice, { type: 'image_generation' });
    assert.equal(body.tools[0].type, 'image_generation'); assert.equal(body.tools[0].action, 'generate');
    assert(!('n' in body) && !('size' in body) && !('messages' in body));
    assert(options.signal instanceof AbortSignal);
    if (status !== 200) return Response.json({ error: { message: 'fixture failure' } }, { status });
    let output = [{ type: 'image_generation_call', status: 'completed', result: b64 }];
    if (shape === 'tool-and-message') output.push({ type: 'message', status: 'completed', content: [{ type: 'output_text', text: '![image](' + imageUrl + ')' }] });
    if (shape === 'message' || shape === 'message-pending' || shape === 'url' || shape === 'text') output = [{ type: 'message', status: shape === 'message-pending' ? 'in_progress' : 'completed', content: [{
      type: 'output_text', text: shape === 'text' ? 'No image generated. https://fixture.invalid/page'
        : '![image](' + (shape === 'url' ? 'https://artifact.fixture.invalid/photo.png' : imageUrl) + ')'
    }] }];
    if (shape === 'tool-pending') output[0].status = 'in_progress';
    if (shape === 'partial-tools') output.push({ type: 'image_generation_call', status: 'in_progress', result: b64 });
    if (shape === 'bad-base64') output[0].result = '%%%';
    if (shape === 'missing-image') output = [];
    const responseStatus = ['in_progress', 'incomplete', 'failed'].includes(shape) ? shape : 'completed';
    return Response.json({ status: responseStatus, output });
  }
  if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: '![image](' + imageUrl + ')' } }] });
  if (url.endsWith('/images/generations')) return Response.json({ data: [{ b64_json: b64 }] });
  if (url.endsWith('/multimodal-generation/generation')) return Response.json({
    output: { choices: [{ message: { content: [{ image: 'https://artifact.fixture.invalid/photo.png' }] } }] }
  });
  if (url === 'https://artifact.fixture.invalid/photo.png') return new Response(buffers[format]);
  throw new Error('unexpected fixture request');
};
async function generate(modelRef = account.id + '::responses-image', extra = {}) {
  const start = calls.length;
  const result = await runAction({}, 'image', { prompt: 'fixture prompt', model: modelRef, ...extra });
  const task = await inspectProviderTaskForDsh(result.taskId);
  assert.equal(task.deliveryState, 'ready'); assert.equal(task.attempts.length, 1);
  assert.equal(task.modelRef, modelRef); assert.equal(task.artifactIds.length, 1);
  const media = await readCoreArtifactMediaForDsh(task.artifactIds[0]);
  assert.equal(media.artifact.mediaType, 'image/' + format); assert.deepEqual(media.bytes, buffers[format]);
  assert.equal(media.artifact.digest.value, crypto.createHash('sha256').update(buffers[format]).digest('hex'));
  assert(fs.existsSync(path.join(dshCoreDataRoot(), 'artifact-store/v0/objects', media.artifact.id + (format === 'jpeg' ? '.jpg' : '.' + format))));
  assert(!JSON.stringify(task).includes('base64') && !JSON.stringify(task).includes('fixture-key'));
  assert(!JSON.stringify(task).includes('fixture prompt'));
  const submissions = calls.slice(start).filter(call => call.body?.model);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].auth, 'Bearer ' + (modelRef.startsWith(other.id + '::') ? 'other-fixture-key' : 'responses-fixture-key'));
  return submissions[0];
}
try {
  for (format of ['png', 'jpeg', 'webp']) for (shape of ['tool', 'message', 'url', 'tool-and-message']) {
    assert((await generate()).url.endsWith('/responses'));
  }
  format = 'jpeg'; shape = 'tool';
  for (const [model, endpoint] of [['chat-image', '/chat/completions'], ['images-image', '/images/generations'],
    ['qwen-image-3.0', '/multimodal-generation/generation']]) {
    assert((await generate(account.id + '::' + model)).url.endsWith(endpoint));
  }
  await generate(other.id + '::responses-image');
  const bindings = account.models.map(model => providerTaskBinding(providerForImageModel(account, model.id)));
  assert(bindings.every(Boolean)); assert.equal(new Set(bindings).size, 4, '同账号不同协议使用不同任务绑定');
  for (shape of ['text', 'bad-base64', 'tool-pending', 'message-pending', 'partial-tools', 'missing-image', 'in_progress', 'incomplete', 'failed']) {
    const start = calls.length;
    let error;
    try { await runAction({}, 'image', { prompt: 'fixture prompt' }); } catch (e) { error = e; }
    assert(error?.taskId);
    const task = await inspectProviderTaskForDsh(error.taskId);
    assert.equal(task.acceptance, 'unknown'); assert.equal(task.artifactIds.length, 0);
    assert.equal(task.attempts.length, 1); assert.equal(task.attempts[0].error.category, 'protocol');
    assert.equal(calls.length, start + 1, '未知响应不换协议、不换模型、不重提');
  }
  shape = 'tool';
  for (status of [401, 429]) {
    const start = calls.length;
    let error;
    try { await runAction({}, 'image', { prompt: 'fixture prompt', model: account.id + '::responses-image' }); } catch (e) { error = e; }
    const task = await inspectProviderTaskForDsh(error.taskId);
    assert.equal(task.acceptance, 'not_accepted'); assert.equal(task.attempts[0].error.httpStatus, status);
    assert.equal(calls.length, start + 1);
  }
  assert(config.modelHealth(account.id, 'responses-image', 'image-gen').retryAt);
  const startBlocked = calls.length;
  let blocked;
  try { await runAction({}, 'image', { prompt: 'fixture prompt', model: account.id + '::responses-image' }); } catch (e) { blocked = e; }
  assert(blocked); assert.equal(calls.length, startBlocked, 'Responses 复用已持久化冷却');
  config.setModelVerified(account.id, 'responses-image', 'image-gen', { ok: true });
  status = 200;
  const adapter = createConfiguredProviderAdapter(providerForImageModel(config.providerById(account.id), 'responses-image'));
  const snapshot = providerAdapterSnapshot(adapter);
  assert.equal(snapshot.operations.poll.status, 'unsupported'); assert.equal(snapshot.operations.cancel.status, 'unsupported');
  const beforeInvalid = calls.length;
  const invalid = await invokeProviderOperation(adapter, 'submit', {
    capability: 'image', model: 'responses-image', input: { prompt: 'fixture prompt', n: 2 }
  });
  assert.equal(invalid.kind, 'not_accepted'); assert.equal(invalid.error.category, 'invalid_request');
  assert.equal(calls.length, beforeInvalid, '多图数量请求前拒绝');
  const withSize = await generate(account.id + '::responses-image', { size: '1024*1024' });
  assert.equal(withSize.body.tools[0].size, '1024x1024');
  assert.equal(config.providerById(account.id).mediaProtocol, 'openai-images');
  console.log('PASS Responses 生图：官方工具/网关消息/URL，PNG/JPEG/WebP 原字节，四协议混池/跨账号，未知零重提，429 冷却，n/size 与同步边界');
} finally { globalThis.fetch = originalFetch; }
