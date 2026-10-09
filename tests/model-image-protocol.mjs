import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-model-image-protocol');
const config = await import('../lib/config.js');
const { modelRef, providerModels } = await import('../lib/models.js');
const { selectImageProtocol } = await import('../lib/provider-protocol.js');
const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
const { imageCandidatesFromCatalog, videoCandidatesFromCatalog, visionCandidatesFromCatalog,
  providerForTaskFromCatalog, providerTaskBinding } = await import('../lib/provider-catalog.js');
const { runAction } = await import('../lib/actions.js');
const { inspectProviderTaskForDsh, observeProviderTaskForDsh, readCoreArtifactMediaForDsh,
  stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const account = config.upsert({ name: 'one-account', type: 'openai', apiKey: 'protocol-fixture-key',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'openai-images',
  models: [
    { id: 'wan2.2-t2i-flash', capabilities: ['image-gen'], imageProtocol: 'dashscope', source: 'discovered' },
    { id: 'custom-image', capabilities: ['image-gen', 'vision'], source: 'discovered' },
    { id: 'custom-video', capabilities: ['video-gen'] }
  ] });
const nativeRef = modelRef(account.id, 'wan2.2-t2i-flash'), imagesRef = modelRef(account.id, 'custom-image');
config.setAssignmentOrder('image-gen', [nativeRef, imagesRef]);
const catalog = () => ({ providers: config.allProviders(), assignments: config.assignments() });
const routes = imageCandidatesFromCatalog(catalog());
assert.deepEqual(routes.map(route => [route.modelRef, route.provider.mediaProtocol]), [[nativeRef, 'dashscope'], [imagesRef, 'openai-images']]);
assert.equal(account.mediaProtocol, 'openai-images', '投影不修改账号默认协议');
assert.equal(videoCandidatesFromCatalog(catalog())[0].provider.mediaProtocol, 'openai-images');
assert.equal(visionCandidatesFromCatalog(catalog())[0].provider.mediaProtocol, 'openai-images');
assert.equal(providerModels(account)[0].imageProtocol, 'dashscope');
const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).png().toBuffer();
const originalFetch = globalThis.fetch;
const requests = [];
let mode = 'reject-native';
globalThis.fetch = async (input, options = {}) => {
  const url = String(input), body = options.body ? JSON.parse(options.body) : null;
  requests.push({ url, model: body?.model, auth: new Headers(options.headers).get('authorization') });
  if (url.endsWith('/text2image/image-synthesis')) {
    return mode === 'reject-native' ? Response.json({ code: 'InvalidApiKey', message: 'unauthorized' }, { status: 401 })
      : Response.json({ output: { task_id: 'protocol-remote' } });
  }
  if (url.endsWith('/images/generations')) return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  if (url.endsWith('/api/v1/tasks/protocol-remote')) return Response.json({ output: mode === 'complete'
    ? { task_status: 'SUCCEEDED', results: [{ url: 'https://artifact.invalid/protocol.png' }] } : { task_status: 'RUNNING' } });
  if (url === 'https://artifact.invalid/protocol.png') return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  if (new URL(url).pathname.endsWith('/models')) return Response.json({ output: { total: 2,
    models: [{ model: 'wan2.2-t2i-flash', capabilities: ['IG'] }, { model: 'custom-image', capabilities: ['IG', 'VU'] }] } });
  throw new Error('unexpected fixture request');
};
try {
  // 一个账号内按模型选择两个真正不同的接口；只在明确未受理时回退。
  const generated = await runAction({}, 'image', { prompt: 'fixture' });
  const task = await inspectProviderTaskForDsh(generated.taskId);
  assert.equal(task.attempts.length, 2); assert.equal(task.modelRef, imagesRef);
  assert.equal(task.outcome, 'succeeded'); assert.equal(task.deliveryState, 'ready');
  assert.deepEqual(requests.filter(request => request.model).map(request => [request.model, new URL(request.url).pathname]), [
    ['wan2.2-t2i-flash', '/api/v1/services/aigc/text2image/image-synthesis'],
    ['custom-image', '/compatible-mode/v1/images/generations']
  ]);
  assert(requests.filter(request => request.model).every(request => request.auth === 'Bearer protocol-fixture-key'));
  const delivered = await readCoreArtifactMediaForDsh(task.artifactIds[0]);
  assert.deepEqual(delivered.bytes, png);

  const beforeExplicit = requests.length;
  await assert.rejects(runAction({}, 'image', { prompt: 'explicit rejection', model: nativeRef }));
  assert.equal(requests.length, beforeExplicit + 1, '显式模型失败不扫描该模型的其他接口');
  assert(requests.at(-1).url.endsWith('/text2image/image-synthesis'));

  const beforeDiscovery = requests.length;
  await runAction({}, 'providers_discover', { id: account.id });
  assert.equal(requests.length, beforeDiscovery + 1, '发现只读取目录，不探测生图接口');
  assert.equal(config.providerById(account.id).models.find(model => model.id === 'wan2.2-t2i-flash').imageProtocol, 'dashscope');
  config.resetCache();
  assert.equal(imageCandidatesFromCatalog(catalog(), nativeRef)[0].provider.mediaProtocol, 'dashscope');

  // 原账号默认是 Images，恢复原生异步任务必须使用模型级 DashScope binding。
  mode = 'accepted';
  const accepted = await runAction({}, 'image', { prompt: 'async fixture', model: nativeRef });
  stopProviderTaskWatchesForDsh();
  const pending = await inspectProviderTaskForDsh(accepted.taskId);
  assert.equal(pending.providerBinding, providerTaskBinding(imageCandidatesFromCatalog(catalog(), nativeRef)[0].provider));
  const postCount = () => requests.filter(request => request.model).length;
  const submits = postCount();
  await runAction({}, 'providers_set_model_image_protocol', { id: account.id, model_id: 'custom-image', imageProtocol: 'dashscope' });
  assert.equal(providerForTaskFromCatalog(catalog(), pending).mediaProtocol, 'dashscope', '其他模型改变协议不影响原任务');
  await runAction({}, 'providers_set_model_image_protocol', { id: account.id, model_id: 'wan2.2-t2i-flash', imageProtocol: 'auto' });
  const beforeMismatch = requests.length;
  assert.throws(() => providerForTaskFromCatalog(catalog(), pending), { code: 'IRIS_PROVIDER_TASK_BINDING_MISMATCH' });
  assert.equal(requests.length, beforeMismatch, '原任务协议改变时联网前停止，不能查错接口或重新生成');
  await runAction({}, 'providers_set_model_image_protocol', { id: account.id, model_id: 'wan2.2-t2i-flash', imageProtocol: 'dashscope' });
  config.resetCache(); mode = 'complete';
  await observeProviderTaskForDsh({ taskId: pending.id, adapter: createConfiguredProviderAdapter(providerForTaskFromCatalog(catalog(), pending)) });
  const complete = await inspectProviderTaskForDsh(pending.id);
  assert.equal(complete.deliveryState, 'ready'); assert.equal(postCount(), submits, '恢复仅 poll/download，无新增 submit');

  // 协议修改使目标生图验证失效，保留视觉验证、其他模型验证和明确耗尽停用。
  config.setModelVerified(account.id, 'custom-image', 'image-gen', { ok: true });
  config.setModelImageProtocol(account.id, 'custom-image', 'dashscope');
  assert.equal(config.modelHealth(account.id, 'custom-image', 'image-gen').status, 'verified', '有效协议不变时保留验证');
  config.setModelVerified(account.id, 'custom-image', 'vision', { ok: true });
  config.setModelVerified(account.id, 'wan2.2-t2i-flash', 'image-gen', { ok: true });
  await runAction({}, 'providers_set_model_image_protocol', { id: account.id, model_id: 'custom-image', imageProtocol: 'openai-images' });
  assert.equal(config.modelHealth(account.id, 'custom-image', 'image-gen').status, 'configured');
  assert.equal(config.modelHealth(account.id, 'custom-image', 'vision').status, 'verified');
  assert.equal(config.modelHealth(account.id, 'wan2.2-t2i-flash', 'image-gen').status, 'verified');
  config.recordRateLimit({ providerId: account.id, modelId: 'custom-image', capability: 'image', httpStatus: 429, reason: 'budget' });
  await runAction({}, 'providers_set_model_image_protocol', { id: account.id, model_id: 'custom-image', imageProtocol: 'dashscope' });
  assert.equal(config.modelHealth(account.id, 'custom-image', 'image-gen').reason, 'budget');
  config.setModelVerified(account.id, 'custom-image', 'image-gen', { ok: true });
  const listed = await runAction({}, 'providers_list', {});
  const model = listed.providers[0].models.find(value => value.id === 'custom-image');
  assert.equal(model.imageRouting.mediaProtocol, 'dashscope'); assert.equal(model.imageRouting.protocolInferred, false);
  assert(!JSON.stringify(listed).includes('protocol-fixture-key'));
  const beforeInvalid = fs.readFileSync(path.join(config.irisHome(), 'providers.json'));
  await assert.rejects(runAction({}, 'providers_set_model_image_protocol', { id: account.id, model_id: 'custom-image', imageProtocol: 'unknown-image-protocol' }), { code: 'IRIS_PROVIDER_IMAGE_PROTOCOL_INVALID' });
  assert.deepEqual(fs.readFileSync(path.join(config.irisHome(), 'providers.json')), beforeInvalid, '本步未实现的协议不写入配置');
  const other = config.upsert({ name: 'same-model-other-account', baseUrl: account.baseUrl, apiKey: 'other-fixture-key',
    mediaProtocol: 'openai-images', models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }] });
  const beforeOther = requests.length;
  const otherResult = await runAction({}, 'image', { prompt: 'other account', model: modelRef(other.id, 'wan2.2-t2i-flash') });
  assert.equal(otherResult.providerId, other.id); assert.equal(requests.length, beforeOther + 1);
  assert.equal(requests.at(-1).auth, 'Bearer other-fixture-key'); assert(requests.at(-1).url.endsWith('/images/generations'));
  assert.equal(imageCandidatesFromCatalog(catalog(), nativeRef)[0].provider.mediaProtocol, 'dashscope', '同名跨账号不交换协议');
  const legacy = config.upsert({ baseUrl: account.baseUrl, apiKey: 'legacy-fixture-key', models: ['gpt-image-1'] });
  config.setModelImageProtocol(legacy.id, 'gpt-image-1', 'openai-images');
  assert.equal(selectImageProtocol(config.providerById(legacy.id), 'gpt-image-1').mediaProtocol, 'openai-images', '旧字符串模型可显式设置协议');
  const legacyFields = config.upsert({ baseUrl: account.baseUrl, apiKey: 'legacy-fields-key',
    imageModel: 'legacy-image', visionModel: 'legacy-vision' });
  config.setModelImageProtocol(legacyFields.id, 'legacy-image', 'openai-images');
  const legacyResult = await runAction({}, 'image', { prompt: 'legacy fields', model: modelRef(legacyFields.id, 'legacy-image') });
  assert.equal(legacyResult.providerId, legacyFields.id); assert(requests.at(-1).url.endsWith('/images/generations'));
  assert(providerModels(config.providerById(legacyFields.id)).some(model => model.id === 'legacy-vision' && model.capabilities.includes('vision')));
  const padded = config.upsert({ baseUrl: account.baseUrl, apiKey: 'padded-fixture-key', mediaProtocol: 'dashscope',
    models: [{ id: ' padded-image ', capabilities: ['image-gen'], imageProtocol: 'openai-images' }] });
  const paddedResult = await runAction({}, 'image', { prompt: 'padded ID', model: modelRef(padded.id, 'padded-image') });
  assert.equal(paddedResult.providerId, padded.id); assert(requests.at(-1).url.endsWith('/images/generations'));
  assert.equal(requests.at(-1).model, 'padded-image', '模型 ID 与现有选型一样去除空格，覆盖不丢失');
} finally { globalThis.fetch = originalFetch; stopProviderTaskWatchesForDsh(); }
console.log('PASS 模型图片协议：同账号真实双端点、Core 交付、发现/重载、恢复绑定与零重提、能力验证隔离、耗尽不绕过、旧配置兼容');
