'use strict';
/**
 * Iris 配置存储：$DSH_HOME/iris/v1/providers.json
 * 结构与 ai-paint 工作台兼容（providers 数组同形），支持一键导入。
 * Key 明文落盘（0600）；接口层永远不回明文。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, storeFile());
  try {
    fs.chmodSync(storeFile(), 0o600);
  } catch (_) {
    /* ignore */
  }
}

export function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    if (!Array.isArray(cache.providers)) cache.providers = [];
  } catch (_) {
    cache = { version: 1, providers: [] };
    persist();
  }
  return cache;
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

/** 按能力挑一个可用供应商：声明了该能力的优先，否则第一个可用的 */
export function pickFor(capability) {
  const all = providers();
  return all.find((p) => Array.isArray(p.capabilities) && p.capabilities.includes(capability)) || all[0] || null;
}

export function upsert(provider) {
  const c = load();
  const i = c.providers.findIndex((p) => p.id === provider.id);
  if (i >= 0) c.providers[i] = { ...c.providers[i], ...provider };
  else c.providers.push({ id: 'iris_' + Math.random().toString(36).slice(2, 8), ...provider });
  persist();
  return i >= 0 ? c.providers[i] : c.providers[c.providers.length - 1];
}
