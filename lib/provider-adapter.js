'use strict';

/**
 * Iris Provider Adapter v0 完整生命周期契约。
 *
 * 本模块不读取配置、不调用网络、不创建 Task，也不依赖 DSH。具体供应商只把
 * discovery/submit/poll/cancel/download/error mapping 映射到这些稳定结果。
 */
import {
  ProviderContractError,
  normalizeSubmissionResult,
  providerErrorRecord,
  resultFromThrown
} from './provider-contract.js';

export const PROVIDER_ADAPTER_CONTRACT_VERSION = 0;

export const PROVIDER_OPERATIONS = Object.freeze([
  'discover',
  'submit',
  'poll',
  'cancel',
  'download',
  'mapError'
]);

export const PROVIDER_TASK_CAPABILITIES = Object.freeze([
  'image',
  'video',
  'tts',
  'transcribe'
]);

export const PROVIDER_POLL_KINDS = Object.freeze([
  'pending',
  'succeeded',
  'failed',
  'canceled',
  'unknown'
]);

export const PROVIDER_CANCEL_KINDS = Object.freeze([
  'canceled',
  'not_supported',
  'unknown'
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROTOCOL = /^[a-z0-9][a-z0-9._-]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateOperation(name) {
  if (!PROVIDER_OPERATIONS.includes(name)) throw new Error('未知 Provider 操作：' + String(name));
}

function normalizedReason(value, fallback) {
  const text = String(value || fallback || '').trim();
  if (!text) throw new TypeError('Provider unsupported 原因不能为空');
  return text.slice(0, 500);
}

/**
 * 建立只读 Adapter 描述。每个生命周期操作必须恰好出现在 operations 或
 * unsupported 之一，避免“方法不存在”被误解成临时故障。
 */
export function defineProviderAdapter(input) {
  if (!isPlainObject(input)) throw new TypeError('Provider Adapter 必须是对象');
  const allowed = new Set([
    'contractVersion', 'id', 'protocol', 'capabilities', 'operations', 'unsupported'
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error('Provider Adapter 不允许顶层字段：' + key);
  }

  const contractVersion = input.contractVersion ?? PROVIDER_ADAPTER_CONTRACT_VERSION;
  if (contractVersion !== PROVIDER_ADAPTER_CONTRACT_VERSION) {
    throw new Error('不支持的 Provider Adapter 契约版本：' + String(contractVersion));
  }
  const id = String(input.id || '').trim();
  const protocol = String(input.protocol || '').trim();
  if (!ID.test(id)) throw new Error('Provider Adapter id 必须是稳定标识');
  if (!PROTOCOL.test(protocol)) throw new Error('Provider Adapter protocol 必须是小写稳定标识');

  const capabilities = [...new Set(Array.isArray(input.capabilities) ? input.capabilities : [])];
  if (!capabilities.length || capabilities.some((item) => !PROVIDER_TASK_CAPABILITIES.includes(item))) {
    throw new Error('Provider Adapter capabilities 必须使用已知媒体任务能力');
  }

  const supplied = input.operations ?? {};
  const missing = input.unsupported ?? {};
  if (!isPlainObject(supplied) || !isPlainObject(missing)) {
    throw new TypeError('Provider Adapter operations/unsupported 必须是对象');
  }

  const operations = {};
  const unsupported = {};
  for (const name of Object.keys(supplied)) validateOperation(name);
  for (const name of Object.keys(missing)) validateOperation(name);
  for (const name of PROVIDER_OPERATIONS) {
    const hasOperation = Object.prototype.hasOwnProperty.call(supplied, name);
    const hasUnsupported = Object.prototype.hasOwnProperty.call(missing, name);
    if (hasOperation === hasUnsupported) {
      throw new Error('Provider 操作 ' + name + ' 必须恰好声明为 supported 或 unsupported');
    }
    if (hasOperation) {
      if (typeof supplied[name] !== 'function') {
        throw new TypeError('Provider 操作 ' + name + ' 必须是函数');
      }
      operations[name] = supplied[name];
    } else {
      unsupported[name] = Object.freeze({ reason: normalizedReason(missing[name], name + ' 未实现') });
    }
  }
  if (!operations.submit || !operations.mapError) {
    throw new Error('Provider Adapter 必须实现 submit 与 mapError');
  }

  return Object.freeze({
    contractVersion,
    id,
    protocol,
    capabilities: Object.freeze(capabilities),
    operations: Object.freeze(operations),
    unsupported: Object.freeze(unsupported)
  });
}

export class ProviderOperationError extends Error {
  constructor(adapter, operation) {
    validateOperation(operation);
    const providerId = adapter?.id || 'unknown-provider';
    const reason = adapter?.unsupported?.[operation]?.reason || '操作未实现';
    super('Iris Provider ' + providerId + ' 不支持 ' + operation + '：' + reason);
    this.name = 'ProviderOperationError';
    this.code = 'IRIS_PROVIDER_OPERATION_UNSUPPORTED';
    this.providerId = providerId;
    this.protocol = adapter?.protocol || 'unknown';
    this.operation = operation;
  }
}

export function hasProviderOperation(adapter, operation) {
  validateOperation(operation);
  return Boolean(adapter?.operations && typeof adapter.operations[operation] === 'function');
}

export function requireProviderOperation(adapter, operation) {
  if (!hasProviderOperation(adapter, operation)) throw new ProviderOperationError(adapter, operation);
  return adapter.operations[operation];
}

/** 只输出可序列化能力事实；不会暴露闭包中的 key、baseUrl 或 live transport。 */
export function providerAdapterSnapshot(adapter) {
  const operations = {};
  for (const name of PROVIDER_OPERATIONS) {
    operations[name] = hasProviderOperation(adapter, name)
      ? Object.freeze({ status: 'supported' })
      : Object.freeze({
        status: 'unsupported',
        reason: adapter?.unsupported?.[name]?.reason || '操作未实现'
      });
  }
  return Object.freeze({
    contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
    provider: Object.freeze({
      id: adapter?.id || 'unknown-provider',
      protocol: adapter?.protocol || 'unknown'
    }),
    capabilities: Object.freeze([...(adapter?.capabilities || [])]),
    operations: Object.freeze(operations)
  });
}

export function normalizeDiscoveryResult(value) {
  const source = Array.isArray(value) ? value : value?.models;
  if (!Array.isArray(source)) throw new TypeError('Provider discover 必须返回 models 数组');
  const models = [];
  const seen = new Set();
  for (const item of source) {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model = { id };
    if (Array.isArray(item?.capabilities)) {
      const capabilities = [...new Set(item.capabilities.filter((cap) => typeof cap === 'string' && cap))];
      if (capabilities.length) model.capabilities = Object.freeze(capabilities);
    }
    models.push(Object.freeze(model));
  }
  return Object.freeze({ models: Object.freeze(models) });
}

function normalizeArtifacts(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('Provider poll artifacts 必须是数组');
  return Object.freeze(value.map((item) => {
    if (!isPlainObject(item) || item.kind !== 'remote-url') {
      throw new TypeError('Provider artifact 当前只支持 remote-url');
    }
    const url = String(item.url || '').trim();
    if (!url) throw new TypeError('Provider remote-url artifact 缺少 url');
    return Object.freeze({
      kind: 'remote-url',
      url,
      ...(typeof item.mediaType === 'string' && item.mediaType ? { mediaType: item.mediaType } : {})
    });
  }));
}

/**
 * poll 标准结果。兼容旧 {done,ok,urls,text,status,message} 仅用于 0.1.x 渐进迁移；
 * 新 Adapter 必须直接返回 kind 结果。
 */
export function normalizeProviderPollResult(value) {
  if (!isPlainObject(value)) throw new TypeError('Provider poll 必须返回结构化结果');

  if (!PROVIDER_POLL_KINDS.includes(value.kind) && typeof value.done === 'boolean') {
    if (!value.done) return Object.freeze({
      kind: 'pending',
      ...(value.status ? { progress: String(value.status) } : {})
    });
    if (value.ok) {
      return Object.freeze({
        kind: 'succeeded',
        artifacts: normalizeArtifacts((value.urls || []).map((url) => ({ kind: 'remote-url', url }))),
        ...(typeof value.text === 'string'
          ? { value: Object.freeze({ kind: 'text', text: value.text }) }
          : {})
      });
    }
    return Object.freeze({
      kind: 'failed',
      error: Object.freeze(providerErrorRecord(value.message || '供应商任务失败', {
        stage: 'poll', category: 'provider', acceptance: 'accepted'
      }))
    });
  }

  if (!PROVIDER_POLL_KINDS.includes(value.kind)) {
    throw new TypeError('未知 Provider poll kind：' + String(value.kind));
  }
  if (value.kind === 'pending') {
    return Object.freeze({
      kind: 'pending',
      ...(value.progress !== undefined ? { progress: String(value.progress) } : {})
    });
  }
  if (value.kind === 'succeeded') {
    return Object.freeze({
      kind: 'succeeded',
      artifacts: normalizeArtifacts(value.artifacts),
      ...(value.value !== undefined ? { value: value.value } : {})
    });
  }
  const stage = value.kind === 'canceled' ? 'cancel' : 'poll';
  return Object.freeze({
    kind: value.kind,
    error: Object.freeze(providerErrorRecord(value.error || value.message || ('Provider poll ' + value.kind), {
      stage,
      category: value.kind === 'canceled' ? 'aborted' : undefined,
      acceptance: 'accepted'
    }))
  });
}

export function normalizeProviderCancelResult(value) {
  if (!isPlainObject(value) || !PROVIDER_CANCEL_KINDS.includes(value.kind)) {
    throw new TypeError('Provider cancel 必须返回 canceled/not_supported/unknown');
  }
  if (value.kind === 'canceled') return Object.freeze({ kind: 'canceled' });
  if (value.kind === 'not_supported') {
    return Object.freeze({ kind: 'not_supported', reason: normalizedReason(value.reason, '供应商不支持远端取消') });
  }
  return Object.freeze({
    kind: 'unknown',
    error: Object.freeze(providerErrorRecord(value.error || value.message || '远端取消结果未知', {
      stage: 'cancel', acceptance: 'accepted'
    }))
  });
}

export function normalizeProviderDownloadResult(value) {
  const bytes = Number(typeof value === 'number' ? value : value?.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError('Provider download 必须返回非负安全整数 bytes');
  }
  return Object.freeze({ bytes });
}

function mappedError(adapter, error, context) {
  const mapper = requireProviderOperation(adapter, 'mapError');
  let mapped;
  try {
    mapped = mapper(error, context);
  } catch (mappingError) {
    mapped = mappingError;
  }
  const source = mapped || error;
  const defaults = {};
  for (const key of ['stage', 'category', 'acceptance', 'retryable']) {
    if (source == null || source[key] === undefined) defaults[key] = context[key];
  }
  return providerErrorRecord(source, defaults);
}

function operationErrorContext(operation, context) {
  const supplied = isPlainObject(context) ? context : {};
  if (operation === 'submit') return { stage: 'submit', acceptance: 'unknown', ...supplied };
  if (operation === 'discover') return { stage: 'validate', acceptance: 'not_accepted', ...supplied };
  if (operation === 'poll') return { stage: 'poll', acceptance: 'accepted', ...supplied };
  if (operation === 'cancel') return { stage: 'cancel', acceptance: 'accepted', ...supplied };
  if (operation === 'download') return { stage: 'download', acceptance: 'accepted', ...supplied };
  return supplied;
}

/**
 * 生命周期统一调用入口。submit 异常转为保守四态结果；cancel 异常转为 unknown；
 * poll/download/discover 保持抛错，让调度器应用各自的重试和事实规则。
 */
export async function invokeProviderOperation(adapter, operation, input, context = {}) {
  validateOperation(operation);
  if (operation === 'mapError') {
    return mappedError(adapter, input, context);
  }
  const fn = requireProviderOperation(adapter, operation);
  const errorContext = operationErrorContext(operation, context);
  let value;
  try {
    value = await fn(input, context);
  } catch (error) {
    const evidenceContext = { ...errorContext };
    for (const key of ['stage', 'category', 'acceptance', 'retryable']) {
      if (error && error[key] !== undefined) evidenceContext[key] = error[key];
    }
    const safe = mappedError(adapter, error, evidenceContext);
    if (operation === 'submit') return resultFromThrown(safe);
    if (operation === 'cancel') return normalizeProviderCancelResult({ kind: 'unknown', error: safe });
    throw new ProviderContractError(safe.safeMessage, safe);
  }

  if (operation === 'discover') return normalizeDiscoveryResult(value);
  if (operation === 'submit') return normalizeSubmissionResult(value);
  if (operation === 'poll') return normalizeProviderPollResult(value);
  if (operation === 'cancel') return normalizeProviderCancelResult(value);
  if (operation === 'download') return normalizeProviderDownloadResult(value);
  throw new Error('未处理的 Provider 操作：' + operation);
}

/** 0.1.x 任务观察器兼容视图；0.2.0 Command 完全消费 canonical poll 后可删除。 */
export function providerPollTaskView(value) {
  const result = normalizeProviderPollResult(value);
  if (result.kind === 'pending') {
    return { kind: result.kind, done: false, ok: false, urls: [], status: result.progress || 'running' };
  }
  if (result.kind === 'succeeded') {
    const urls = result.artifacts.map((item) => item.url);
    if (result.value?.kind === 'text') urls.push(String(result.value.text || ''));
    return { kind: result.kind, done: true, ok: true, urls, value: result.value };
  }
  return {
    kind: result.kind,
    done: true,
    ok: false,
    urls: [],
    message: result.error.safeMessage,
    error: result.error
  };
}
