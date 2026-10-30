'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITIES } from './capability.js';
import { modelPool, functionModelPool, functionPolicy, orderedModels, providerModels, parseModelRef, resolveModelRef, resolvePoolModel, selectionReasonForModel } from './models.js';
import { selectMediaProtocol, providerForImageModel, providerForMusicModel, providerMediaBaseUrl, isConfiguredProvider, providerProtocolDescriptor } from './provider-protocol.js';
import { redactProviderMessage } from './provider-contract.js';
import { modelRateLimit } from './provider-health.js';
import { normalizeVisionInputLimits } from './vision-image-input.js';
import { modelDirectorySummary, modelUnavailableReason, validateModelDirectory } from './model-directory.js';
import { checkedComfyWorkflow, comfyWorkflowDigest } from './comfyui-workflow.js';
import { assertPluginDependencyMatches } from './plugin-contract.js';

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
  for (const [capability, assignment] of Object.entries(parsed.assignments || {})) functionPolicy(assignment, capability);
  for (const provider of parsed.providers) {
    validateModelDirectory(provider.modelDirectory);
    for (const model of provider.models || []) if (model?.comfyWorkflow !== undefined) checkedComfyWorkflow(model.comfyWorkflow);
  }
  return parsed;
}

const CANDIDATE_CAP_LABEL = Object.freeze({
  [CAPABILITIES.IMAGE]: '图片', [CAPABILITIES.VIDEO]: '视频',
  [CAPABILITIES.TTS]: '语音', [CAPABILITIES.TRANSCRIBE]: '转写', [CAPABILITIES.VISION]: '视觉',
  [CAPABILITIES.MUSIC]: '音乐'
});

/** 与 DSH 共用功能策略；CLI 不附加宿主资源。 */
function candidatesFromCatalog(catalog, requestedModelRef, capability, registry) {
  const label = CANDIDATE_CAP_LABEL[capability];
  if (!label) fail('IRIS_PROVIDER_TASK_OBSERVE_UNSUPPORTED', '当前 Headless 候选链只开放图片、视频、语音与转写能力');
  const providers = catalog.providers.filter(isConfiguredProvider);
  const configuredPool = functionModelPool(providers, capability, catalog.assignments?.[capability], { registry });
  const pool = orderedModels(configuredPool, capability, catalog.assignments?.[capability], { includeRateLimited: true, includeUnavailable: true });
  const requested = String(requestedModelRef || '').trim();
  if (requested) {
    const parsed = parseModelRef(requested);
    if (!parsed && requested.includes('::')) fail('IRIS_PROVIDER_MODEL_INVALID', 'model_ref 格式无效');
    const exact = resolvePoolModel(pool, requested, capability);
    if (!exact) fail('IRIS_PROVIDER_MODEL_UNAVAILABLE', `指定模型未分配给${label}功能、未启用或没有所需能力`);
    const provider = providers.find((item) => item.id === exact.providerId);
    if (exact.unavailableCapabilities?.includes(capability)) fail('IRIS_PROVIDER_MODEL_UNAVAILABLE', modelUnavailableReason());
    if (exact.rateLimited) fail('IRIS_PROVIDER_MODEL_RATE_LIMITED', modelRateLimit(provider, exact.id)?.until
      ? '指定模型正在限流冷却，请稍后使用或手动实测'
      : '指定模型额度或预算耗尽，请手动实测成功后再使用');
    return Object.freeze([Object.freeze({
      provider, model: exact.id, modelRef: resolveModelRef(provider, capability, requested),
      selectionReason: 'explicit'
    })]);
  }
  const assignment = catalog.assignments?.[capability];
  const ordered = pool.filter(model => !model.rateLimited && !model.unavailableCapabilities?.includes(capability));
  if (!ordered.length) fail('IRIS_PROVIDER_MODEL_UNAVAILABLE', `请检查${label}功能的启用方式、已确认模型、连接和协议；当前没有可用候选`);
  return Object.freeze(ordered.map((item) => Object.freeze({
    provider: providers.find((provider) => provider.id === item.providerId),
    model: item.id,
    modelRef: item.ref,
    selectionReason: selectionReasonForModel(configuredPool, capability, assignment, item)
  })));
}

export function imageCandidatesFromCatalog(catalog, requestedModelRef = '', registry) {
  return Object.freeze(candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.IMAGE, registry).map(route =>
    Object.freeze({ ...route, provider: providerForImageModel(route.provider, route.model, registry) })));
}

export function videoCandidatesFromCatalog(catalog, requestedModelRef = '', registry) {
  return candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.VIDEO, registry);
}

export function ttsCandidatesFromCatalog(catalog, requestedModelRef = '', registry) {
  return candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.TTS, registry);
}

export function musicCandidatesFromCatalog(catalog, requestedModelRef = '', registry) {
  return Object.freeze(candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.MUSIC, registry).map(route =>
    Object.freeze({ ...route, provider: providerForMusicModel(route.provider, route.model, registry) })));
}

export function transcribeCandidatesFromCatalog(catalog, requestedModelRef = '', registry) {
  return candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.TRANSCRIBE, registry);
}

export function visionCandidatesFromCatalog(catalog, requestedModelRef = '', registry) {
  return candidatesFromCatalog(catalog, requestedModelRef, CAPABILITIES.VISION, registry);
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
        ...(provider.visionInput ? { visionInput: normalizeVisionInputLimits(provider.visionInput) } : {}),
        capabilities: Object.values(CAPABILITIES).filter((capability) => models.some((model) => model.capabilities.includes(capability))),
        modelCount: models.length, directory: modelDirectorySummary(provider)
      };
    })
  };
}

export function catalogCapabilitySnapshot(catalog, registry) {
  return {
    schemaVersion: 1,
    source: 'configuration',
    capabilities: Object.values(CAPABILITIES).map((capability) => {
      const policy = functionPolicy(catalog.assignments?.[capability], capability);
      const pool = functionModelPool(catalog.providers.filter(isConfiguredProvider), capability, catalog.assignments?.[capability], { registry });
      const candidates = orderedModels(pool, capability, catalog.assignments?.[capability]).map((model) => model.ref);
      return { capability, mode: policy.mode, candidates, ...(candidates.length ? {} : { gap: 'no_configured_model' }) };
    })
  };
}

/** 非敏感摘要把 Task 绑定到提交时实际使用的媒体端点与协议。 */
export function providerTaskBinding(provider, registry) {
  const baseUrl = providerMediaBaseUrl(provider);
  const protocol = selectMediaProtocol(provider).mediaProtocol;
  let endpoint, descriptor;
  try {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('unsafe endpoint');
    descriptor = providerProtocolDescriptor(protocol, registry);
    if (!descriptor) throw new Error('unknown protocol');
    endpoint = descriptor.normalizeEndpoint(baseUrl);
    if (typeof endpoint !== 'string' || !endpoint) throw new Error('invalid normalized endpoint');
  } catch (_) { fail('IRIS_PROVIDER_CONFIG_INVALID', 'Provider 媒体端点或协议无效'); }
  const identity = protocol === 'comfyui' ? [2, protocol, endpoint, comfyWorkflowDigest(provider.comfyWorkflow)] : [1, protocol, endpoint];
  // Only the new unified plugin contract opts in. Legacy protocols retain their exact historical binding.
  if (descriptor.dependency) identity.push(descriptor.dependency);
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** 恢复只使用 Task 已保存的 Provider/模型；忽略当前 assignment 与 failover 顺序。 */
export function providerForTaskFromCatalog(catalog, task, registry) {
  const capability = CAPABILITIES[
    task?.capability === 'video' ? 'VIDEO'
      : task?.capability === 'image' ? 'IMAGE'
      : task?.capability === 'tts' ? 'TTS'
      : task?.capability === 'music' ? 'MUSIC'
      : task?.capability === 'transcribe' ? 'TRANSCRIBE' : ''
  ];
  if (!capability) fail('IRIS_PROVIDER_TASK_OBSERVE_UNSUPPORTED', '当前 Headless 恢复解析只开放图片、视频、语音与转写 Task');
  const label = { video: '视频', tts: '语音', music: '音乐', transcribe: '转写' }[task.capability] || '图片';
  const parsed = parseModelRef(task.modelRef);
  if (!parsed || parsed.providerId !== task.providerId) fail('IRIS_PROVIDER_TASK_IDENTITY_MISMATCH', 'Task 的 Provider 与模型身份不一致');
  const matches = catalog.providers.filter((item) => item && item.id === task.providerId);
  if (matches.length > 1) fail('IRIS_PROVIDER_CONFIG_AMBIGUOUS', 'provider-config 存在重复 Provider ID');
  const configured = matches[0];
  if (!configured || configured.enabled === false || (configured.auth !== 'none' && (typeof configured.apiKey !== 'string' || !configured.apiKey.trim()))) fail('IRIS_PROVIDER_TASK_PROVIDER_UNAVAILABLE', 'Task 原 Provider 已移除、停用或缺少凭据');
  const provider = task.capability === 'image' ? providerForImageModel(configured, parsed.modelId, registry)
    : task.capability === 'music' ? providerForMusicModel(configured, parsed.modelId, registry) : configured;
  assertPluginDependencyMatches(task.pluginDependency, providerProtocolDescriptor(selectMediaProtocol(provider).mediaProtocol, registry)?.dependency);
  if (!task.providerBinding) fail('IRIS_PROVIDER_TASK_BINDING_MISSING', '旧 Task 缺少提交端点绑定；仅支持只读查看，不猜测恢复配置');
  if (providerTaskBinding(provider, registry) !== task.providerBinding) fail('IRIS_PROVIDER_TASK_BINDING_MISMATCH', 'Task 提交端点、协议或插件依赖已改变；请恢复原配置和插件版本，不会重新提交');
  const model = modelPool([provider]).find((item) => item.providerId === parsed.providerId && item.id === parsed.modelId && item.capabilities.includes(capability));
  if (!model) fail('IRIS_PROVIDER_MODEL_UNAVAILABLE', `Task 原模型已移除或不再具备${label}能力`);
  return provider;
}
