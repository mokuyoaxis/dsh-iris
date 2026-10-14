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
import { PROMPT_TARGETS } from './prompt-optimizer-core.js';

export { PROMPT_TARGETS } from './prompt-optimizer-core.js';

const DEFAULT_VALUE = {
  version: 1,
  enabled: true,
  systemPrompt: [
    '# Iris 提示词编辑器',
    '## 职责',
    '按用户选择的功能，把草稿整理为可直接交给目标 AI 的提示词。只编辑文字，不执行工具或媒体生成。',
    '## 保留用户意图',
    '保留原始目标、事实、专有名词、引号内原文、硬性约束和否定条件。尤其保留主体身份与数量、左右方位、颜色、数值与单位、构图、时序和明确指定的风格，不擅自替换或扩展。',
    '逐项保留用户已写出的具体描述，不把这些细节当成冗余删去；明确否定条件不得用更宽泛的词概括、替换或扩大。没有依据时，不增加可被观察到的新属性、位置、声音、动作或光照。',
    '用户明示的事实和硬性约束优先于通用模板建议；只有用户本次改写规则明确授权的具体内容可以改变，其余细节与约束继续保留。信息不足或存在冲突时保持未指定或待确认，不替用户作关键决定。',
    '素材引用只是引用。没有看到图片、听到音频或读到文件时，不声称已分析其内容；不编造 Artifact ID、附件 ID、路径、模型、工具参数或执行结果。',
    '## 组织方式',
    '参照 Iris Skills 的任务组织：明确目标与必要输入，写清具体操作、必须保持和允许改变的部分，以及用户要求的输出和验收条件。只使用与本次功能有关的维度，不堆砌质量词或无依据的细节。',
    '默认沿用草稿语言；只允许分段、标点和明确等义的措辞。缺失维度无需补齐；不把几个改为三五位，不增加低声聊天、背景模糊或清晰、书本位置等内容，不把人物左右推为画面左右。已有内容完整时允许不改写。条件、否定、指代与动作顺序不能拆散或擅自重排。',
    '## 输出',
    '遵守本次编辑策略指定的输出协议；普通改写只输出完整提示词正文，不解释、不加额外标题、不使用 Markdown 代码块或工具调用 JSON。补充建议不混入正文，未经用户采纳不视为用户要求。'
  ].join('\n\n'),
  targets: {
    general: '# 通用任务\n\n## 目标\n把用户任务整理为明确、可执行的指令。\n\n## 组织\n按需要写清目标、必要背景与输入、约束、期望输出和验收标准；不添加用户未要求的工作步骤或背景事实。',
    image: '# 画图 · iris_draw_image\n\n## 目标\n整理已有的画图提示词文字，不执行画图。\n\n## 组织\n按已提供的主体与动作、环境、构图与视角、光影、色彩、材质和风格分组。分类维度不是待补全的要求，未指定内容继续未指定。不添加人物、物体、画风、画幅或新关系。\n\n## 保留\n准确保留数量、约数、年龄、左右方位、服装、颜色、程度、姿态及否定范围；仅用户明确授权改变的项目可以改变。文字里的尺寸要求仍是用户要求，不冒充工具参数已设置。',
    'image-edit': '# 改图 · iris_edit_image\n\n## 目标\n以已有原图为基础，只修改用户明确指定的部分。\n\n## 组织\n写清需要改变的对象、属性或区域，以及必须保持的主体身份、构图、背景、风格和其余细节。修改范围越小，指令越聚焦。\n\n## 输入与约束\n原图未提供可见内容时，不猜测原图颜色、位置或人物细节；用户提供的来源 ID 保持为引用。不要把改图改写成重新画一张，也不擅自增加重绘、遮罩或多参考图工作流。',
    video: '# 视频 · iris_generate_video\n\n## 目标\n描述用户要生成的文生或图生视频。\n\n## 组织\n围绕主体动作、动作先后、场景变化、镜头运动与景别、节奏和连续性组织可拍摄的过程。保留用户给出的时长、构图与负面约束，不擅自增加分镜、声音或时长参数。\n\n## 输入与约束\n已有首帧或参考图时，只依据用户明确提供的内容保持主体与空间关系；不虚构已经查看素材。不要用静态画质词替代动作和时间描述。',
    s2v: '# 数字人 · iris_generate_video（S2V）\n\n## 输入\n此功能依据首帧图像与音频生成视频；S2V 不是首尾帧插值。\n\n## 目标与组织\n在既定人物和已有音频约束下，描述与用户要求一致的表情、口型、姿态、动作和镜头。保持身份、服装、背景及动作连续性，不擅自改写音频台词、添加声音或替换人物。\n\n## 约束\n音频内容或图像不可见时，不猜测台词、时长、情绪或外观细节；已有素材无需再次生成。'
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

/** 只反馈字段名，不携带被忽略的字段值；持久配置仍使用原 v1 规范化。 */
function importFeedback(input) {
  const ignored = [];
  const collect = (value, prefix, allowed) => {
    if (!value) return;
    for (const key of Object.keys(value)) if (!allowed.includes(key)) ignored.push(prefix + key);
  };
  collect(input, '', ['version', 'enabled', 'systemPrompt', 'targets', 'route', 'generation']);
  collect(input.targets, 'targets.', PROMPT_TARGETS);
  collect(input.route, 'route.', input.route?.mode === 'fixed' ? ['mode', 'provider', 'model'] : ['mode']);
  collect(input.generation, 'generation.', ['temperature', 'reasoningEffort', 'maxOutputTokens', 'timeoutMs']);
  return { warnings: ignored.length ? [{ code: 'ignored-fields', count: ignored.length,
    fields: ignored.slice(0, 32).map(field => field.length > 256 ? field.slice(0, 253) + '...' : field) }] : [] };
}

let cache = null;
let cacheSource = 'default';
let cacheFeedback = { warnings: [] };

function snapshot() {
  return { source: cacheSource, config: structuredClone(cache), feedback: structuredClone(cacheFeedback) };
}

function persistConfig(next) {
  const encoded = JSON.stringify(next, null, 2);
  try { atomicWritePrivate(configFile(), encoded); }
  catch (error) {
    // 已知文件系统异常可能带私有路径；编程异常仍原样暴露。
    if (typeof error.code !== 'string' || typeof error.syscall !== 'string') throw error;
    const display = new Error('提示词配置写入失败，请检查存储权限和空间后重新载入配置');
    display.code = error.code;
    throw display;
  }
}

function useFallback(file, reason, isolate) {
  let isolation = 'not-attempted';
  if (isolate) {
    const backup = privateSibling(file, 'corrupted');
    try {
      fs.renameSync(file, backup);
      isolation = 'saved';
      chmodPrivateFile(backup);
    } catch (_) { if (isolation !== 'saved') isolation = 'failed'; }
  }
  cache = structuredClone(DEFAULT_VALUE);
  cacheSource = 'default';
  cacheFeedback = { warnings: [{ code: 'config-fallback', reason, isolation }] };
  // JSON.parse/文件系统异常可能带原稿或绝对路径；只记录受控原因与隔离事实。
  console.error('[iris] prompt-optimizer.json 已回退内置默认值：', reason, isolation);
  return snapshot();
}

export function loadPromptOptimizerConfig() {
  if (cache) return snapshot();
  const file = configFile();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') return useFallback(file, 'read-failed', false);
    cache = structuredClone(DEFAULT_VALUE);
    cacheSource = 'default';
    cacheFeedback = { warnings: [] };
    return snapshot();
  }
  let input;
  try { input = JSON.parse(raw); }
  catch (_) { return useFallback(file, 'json-invalid', true); }
  try {
    cache = normalizePromptOptimizerConfig(input);
    cacheSource = JSON.stringify(cache) === JSON.stringify(DEFAULT_VALUE) ? 'default' : 'custom';
  } catch (_) { return useFallback(file, 'validation-invalid', true); }
  cacheFeedback = importFeedback(input);
  return snapshot();
}

export function importPromptOptimizerConfig(input) {
  const next = normalizePromptOptimizerConfig(input);
  persistConfig(next);
  cache = next;
  cacheSource = 'custom';
  cacheFeedback = importFeedback(input);
  return snapshot();
}

export function setPromptOptimizerEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  const loaded = loadPromptOptimizerConfig();
  if (loaded.feedback.warnings.some(warning => warning.code === 'config-fallback' && warning.isolation !== 'saved')) {
    throw new Error('原配置尚未隔离保留，不能只更新入口开关；请先导入有效配置或明确恢复全部设置');
  }
  const next = normalizePromptOptimizerConfig({ ...loaded.config, enabled });
  persistConfig(next);
  cache = next;
  cacheSource = JSON.stringify(cache) === JSON.stringify(DEFAULT_VALUE) ? 'default' : 'custom';
  cacheFeedback = { warnings: cacheFeedback.warnings.filter(warning => warning.code === 'config-fallback') };
  return snapshot();
}

/** 只更新指令；无法读取原设置时不得声称保留了路由与预算。 */
export function resetPromptOptimizerInstructions() {
  const loaded = loadPromptOptimizerConfig();
  if (loaded.feedback.warnings.some(warning => warning.code === 'config-fallback')) {
    throw new Error('当前配置无法读取，不能保证保留模型与生成参数；请先导入有效配置或选择恢复全部设置');
  }
  const next = { ...loaded.config, systemPrompt: DEFAULT_VALUE.systemPrompt, targets: structuredClone(DEFAULT_VALUE.targets) };
  persistConfig(next);
  cache = next;
  cacheSource = JSON.stringify(cache) === JSON.stringify(DEFAULT_VALUE) ? 'default' : 'custom';
  cacheFeedback = { warnings: [] };
  return snapshot();
}

export function resetPromptOptimizerConfig() {
  const next = structuredClone(DEFAULT_VALUE);
  persistConfig(next);
  cache = next;
  cacheSource = 'default';
  cacheFeedback = { warnings: [] };
  return snapshot();
}

/** 仅供测试/热重载丢弃进程内缓存。 */
export function resetPromptOptimizerConfigCache() {
  cache = null;
  cacheSource = 'default';
  cacheFeedback = { warnings: [] };
}

export function promptOptimizerConfigFile() {
  return configFile();
}
