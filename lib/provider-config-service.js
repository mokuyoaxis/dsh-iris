import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProviderCatalog, providerCatalogSnapshot, catalogCapabilitySnapshot } from './provider-catalog.js';
import { isKnownCapability } from './capability.js';
import { providerModels, modelPool, functionPolicy, savedAssignmentRefs, parseModelRef, HOST_VISION_REF, capabilitiesOfDiscoveredModel, hasConfiguredModelCapabilities, resolvePoolModel } from './models.js';
import { atomicWritePrivate, privateSibling, ensurePrivateDir } from './private-storage.js';
import { createConfiguredProviderAdapter } from './provider-adapters.js';
import { selectImageProtocol, normalizeImageProtocol, normalizeMusicProtocol, isConfiguredProvider, providerForImageModel, providerApiKey } from './provider-protocol.js';
import { invokeProviderOperation } from './provider-adapter.js';
import { redactProviderMessage } from './provider-contract.js';
import { modelRateLimit, recordModelRateLimit, clearModelRateLimit, clearModelCapabilityHealth, isDefinitiveHealthFailure, recordModelAvailability, resetHealthOnCriticalChange } from './provider-health.js';
import { normalizeVisionInputLimits, visionInputLimits } from './vision-image-input.js';
import { currentModelDirectory, modelDirectoryBinding, modelAvailabilityBinding } from './model-directory.js';
import { refreshModelDirectory } from './model-directory-service.js';
import { projectProviderSettings, applyProviderSettings } from './provider-settings.js';
import { checkedComfyWorkflow, compileComfyWorkflow, projectComfyWorkflow } from './comfyui-workflow.js';
import { createComfyUiClient } from './comfyui-client.js';
import { inspectComfyWorkflow } from './comfyui-inspection.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'IRIS_CONFIG_INPUT_INVALID' }); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safe = value => redactProviderMessage(String(value || '').replace(/https?:\/\/[^\s<>"']+/gi, '[URL]'));
const text = value => { if (typeof value !== 'string' || !value.trim()) fail('ID 必须是非空字符串'); return value.trim(); };
const caps = value => {
  if (!Array.isArray(value) || !value.every(isKnownCapability) || new Set(value).size !== value.length) fail('capabilities 必须是不重复的已知能力数组');
  return value;
};

function assignmentSnapshot(catalog) {
  const pool = modelPool(catalog.providers, { includeHostVision: true });
  return Object.fromEntries(Object.entries(catalog.assignments || {}).map(([capability, value]) => {
    const policy = functionPolicy(value, capability);
    const refs = policy.models.map(ref => resolvePoolModel(pool, ref, capability));
    return [safe(capability), { mode: policy.mode, hostVision: policy.hostVision,
      model_refs: refs.filter(Boolean).map(model => safe(model.ref)), invalidRefs: refs.filter(ref => !ref).length }];
  }));
}

export function configSnapshot(catalog, registry) {
  return { ...providerCatalogSnapshot(catalog), models: catalog.providers.flatMap(provider => providerModels(provider).map(model => ({
    ref: safe(model.ref), providerId: safe(provider.id), id: safe(model.id), capabilities: model.capabilities,
    ...(model.catalogStatus ? { catalogStatus: model.catalogStatus } : {}),
    ...(model.unavailableCapabilities ? { unavailableCapabilities: model.unavailableCapabilities } : {}),
    ...(model.imageProtocol !== undefined ? { imageProtocol: model.imageProtocol } : {}),
    ...(model.musicProtocol !== undefined ? { musicProtocol: model.musicProtocol } : {}),
    ...(model.visionInput !== undefined ? { visionInput: model.visionInput } : {}),
    ...(provider.models?.find(entry => entry?.id === model.id)?.comfyWorkflow ? {
      comfyWorkflow: projectComfyWorkflow(provider.models.find(entry => entry?.id === model.id).comfyWorkflow) } : {}),
    ...(model.capabilities.includes('vision') ? { visionInputEffective: visionInputLimits(provider, model.id) } : {}),
    ...(model.capabilities.includes('image-gen') ? { imageRouting: selectImageProtocol(provider, model.id, registry) } : {}),
    verified: Object.fromEntries(Object.entries(model.verified || {}).map(([capability, value]) => [capability, { ok: value.ok === true, at: safe(value.at), category: safe(value.category) }])),
    ...(model.rateLimited ? { rateLimited: true, rateLimitedAt: modelRateLimit(provider, model.id).at,
      ...(modelRateLimit(provider, model.id).until ? { retryAt: modelRateLimit(provider, model.id).until }
        : { reason: modelRateLimit(provider, model.id).reason }) } : {})
  }))), assignments: assignmentSnapshot(catalog), routing: catalogCapabilitySnapshot(catalog, registry) };
}

export async function executeConfigCommand(configPath, command, input = {}, { signal, probe, registry } = {}) {
  if (command === 'init') {
    if (!path.isAbsolute(configPath)) fail('provider-config 必须是绝对路径');
    ensurePrivateDir(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ providers: [], assignments: {} }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { command, created: true };
  }
  const catalog = loadProviderCatalog(configPath);
  const before = fs.readFileSync(configPath);
  if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(catalog)) throw Object.assign(new Error('配置在读取期间发生变化，请重试'), { code: 'IRIS_CONFIG_CHANGED' });
  if (command === 'settings.show') return projectProviderSettings(catalog, hash(before), registry);
  if (command === 'models.workflow-check' || command === 'settings.workflow-check') {
    const settings = command === 'settings.workflow-check';
    const allowed = settings ? ['expectedRevision', 'modelRef', 'workflowParameters'] : ['model_ref', 'workflow_parameters'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('工作流检查包含不支持的字段');
    if (settings && input.expectedRevision !== hash(before)) throw Object.assign(new Error('配置已变化，请重新读取后检查'), { code: 'IRIS_CONFIG_CHANGED' });
    const ref = parseModelRef(settings ? input.modelRef : input.model_ref);
    if (!ref) fail('需要明确的 providerId::modelId');
    const matches = catalog.providers.filter(provider => provider.id === ref.providerId);
    if (matches.length !== 1 || !isConfiguredProvider(matches[0]) || !matches[0].models?.some(model => model.id === ref.modelId)) fail('请先配置并启用明确的工作流连接');
    const provider = providerForImageModel(matches[0], ref.modelId, registry);
    if (provider.mediaProtocol !== 'comfyui') fail('此检查仅用于 ComfyUI 工作流');
    const workflow = compileComfyWorkflow(provider.comfyWorkflow, { workflow_parameters: settings ? input.workflowParameters : input.workflow_parameters });
    const report = await inspectComfyWorkflow(createComfyUiClient(provider), workflow, { signal });
    signal?.throwIfAborted();
    if (hash(fs.readFileSync(configPath)) !== hash(before)) throw Object.assign(new Error('检查期间配置已变化，请重新检查'), { code: 'IRIS_CONFIG_CHANGED' });
    const key = providerApiKey(provider);
    return { ...JSON.parse(key ? JSON.stringify(report).split(key).join('[redacted]') : JSON.stringify(report)), revision: hash(before) };
  }
  if (command === 'settings.save' || command === 'settings.discover') {
    if (!input || typeof input.expectedRevision !== 'string' || input.expectedRevision !== hash(before)) {
      throw Object.assign(new Error('配置已变化，请重新读取后核对草稿'), { code: 'IRIS_CONFIG_CHANGED' });
    }
    if (command === 'settings.discover') {
      if (Object.keys(input).some(key => !['expectedRevision', 'providerId'].includes(key))) fail('目录请求包含不支持的字段');
      const found = catalog.providers.filter(item => item.id === input.providerId);
      if (found.length !== 1 || !isConfiguredProvider(found[0])) fail('请先保存并启用有认证配置的连接');
      const discovered = await invokeProviderOperation(createConfiguredProviderAdapter(found[0], { registry }), 'discover', { signal, timeoutMs: 10000 });
      signal?.throwIfAborted();
      if (hash(fs.readFileSync(configPath)) !== hash(before)) throw Object.assign(new Error('目录读取期间配置已变化'), { code: 'IRIS_CONFIG_CHANGED' });
      return { contractVersion: 0, revision: hash(before), models: discovered.models.slice(0, 256).map(model => ({
        id: safe(text(typeof model === 'string' ? model : model.id)).split(found[0].apiKey || '\u0000').join('[redacted]'), capabilities: capabilitiesOfDiscoveredModel(model)
      })), truncated: discovered.models.length > 256, persisted: false };
    }
    applyProviderSettings(catalog, input, registry);
    signal?.throwIfAborted();
    writeConfigChange(configPath, catalog, before, {});
    return projectProviderSettings(catalog, hash(fs.readFileSync(configPath)), registry);
  }
  if (command === 'show') return configSnapshot(catalog, registry);
  if (command === 'check') {
    const issues = [];
    const ids = catalog.providers.map(provider => provider.id);
    if (new Set(ids).size !== ids.length) issues.push('duplicate_provider_id');
    const pool = modelPool(catalog.providers, { includeHostVision: true });
    for (const provider of catalog.providers) {
      try { normalizeVisionInputLimits(provider.visionInput); } catch (_) { issues.push('invalid_vision_input'); }
      for (const model of provider.models || []) {
        if (model?.musicProtocol !== undefined) {
          try { normalizeMusicProtocol(model.musicProtocol, registry); } catch (_) { issues.push('invalid_model_music_protocol'); }
        }
        try { normalizeVisionInputLimits(model?.visionInput); } catch (_) { issues.push('invalid_model_vision_input'); }
        if (model?.imageProtocol === undefined) continue;
        try { normalizeImageProtocol(model.imageProtocol, registry); } catch (_) { issues.push('invalid_model_image_protocol'); }
      }
    }
    for (const [capability, assignment] of Object.entries(catalog.assignments || {})) {
      if (!isKnownCapability(capability)) issues.push('unknown_assignment_capability');
      const policy = functionPolicy(assignment, capability);
      if (policy.mode === 'manual') for (const ref of policy.models) if (!resolvePoolModel(pool, ref, capability)) issues.push('unavailable_assignment_model');
    }
    return { valid: issues.length === 0, issues: [...new Set(issues)] };
  }
  if (command === 'models.list') return { models: configSnapshot(catalog, registry).models };
  if (command === 'assignments.list') return { ...catalogCapabilitySnapshot(catalog, registry), assignments: assignmentSnapshot(catalog) };
  let result = { command, changed: true };
  const initialPool = modelPool(catalog.providers);
  let provider;
  const providerId = input.provider_id || parseModelRef(input.model_ref)?.providerId || input.provider?.id;
  if (providerId) {
    const matches = catalog.providers.filter(value => value.id === providerId);
    if (matches.length > 1) fail('Provider ID 不唯一');
    provider = matches[0];
  }
  if (command === 'providers.add' || command === 'providers.set') {
    const value = input.provider;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('需要 provider 对象');
    const id = text(value.id);
    if (command === 'providers.add' ? Boolean(provider) : !provider) fail(command === 'providers.add' ? 'Provider 已存在' : 'Provider 不存在');
    const updated = { ...(provider || {}), ...value, id };
    if (updated.visionInput !== undefined) updated.visionInput = normalizeVisionInputLimits(updated.visionInput) || null;
    let url;
    try { url = new URL(updated.baseUrl); } catch (_) { fail('baseUrl 必须是 HTTP(S) 地址'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('baseUrl 含不支持的协议或凭据参数');
    if (updated.enabled !== undefined && typeof updated.enabled !== 'boolean') fail('enabled 必须是布尔值');
    if (updated.models !== undefined) {
      if (!Array.isArray(updated.models)) fail('models 必须是数组');
      for (const model of updated.models) {
        text(typeof model === 'string' ? model : model?.id);
        if (model?.capabilities !== undefined) caps(model.capabilities);
      }
      updated.models = updated.models.map(model => typeof model === 'string' ? model : ({ ...model,
        ...(model?.imageProtocol !== undefined ? { imageProtocol: normalizeImageProtocol(model.imageProtocol, registry) } : {}),
        ...(model?.comfyWorkflow !== undefined ? { comfyWorkflow: checkedComfyWorkflow(model.comfyWorkflow) } : {}),
        ...(model?.musicProtocol !== undefined ? { musicProtocol: normalizeMusicProtocol(model.musicProtocol, registry) } : {}),
        ...(model?.visionInput !== undefined ? { visionInput: normalizeVisionInputLimits(model.visionInput) || null } : {}) }));
    }
    if (provider) {
      for (const model of providerModels(provider)) {
        if (selectImageProtocol(provider, model.id, registry).mediaProtocol !== selectImageProtocol(updated, model.id, registry).mediaProtocol
            || JSON.stringify(provider.models?.find(entry => entry?.id === model.id)?.comfyWorkflow)
              !== JSON.stringify(updated.models?.find(entry => entry?.id === model.id)?.comfyWorkflow)) {
          clearModelCapabilityHealth(updated, model.id, 'image-gen');
        }
      }
      resetHealthOnCriticalChange(provider, updated, value);
    }
    if (provider) catalog.providers[catalog.providers.indexOf(provider)] = updated;
    else catalog.providers.push(updated);
  } else if (command === 'providers.remove') {
    if (!provider) fail('Provider 不存在');
    catalog.providers.splice(catalog.providers.indexOf(provider), 1);
  } else if (command.startsWith('models.')) {
    if (!provider) fail('Provider 不存在');
    const parsed = parseModelRef(input.model_ref);
    const modelId = parsed?.modelId || input.model_id;
    let entries = Array.isArray(provider.models) ? provider.models.map(model => typeof model === 'string' ? { id: model } : { ...model })
      : providerModels(provider).map(({ id, capabilities }) => ({ id, capabilities }));
    let entry = entries.find(model => model.id === modelId);
    if (command === 'models.discover') {
      const discovered = await invokeProviderOperation(createConfiguredProviderAdapter(provider, { registry }), 'discover', { signal, timeoutMs: 15000 });
      const models = discovered.models.map(model => ({ id: text(typeof model === 'string' ? model : model.id), capabilities: capabilitiesOfDiscoveredModel(model), source: 'discovered' }));
      result = { command, changed: input.apply === true, total: models.length, mediaCount: models.filter(model => model.capabilities.length).length, models: models.map(model => ({ ...model, id: safe(model.id) })) };
      if (input.apply !== true) return result;
      provider.modelDirectory = { version: 1, binding: modelDirectoryBinding(provider), checkedAt: new Date().toISOString(),
        models: models.map(({ id, capabilities }) => ({ id, capabilities })),
        added: models.filter(model => !entries.some(entry => entry.id === model.id)).map(model => model.id) };
      for (const model of models) {
        const old = entries.find(value => value.id === model.id);
        if (!old) entries.push(model);
        else if (!hasConfiguredModelCapabilities(provider, model.id)) Object.assign(old, model);
      }
    } else if (command === 'models.add') {
      text(modelId);
      const capabilities = input.capabilities === undefined ? undefined : caps(input.capabilities);
      if (entry) fail('模型已存在；请用 models caps 修改能力');
      entries.push({ id: modelId, capabilities, source: 'manual',
        ...(input.imageProtocol !== undefined ? { imageProtocol: normalizeImageProtocol(input.imageProtocol, registry) } : {}),
        ...(input.musicProtocol !== undefined ? { musicProtocol: normalizeMusicProtocol(input.musicProtocol, registry) } : {}),
        ...(input.visionInput !== undefined ? { visionInput: normalizeVisionInputLimits(input.visionInput) || null } : {}) });
    } else if (command === 'models.remove') {
      if (!entry) fail('模型不存在');
      entries = entries.filter(model => model.id !== modelId);
    } else if (command === 'models.caps') {
      if (!entry) fail('模型不存在');
      entry.capabilities = caps(input.capabilities); entry.source = 'manual';
    } else if (command === 'models.protocol') {
      if (!entry) fail('模型不存在');
      const protocol = normalizeImageProtocol(input.imageProtocol, registry);
      const previous = selectImageProtocol(provider, modelId, registry).mediaProtocol;
      if (protocol === 'auto') delete entry.imageProtocol;
      else entry.imageProtocol = protocol;
      provider.models = entries;
      if (previous !== selectImageProtocol(provider, modelId, registry).mediaProtocol) clearModelCapabilityHealth(provider, modelId, 'image-gen');
      result = { ...result, model_ref: safe(input.model_ref), imageRouting: selectImageProtocol(provider, modelId, registry) };
    } else if (command === 'models.music-protocol') {
      if (!entry) fail('模型不存在');
      const protocol = normalizeMusicProtocol(input.musicProtocol, registry);
      if (entry.musicProtocol !== protocol) clearModelCapabilityHealth(provider, modelId, 'music-gen');
      entry.musicProtocol = protocol;
      result = { ...result, model_ref: safe(input.model_ref), musicProtocol: protocol };
    } else if (command === 'models.vision-input') {
      if (!entry || !Object.hasOwn(input, 'visionInput')) fail('需要已存在的模型和 visionInput 对象或 null');
      const limits = normalizeVisionInputLimits(input.visionInput);
      if (limits) entry.visionInput = limits;
      else delete entry.visionInput;
      provider.models = entries;
      result = { ...result, model_ref: safe(input.model_ref), visionInputEffective: visionInputLimits(provider, modelId) };
    } else if (command === 'models.test') {
      if (!entry || !isKnownCapability(input.capability) || !providerModels(provider).find(model => model.id === modelId)?.capabilities.includes(input.capability)) fail('模型不存在或没有指定能力');
      if (typeof probe !== 'function') fail('模型实测缺少 Probe Port');
      const tested = await probe({ provider, modelId, capability: input.capability, signal });
      if (tested.skipped) return { command, changed: false, ...tested };
      const evidence = { at: new Date().toISOString(), source: 'probe', category: tested.category || (tested.ok ? 'success' : 'unknown'),
        ...(tested.providerCode ? { providerCode: safe(tested.providerCode) } : {}),
        ...(tested.httpStatus || tested.status ? { httpStatus: tested.httpStatus || tested.status } : {}) };
      entry.verified = { ...(entry.verified || {}), [input.capability]: { ok: tested.ok === true, ...evidence } };
      provider.health ||= { version: 1, revision: 0, observations: [] };
      const observations = provider.health.observations;
      let observation = observations.find(value => value.modelId === modelId && value.capability === input.capability);
      if (!observation) { observation = { modelId, capability: input.capability }; observations.push(observation); }
      recordModelAvailability(provider, modelId, input.capability, { ...tested, ...evidence });
      if (tested.ok === true) { observation.lastSuccess = evidence; clearModelRateLimit(provider, modelId); }
      else {
        observation[isDefinitiveHealthFailure(evidence) ? 'lastFailure' : 'lastTransient'] = evidence;
        recordModelRateLimit(provider, modelId, evidence);
      }
      result = { command, changed: true, passed: tested.ok === true, ...(tested.taskId ? { taskId: tested.taskId } : {}), ...(tested.code ? { code: tested.code } : {}) };
    } else fail('未知模型命令');
    provider.models = entries;
    if (['models.add', 'models.caps'].includes(command) && input.enableAutomatic !== undefined) {
      if (typeof input.enableAutomatic !== 'boolean') fail('enableAutomatic 必须是布尔值');
      if (input.enableAutomatic) for (const capability of caps(input.capabilities)) {
        catalog.assignments ||= {};
        const previous = functionPolicy(catalog.assignments[capability], capability);
        catalog.assignments[capability] = { mode: 'auto', models: savedAssignmentRefs(modelPool(catalog.providers, { includeHostVision: true }), capability, previous.models),
          ...(capability === 'vision' ? { hostVision: previous.hostVision } : {}) };
      }
    }
  } else if (command === 'assignments.set' || command === 'assignments.clear') {
    if (!isKnownCapability(input.capability)) fail('未知能力');
    catalog.assignments ||= {};
    if (command === 'assignments.clear') delete catalog.assignments[input.capability];
    else if (input.mode !== undefined) {
      const previous = functionPolicy(catalog.assignments[input.capability], input.capability);
      const next = { mode: input.mode, models: savedAssignmentRefs(modelPool(catalog.providers, { includeHostVision: true }), input.capability, previous.models),
        ...(input.capability === 'vision' ? { hostVision: input.hostVision ?? previous.hostVision } : {}) };
      functionPolicy(next, input.capability);
      if (input.hostVision && input.capability !== 'vision') fail('hostVision 仅用于视觉');
      if (input.model_refs !== undefined) {
        if (!Array.isArray(input.model_refs) || new Set(input.model_refs).size !== input.model_refs.length) fail('model_refs 必须是不重复的引用数组');
        const pool = modelPool(catalog.providers, { includeHostVision: true });
        for (const ref of input.model_refs) if ((typeof ref !== 'string' || (!parseModelRef(ref) && ref !== HOST_VISION_REF))
            || !resolvePoolModel(pool, ref, input.capability)) fail('分配模型不存在或没有该能力');
        next.models = input.model_refs;
      }
      catalog.assignments[input.capability] = next;
    } else {
      if (!Array.isArray(input.model_refs) || new Set(input.model_refs).size !== input.model_refs.length) fail('model_refs 必须是不重复的复合引用数组');
      const pool = modelPool(catalog.providers, { includeHostVision: true });
      for (const ref of input.model_refs) if ((!parseModelRef(ref) && ref !== HOST_VISION_REF) || !resolvePoolModel(pool, ref, input.capability)) fail('分配模型不存在或没有该能力');
      catalog.assignments[input.capability] = input.model_refs;
    }
  } else fail('未知配置命令');

  // 移除/降级条目时剪去明确指向该条目的分配，保留其他账号和旧裸引用格式。
  if (command === 'providers.remove' || command === 'models.remove' || command === 'models.caps') {
    const pool = modelPool(catalog.providers);
    for (const [capability, assignment] of Object.entries(catalog.assignments || {})) {
      const values = functionPolicy(assignment, capability).models.filter(ref => resolvePoolModel(pool, ref, capability) || !resolvePoolModel(initialPool, ref, capability));
      if (assignment && typeof assignment === 'object' && !Array.isArray(assignment) && Object.hasOwn(assignment, 'mode')) catalog.assignments[capability] = { ...assignment, models: values };
      else if (!values.length) delete catalog.assignments[capability];
      else catalog.assignments[capability] = Array.isArray(assignment) ? values : values[0];
    }
  }
  signal?.throwIfAborted();
  return writeConfigChange(configPath, catalog, before, result);
}

/** 请求边界持久化冷却或明确耗尽；沿用配置锁、备份与原子写入。 */
export function recordCatalogRateLimit(configPath, event) {
  const { providerId, modelId } = event;
  const catalog = loadProviderCatalog(configPath);
  const before = fs.readFileSync(configPath);
  const provider = catalog.providers.find(value => value.id === providerId);
  if (!provider || !recordModelRateLimit(provider, modelId, { ...event, source: 'task' })) return;
  return writeConfigChange(configPath, catalog, before, { changed: true });
}

/** CLI真实提交的可用性证据，复用同一配置锁；不为可重建元数据新增备份。 */
export function recordCatalogAvailability(configPath, { providerId, modelId, capability, ...event }) {
  const catalog = loadProviderCatalog(configPath);
  const before = fs.readFileSync(configPath);
  const provider = catalog.providers.find(item => item.id === providerId);
  const cap = { image: 'image-gen', video: 'video-gen', music: 'music-gen' }[capability] || capability;
  if (!provider || (event.binding && modelAvailabilityBinding(provider, modelId, cap) !== event.binding)
      || !recordModelAvailability(provider, modelId, capability, event)) return;
  const directory = currentModelDirectory(provider);
  if (directory && event.ok !== true) directory.invalidatedAt = event.at || new Date().toISOString();
  return writeConfigChange(configPath, catalog, before, { changed: true }, { backup: false });
}

/** 新的自动请求按需读取目录；只读CLI命令与手选/停用不走这里。 */
export async function refreshCatalogDirectories(configPath, catalog, capability, { signal, registry } = {}) {
  if (functionPolicy(catalog.assignments?.[capability], capability).mode !== 'auto') return [];
  return Promise.all(catalog.providers.filter(provider => isConfiguredProvider(provider)
    && providerModels(provider).some(model => model.capabilities.includes(capability))).map(provider =>
    refreshModelDirectory(provider, { signal, registry, save: directory => {
      const fresh = loadProviderCatalog(configPath);
      const before = fs.readFileSync(configPath);
      const current = fresh.providers.find(item => item.id === provider.id);
      if (!current || modelDirectoryBinding(current) !== directory.binding) return false;
      current.modelDirectory = directory;
      writeConfigChange(configPath, fresh, before, { changed: true }, { backup: false });
      provider.modelDirectory = directory;
      return true;
    } })));
}

function writeConfigChange(configPath, catalog, before, result, { backup = true } = {}) {
  const lock = configPath + '.lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (_) { throw Object.assign(new Error('配置正在被另一进程修改'), { code: 'IRIS_CONFIG_BUSY' }); }
  try {
    loadProviderCatalog(configPath);
    if (hash(fs.readFileSync(configPath)) !== hash(before)) throw Object.assign(new Error('配置在操作期间发生变化，请重新读取后重试'), { code: 'IRIS_CONFIG_CHANGED' });
    if (backup) {
      const backupPath = privateSibling(configPath, 'backup');
      fs.writeFileSync(backupPath, before, { flag: 'wx', mode: 0o600 });
      result.backupPath = backupPath;
    }
    atomicWritePrivate(configPath, JSON.stringify(catalog, null, 2) + '\n');
    return result;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
