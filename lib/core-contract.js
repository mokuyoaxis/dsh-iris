'use strict';

import path from 'node:path';

/** Iris Core Runtime 的内部候选契约；尚未作为 package export 发布。 */
export const CORE_CONTRACT_VERSION = 0;

export const CORE_ACCESS_MODES = Object.freeze(['reader', 'writer']);
export const CORE_LIFECYCLE_STATES = Object.freeze(['created', 'started', 'disposing', 'disposed']);
export const CORE_OPERATIONS = Object.freeze(['inspect', 'execute', 'recover']);

const MODE_SET = new Set(CORE_ACCESS_MODES);
const STATE_SET = new Set(CORE_LIFECYCLE_STATES);
const OPERATION_SET = new Set(CORE_OPERATIONS);

export class CoreContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoreContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoreContractError(code, message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Core 不推断 DSH_HOME、HOME 或 cwd。默认数据根只能由具体 Host/CLI 边界选择，
 * 再以绝对路径显式传入。物理路径（realpath）与写者租约在 Runtime 实现阶段完成。
 */
export function normalizeCoreOptions(input) {
  if (!plainObject(input)) fail('IRIS_CORE_OPTIONS_INVALID', 'Core Runtime 选项必须是对象');
  const allowed = new Set(['dataRoot', 'mode']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail('IRIS_CORE_OPTIONS_INVALID', `Core Runtime 不允许选项：${key}`);
  }

  const dataRoot = typeof input.dataRoot === 'string' ? input.dataRoot.trim() : '';
  if (!dataRoot || dataRoot.includes('\0') || !path.isAbsolute(dataRoot)) {
    fail('IRIS_CORE_OPTIONS_INVALID', 'Core Runtime dataRoot 必须是显式绝对路径');
  }
  const mode = input.mode ?? 'writer';
  if (!MODE_SET.has(mode)) fail('IRIS_CORE_OPTIONS_INVALID', `未知 Core Runtime 模式：${String(mode)}`);

  return Object.freeze({
    contractVersion: CORE_CONTRACT_VERSION,
    dataRoot: path.normalize(dataRoot),
    mode
  });
}

export function createCoreLifecycle() {
  return Object.freeze({ contractVersion: CORE_CONTRACT_VERSION, state: 'created' });
}

/** 纯状态转换；真正的资源获取、取消与释放由 Runtime 按文档顺序执行。 */
export function transitionCoreLifecycle(snapshot, event) {
  const state = snapshot && snapshot.state;
  if (!STATE_SET.has(state)) fail('IRIS_CORE_STATE_INVALID', 'Core Runtime 生命周期快照无效');

  if (event === 'start' && state === 'created') {
    return Object.freeze({ contractVersion: CORE_CONTRACT_VERSION, state: 'started' });
  }
  if (event === 'dispose' && (state === 'created' || state === 'started')) {
    return Object.freeze({ contractVersion: CORE_CONTRACT_VERSION, state: 'disposing' });
  }
  if (event === 'dispose' && (state === 'disposing' || state === 'disposed')) return snapshot;
  if (event === 'finish-dispose' && state === 'disposing') {
    return Object.freeze({ contractVersion: CORE_CONTRACT_VERSION, state: 'disposed' });
  }
  fail('IRIS_CORE_STATE_INVALID', `Core Runtime 不能在 ${state} 状态执行 ${String(event)}`);
}

/**
 * reader 只允许不产生持久化副作用的 inspect；初始化、修复、索引接回与观察任务
 * 都属于写者行为。此函数只冻结权限真值表，不替代后续的数据根租约。
 */
export function assertCoreOperation(options, lifecycle, operation) {
  if (!options || options.contractVersion !== CORE_CONTRACT_VERSION || !MODE_SET.has(options.mode)) {
    fail('IRIS_CORE_OPTIONS_INVALID', 'Core Runtime 选项未经过当前契约规范化');
  }
  if (!lifecycle || lifecycle.state !== 'started') {
    fail('IRIS_CORE_STATE_INVALID', 'Core Runtime 仅能在 started 状态执行操作');
  }
  if (!OPERATION_SET.has(operation)) {
    fail('IRIS_CORE_OPERATION_INVALID', `未知 Core Runtime 操作：${String(operation)}`);
  }
  if (options.mode === 'reader' && operation !== 'inspect') {
    fail('IRIS_CORE_READ_ONLY', `只读 Core Runtime 不能执行 ${operation}`);
  }
  return true;
}

/** 供未来数据根租约实现统一返回稳定错误；不得暴露本机绝对路径。 */
export function coreDataRootBusyError() {
  return new CoreContractError(
    'IRIS_CORE_DATA_ROOT_BUSY',
    '该 Iris 数据根已有写者；先停止现有写者并运行 doctor --data-root 检查，只有 stale PID 才可显式执行 runtime recover'
  );
}
