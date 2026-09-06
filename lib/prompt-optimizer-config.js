'use strict';
/**
 * Iris 提示词优化器配置。
 *
 * 与 providers.json 分离保存：这里不含凭据，只记录用户可导入/导出的 Prompt、
 * 目标媒介要求与模型路由偏好。损坏配置会被隔离，运行时回退到内置默认值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { irisHome } from './config.js';
import { atomicWritePrivate, chmodPrivateFile, privateSibling } from './private-storage.js';

export const PROMPT_TARGETS = ['general', 'image', 'video', 's2v'];

const DEFAULT_VALUE = {
  version: 1,
  enabled: true,
  systemPrompt: [
    '你是 Iris 提示词编辑器。把用户草稿改写成一段可直接交给目标 AI 的高质量提示词。',
    '必须保留原始意图、事实、专有名词、引号内原文、硬性约束和否定条件；不得臆造用户没有提供的事实。',
    '只补充能提高可执行性、结构清晰度、风格一致性和验收明确度的具体信息。信息不足时保持克制，不替用户作关键决定。',
    '默认沿用草稿的语言。只输出优化后的提示词正文，不解释、不加标题、不使用 Markdown 代码块。'
  ].join('\n'),
  targets: {
    general: '适用于一般对话任务：明确目标、必要背景、约束、期望输出和验收标准；避免无意义地拉长文本。',
    image: '适用于图像生成：在原意允许的范围内明确主体、环境、构图、视角、光线、色彩、材质、风格和负面约束。',
    video: '适用于视频生成：在原意允许的范围内明确主体动作、场景变化、镜头运动、景别、节奏、时长感、连续性和负面约束。',
    s2v: '适用于首尾帧视频：明确首帧到尾帧之间的动作、镜头、空间关系和连续性，避免引入与两端画面冲突的新主体。'
  },
  route: {
    mode: 'session'
  },
  generation: {
    temperature: 0.3,
    reasoningEffort: 'off-if-supported',
    maxOutputTokens: 1200,
    timeoutMs: 45000
  }
};

export const DEFAULT_PROMPT_OPTIMIZER_CONFIG = Object.freeze(structuredClone(DEFAULT_VALUE));

function configFile() {
  return path.join(irisHome(), 'prompt-optimizer.json');
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback, field, maxLength) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  if (value.length > maxLength) throw new Error(`${field} 不能超过 ${maxLength} 个字符`);
  return value.trim();
}

function boundedNumber(value, fallback, field, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} 必须是 ${min}–${max} 之间的数字`);
  }
  return value;
}

/** 规范化用户导入的完整或局部 JSON，不保留未知字段。 */
export function normalizePromptOptimizerConfig(input) {
  if (!plain(input)) throw new Error('提示词优化器配置根节点必须是对象');
  if (input.version !== undefined && input.version !== 1) throw new Error('仅支持 version: 1');

  const targetInput = input.targets === undefined ? {} : input.targets;
  if (!plain(targetInput)) throw new Error('targets 必须是对象');
  const targets = {};
  for (const target of PROMPT_TARGETS) {
    targets[target] = text(targetInput[target], DEFAULT_VALUE.targets[target], `targets.${target}`, 8000);
  }

  const routeInput = input.route === undefined ? {} : input.route;
  if (!plain(routeInput)) throw new Error('route 必须是对象');
  const mode = routeInput.mode === undefined ? DEFAULT_VALUE.route.mode : routeInput.mode;
  if (mode !== 'session' && mode !== 'fixed') throw new Error('route.mode 只能是 session 或 fixed');
  const route = { mode };
  if (mode === 'fixed') {
    route.provider = text(routeInput.provider, undefined, 'route.provider', 256);
    route.model = text(routeInput.model, undefined, 'route.model', 256);
    if (!route.provider || !route.model) throw new Error('fixed 路由必须同时提供 route.provider 与 route.model');
  }

  const generationInput = input.generation === undefined ? {} : input.generation;
  if (!plain(generationInput)) throw new Error('generation 必须是对象');
  const generation = {
    temperature: boundedNumber(generationInput.temperature, DEFAULT_VALUE.generation.temperature, 'generation.temperature', 0, 2),
    reasoningEffort: text(generationInput.reasoningEffort, DEFAULT_VALUE.generation.reasoningEffort, 'generation.reasoningEffort', 128),
    maxOutputTokens: Math.round(boundedNumber(generationInput.maxOutputTokens, DEFAULT_VALUE.generation.maxOutputTokens, 'generation.maxOutputTokens', 64, 4096)),
    timeoutMs: Math.round(boundedNumber(generationInput.timeoutMs, DEFAULT_VALUE.generation.timeoutMs, 'generation.timeoutMs', 1000, 120000))
  };

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');

  return {
    version: 1,
    enabled: input.enabled === undefined ? DEFAULT_VALUE.enabled : input.enabled,
    systemPrompt: text(input.systemPrompt, DEFAULT_VALUE.systemPrompt, 'systemPrompt', 16000),
    targets,
    route,
    generation
  };
}

let cache = null;
let cacheSource = 'default';

export function loadPromptOptimizerConfig() {
  if (cache) return { source: cacheSource, config: structuredClone(cache) };
  const file = configFile();
  if (!fs.existsSync(file)) {
    cache = structuredClone(DEFAULT_VALUE);
    cacheSource = 'default';
    return { source: cacheSource, config: structuredClone(cache) };
  }
  try {
    cache = normalizePromptOptimizerConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    cacheSource = JSON.stringify(cache) === JSON.stringify(DEFAULT_VALUE) ? 'default' : 'custom';
  } catch (err) {
    const backup = privateSibling(file, 'corrupted');
    try {
      fs.renameSync(file, backup);
      chmodPrivateFile(backup);
    } catch (_) { /* 隔离失败也必须能使用内置默认值 */ }
    console.error('[iris] prompt-optimizer.json 已损坏，已回退内置默认值：', err && err.message);
    cache = structuredClone(DEFAULT_VALUE);
    cacheSource = 'default';
  }
  return { source: cacheSource, config: structuredClone(cache) };
}

export function importPromptOptimizerConfig(input) {
  const next = normalizePromptOptimizerConfig(input);
  atomicWritePrivate(configFile(), JSON.stringify(next, null, 2));
  cache = next;
  cacheSource = 'custom';
  return { source: cacheSource, config: structuredClone(cache) };
}

export function setPromptOptimizerEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  const next = normalizePromptOptimizerConfig({ ...loadPromptOptimizerConfig().config, enabled });
  atomicWritePrivate(configFile(), JSON.stringify(next, null, 2));
  cache = next;
  cacheSource = JSON.stringify(cache) === JSON.stringify(DEFAULT_VALUE) ? 'default' : 'custom';
  return { source: cacheSource, config: structuredClone(cache) };
}

export function resetPromptOptimizerConfig() {
  const next = structuredClone(DEFAULT_VALUE);
  atomicWritePrivate(configFile(), JSON.stringify(next, null, 2));
  cache = next;
  cacheSource = 'default';
  return { source: cacheSource, config: structuredClone(cache) };
}

/** 仅供测试/热重载丢弃进程内缓存。 */
export function resetPromptOptimizerConfigCache() {
  cache = null;
  cacheSource = 'default';
}

export function promptOptimizerConfigFile() {
  return configFile();
}
