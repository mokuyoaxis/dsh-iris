'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITIES } from './capability.js';
import { modelPool, orderedModels, providerModels, parseModelRef, resolveModelRef, resolvePoolModel, selectionReasonForModel } from './models.js';
import { dashscopeApiBase, selectMediaProtocol, providerMediaBaseUrl, isConfiguredProvider } from './provider-protocol.js';
import { redactProviderMessage } from './provider-contract.js';

export class ProviderCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderCatalogError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderCatalogError(code, message);
}

/** Headless 边界只读取显式配置文件；不推断 DSH_HOME、HOME 或 cwd。 */
export function loadProviderCatalog(configPath) {
  const supplied = String(configPath || '').trim();
  if (!supplied || !path.isAbsolute(supplied)) {
    fail('IRIS_PROVIDER_CONFIG_INVALID', 'provider-config 必须是显式绝对路径');
  }
  let source;
  try {
    const stat = fs.lstatSync(supplied);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      fail('IRIS_PROVIDER_CONFIG_PERMISSIONS', 'provider-config 权限过宽；请限制为仅当前用户可读写');
    }
    source = fs.readFileSync(supplied, 'utf8');
  } catch (error) {
    if (error instanceof ProviderCatalogError) throw error;
    fail('IRIS_PROVIDER_CONFIG_UNREADABLE', 'provider-config 不存在、不是普通文件或无法读取');
  }
  let parsed;
  try { parsed = JSON.parse(source); }
  catch (_) { fail('IRIS_PROVIDER_CONFIG_INVALID', 'provider-config 不是有效 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Array.isArray(parsed.providers)
      || (parsed.assignments !== undefined && (!parsed.assignments || typeof parsed.assignments !== 'object'
        || Array.isArray(parsed.assignments)))) {
    fail('IRIS_PROVIDER_CONFIG_INVALID', 'provider-config 结构无效');
  }
  return parsed;
}

const CANDIDATE_CAP_LABEL = Object.freeze({
  [CAPABILITIES.IMAGE]: '图片', [CAPABILITIES.VIDEO]: '视频',
  [CAPABILITIES.TTS]: '语音', [CAPABILITIES.TRANSCRIBE]: '转写'
});

/** 与稳定配置层相同的“手工顺序优先、池序补齐”候选规则（image/video/tts/transcribe 同构）。 */
function candidatesFromCatalog(catalog, requestedModelRef, capability) {
  const label = CANDIDATE_CAP_LABEL[capability];
  if (!label) fail('IRIS_PROVIDER_TASK_OBSERVE_UNSUPPORTED', '当前 Headless 候选链只开放图片、视频、语音与转写能力');
  const providers = catalog.providers.filter(isConfiguredProvider);
  const pool = modelPool(providers).filter((item) => item.capabilities.includes(capability));
  const requested = String(requestedModelRef || '').trim();
  if (requested) {
    const parsed = parseModelRef(requested);
    if (!parsed && requested.includes('::')) fail('IRIS_PROVIDER_MODEL_INVALID', 'model_ref 格式无效');
    const exact = resolvePoolModel(pool, requested, capability);
    if (!exact) fail('IRIS_PROVIDER_MODEL_UNAVAILABLE', `指定模型不存在、未启用或没有${label}能力`);
    const provider = providers.find((item) => item.id === exact.providerId);
    return Object.freeze([Object.freeze({
      provider, model: exact.id, modelRef: resolveModelRef(provider, capability, requested),
      selectionReason: 'explicit'
    })]);
  }
  const assignment = catalog.assignments?.[capability];
  const ordered = orderedModels(pool, capability, assignment);
  if (!ordered.length) fail('IRIS_PROVIDER_MODEL_UNAVAILABLE', `provider-config 中没有可用${label}模型`);
  return Object.freeze(ordered.map((item) => Object.freeze({
    provider: providers.find((provider) => provider.id === item.providerId),
    model: item.id,
    modelRef: item.ref,
    selectionReason: selectionReasonForModel(pool, capability, assignment, item)
  })));
}

export function imageCandidatesFromCatalog(catalog, requestedModelRef = '') {
  return candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.IMAGE);
}

export function videoCandidatesFromCatalog(catalog, requestedModelRef = '') {
  return candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.VIDEO);
}

export function ttsCandidatesFromCatalog(catalog, requestedModelRef = '') {
  return candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.TTS);
}

export function transcribeCandidatesFromCatalog(catalog, requestedModelRef = '') {
  return candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.TRANSCRIBE);
}

/** 只读配置投影；不构造 Adapter、不发现模型、不暴露端点或凭据。 */
export function providerCatalogSnapshot(catalog) {
  const safeLabel = (value) => value
    ? redactProviderMessage(String(value).replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')) : '';
  return {
    schemaVersion: 1,
    providers: catalog.providers.filter((provider) => provider && typeof provider === 'object').map((provider) => {
      const models = providerModels(provider);
      const selection = selectMediaProtocol(provider);
      return {
        id: safeLabel(provider.id), name: safeLabel(provider.name || provider.id),
        enabled: provider.enabled !== false, configured: isConfiguredProvider(provider),
        auth: provider.auth === 'none' ? 'none' : 'bearer',
        mediaProtocol: safeLabel(selection.mediaProtocol), protocolInferred: selection.protocolInferred,
        capabilities: Object.values(CAPABILITIES).filter((capability) => models.some((model) => model.capabilities.includes(capability))),
        modelCount: models.length
      };
    })
  };
}

export function catalogCapabilitySnapshot(catalog) {
  const pool = modelPool(catalog.providers.filter(isConfiguredProvider));
  return {
    schemaVersion: 1,
    source: 'configuration',
    capabilities: Object.values(CAPABILITIES).map((capability) => {
      const candidates = orderedModels(pool, capability, catalog.assignments?.[capability]).map((model) => model.ref);
      return { capability, candidates, ...(candidates.length ? {} : { gap: 'no_configured_model' }) };
    })
  };
}

/** 非敏感摘要把 Task 绑定到提交时实际使用的媒体端点与协议。 */
export function providerTaskBinding(provider) {
  const baseUrl = providerMediaBaseUrl(provider);
  const protocol = selectMediaProtocol(provider).mediaProtocol;
  let endpoint;
  try {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('unsafe endpoint');
    if (!['dashscope', 'openai-images'].includes(protocol)) throw new Error('unknown protocol');
    endpoint = protocol === 'dashscope' ? dashscopeApiBase(baseUrl) : url.href.replace(/\/+$/, '');
  } catch (_) { fail('IRIS_PROVIDER_CONFIG_INVALID', 'Provider 媒体端点或协议无效'); }
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify([1, protocol, endpoint])).digest('hex');
}

/** 恢复只使用 Task 已保存的 Provider/模型；忽略当前 assignment 与 failover 顺序。 */
export function providerForTaskFromCatalog(catalog, task) {
  const capability = CAPABILITIES[
    task?.capability === 'video' ? 'VIDEO'
      : task?.capability === 'image' ? 'IMAGE'
      : task?.capability === 'tts' ? 'TTS'
      : task?.capability === 'transcribe' ? 'TRANSCRIBE' : ''
  ];
  if (!capability) fail('IRIS_PROVIDER_TASK_OBSERVE_UNSUPPORTED', '当前 Headless 恢复解析只开放图片、视频、语音与转写 Task');
  const label = { video: '视频', tts: '语音', transcribe: '转写' }[task.capability] || '图片';
  const parsed = parseModelRef(task.modelRef);
  if (!parsed || parsed.providerId !== task.providerId) fail('IRIS_PROVIDER_TASK_IDENTITY_MISMATCH', 'Task 的 Provider 与模型身份不一致');
  const matches = catalog.providers.filter((item) => item && item.id === task.providerId);
  if (matches.length > 1) fail('IRIS_PROVIDER_CONFIG_AMBIGUOUS', 'provider-config 存在重复 Provider ID');
  const provider = matches[0];
  if (!provider || provider.enabled === false || (provider.auth !== 'none' && (typeof provider.apiKey !== 'string' || !provider.apiKey.trim()))) fail('IRIS_PROVIDER_TASK_PROVIDER_UNAVAILABLE', 'Task 原 Provider 已移除、停用或缺少凭据');
  if (!task.providerBinding) fail('IRIS_PROVIDER_TASK_BINDING_MISSING', '旧 Task 缺少提交端点绑定；仅支持只读查看，不猜测恢复配置');
  if (providerTaskBinding(provider) !== task.providerBinding) fail('IRIS_PROVIDER_TASK_BINDING_MISMATCH', 'Task 提交端点或协议已改变；拒绝向新端点观察原任务');
  const model = modelPool([provider]).find((item) => item.providerId === parsed.providerId && item.id === parsed.modelId && item.capabilities.includes(capability));
  if (!model) fail('IRIS_PROVIDER_MODEL_UNAVAILABLE', `Task 原模型已移除或不再具备${label}能力`);
  return provider;
}
