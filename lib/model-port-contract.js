'use strict';
/** Text/Vision v0 纯契约；不读取配置、宿主或存储，不拥有网络与 timer。 */

export const MODEL_PORT_CONTRACT_VERSION = 0;
export const MODEL_IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const MESSAGES = Object.freeze({
  IRIS_MODEL_INPUT_INVALID: '模型请求或预算不合法',
  IRIS_MODEL_IMAGE_TOO_LARGE: '图片超过模型输入预算',
  IRIS_MODEL_UNAVAILABLE: '模型能力不可用',
  IRIS_MODEL_INCOMPATIBLE: '模型端口或协议不兼容',
  IRIS_MODEL_UNSUPPORTED: '模型不支持所请求的能力或参数',
  IRIS_MODEL_AUTH_FAILED: '模型请求被认证或权限检查拒绝',
  IRIS_MODEL_RATE_LIMITED: '模型请求受到速率或额度限制',
  IRIS_MODEL_REQUEST_FAILED: '模型请求失败，未自动重试',
  IRIS_MODEL_PROTOCOL_INVALID: '模型响应不符合协议',
  IRIS_MODEL_INCOMPLETE: '模型结果缺少正常结束信号',
  IRIS_MODEL_OUTPUT_LIMIT: '模型结果超过输出预算或被截断',
  IRIS_MODEL_CALL_LIMIT: '模型操作的调用次数已用尽',
  IRIS_MODEL_EMPTY_RESULT: '模型正常结束但没有正文',
  IRIS_MODEL_UNEXPECTED_TOOL: '模型意外请求了工具',
  IRIS_MODEL_CONTENT_BLOCKED: '模型结果被内容策略阻断',
  IRIS_MODEL_ABORTED: '模型操作已在本地取消',
  IRIS_MODEL_TIMEOUT: '模型操作超过时间预算'
});
export const MODEL_ERROR_CODES = Object.freeze(Object.keys(MESSAGES));
const ERROR_RECORDS = new WeakMap();
const STAGES = new Set(['validate', 'prepare', 'invoke', 'read', 'normalize']);
const INVOCATIONS = new Set(['not_invoked', 'rejected', 'responded', 'unknown']);
const SUPPORT = new Set(['supported', 'unsupported', 'unknown']);
const BACKEND_ID = /^[a-z][a-z0-9-]*:[A-Za-z0-9._~%:-]+$/;
const encoder = new TextEncoder();

function backendIdValid(value) {
  return typeof value === 'string' && value.length <= 512 && BACKEND_ID.test(value);
}

/** 不接受供应商原文；私有记录确保篡改 Error.message/code 不影响安全序列化。 */
export class ModelPortError extends Error {
  constructor(code, details = {}) {
    if (typeof code !== 'string' || !Object.hasOwn(MESSAGES, code)) throw new TypeError('未知模型错误码');
    super(MESSAGES[code]);
    this.name = 'ModelPortError';
    const { stage = 'validate', invocation = 'not_invoked', backendId, status, imageBytes, imageMaxBytes } = details;
    if (!STAGES.has(stage) || !INVOCATIONS.has(invocation)
        || (backendId !== undefined && !backendIdValid(backendId))
        || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
        || [imageBytes, imageMaxBytes].some(value => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))) {
      throw new TypeError('模型错误上下文不合法');
    }
    const message = code === 'IRIS_MODEL_IMAGE_TOO_LARGE' && imageBytes
      ? `图片大小 ${imageBytes} 字节${imageMaxBytes ? `，输入上限 ${imageMaxBytes} 字节` : '，超过模型输入上限'}；请调整账号或模型的看图输入预算`
      : MESSAGES[code];
    const record = Object.freeze({ code, message, stage, invocation,
      ...(backendId !== undefined ? { backendId } : {}), ...(status !== undefined ? { status } : {}),
      ...(imageBytes !== undefined ? { imageBytes } : {}), ...(imageMaxBytes !== undefined ? { imageMaxBytes } : {}) });
    ERROR_RECORDS.set(this, record);
    Object.assign(this, record);
  }
  toJSON() { return modelErrorRecord(this); }
}

/** 任意原始错误默认按未知调用失败处理，不信任其 code/status/message/cause。 */
export function modelErrorRecord(error) {
  return Object.freeze({ ...(ERROR_RECORDS.get(error) || {
    code: 'IRIS_MODEL_REQUEST_FAILED', message: MESSAGES.IRIS_MODEL_REQUEST_FAILED,
    stage: 'invoke', invocation: 'unknown'
  }) });
}

export function normalizeModelError(error, context = {}) {
  const record = modelErrorRecord(error);
  return new ModelPortError(record.code, {
    stage: record.stage, invocation: record.invocation,
    ...(record.backendId !== undefined ? { backendId: record.backendId } : {}),
    ...(record.status !== undefined ? { status: record.status } : {}), ...context,
    ...(record.imageBytes !== undefined ? { imageBytes: record.imageBytes } : {}),
    ...(record.imageMaxBytes !== undefined ? { imageMaxBytes: record.imageMaxBytes } : {})
  });
}

function fail(code, context) { throw new ModelPortError(code, context); }

// DTO 必须为自有数据字段；不执行 getter、不接受原型 live object 或 symbol 字段。
function dto(value, allowed, code, context) {
  if (value === null || typeof value !== 'object'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code, context);
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(fields[key], 'value')) fail(code, context);
  }
}

function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function stableId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.startsWith('/') && !value.includes('://');
}

function stringList(value, accepts, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const fields = Object.getOwnPropertyDescriptors(value);
  const length = fields.length.value;
  // 不读取元素 getter，也不调用自定义 iterator；只接受密集的自有数据元素。
  if (Reflect.ownKeys(fields).length !== length + 1) fail(code);
  const out = [];
  for (let index = 0; index < length; index++) {
    const field = fields[index];
    if (!field || !Object.hasOwn(field, 'value') || !accepts(field.value)) fail(code);
    out.push(field.value);
  }
  if (new Set(out).size !== length) fail(code);
  return Object.freeze(out);
}

function identity(value, code, context) {
  dto(value, ['origin', 'backendId', 'providerId', 'modelId'], code, context);
  if (!['provider', 'host'].includes(value.origin) || !backendIdValid(value.backendId)) fail(code, context);
  const out = { origin: value.origin, backendId: value.backendId };
  for (const key of ['providerId', 'modelId']) {
    if (value[key] !== undefined) {
      if (!stableId(value[key])) fail(code, context);
      out[key] = value[key];
    } else if (value.origin === 'provider') fail(code, context);
  }
  return Object.freeze(out);
}

/** 验证并复制描述；unknown 保持 unknown，缺省 Host 身份与限制不编造。 */
export function normalizeModelDescriptor(value) {
  const code = 'IRIS_MODEL_INCOMPATIBLE';
  dto(value, ['contractVersion', 'kind', 'identity', 'availability', 'reasonCode', 'features', 'reasoning', 'image'], code);
  if (value.contractVersion !== MODEL_PORT_CONTRACT_VERSION || !['text', 'vision'].includes(value.kind)
      || !['available', 'unavailable', 'incompatible'].includes(value.availability)) fail(code);
  const validReason = typeof value.reasonCode === 'string' && Object.hasOwn(MESSAGES, value.reasonCode);
  if ((value.availability !== 'available' && !validReason)
      || (value.reasonCode !== undefined && !validReason)) fail(code);
  const bound = identity(value.identity, code);
  dto(value.features, ['system', 'temperature', 'maxOutputTokens', 'reasoning'], code);
  const features = {};
  for (const name of ['system', 'temperature', 'maxOutputTokens', 'reasoning']) {
    if (!SUPPORT.has(value.features[name])) fail(code);
    features[name] = value.features[name];
  }
  const out = { contractVersion: MODEL_PORT_CONTRACT_VERSION, kind: value.kind, identity: bound,
    availability: value.availability, ...(value.reasonCode !== undefined ? { reasonCode: value.reasonCode } : {}),
    features: Object.freeze(features) };
  if (value.reasoning !== undefined) {
    dto(value.reasoning, ['off', 'effortIds'], code);
    if (!SUPPORT.has(value.reasoning.off)) fail(code);
    const reasoning = { off: value.reasoning.off };
    if (value.reasoning.effortIds !== undefined) {
      reasoning.effortIds = stringList(value.reasoning.effortIds, stableId, code);
    }
    if (features.reasoning !== 'supported' && (reasoning.off === 'supported' || reasoning.effortIds?.length)) fail(code);
    out.reasoning = Object.freeze(reasoning);
  }
  if (value.image !== undefined) {
    if (value.kind !== 'vision') fail(code);
    dto(value.image, ['mediaTypes', 'maxBytes'], code);
    const image = {};
    if (value.image.mediaTypes !== undefined) {
      image.mediaTypes = stringList(value.image.mediaTypes, type => MODEL_IMAGE_MEDIA_TYPES.includes(type), code);
    }
    if (value.image.maxBytes !== undefined) {
      if (!positiveInteger(value.image.maxBytes)) fail(code);
      image.maxBytes = value.image.maxBytes;
    }
    out.image = Object.freeze(image);
  }
  return Object.freeze(out);
}

export function modelPortSnapshot(port) {
  try {
    dto(port, ['describe', 'complete'], 'IRIS_MODEL_INCOMPATIBLE');
    if (typeof port.describe !== 'function' || typeof port.complete !== 'function') fail('IRIS_MODEL_INCOMPATIBLE');
    return normalizeModelDescriptor(port.describe());
  } catch (_) { fail('IRIS_MODEL_INCOMPATIBLE'); }
}

export function normalizeModelCallOptions(descriptor, options) {
  const code = 'IRIS_MODEL_INPUT_INVALID';
  const context = { backendId: descriptor.identity.backendId };
  dto(options, ['signal', 'budget'], code, context);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail(code, context);
  dto(options.budget, ['timeoutMs', 'maxInputTextBytes', 'maxOutputChars', ...(descriptor.kind === 'vision' ? ['maxImageBytes'] : [])], code, context);
  const budget = {};
  for (const key of ['timeoutMs', 'maxInputTextBytes', 'maxOutputChars', ...(descriptor.kind === 'vision' ? ['maxImageBytes'] : [])]) {
    if (!positiveInteger(options.budget[key])) fail(code, context);
    budget[key] = options.budget[key];
  }
  return Object.freeze({ budget: Object.freeze(budget), ...(options.signal !== undefined ? { signal: options.signal } : {}) });
}

export function normalizeModelOperationOptions(value) {
  const code = 'IRIS_MODEL_INPUT_INVALID';
  dto(value, ['signal', 'budget'], code);
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) fail(code);
  dto(value.budget, ['timeoutMs', 'maxInvocations'], code);
  const maxInvocations = value.budget.maxInvocations === undefined ? 1 : value.budget.maxInvocations;
  if (!positiveInteger(value.budget.timeoutMs) || !positiveInteger(maxInvocations)) fail(code);
  return Object.freeze({ budget: Object.freeze({ timeoutMs: value.budget.timeoutMs, maxInvocations }),
    ...(value.signal !== undefined ? { signal: value.signal } : {}) });
}

/** 只做纯校验，不启动 deadline；Vision 字节在验证大小后复制。 */
export function normalizeModelCall(descriptor, request, options) {
  const code = 'IRIS_MODEL_INPUT_INVALID';
  const context = { backendId: descriptor.identity.backendId };
  const normalizedOptions = normalizeModelCallOptions(descriptor, options);
  const budget = normalizedOptions.budget;
  dto(request, ['prompt', 'system', 'generation', ...(descriptor.kind === 'vision' ? ['image'] : [])], code, context);
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) fail(code, context);
  if (request.system !== undefined && (typeof request.system !== 'string' || !request.system.trim())) fail(code, context);
  if (encoder.encode(request.prompt).byteLength + encoder.encode(request.system || '').byteLength > budget.maxInputTextBytes) fail(code, context);
  const out = { prompt: request.prompt, ...(request.system !== undefined ? { system: request.system } : {}) };
  if (request.system !== undefined && descriptor.features.system !== 'supported') fail('IRIS_MODEL_UNSUPPORTED', context);
  if (request.generation !== undefined) {
    dto(request.generation, ['temperature', 'maxOutputTokens', 'reasoning'], code, context);
    const generation = {};
    for (const key of ['temperature', 'maxOutputTokens']) {
      const value = request.generation[key];
      if (value !== undefined) {
        if (key === 'temperature' ? !Number.isFinite(value) || value < 0 : !positiveInteger(value)) fail(code, context);
        if (descriptor.features[key] !== 'supported') fail('IRIS_MODEL_UNSUPPORTED', context);
        generation[key] = value;
      }
    }
    if (request.generation.reasoning !== undefined) {
      const value = request.generation.reasoning;
      dto(value, ['mode', 'effortId'], code, context);
      if (!['provider-default', 'off', 'effort'].includes(value.mode)) fail(code, context);
      if (value.mode !== 'effort' && Object.hasOwn(value, 'effortId')) fail(code, context);
      if (value.mode === 'effort' && !stableId(value.effortId)) fail(code, context);
      if (value.mode !== 'provider-default' && (descriptor.features.reasoning !== 'supported'
          || (value.mode === 'off' ? descriptor.reasoning?.off !== 'supported' : !descriptor.reasoning?.effortIds?.includes(value.effortId)))) {
        fail('IRIS_MODEL_UNSUPPORTED', context);
      }
      generation.reasoning = Object.freeze({ mode: value.mode, ...(value.mode === 'effort' ? { effortId: value.effortId } : {}) });
    }
    out.generation = Object.freeze(generation);
  }
  if (descriptor.kind === 'vision') {
    dto(request.image, ['bytes', 'mediaType'], code, context);
    const { bytes, mediaType } = request.image;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || !MODEL_IMAGE_MEDIA_TYPES.includes(mediaType)) fail(code, context);
    if (bytes.byteLength > budget.maxImageBytes || (descriptor.image?.maxBytes !== undefined && bytes.byteLength > descriptor.image.maxBytes)) fail(code, context);
    if (descriptor.image?.mediaTypes && !descriptor.image.mediaTypes.includes(mediaType)) fail('IRIS_MODEL_UNSUPPORTED', context);
    out.image = Object.freeze({ bytes: new Uint8Array(bytes), mediaType });
  }
  return Object.freeze({ request: Object.freeze(out), options: normalizedOptions });
}

function requireStop(reason, context) {
  if (reason === 'stop') return;
  const codes = { length: 'IRIS_MODEL_OUTPUT_LIMIT', 'max-tokens': 'IRIS_MODEL_OUTPUT_LIMIT',
    'tool-calls': 'IRIS_MODEL_UNEXPECTED_TOOL', 'content-blocked': 'IRIS_MODEL_CONTENT_BLOCKED',
    error: 'IRIS_MODEL_REQUEST_FAILED', aborted: 'IRIS_MODEL_ABORTED' };
  fail(reason === undefined || reason === null ? 'IRIS_MODEL_INCOMPLETE'
    : typeof reason === 'string' && Object.hasOwn(codes, reason) ? codes[reason] : 'IRIS_MODEL_PROTOCOL_INVALID', context);
}

export function normalizeModelCompletion(descriptor, value, budget) {
  const context = { stage: 'normalize', invocation: 'unknown', backendId: descriptor.identity.backendId };
  dto(value, ['contractVersion', 'text', 'finishReason', 'identity', 'usage'], 'IRIS_MODEL_PROTOCOL_INVALID', context);
  if (typeof value.text === 'string' && value.text.length || value.finishReason === 'stop') context.invocation = 'responded';
  if (value.contractVersion !== MODEL_PORT_CONTRACT_VERSION || typeof value.text !== 'string') fail('IRIS_MODEL_PROTOCOL_INVALID', context);
  requireStop(value.finishReason, context);
  if (!value.text.trim()) fail('IRIS_MODEL_EMPTY_RESULT', context);
  if (value.text.length > budget.maxOutputChars) fail('IRIS_MODEL_OUTPUT_LIMIT', context);
  const actual = identity(value.identity, 'IRIS_MODEL_PROTOCOL_INVALID', context);
  for (const key of ['origin', 'backendId', 'providerId', 'modelId']) {
    if (descriptor.identity[key] !== undefined && actual[key] !== descriptor.identity[key]) fail('IRIS_MODEL_PROTOCOL_INVALID', context);
  }
  const out = { contractVersion: MODEL_PORT_CONTRACT_VERSION, text: value.text, finishReason: 'stop', identity: actual };
  if (value.usage !== undefined) {
    dto(value.usage, ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens'], 'IRIS_MODEL_PROTOCOL_INVALID', context);
    const usage = {};
    for (const [key, count] of Object.entries(value.usage)) {
      if (!Number.isSafeInteger(count) || count < 0) fail('IRIS_MODEL_PROTOCOL_INVALID', context);
      usage[key] = count;
    }
    out.usage = Object.freeze(usage);
  }
  return Object.freeze(out);
}

/** 协议无关的正文收集器；适配器先映射事件，思考/工具事件不得作为 text 传入。 */
export function createModelTextCollector({ maxOutputChars, signal, backendId } = {}) {
  if (!positiveInteger(maxOutputChars) || (signal !== undefined && !(signal instanceof AbortSignal))) fail('IRIS_MODEL_INPUT_INVALID');
  if (backendId !== undefined && !backendIdValid(backendId)) fail('IRIS_MODEL_INPUT_INVALID');
  const blocks = new Map();
  let length = 0;
  let responded = false;
  let stopped = false;
  let failure;
  const context = () => ({ stage: 'read', invocation: responded ? 'responded' : 'unknown', ...(backendId ? { backendId } : {}) });
  const reject = (code) => { failure = new ModelPortError(code, context()); throw failure; };
  const check = () => {
    if (failure) throw failure;
    if (signal?.aborted) reject('IRIS_MODEL_ABORTED');
  };
  const update = (text, id, replace) => {
    check();
    if (stopped || typeof text !== 'string' || !stableId(id)) reject('IRIS_MODEL_PROTOCOL_INVALID');
    if (text.length) responded = true;
    const previous = blocks.get(id) || '';
    const nextLength = length + text.length - (replace ? previous.length : 0);
    if (nextLength > maxOutputChars) {
      failure = new ModelPortError('IRIS_MODEL_OUTPUT_LIMIT', { ...context(), invocation: 'responded' });
      throw failure;
    }
    blocks.set(id, replace ? text : previous + text);
    length = nextLength;
  };
  return Object.freeze({
    append: (text, id = 'default') => update(text, id, false),
    replace: (text, id = 'default') => update(text, id, true),
    fail(error) {
      check();
      failure = normalizeModelError(error, context());
      throw failure;
    },
    finish(reason) {
      check();
      if (stopped) reject('IRIS_MODEL_PROTOCOL_INVALID');
      if (['stop', 'length', 'max-tokens', 'tool-calls', 'content-blocked'].includes(reason)) responded = true;
      try { requireStop(reason, context()); } catch (error) { failure = error; throw error; }
      stopped = true;
    },
    complete() {
      check();
      if (!stopped) reject('IRIS_MODEL_INCOMPLETE');
      const text = [...blocks.values()].join('');
      if (!text.trim()) reject('IRIS_MODEL_EMPTY_RESULT');
      return text;
    }
  });
}
