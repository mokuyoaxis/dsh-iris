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

export function upsert(provider) {
  const c = load();
  const { id, ...input } = provider;
  // PATCH 语义：缺失字段和 undefined 都不覆盖旧值；null/空串仍是显式更新。
  const rest = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  if (id) {
    const i = c.providers.findIndex((p) => p.id === id);
    if (i >= 0) {
      if (rest.mediaProtocol === 'auto') rest.mediaProtocol = inferMediaProtocol(rest.baseUrl ?? c.providers[i].baseUrl);
      c.providers[i] = { ...c.providers[i], ...rest };
      normalizeStoredProvider(c.providers[i]);
      persist();
      return c.providers[i];
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
  entry.capabilities = (Array.isArray(capabilities) ? capabilities : []).filter((x) => cap.isKnownCapability(x));
  persist();
  return true;
}

/** 记录某模型的实测结果（verified[capability] = {ok, at, note}） */
export function setModelVerified(id, modelId, capability, result) {
  const c = load();
  const p = c.providers.find((x) => x.id === id);
  if (!p) return false;
  const entry = findModelEntry(p, modelId);
  if (!entry) return false;
  if (!entry.verified) entry.verified = {};
  entry.verified[capability] = { ok: !!result.ok, at: new Date().toISOString(), note: String(result.note || '').slice(0, 200) };
  persist();
  return true;
}
