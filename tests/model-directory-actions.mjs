import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { CAPABILITIES } from '../lib/capability.js';
import { modelDirectoryBinding, modelAvailabilityBinding, modelUnavailable, isModelNotFound } from '../lib/model-directory.js';
import { recordModelAvailability } from '../lib/provider-health.js';
import { defineHostAdapter } from '../lib/host-contract.js';
import { withDshProviderConfig } from '../lib/dsh-provider-config.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';
import { ttsCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding } from '../lib/provider-catalog.js';

useTempDshHome('iris-model-directory-actions');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const p = config.upsert({ id: 'catalog', name: 'fixture', enabled: true, auth: 'none',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
  models: [{ id: 'old', capabilities: ['tts'] }, { id: 'custom-unlisted', capabilities: ['tts'], source: 'manual' }] });
config.setFunctionPolicy('tts', 'auto');
const snapshot = () => ({ providers: config.allProviders(), assignments: config.assignments() });
const originalFetch = globalThis.fetch;
const calls = [];
let fail = false;
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), method: options?.method || 'GET' });
  assert.equal(options?.method || 'GET', 'GET', '本组管理动作不能生成媒体');
  if (fail) throw new Error('catalog unavailable fixture');
  return Response.json({ output: { total: 1, models: [{ id: 'qwen3-tts-flash', capabilities: ['TTS'] }] } });
};
try {
  const beforeModels = structuredClone(p.models), beforePolicy = structuredClone(config.assignments());
  await runAction({}, 'providers_list'); await runAction({}, 'assignments_get');
  assert.equal(calls.length, 0, '只读配置检查不访问供应商');
  const synced = await runAction({}, 'providers_sync_directory', { id: p.id, force: true });
  assert.equal(synced.synced, true); assert.equal(calls.length, 1);
  assert.deepEqual(config.allProviders()[0].models, beforeModels);
  assert.deepEqual(config.assignments(), beforePolicy);
  const view = await runAction({}, 'providers_list');
  const listed = view.providers.find(provider => provider.id === p.id);
  assert.deepEqual(listed.directory.missing, ['old', 'custom-unlisted']);
  assert.equal(listed.models.find(model => model.id === 'qwen3-tts-flash').source, 'discovered');
  assert.equal(listed.models.find(model => model.id === 'old').catalogStatus, 'unlisted');
  assert(!config.assignmentOrder('tts').includes(p.id + '::qwen3-tts-flash'), '目录新项仍需用途确认');
  assert.equal(ttsCandidatesFromCatalog(snapshot()).length, 2, '目录未列出不单独阻止自定义模型');
  config.setModelVerified(p.id, 'old', 'tts', { ok: true, at: new Date().toISOString() });
  const success = structuredClone(p.health.observations.find(value => value.modelId === 'old').lastSuccess);
  config.recordProviderHealth(p.id, 'old', 'tts', { ok: false, httpStatus: 404, category: 'invalid_request',
    providerCode: 'NotFound.Model', note: 'Model not exist.', source: 'probe' });
  assert(modelUnavailable(p, 'old', 'tts'));
  assert.equal(config.modelHealth(p.id, 'old', 'tts').modelUnavailable, true);
  assert.deepEqual(p.health.observations.find(value => value.modelId === 'old').lastSuccess, success, '保留历史成功');
  assert.deepEqual(ttsCandidatesFromCatalog(snapshot()).map(row => row.model), ['custom-unlisted']);
  const assignment = await runAction({}, 'assignments_get');
  assert.equal(assignment.poolByCapability.tts.find(model => model.id === 'old').modelUnavailable, true);
  assert(assignment.order.tts.includes(p.id + '::old'), '界面保留已隔离条目及恢复入口');
  assert.equal(assignment.readiness.tts.candidateCount, 1);
  assert.throws(() => ttsCandidatesFromCatalog(snapshot(), p.id + '::old'), /模型不存在/);
  const task = { capability: 'tts', providerId: p.id, modelRef: p.id + '::old', providerBinding: providerTaskBinding(p) };
  assert.equal(providerForTaskFromCatalog(snapshot(), task).id, p.id, '旧任务恢复不经过当前目录和候选隔离');
  config.recordProviderHealth(p.id, 'old', 'tts', { ok: true, source: 'task' });
  assert(modelUnavailable(p, 'old', 'tts'), '旧任务成功不解除新提交阻断');
  config.recordProviderHealth(p.id, 'old', 'tts', { ok: false, source: 'probe', category: 'network' });
  assert(modelUnavailable(p, 'old', 'tts'), '网络探针失败不抹掉已有明确阻断');
  const isolated = { ...p, apiKey: 'new-key', auth: 'bearer' };
  assert.equal(modelUnavailable(isolated, 'old', 'tts'), null, '可用性不串到新连接');
  assert.equal(modelUnavailable(p, 'old', 'vision'), null, '可用性按能力隔离');
  config.recordProviderHealth(p.id, 'custom-unlisted', 'tts', { ok: false, stage: 'poll', httpStatus: 404, providerCode: 'model_not_found', note: 'Model not exist.' });
  assert.equal(modelUnavailable(p, 'custom-unlisted', 'tts'), null, '旧任务轮询错误不能阻断新提交');
  fail = true;
  const previous = structuredClone(p.modelDirectory.models);
  const failed = await runAction({}, 'providers_sync_directory', { id: p.id, force: true });
  assert.equal(failed.synced, false);
  assert.deepEqual(p.modelDirectory.models, previous);
  assert.equal((await runAction({}, 'providers_list')).providers[0].directory.status, 'stale');
  fail = false;
  config.recordProviderHealth(p.id, 'old', 'tts', { ok: true, source: 'probe' });
  assert.equal(modelUnavailable(p, 'old', 'tts'), null, '显式成功实测恢复');
  assert.equal(ttsCandidatesFromCatalog(snapshot()).length, 2);
  const canonical = Object.values(CAPABILITIES);
  for (const capability of canonical) {
    config.recordProviderHealth(p.id, 'old', capability, { ok: false, source: 'task', httpStatus: 404, providerCode: 'model_not_found' });
    assert(modelUnavailable(p, 'old', capability));
  }
  for (const value of [{ httpStatus: 404, providerCode: 'NotFound', note: 'Request path not found.' },
    { httpStatus: 400, providerCode: 'InvalidParameter', note: 'Unsupported voice' },
    { httpStatus: 401, providerCode: 'InvalidApiKey' }, { httpStatus: 429 }, { category: 'timeout' }]) assert.equal(isModelNotFound(value), false);
  const legacy = { ...p, health: { version: 1, revision: 0, observations: [{ modelId: 'old', capability: 'tts',
    lastTransient: { at: new Date().toISOString(), httpStatus: 404, note: '模型或参数不受支持：Model not exist.' } }] } };
  assert(modelUnavailable(legacy, 'old', 'tts'), '已有精确404证据直接生效，无需迁移');
  const adapter = createConfiguredProviderAdapter(p);
  const before = calls.length;
  const rejected = await invokeProviderOperation(adapter, 'submit', { capability: 'tts', model: 'old', input: { text: '你好' } });
  assert.equal(rejected.kind, 'not_accepted'); assert.equal(rejected.error.stage, 'validate');
  assert.equal(calls.length, before, '直接Adapter提交也不得绕过阻断');
  config.resetCache();
  assert(modelUnavailable(config.allProviders()[0], 'old', 'tts'), '重新读取配置仍保留明确阻断');
  const stored = JSON.parse(fs.readFileSync(path.join(config.irisHome(), 'providers.json')));
  assert.equal(stored.version, 1);
  assert.equal(stored.providers[0].modelDirectory.binding, modelDirectoryBinding(config.allProviders()[0]));
  const imageProvider = { id: 'image-connection', auth: 'none', baseUrl: 'https://fixture.invalid/v1', mediaProtocol: 'openai-images',
    models: [{ id: 'canvas', capabilities: ['image-gen'], imageProtocol: 'openai-images' }] };
  recordModelAvailability(imageProvider, 'canvas', 'image-gen', { httpStatus: 404, providerCode: 'model_not_found', stage: 'submit' });
  assert(modelUnavailable(imageProvider, 'canvas', 'image-gen'));
  const otherProtocol = { ...imageProvider, models: [{ ...imageProvider.models[0], imageProtocol: 'openai-chat-images' }] };
  assert.notEqual(modelAvailabilityBinding(imageProvider, 'canvas', 'image-gen'), modelAvailabilityBinding(otherProtocol, 'canvas', 'image-gen'));
  assert.equal(modelUnavailable(otherProtocol, 'canvas', 'image-gen'), null, '图片有效协议变化不能沿用旧404');

  let hostKey = 'fixture-host-key-one';
  const host = defineHostAdapter({ id: 'directory-fixture', ports: { providerConnections: {
    async resolve() { return { baseUrl: 'https://host.fixture.invalid/v1', apiKey: hostKey }; }
  } } });
  const shared = config.upsert({ id: 'host-directory', dshProvider: { provider: 'fixture', settingsNs: 'fixture' },
    mediaProtocol: 'openai-images', models: [{ id: 'host-image', capabilities: ['image-gen'] }] });
  const at = new Date().toISOString();
  await withDshProviderConfig(host, async () => {
    const effective = config.runtimeProviders().find(item => item.id === shared.id);
    assert(config.saveModelDirectory(shared.id, { version: 1, binding: modelDirectoryBinding(effective), checkedAt: at, models: [], added: [] }));
    config.recordAvailability({ providerId: shared.id, modelId: 'host-image', capability: 'image-gen', httpStatus: 404,
      providerCode: 'model_not_found', stage: 'submit', binding: modelAvailabilityBinding(effective, 'host-image', 'image-gen') });
    assert(modelUnavailable(config.runtimeProviders().find(item => item.id === shared.id), 'host-image', 'image-gen'));
  });
  hostKey = 'fixture-host-key-two';
  await withDshProviderConfig(host, async () => {
    const effective = config.runtimeProviders().find(item => item.id === shared.id);
    assert.equal(modelUnavailable(effective, 'host-image', 'image-gen'), null, '宿主轮换密钥即失效旧阻断');
    const oldDirectory = shared.modelDirectory;
    assert.equal(config.saveModelDirectory(shared.id, oldDirectory), false, '旧请求不能覆盖新连接目录');
    assert.equal(config.recordAvailability({ providerId: shared.id, modelId: 'host-image', capability: 'image-gen',
      ok: false, httpStatus: 404, providerCode: 'model_not_found', binding: oldDirectory.binding }), false);
    assert(config.recordAvailability({ providerId: shared.id, modelId: 'host-image', capability: 'image-gen',
      ok: true, stage: 'submit', binding: modelAvailabilityBinding(effective, 'host-image', 'image-gen') }));
  });
  assert.equal(config.modelHealth(shared.id, 'host-image', 'image-gen').modelUnavailable, undefined, '新连接成功提交后只读界面不再展示旧连接阻断');
  const text = fs.readFileSync(path.join(config.irisHome(), 'providers.json'), 'utf8');
  assert(!text.includes('fixture-host-key-') && !text.includes('host.fixture.invalid'), '宿主目录与可用性仅保存摘要，不复制凭据或端点');
  await runAction({}, 'providers_confirm_model', { id: p.id, model_id: 'qwen3-tts-flash', capabilities: ['tts'] });
  assert(ttsCandidatesFromCatalog(snapshot()).some(row => row.model === 'qwen3-tts-flash'), '纯目录新项通过现有用途确认入口后即可加入已启用的自动池');
  assert.equal(calls.length, before, '确认目录模型用途不发起付费请求或重新同步');
} finally { globalThis.fetch = originalFetch; }
console.log('PASS 管理与共享候选：只读零请求、未列出保留、待确认新项、404隔离/恢复、连接/能力边界和旧任务恢复');
