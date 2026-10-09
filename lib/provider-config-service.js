import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProviderCatalog, providerCatalogSnapshot, catalogCapabilitySnapshot } from './provider-catalog.js';
import { isKnownCapability } from './capability.js';
import { providerModels, modelPool, parseModelRef, capabilitiesOfModel, capabilitiesOfDiscoveredModel, resolvePoolModel } from './models.js';
import { atomicWritePrivate, privateSibling, ensurePrivateDir } from './private-storage.js';
import { createConfiguredProviderAdapter } from './provider-adapters.js';
import { selectImageProtocol, normalizeImageProtocol } from './provider-protocol.js';
import { invokeProviderOperation } from './provider-adapter.js';
import { redactProviderMessage } from './provider-contract.js';
import { modelRateLimit, recordModelRateLimit, clearModelRateLimit, clearModelCapabilityHealth, isDefinitiveHealthFailure } from './provider-health.js';
import { normalizeVisionInputLimits, visionInputLimits } from './vision-image-input.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'IRIS_CONFIG_INPUT_INVALID' }); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safe = value => redactProviderMessage(String(value || '').replace(/https?:\/\/[^\s<>"']+/gi, '[URL]'));
const text = value => { if (typeof value !== 'string' || !value.trim()) fail('ID 必须是非空字符串'); return value.trim(); };
const caps = value => {
  if (!Array.isArray(value) || !value.every(isKnownCapability) || new Set(value).size !== value.length) fail('capabilities 必须是不重复的已知能力数组');
  return value;
};

function assignmentSnapshot(catalog) {
  const pool = modelPool(catalog.providers);
  return Object.fromEntries(Object.entries(catalog.assignments || {}).map(([capability, value]) => {
    const refs = (Array.isArray(value) ? value : [value]).map(ref => resolvePoolModel(pool, ref, capability));
    return [safe(capability), { model_refs: refs.filter(Boolean).map(model => safe(model.ref)), invalidRefs: refs.filter(ref => !ref).length }];
  }));
}

export function configSnapshot(catalog) {
  return { ...providerCatalogSnapshot(catalog), models: catalog.providers.flatMap(provider => providerModels(provider).map(model => ({
    ref: safe(model.ref), providerId: safe(provider.id), id: safe(model.id), capabilities: model.capabilities,
    ...(model.imageProtocol !== undefined ? { imageProtocol: model.imageProtocol } : {}),
    ...(model.visionInput !== undefined ? { visionInput: model.visionInput } : {}),
    ...(model.capabilities.includes('vision') ? { visionInputEffective: visionInputLimits(provider, model.id) } : {}),
    ...(model.capabilities.includes('image-gen') ? { imageRouting: selectImageProtocol(provider, model.id) } : {}),
    verified: Object.fromEntries(Object.entries(model.verified || {}).map(([capability, value]) => [capability, { ok: value.ok === true, at: safe(value.at), category: safe(value.category) }])),
    ...(model.rateLimited ? { rateLimited: true, rateLimitedAt: modelRateLimit(provider, model.id).at,
      ...(modelRateLimit(provider, model.id).until ? { retryAt: modelRateLimit(provider, model.id).until }
        : { reason: modelRateLimit(provider, model.id).reason }) } : {})
  }))), assignments: assignmentSnapshot(catalog), routing: catalogCapabilitySnapshot(catalog) };
}

export async function executeConfigCommand(configPath, command, input = {}, { signal, probe } = {}) {
  if (command === 'init') {
    if (!path.isAbsolute(configPath)) fail('provider-config 必须是绝对路径');
    ensurePrivateDir(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ providers: [], assignments: {} }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { command, created: true };
  }
  const catalog = loadProviderCatalog(configPath);
  const before = fs.readFileSync(configPath);
  if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(catalog)) throw Object.assign(new Error('配置在读取期间发生变化，请重试'), { code: 'IRIS_CONFIG_CHANGED' });
  if (command === 'show') return configSnapshot(catalog);
  if (command === 'check') {
    const issues = [];
    const ids = catalog.providers.map(provider => provider.id);
    if (new Set(ids).size !== ids.length) issues.push('duplicate_provider_id');
    const pool = modelPool(catalog.providers);
    for (const provider of catalog.providers) {
      try { normalizeVisionInputLimits(provider.visionInput); } catch (_) { issues.push('invalid_vision_input'); }
      for (const model of provider.models || []) {
        try { normalizeVisionInputLimits(model?.visionInput); } catch (_) { issues.push('invalid_model_vision_input'); }
        if (model?.imageProtocol === undefined) continue;
        try { normalizeImageProtocol(model.imageProtocol); } catch (_) { issues.push('invalid_model_image_protocol'); }
      }
    }
    for (const [capability, assignment] of Object.entries(catalog.assignments || {})) {
      if (!isKnownCapability(capability)) issues.push('unknown_assignment_capability');
      for (const ref of (Array.isArray(assignment) ? assignment : [assignment])) if (!resolvePoolModel(pool, ref, capability)) issues.push('unavailable_assignment_model');
    }
    return { valid: issues.length === 0, issues: [...new Set(issues)] };
  }
  if (command === 'models.list') return { models: configSnapshot(catalog).models };
  if (command === 'assignments.list') return { ...catalogCapabilitySnapshot(catalog), assignments: assignmentSnapshot(catalog) };
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
        ...(model?.imageProtocol !== undefined ? { imageProtocol: normalizeImageProtocol(model.imageProtocol) } : {}),
        ...(model?.visionInput !== undefined ? { visionInput: normalizeVisionInputLimits(model.visionInput) || null } : {}) }));
    }
    if (provider) {
      for (const model of providerModels(provider)) {
        if (selectImageProtocol(provider, model.id).mediaProtocol !== selectImageProtocol(updated, model.id).mediaProtocol) {
          clearModelCapabilityHealth(updated, model.id, 'image-gen');
        }
      }
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
      const discovered = await invokeProviderOperation(createConfiguredProviderAdapter(provider), 'discover', { signal, timeoutMs: 15000 });
      const models = discovered.models.map(model => ({ id: text(typeof model === 'string' ? model : model.id), capabilities: capabilitiesOfDiscoveredModel(model), source: 'discovered' }));
      result = { command, changed: input.apply === true, total: models.length, mediaCount: models.filter(model => model.capabilities.length).length, models: models.map(model => ({ ...model, id: safe(model.id) })) };
      if (input.apply !== true) return result;
      for (const model of models) {
        if (!model.capabilities.length) continue;
        const old = entries.find(value => value.id === model.id);
        if (!old) entries.push(model);
        else if (old.source !== 'manual') Object.assign(old, model);
      }
    } else if (command === 'models.add') {
      text(modelId);
      const capabilities = input.capabilities === undefined ? capabilitiesOfModel(modelId) : caps(input.capabilities);
      if (entry) fail('模型已存在；请用 models caps 修改能力');
      entries.push({ id: modelId, capabilities, source: 'manual',
        ...(input.imageProtocol !== undefined ? { imageProtocol: normalizeImageProtocol(input.imageProtocol) } : {}),
        ...(input.visionInput !== undefined ? { visionInput: normalizeVisionInputLimits(input.visionInput) || null } : {}) });
    } else if (command === 'models.remove') {
      if (!entry) fail('模型不存在');
      entries = entries.filter(model => model.id !== modelId);
    } else if (command === 'models.caps') {
      if (!entry) fail('模型不存在');
      entry.capabilities = caps(input.capabilities); entry.source = 'manual';
    } else if (command === 'models.protocol') {
      if (!entry) fail('模型不存在');
      const protocol = normalizeImageProtocol(input.imageProtocol);
      const previous = selectImageProtocol(provider, modelId).mediaProtocol;
      if (protocol === 'auto') delete entry.imageProtocol;
      else entry.imageProtocol = protocol;
      provider.models = entries;
      if (previous !== selectImageProtocol(provider, modelId).mediaProtocol) clearModelCapabilityHealth(provider, modelId, 'image-gen');
      result = { ...result, model_ref: safe(input.model_ref), imageRouting: selectImageProtocol(provider, modelId) };
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
        ...(tested.httpStatus || tested.status ? { httpStatus: tested.httpStatus || tested.status } : {}) };
      entry.verified = { ...(entry.verified || {}), [input.capability]: { ok: tested.ok === true, ...evidence } };
      provider.health ||= { version: 1, revision: 0, observations: [] };
      const observations = provider.health.observations;
      let observation = observations.find(value => value.modelId === modelId && value.capability === input.capability);
      if (!observation) { observation = { modelId, capability: input.capability }; observations.push(observation); }
      if (tested.ok === true) { observation.lastSuccess = evidence; clearModelRateLimit(provider, modelId); }
      else {
        observation[isDefinitiveHealthFailure(evidence) ? 'lastFailure' : 'lastTransient'] = evidence;
        recordModelRateLimit(provider, modelId, evidence);
      }
      result = { command, changed: true, passed: tested.ok === true, ...(tested.taskId ? { taskId: tested.taskId } : {}), ...(tested.code ? { code: tested.code } : {}) };
    } else fail('未知模型命令');
    provider.models = entries;
  } else if (command === 'assignments.set' || command === 'assignments.clear') {
    if (!isKnownCapability(input.capability)) fail('未知能力');
    catalog.assignments ||= {};
    if (command === 'assignments.clear') delete catalog.assignments[input.capability];
    else {
      if (!Array.isArray(input.model_refs) || new Set(input.model_refs).size !== input.model_refs.length) fail('model_refs 必须是不重复的复合引用数组');
      const pool = modelPool(catalog.providers);
      for (const ref of input.model_refs) if (!parseModelRef(ref) || !resolvePoolModel(pool, ref, input.capability)) fail('分配模型不存在或没有该能力');
      catalog.assignments[input.capability] = input.model_refs;
    }
  } else fail('未知配置命令');

  // 移除/降级条目时剪去明确指向该条目的分配，保留其他账号和旧裸引用格式。
  if (command === 'providers.remove' || command === 'models.remove' || command === 'models.caps') {
    const pool = modelPool(catalog.providers);
    for (const [capability, assignment] of Object.entries(catalog.assignments || {})) {
      const values = (Array.isArray(assignment) ? assignment : [assignment]).filter(ref => resolvePoolModel(pool, ref, capability) || !resolvePoolModel(initialPool, ref, capability));
      if (!values.length) delete catalog.assignments[capability];
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

function writeConfigChange(configPath, catalog, before, result) {
  const lock = configPath + '.lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (_) { throw Object.assign(new Error('配置正在被另一进程修改'), { code: 'IRIS_CONFIG_BUSY' }); }
  try {
    loadProviderCatalog(configPath);
    if (hash(fs.readFileSync(configPath)) !== hash(before)) throw Object.assign(new Error('配置在操作期间发生变化，请重新读取后重试'), { code: 'IRIS_CONFIG_CHANGED' });
    const backupPath = privateSibling(configPath, 'backup');
    fs.writeFileSync(backupPath, before, { flag: 'wx', mode: 0o600 });
    atomicWritePrivate(configPath, JSON.stringify(catalog, null, 2) + '\n');
    result.backupPath = backupPath;
    return result;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
