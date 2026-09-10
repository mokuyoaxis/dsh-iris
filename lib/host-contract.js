'use strict';

/**
 * Iris Host Adapter v0 的纯契约原语。
 *
 * 本模块不导入 DSH/Cordis，也不读取宿主服务。具体 Adapter 只能把宿主能力
 * 映射到这些命名端口；Command 不得接收原始 ctx。
 */

export const HOST_CONTRACT_VERSION = 0;

export const HOST_PORTS = Object.freeze([
  'attachments',
  'browser',
  'clientSlots',
  'routes',
  'sessions',
  'skills',
  'textModel',
  'tools',
  'visionModel'
]);

const HOST_PORT_SET = new Set(HOST_PORTS);
const HOST_ID = /^[a-z0-9][a-z0-9._-]*$/;
const UNAVAILABLE_KINDS = new Set(['unavailable', 'incompatible']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePortName(name) {
  if (!HOST_PORT_SET.has(name)) throw new Error(`未知 Host Port：${name}`);
}

/**
 * 建立只读 Host Adapter 描述。ports 中只放真实可调用的能力；缺失或版本不兼容
 * 的能力放入 unavailable，供 Doctor 和用户错误复用同一份原因。
 */
export function defineHostAdapter(input) {
  if (!isPlainObject(input)) throw new TypeError('Host Adapter 必须是对象');
  const allowed = new Set(['contractVersion', 'id', 'version', 'ports', 'unavailable']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Host Adapter 不允许顶层字段：${key}`);
  }
  const contractVersion = input.contractVersion ?? HOST_CONTRACT_VERSION;
  if (contractVersion !== HOST_CONTRACT_VERSION) {
    throw new Error(`不支持的 Host Adapter 契约版本：${String(contractVersion)}`);
  }
  const id = String(input.id || '').trim();
  if (!HOST_ID.test(id)) throw new Error('Host Adapter id 必须是小写稳定标识');
  const version = String(input.version || 'unknown').trim() || 'unknown';
  const supplied = input.ports ?? {};
  const missing = input.unavailable ?? {};
  if (!isPlainObject(supplied) || !isPlainObject(missing)) {
    throw new TypeError('Host Adapter ports/unavailable 必须是对象');
  }

  const ports = {};
  for (const [name, value] of Object.entries(supplied)) {
    validatePortName(name);
    if (!isPlainObject(value)) throw new TypeError(`Host Port ${name} 必须是方法对象`);
    ports[name] = value;
  }

  const unavailable = {};
  for (const [name, value] of Object.entries(missing)) {
    validatePortName(name);
    if (Object.prototype.hasOwnProperty.call(ports, name)) {
      throw new Error(`Host Port ${name} 不能同时可用和不可用`);
    }
    if (!isPlainObject(value) || !UNAVAILABLE_KINDS.has(value.kind) || !String(value.reason || '').trim()) {
      throw new TypeError(`Host Port ${name} 的不可用记录必须包含 kind 和 reason`);
    }
    unavailable[name] = Object.freeze({ kind: value.kind, reason: String(value.reason).trim() });
  }

  return Object.freeze({
    contractVersion,
    id,
    version,
    ports: Object.freeze(ports),
    unavailable: Object.freeze(unavailable)
  });
}

export function hasHostPort(adapter, name) {
  validatePortName(name);
  return Boolean(adapter && adapter.ports && Object.prototype.hasOwnProperty.call(adapter.ports, name));
}

export class HostCapabilityError extends Error {
  constructor(adapter, name, operation) {
    validatePortName(name);
    const detail = adapter && adapter.unavailable && adapter.unavailable[name];
    const host = adapter && adapter.id ? adapter.id : 'unknown-host';
    const action = String(operation || '当前操作');
    const suffix = detail && detail.reason ? `：${detail.reason}` : '';
    super(`Iris ${action}需要 Host Port ${name}，但 ${host} 未提供${suffix}`);
    this.name = 'HostCapabilityError';
    this.code = detail && detail.kind === 'incompatible'
      ? 'IRIS_HOST_CAPABILITY_INCOMPATIBLE'
      : 'IRIS_HOST_CAPABILITY_UNAVAILABLE';
    this.hostId = host;
    this.capability = name;
    this.operation = action;
  }
}

export function requireHostPort(adapter, name, operation) {
  if (!hasHostPort(adapter, name)) throw new HostCapabilityError(adapter, name, operation);
  return adapter.ports[name];
}

/** 只返回可序列化能力事实；不得把宿主 live object 暴露给 Doctor/API。 */
export function hostCapabilitySnapshot(adapter) {
  const capabilities = {};
  for (const name of HOST_PORTS) {
    const available = hasHostPort(adapter, name);
    const detail = !available && adapter && adapter.unavailable ? adapter.unavailable[name] : undefined;
    capabilities[name] = available
      ? Object.freeze({ status: 'available' })
      : Object.freeze({ status: detail && detail.kind === 'incompatible' ? 'incompatible' : 'unavailable',
        ...(detail && detail.reason ? { reason: detail.reason } : {}) });
  }
  return Object.freeze({
    contractVersion: HOST_CONTRACT_VERSION,
    host: Object.freeze({ id: adapter && adapter.id || 'unknown-host', version: adapter && adapter.version || 'unknown' }),
    capabilities: Object.freeze(capabilities)
  });
}
