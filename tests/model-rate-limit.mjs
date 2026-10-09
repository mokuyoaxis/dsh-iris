import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-model-rate-limit');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const { imageCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding } = await import('../lib/provider-catalog.js');
const { modelRef } = await import('../lib/models.js');
const model = 'qwen-image-3.0-pro';
const makeProvider = name => config.upsert({ name, baseUrl: 'https://fixture.invalid/v1',
  apiKey: name + '-secret', type: 'openai', mediaProtocol: 'openai-images',
  models: [{ id: model, capabilities: ['image-gen', 'vision'] }, { id: 'sibling-image', capabilities: ['image-gen'] }] });
const primary = makeProvider('primary');
const fallback = makeProvider('fallback');
config.setAssignmentOrder('image-gen', [modelRef(primary.id, model), modelRef(fallback.id, model)]);
const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
const imageFile = path.join(root, 'input.png'); fs.writeFileSync(imageFile, png);
let primaryStatus = 429;
let primaryCode = 'Throttling.AllocationQuota', primaryMessage = 'Allocated quota exceeded, please increase your quota limit.';
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const input = JSON.parse(options.body);
  const account = options.headers.Authorization === 'Bearer primary-secret' ? 'primary' : 'fallback';
  requests.push({ account, model: input.model, url: String(url) });
  if (input.model === 'sibling-image') return Response.json({ error: { message: 'server failure' } }, { status: 500 });
  if (input.model === model && account === 'primary' && primaryStatus !== 200) {
    return Response.json({ error: { code: primaryCode, message: primaryMessage } }, { status: primaryStatus, headers: { 'Retry-After': '120' } });
  }
  if (String(url).endsWith('/chat/completions')) return new Response(
    'data: {"choices":[{"delta":{"content":"红色"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
  return Response.json({ data: [{ b64_json: png.toString('base64') }] });
};
try {
  const first = await runAction({}, 'image', { prompt: 'fixture' });
  assert.equal(first.providerId, fallback.id);
  assert.deepEqual(requests.map(value => value.account), ['primary', 'fallback']);
  const blocked = config.modelHealth(primary.id, model, 'image-gen');
  assert.equal(blocked.status, 'failed'); assert.equal(blocked.rateLimited, true); assert.equal(blocked.httpStatus, 429);
  assert.equal(Date.parse(blocked.retryAt) - Date.parse(blocked.observedAt), 120000, 'HTTP Retry-After 实际传递至持久冷却');
  assert.equal(config.modelHealth(primary.id, model, 'vision').rateLimited, true, '停用按模型覆盖所有能力');
  assert.equal(config.modelHealth(fallback.id, model, 'image-gen').status, 'verified', '同名模型不同账号不受影响');
  assert.equal(config.providerHealthSnapshot().capabilities['image-gen'].status, 'verified', '可用 fallback 仍显示绿色');
  assert(!JSON.stringify(config.providerHealthSnapshot()).includes('secret'));
  assert.deepEqual(imageCandidatesFromCatalog({ providers: config.allProviders(), assignments: config.assignments() }).map(route => route.modelRef),
    config.pickAllFor('image-gen').map(provider => modelRef(provider.id, provider.imageModel)), 'CLI 与 DSH 跳过同一模型');
  await runAction({}, 'image', { prompt: 'second' });
  assert.equal(requests.filter(value => value.account === 'primary').length, 1, '第二个请求不再扫描首次 429 模型');
  config.resetCache();
  await runAction({}, 'image', { prompt: 'reloaded' });
  assert.equal(requests.filter(value => value.account === 'primary').length, 1, '重载后仍跳过');
  await assert.rejects(runAction({}, 'image', { prompt: 'explicit', model: modelRef(primary.id, model) }), { code: 'IRIS_PROVIDER_MODEL_RATE_LIMITED' });
  assert.equal(requests.length, 4, '显式生成不会绕过停用');

  config.mergeDiscoveredModels(primary.id, [{ id: model, capabilities: ['image-gen', 'vision'] }]);
  config.setAssignmentOrder('image-gen', [modelRef(primary.id, model), modelRef(fallback.id, model)]);
  config.upsert({ id: primary.id, name: 'renamed', apiKey: 'primary-secret', baseUrl: 'https://fixture.invalid/new/v1' });
  assert.equal(config.modelHealth(primary.id, model, 'image-gen').rateLimited, true, '发现、分配与端点变更不解除停用');
  config.setProviderModels(primary.id, []);
  config.addProviderModel(primary.id, model, ['image-gen', 'vision']);
  assert.equal(config.modelHealth(primary.id, model, 'image-gen').rateLimited, true, '移除再添加模型仍需实测');
  config.recordProviderHealth(primary.id, model, 'image-gen', { ok: true, source: 'task' });
  assert.equal(config.modelHealth(primary.id, model, 'image-gen').rateLimited, true, '旧任务成功不恢复');
  await assert.rejects(runAction({}, 'providers_test_model', { id: primary.id, model_id: model, capability: 'image-gen' }), /确认/);
  assert.equal(requests.length, 4, '恢复实测保留既有真实请求确认');
  const failedProbe = await runAction({}, 'providers_test_model', { id: primary.id, model_id: model, capability: 'image-gen', confirm_paid: true });
  assert.equal(failedProbe.passed, false); assert.equal(requests.length, 5, '失败实测只调用指定模型一次，无 fallback');
  assert.equal(config.modelHealth(primary.id, model, 'image-gen').observedAt, blocked.observedAt, '保留首次停用时间');
  primaryStatus = 500;
  await runAction({}, 'providers_test_model', { id: primary.id, model_id: model, capability: 'image-gen', confirm_paid: true });
  assert.equal(config.modelHealth(primary.id, model, 'image-gen').rateLimited, true, '非 429 的失败实测也不能恢复');
  primaryStatus = 200;
  const recovered = await runAction({}, 'providers_test_model', { id: primary.id, model_id: model, capability: 'image-gen', confirm_paid: true });
  assert.equal(recovered.passed, true); assert.equal(config.modelHealth(primary.id, model, 'image-gen').status, 'verified');
  assert.equal(config.modelHealth(primary.id, model, 'vision').rateLimited, undefined, '成功实测恢复该账号的模型');
  assert.equal((await runAction({}, 'image', { prompt: 'restored' })).providerId, primary.id);

  // OCR 的多个切片复用候选，但首次 429 后不得在每个切片重复调用它。
  primaryStatus = 429;
  config.setAssignmentOrder('vision', [modelRef(primary.id, model), modelRef(fallback.id, model)]);
  const longFile = path.join(root, 'long.png');
  fs.writeFileSync(longFile, await sharp({ create: { width: 8, height: 500, channels: 3, background: '#fff' } }).png().toBuffer());
  const beforeOcr = requests.length;
  const ocr = await runAction({}, 'ocr', { image_path: longFile, chunk_height: 100, overlap: 0 });
  assert.equal(ocr.status, 'complete');
  assert.equal(requests.slice(beforeOcr).filter(value => value.account === 'primary').length, 1);
  assert(requests.slice(beforeOcr).filter(value => value.account === 'fallback').length > 1);
  const visionProbe = await runAction({}, 'providers_test_model', { id: primary.id, model_id: model, capability: 'vision', confirm_paid: true });
  assert.equal(visionProbe.passed, false); assert.equal(config.modelHealth(primary.id, model, 'vision').rateLimited, true);
  primaryStatus = 200;
  assert.equal((await runAction({}, 'providers_test_model', { id: primary.id, model_id: model, capability: 'vision', confirm_paid: true })).passed, true);
  assert.equal(config.modelHealth(primary.id, model, 'vision').status, 'verified');

  config.addProviderModel(primary.id, 'sibling-image', ['image-gen']);
  await assert.rejects(runAction({}, 'image', { prompt: '500', model: modelRef(primary.id, 'sibling-image') }));
  assert.equal(config.modelHealth(primary.id, 'sibling-image', 'image-gen').rateLimited, undefined, '500 不停用');
  for (const status of [401, 403]) {
    primaryStatus = status; primaryCode = 'Workspace.AccessDenied'; primaryMessage = 'Permission denied';
    await assert.rejects(runAction({}, 'image', { prompt: 'authentication', model: modelRef(primary.id, model) }));
    assert.equal(config.modelHealth(primary.id, model, 'image-gen').rateLimited, undefined, '普通认证错误不误判为额度耗尽');
  }
  primaryStatus = 403; primaryCode = 'AllocationQuota.FreeTierOnly'; primaryMessage = 'Free quota exhausted.';
  await assert.rejects(runAction({}, 'image', { prompt: 'free quota', model: modelRef(primary.id, model) }));
  const quota = config.modelHealth(primary.id, model, 'image-gen', { now: Date.now() + 8 * 86400000 });
  assert.equal(quota.reason, 'free_quota'); assert.equal(quota.retryAt, undefined);
  primaryStatus = 200;
  assert.equal((await runAction({}, 'providers_test_model', { id: primary.id, model_id: model, capability: 'image-gen', confirm_paid: true })).passed, true);
  primaryStatus = 429; primaryCode = 'BudgetLimitExceeded'; primaryMessage = 'Budget exceeded';
  await assert.rejects(runAction({}, 'image', { prompt: 'budget', model: modelRef(primary.id, model) }));
  assert.equal(config.modelHealth(primary.id, model, 'image-gen', { now: Date.now() + 8 * 86400000 }).reason, 'budget');
  const savedProvider = config.providerById(primary.id);
  config.recordRateLimit({ providerId: primary.id, modelId: model, capability: 'image' });
  assert.equal(providerForTaskFromCatalog({ providers: config.allProviders() }, { capability: 'image', providerId: primary.id,
    modelRef: modelRef(primary.id, model), providerBinding: providerTaskBinding(savedProvider) }).id, primary.id,
  '已受理 Task 的 Provider 恢复解析不受模型停用阻断');
  console.log('PASS 请求边界分类：短时 429/Retry-After、403 免费额度、429 预算、跨重载/账号隔离、实测恢复、OCR 切片与旧任务解析');
} finally { globalThis.fetch = originalFetch; stopProviderTaskWatchesForDsh(); }
