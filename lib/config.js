'use strict';
/**
 * Iris 配置存储：$DSH_HOME/iris/v1/providers.json
 * Iris 独立持有配置；旧工作台仅作为用户显式指定的一次性导入来源。
 * Key 明文落盘（0600）；接口层永远不回明文。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as cap from './capability.js';
import * as models from './models.js';
import { atomicWritePrivate, chmodPrivateFile, privateSibling } from './private-storage.js';
import { inferMediaProtocol } from './provider-protocol.js';
import { redactProviderMessage } from './provider-contract.js';
import {
  PROVIDER_HEALTH_FRESH_MS,
  aggregateHealthStates,
  healthObservationState,
  isDefinitiveHealthFailure,
  newestHealthEvidence
} from './provider-health.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateStoredConfig(value) {
  if (!isPlainObject(value)) throw new Error('配置根节点必须是对象');
  if (!Array.isArray(value.providers)) throw new Error('providers 必须是数组');
  if (!isPlainObject(value.assignments)) throw new Error('assignments 必须是对象');
  for (const provider of value.providers) {
    if (!isPlainObject(provider)) throw new Error('provider 条目必须是对象');
    if (provider.id !== undefined && typeof provider.id !== 'string') throw new Error('provider.id 必须是字符串');
    if (provider.baseUrl !== undefined && typeof provider.baseUrl !== 'string') throw new Error('provider.baseUrl 必须是字符串');
    if (provider.apiKey !== undefined && typeof provider.apiKey !== 'string') throw new Error('provider.apiKey 必须是字符串');
    if (provider.models !== undefined && !Array.isArray(provider.models)) throw new Error('provider.models 必须是数组');
    for (const model of provider.models || []) {
      if (typeof model === 'string') continue;
      if (!isPlainObject(model) || typeof model.id !== 'string' || !model.id.trim()) {
        throw new Error('provider.models 条目必须是模型名或带 id 的对象');
      }
    }
  }
}

function normalizeStoredProvider(provider) {
  if (provider.mediaProtocol === 'dashscope' || provider.mediaProtocol === 'openai-images') return false;
  provider.mediaProtocol = inferMediaProtocol(provider.baseUrl);
  return true;
}

export function irisHome() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'iris', 'v1');
}

function storeFile() {
  return path.join(irisHome(), 'providers.json');
}

let cache = null;

/* ---------------- 状态变化总线（阶段 4 SSE：供应商/分配落盘即通知） ---------------- */
const changeListeners = new Set();
/** 订阅配置变化（upsert/remove/assignment 都会触发）；返回退订函数 */
export function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function emitChange() {
  for (const fn of [...changeListeners]) {
    try { fn(); } catch (_) { /* 单个监听者异常不影响其余 */ }
  }
}

function persist() {
  atomicWritePrivate(storeFile(), JSON.stringify(cache, null, 2));
  emitChange(); // 任何配置落盘 = 状态变了 → SSE 推送
}

export function load() {
  if (cache) return cache;
  const file = storeFile();
  if (!fs.existsSync(file)) {
    // 文件不存在 = 首次运行，正常初始化
    cache = { version: 1, providers: [], assignments: {} };
    persist();
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    let normalized = false;
    if (isPlainObject(parsed) && parsed.assignments === undefined) {
      parsed.assignments = {};
      normalized = true;
    }
    validateStoredConfig(parsed);
    cache = parsed;
    for (const provider of cache.providers) normalized = normalizeStoredProvider(provider) || normalized;
    if (normalized) persist();
  } catch (err) {
    // 文件存在但损坏：隔离，绝不静默覆盖证据
    const backup = privateSibling(file, 'corrupted');
    try {
      fs.renameSync(file, backup);
      chmodPrivateFile(backup);
    } catch (_) {
      /* 隔离失败也继续 */
    }
    console.error('[iris] providers.json 已损坏，已隔离为 ' + backup + '：', err && err.message);
    cache = { version: 1, providers: [], assignments: {} };
    persist();
  }
  return cache;
}

/** 测试/重载用：丢弃内存缓存，下次读取重新走盘 */
export function resetCache() {
  cache = null;
}

/** 用户显式指定来源且 Iris 为空时，从工作台配置导入。 */
export function importFromWorkbench(workbenchConfigPath) {
  const c = load();
  if (c.providers.length) return { imported: 0, reason: '已有配置，跳过导入' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(workbenchConfigPath, 'utf8'));
  } catch (_) {
    return { imported: 0, reason: '来源文件不可读或 JSON 无效' };
  }
  const list = Array.isArray(raw?.providers) ? raw.providers : [];
  let n = 0;
  for (const p of list) {
    if (!p || typeof p.apiKey !== 'string' || !p.apiKey.trim() ||
        typeof p.baseUrl !== 'string' || !p.baseUrl.trim()) continue;
    c.providers.push({
      id: 'iris_' + Math.random().toString(36).slice(2, 8),
      name: p.name || p.id,
      type: p.type === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      enabled: p.enabled !== false,
      mediaProtocol: inferMediaProtocol(p.baseUrl)
    });
    n++;
  }
  if (n) persist();
  return n ? { imported: n } : { imported: 0, reason: '来源没有可导入的供应商' };
}

export function providers() {
  return load().providers.filter((p) => p.enabled && p.apiKey);
}

export function providerById(id) {
  return providers().find((p) => p.id === id);
}

/** 能力 → 该能力在 provider 上对应的模型字段（models.CAP_FIELD 别名） */
const FIELD_OF = models.CAP_FIELD;

/**
 * 严格选择（阶段 6 模型池）：优先用「已分配模型」（有序列表取第一个可用），
 * 否则从全局模型池挑第一个有能力标签的模型。
 * 返回该模型所属 provider 的副本，并把该能力的模型字段设为选中模型。
 * 向后兼容：调用方继续读 provider.apiKey / provider.imageModel 等。
 * 无可用模型 → null（不再兜底到任意 provider）。
 */
export function pickFor(capability) {
  const pool = models.modelPool(providers());
  let m = null;
  for (const ref of assignmentOrder(capability)) {
    m = pool.find((x) => x.ref === ref && x.capabilities.includes(capability));
    if (m) break;
  }
  if (!m) m = models.pickModel(pool, capability);
  if (!m) return null;
  const p = providerById(m.providerId);
  if (!p) return null;
  const field = FIELD_OF[capability];
  return field ? { ...p, [field]: m.id } : p;
}

/**
 * 同一能力的有序 provider 列表（供 failover 依次尝试）：
 * 已分配顺序优先（阶段 6 条目 4），其余按池顺序补齐（去重）。
 * 一个 provider 若池里有多个该能力模型，会返回多条（各自带不同模型）。
 */
export function pickAllFor(capability) {
  const pool = models.modelPool(providers());
  const chosen = [];
  const seen = new Set();
  const add = (m) => {
    const k = m.providerId + '\u0000' + m.id;
    if (!seen.has(k)) { seen.add(k); chosen.push(m); }
  };
  for (const ref of assignmentOrder(capability)) {
    for (const m of pool) if (m.ref === ref && m.capabilities.includes(capability)) add(m);
  }
  for (const m of pool) if (m.capabilities.includes(capability)) add(m);
  const out = [];
  for (const m of chosen) {
    const p = providerById(m.providerId);
    if (!p) continue;
    const field = FIELD_OF[capability];
    out.push(field ? { ...p, [field]: m.id } : p);
  }
  return out;
}

/** 能力 → 模型复合引用 的分配映射；兼容旧的纯 model id。 */
export function assignments() {
  return load().assignments || {};
}

function resolveAssignment(pool, raw, capability) {
  let providerId = '';
  let modelId = '';
  if (raw && typeof raw === 'object') {
    providerId = String(raw.providerId || '');
    modelId = String(raw.modelId || raw.id || '');
  } else if (typeof raw === 'string') {
    const parsed = models.parseModelRef(raw);
    if (parsed) ({ providerId, modelId } = parsed);
    else modelId = raw; // v1 旧格式：纯 model id，按池顺序取第一个
  }
  return pool.find((m) => m.id === modelId
    && (!providerId || m.providerId === providerId)
    && m.capabilities.includes(capability)) || null;
}

/** 归一化某能力的有序分配列表 → [providerId::modelId, ...]。 */
export function assignmentOrder(capability) {
  const a = assignments()[capability];
  if (!a) return [];
  const pool = models.modelPool(providers());
  const refs = [];
  for (const raw of (Array.isArray(a) ? a : [a])) {
    const m = resolveAssignment(pool, raw, capability);
    if (m && !refs.includes(m.ref)) refs.push(m.ref);
  }
  return refs;
}

/** 设置某能力分配的模型 id（需在全局池中存在且具备该能力） */
export function setAssignment(capability, ref) {
  const c = load();
  const pool = models.modelPool(providers());
  const m = resolveAssignment(pool, ref, capability);
  if (!m) return false;
  if (!c.assignments) c.assignments = {};
  c.assignments[capability] = m.ref;
  persist();
  return true;
}

/**
 * 设置某能力的有序 failover 列表（阶段 6 条目 4）：每个模型须在全局池中存在且具备该能力。
 * 空数组 = 清除分配（回退池顺序自动选择）。重复 id 自动去重。
 */
export function setAssignmentOrder(capability, modelRefs) {
  const c = load();
  if (!c.assignments) c.assignments = {};
  if (!Array.isArray(modelRefs) || !modelRefs.length) {
    if (c.assignments[capability]) {
      delete c.assignments[capability];
      persist();
    }
    return true;
  }
  const pool = models.modelPool(providers());
  const refs = [];
  for (const raw of modelRefs) {
    const m = resolveAssignment(pool, raw, capability);
    if (!m) return false;
    if (!refs.includes(m.ref)) refs.push(m.ref);
  }
  if (!refs.length) return false;
  c.assignments[capability] = refs;
  persist();
  return true;
}

/** 清除某个能力的手动分配（回退到池自动选择） */
export function clearAssignment(capability) {
  const c = load();
  if (c.assignments && c.assignments[capability]) {
    delete c.assignments[capability];
    persist();
  }
  return true;
}

/** 某 provider 的模型池覆盖的能力集合（合并各模型的能力标签） */
export function capabilitiesOf(p) {
  const caps = new Set();
  for (const m of models.providerModels(p)) {
    for (const c of m.capabilities) caps.add(c);
  }
  return [...caps];
}

const HEALTH_SENSITIVE_FIELDS = new Set([
  'type', 'baseUrl', 'apiKey', 'mediaProtocol',
  'imageModel', 'videoModel', 'ttsModel', 'transcribeModel', 'visionModel'
]);

function healthContainer(provider) {
  const current = provider.health;
  if (current && current.version === 1 && Number.isSafeInteger(current.revision)
      && Array.isArray(current.observations)) return current;
  const revision = Number.isSafeInteger(current && current.revision) ? current.revision : 0;
  provider.health = { version: 1, revision, observations: [] };
  return provider.health;
}

function healthObservation(provider, modelId, capability) {
  const health = provider && provider.health;
  if (!health || health.version !== 1 || !Array.isArray(health.observations)) return null;
  return health.observations.find((item) => item && item.modelId === modelId
    && item.capability === capability) || null;
}

function safeHealthNote(provider, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let note = redactProviderMessage(raw, 200);
  const key = String(provider && provider.apiKey || '');
  if (key) note = note.split(key).join('[REDACTED]');
  return note;
}

function observationEvidence(provider, result, fallbackSource) {
  const atMs = Date.parse(String(result && result.at || ''));
  const status = Number(result && (result.httpStatus ?? result.status));
  const note = safeHealthNote(provider, result && (result.note || result.safeMessage || result.message));
  return {
    at: new Date(Number.isFinite(atMs) ? atMs : Date.now()).toISOString(),
    source: ['probe', 'task'].includes(result && result.source) ? result.source : fallbackSource,
    category: String(result && result.category || (result && result.ok ? 'success' : 'unknown')).slice(0, 40),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    ...(note ? { note } : {})
  };
}

function applyProviderHealth(provider, modelId, capability, result, fallbackSource = 'task') {
  const model = String(modelId || '').trim();
  if (!provider || !model || !cap.isKnownCapability(capability)) return false;
  const health = healthContainer(provider);
  let observation = health.observations.find((item) => item && item.modelId === model
    && item.capability === capability);
  if (!observation) {
    observation = { modelId: model, capability };
    health.observations.push(observation);
  }
  const evidence = observationEvidence(provider, result || {}, fallbackSource);
  if (result && result.ok === true) {
    observation.lastSuccess = evidence;
  } else if (isDefinitiveHealthFailure({ ...result, ...evidence })) {
    observation.lastFailure = evidence;
  } else {
    observation.lastTransient = evidence;
  }
  return true;
}

function pruneHealthToEffectiveModels(provider) {
  if (!provider) return;
  const allowedByModel = new Map();
  for (const entry of models.providerModels(provider)) {
    allowedByModel.set(entry.id, new Set(entry.capabilities));
  }
  if (provider.health && Array.isArray(provider.health.observations)) {
    provider.health.observations = provider.health.observations.filter((item) =>
      item && allowedByModel.get(item.modelId)?.has(item.capability));
  }
  for (const entry of provider.models || []) {
    if (!entry || typeof entry !== 'object' || !entry.verified || typeof entry.verified !== 'object') continue;
    const allowed = allowedByModel.get(entry.id) || new Set();
    entry.verified = Object.fromEntries(Object.entries(entry.verified).filter(([capability]) => allowed.has(capability)));
    if (!Object.keys(entry.verified).length) delete entry.verified;
  }
}

function pruneModelHealth(provider, modelId) {
  if (!provider || !provider.health || !Array.isArray(provider.health.observations)) return;
  provider.health.observations = provider.health.observations.filter((item) => item.modelId !== modelId);
}

function resetHealthOnCriticalChange(previous, next, patch) {
  const changed = [...HEALTH_SENSITIVE_FIELDS].some((key) =>
    Object.prototype.hasOwnProperty.call(patch, key) && previous[key] !== next[key]);
  if (!changed) return;
  const current = previous.health;
  const revision = Number.isSafeInteger(current && current.revision) ? current.revision + 1 : 1;
  next.health = { version: 1, revision, observations: [] };
}

/** 记录一次显式实测或真实任务观察；临时错误不会覆盖近期成功。 */
export function recordProviderHealth(id, modelId, capability, result) {
  const c = load();
  const provider = c.providers.find((item) => item.id === id);
  if (!provider || !applyProviderHealth(provider, modelId, capability, result, result && result.source || 'task')) {
    return false;
  }
  persist();
  return true;
}

/** 返回单个 Provider × Model × Capability 的安全状态。 */
export function modelHealth(id, modelId, capability, { now = Date.now() } = {}) {
  const provider = load().providers.find((item) => item.id === id);
  if (!provider || provider.enabled === false || !provider.apiKey) return { status: 'unconfigured' };
  const observation = healthObservation(provider, modelId, capability);
  const status = healthObservationState(observation, { now });
  const evidence = status === 'verified'
    ? observation && observation.lastSuccess
    : (status === 'failed' ? observation && observation.lastFailure : newestHealthEvidence(observation));
  return {
    status,
    ...(evidence ? {
      observedAt: evidence.at,
      source: evidence.source,
      category: evidence.category,
      ...(evidence.httpStatus ? { httpStatus: evidence.httpStatus } : {}),
      ...(evidence.note ? { note: evidence.note } : {})
    } : {})
  };
}

/** 当前有序 failover 路径的健康快照；只含脱敏标量，不触发网络。 */
export function providerHealthSnapshot({ now = Date.now() } = {}) {
  const capabilities = {};
  for (const capability of Object.values(cap.CAPABILITIES)) {
    const candidates = pickAllFor(capability).map((provider) => {
      const modelId = String(provider[FIELD_OF[capability]] || '');
      const health = modelHealth(provider.id, modelId, capability, { now });
      return { providerId: provider.id, modelId, ...health };
    });
    const status = aggregateHealthStates(candidates.map((item) => item.status));
    const newest = [...candidates]
      .filter((item) => item.status === status && item.observedAt)
      .sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)))[0];
    capabilities[capability] = {
      status,
      candidateCount: candidates.length,
      ...(newest ? { observedAt: newest.observedAt } : {}),
      candidates
    };
  }
  return {
    schemaVersion: 1,
    freshForMs: PROVIDER_HEALTH_FRESH_MS,
    generatedAt: new Date(Number(now)).toISOString(),
    overall: aggregateHealthStates(Object.values(capabilities).map((item) => item.status)),
    capabilities
  };
}

export function upsert(provider) {
  const c = load();
  const { id, ...input } = provider;
  // PATCH 语义：缺失字段和 undefined 都不覆盖旧值；null/空串仍是显式更新。
  const rest = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  if (id) {
    const i = c.providers.findIndex((p) => p.id === id);
    if (i >= 0) {
      const previous = c.providers[i];
      if (rest.mediaProtocol === 'auto') rest.mediaProtocol = inferMediaProtocol(rest.baseUrl ?? previous.baseUrl);
      const next = { ...previous, ...rest };
      normalizeStoredProvider(next);
      resetHealthOnCriticalChange(previous, next, rest);
      if (Object.prototype.hasOwnProperty.call(rest, 'models')) pruneHealthToEffectiveModels(next);
      c.providers[i] = next;
      persist();
      return next;
    }
  }
  const fresh = { id: 'iris_' + Math.random().toString(36).slice(2, 8), ...rest };
  if (fresh.mediaProtocol === 'auto') delete fresh.mediaProtocol;
  normalizeStoredProvider(fresh);
  c.providers.push(fresh);
  persist();
  return fresh;
}

/** 全部供应商原始记录（含停用，管理 GUI 用） */
export function allProviders() {
  return load().providers;
}

/** 删除一个供应商 */
export function removeProvider(id) {
  const c = load();
  const i = c.providers.findIndex((p) => p.id === id);
  if (i < 0) return false;
  c.providers.splice(i, 1);
  persist();
  return true;
}

/** 设置一个供应商的模型池（覆盖显式 models 数组；空数组 = 回退到自动发现/旧字段） */
export function setProviderModels(id, modelEntries) {
  const c = load();
  const p = c.providers.find((x) => x.id === id);
  if (!p) return null;
  if (Array.isArray(modelEntries)) {
    // 保留同名模型已有的 verified/source（重新发现不丢实测结果）
    const prev = {};
    for (const m of p.models || []) if (m && m.id) prev[m.id] = m;
    p.models = modelEntries.map((m) => {
      const entry = typeof m === 'string' ? { id: m } : { id: m.id, capabilities: m.capabilities };
      const old = prev[entry.id];
      if (old) {
        if (old.verified) entry.verified = old.verified;
        if (old.source) entry.source = old.source;
      }
      if (m && m.verified) entry.verified = m.verified;
      if (m && m.source) entry.source = m.source;
      return entry;
    });
  }
  pruneHealthToEffectiveModels(p);
  persist();
  return p;
}

/** 找 provider 里的某个模型条目（可变引用） */
function findModelEntry(p, modelId) {
  return (p.models || []).find((m) => m && m.id === modelId);
}

/** 手动添加一个模型到池（source=manual，能力由调用方给） */
export function addProviderModel(id, modelId, capabilities) {
  const c = load();
  const p = c.providers.find((x) => x.id === id);
  if (!p) return null;
  const name = String(modelId || '').trim();
  if (!name) return null;
  if (!Array.isArray(p.models)) p.models = [];
  let entry = findModelEntry(p, name);
  if (!entry) {
    entry = { id: name, capabilities: Array.isArray(capabilities) ? capabilities : [], source: 'manual' };
    p.models.push(entry);
  } else if (Array.isArray(capabilities)) {
    entry.capabilities = capabilities;
  }
  pruneHealthToEffectiveModels(p);
  persist();
  return entry;
}

/** 从池移除一个模型 */
export function removeProviderModel(id, modelId) {
  const c = load();
  const p = c.providers.find((x) => x.id === id);
  if (!p || !Array.isArray(p.models)) return false;
  const i = p.models.findIndex((m) => m && m.id === modelId);
  if (i < 0) return false;
  p.models.splice(i, 1);
  pruneModelHealth(p, modelId);
  persist();
  return true;
}

/** 设置某模型的能力标签（用户纠正规则误判 / 给未知模型标能力） */
export function setModelCapabilities(id, modelId, capabilities) {
  const c = load();
  const p = c.providers.find((x) => x.id === id);
  if (!p) return false;
  const entry = findModelEntry(p, modelId);
  if (!entry) return false;
  const nextCapabilities = (Array.isArray(capabilities) ? capabilities : []).filter((x) => cap.isKnownCapability(x));
  entry.capabilities = nextCapabilities;
  pruneHealthToEffectiveModels(p);
  persist();
  return true;
}

/** 记录某模型的显式实测结果，并同步到新健康事实。 */
export function setModelVerified(id, modelId, capability, result) {
  const c = load();
  const p = c.providers.find((x) => x.id === id);
  if (!p) return false;
  const entry = findModelEntry(p, modelId);
  const at = new Date().toISOString();
  if (entry) {
    if (!entry.verified) entry.verified = {};
    entry.verified[capability] = {
      ok: !!result.ok,
      at,
      note: safeHealthNote(p, result.note || ''),
      source: 'probe',
      category: String(result.category || (result.ok ? 'success' : 'unknown')).slice(0, 40)
    };
  }
  applyProviderHealth(p, modelId, capability, { ...result, at, source: 'probe' }, 'probe');
  persist();
  return true;
}
