'use strict';
/**
 * Iris 配置存储：$DSH_HOME/iris/v1/providers.json
 * 结构与 ai-paint 工作台兼容（providers 数组同形），支持一键导入。
 * Key 明文落盘（0600）；接口层永远不回明文。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as cap from './capability.js';
import * as models from './models.js';

export function irisHome() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'iris', 'v1');
}

function storeFile() {
  return path.join(irisHome(), 'providers.json');
}

let cache = null;

function persist() {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  const tmp = storeFile() + '.tmp';
  // 0600 从创建时生效（含临时文件）；rename 保留 mode，chmod 兜底不依赖 umask
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storeFile());
  try {
    fs.chmodSync(storeFile(), 0o600);
  } catch (_) {
    /* ignore */
  }
}

export function load() {
  if (cache) return cache;
  const file = storeFile();
  if (!fs.existsSync(file)) {
    // 文件不存在 = 首次运行，正常初始化
    cache = { version: 1, providers: [] };
    persist();
    return cache;
  }
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(cache.providers)) cache.providers = [];
  } catch (err) {
    // 文件存在但损坏：隔离，绝不静默覆盖证据
    const backup = file + '.corrupted-' + Date.now();
    try {
      fs.renameSync(file, backup);
    } catch (_) {
      /* 隔离失败也继续 */
    }
    console.error('[iris] providers.json 已损坏，已隔离为 ' + backup + '：', err && err.message);
    cache = { version: 1, providers: [] };
    persist();
  }
  return cache;
}

/** 测试/重载用：丢弃内存缓存，下次读取重新走盘 */
export function resetCache() {
  cache = null;
}

/** 首次运行且 Iris 为空时，从工作台配置导入（迁移动作，非耦合） */
export function importFromWorkbench(workbenchConfigPath) {
  const c = load();
  if (c.providers.length) return { imported: 0, reason: '已有配置，跳过导入' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(workbenchConfigPath, 'utf8'));
  } catch (_) {
    return { imported: 0, reason: '未找到工作台配置' };
  }
  const list = Array.isArray(raw.providers) ? raw.providers : [];
  let n = 0;
  for (const p of list) {
    if (!p || !p.apiKey || !p.baseUrl) continue;
    c.providers.push({
      id: 'iris_' + Math.random().toString(36).slice(2, 8),
      name: p.name || p.id,
      type: p.type === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      enabled: p.enabled !== false,
      // 媒体生成默认走百炼协议；OpenAI Images 兼容后端由用户按需切换
      mediaProtocol: /dashscope/i.test(p.baseUrl) ? 'dashscope' : 'openai-images'
    });
    n++;
  }
  if (n) persist();
  return { imported: n };
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
 * 严格选择（阶段 6 模型池）：从全局模型池挑有能力标签的模型，
 * 返回该模型所属 provider 的副本，并把该能力的模型字段设为选中模型。
 * 向后兼容：调用方继续读 provider.apiKey / provider.imageModel 等。
 * 无可用模型 → null（不再兜底到任意 provider）。
 */
export function pickFor(capability) {
  const pool = models.modelPool(providers());
  const m = models.pickModel(pool, capability);
  if (!m) return null;
  const p = providerById(m.providerId);
  if (!p) return null;
  const field = FIELD_OF[capability];
  return field ? { ...p, [field]: m.id } : p;
}

/**
 * 同一能力的有序 provider 列表（每个带选中模型字段，按池顺序，供 failover 依次尝试）。
 * 一个 provider 若池里有多个该能力模型，会返回多条（各自带不同模型）。
 */
export function pickAllFor(capability) {
  const pool = models.modelPool(providers());
  const out = [];
  for (const m of pool) {
    if (!m.capabilities.includes(capability)) continue;
    const p = providerById(m.providerId);
    if (!p) continue;
    const field = FIELD_OF[capability];
    out.push(field ? { ...p, [field]: m.id } : p);
  }
  return out;
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
  const i = c.providers.findIndex((p) => p.id === provider.id);
  if (i >= 0) c.providers[i] = { ...c.providers[i], ...provider };
  else c.providers.push({ id: 'iris_' + Math.random().toString(36).slice(2, 8), ...provider });
  persist();
  return i >= 0 ? c.providers[i] : c.providers[c.providers.length - 1];
}
