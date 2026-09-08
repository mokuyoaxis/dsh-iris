'use strict';
/**
 * v0.1.3 最小 Provider 提交契约。
 *
 * 这里只定义提交结果、脱敏错误和候选调度边界，不依赖 DSH、配置存储或具体供应商。
 */
import { allowsAutomaticFailover } from './task-semantics.js';
import { parseModelRef } from './models.js';

export const SUBMISSION_KINDS = Object.freeze([
  'completed',
  'accepted',
  'not_accepted',
  'acceptance_unknown'
]);

export const PROVIDER_STAGES = Object.freeze([
  'validate',
  'prepare',
  'upload',
  'submit',
  'response',
  'poll',
  'cancel',
  'download',
  'persist',
  'emit'
]);

export const PROVIDER_ERROR_CATEGORIES = Object.freeze([
  'invalid_request',
  'authentication',
  'quota',
  'rate_limit',
  'network',
  'timeout',
  'aborted',
  'provider',
  'protocol',
  'local_io',
  'unknown'
]);

const ACCEPTANCE = new Set(['not_accepted', 'accepted', 'unknown']);
const SECRET_QUERY = /([?&](?:access[_-]?key|api[_-]?key|authorization|credential|signature|token)=)[^&#\s]+/gi;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const API_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const JSON_SECRET = /(["']?(?:api[_-]?key|authorization|access[_-]?token|secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi;
const POSIX_PATH = /(^|[\s("'=])\/(?:[^/\s"'`,;)}\]]+\/)*[^/\s"'`,;)}\]]+/gm;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\\\s"'`,;)}\]]+\\)*[^\\\s"'`,;)}\]]+/g;

export function redactProviderMessage(value, maxLength = 1000) {
  return String(value || '供应商操作失败')
    .replace(SECRET_QUERY, '$1[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(API_KEY, '[REDACTED]')
    .replace(JSON_SECRET, '$1[REDACTED]')
    .replace(WINDOWS_PATH, '[PATH]')
    .replace(POSIX_PATH, '$1[PATH]')
    .slice(0, maxLength);
}

function enumValue(values, value, fallback) {
  return values.includes(value) ? value : fallback;
}

function integerOrUndefined(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : undefined;
}

/** 只返回允许持久化的结构化字段，不包含 cause、stack、请求体或响应正文。 */
export function providerErrorRecord(error, overrides = {}) {
  const source = error && typeof error === 'object' ? error : {};
  const acceptance = ACCEPTANCE.has(overrides.acceptance)
    ? overrides.acceptance
    : (ACCEPTANCE.has(source.acceptance) ? source.acceptance : 'unknown');
  const out = {
    stage: enumValue(PROVIDER_STAGES, overrides.stage || source.stage, 'submit'),
    category: enumValue(PROVIDER_ERROR_CATEGORIES, overrides.category || source.category, 'unknown'),
    acceptance,
    retryable: Boolean(overrides.retryable ?? source.retryable),
    safeMessage: redactProviderMessage(overrides.safeMessage || source.safeMessage || source.message || error)
  };
  const httpStatus = integerOrUndefined(overrides.httpStatus ?? source.httpStatus ?? source.status);
  if (httpStatus !== undefined) out.httpStatus = httpStatus;
  const providerCode = overrides.providerCode ?? source.providerCode ?? source.code;
  if (typeof providerCode === 'string' && providerCode.trim()) {
    out.providerCode = redactProviderMessage(providerCode.trim(), 128);
  }
  return out;
}

export class ProviderContractError extends Error {
  constructor(message, details = {}) {
    super(redactProviderMessage(message));
    this.name = 'ProviderContractError';
    Object.assign(this, providerErrorRecord({ ...details, message }, details));
  }

  toJSON() {
    return providerErrorRecord(this);
  }
}

export function normalizeSubmissionResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Provider submit 必须返回结构化结果');
  }
  if (!SUBMISSION_KINDS.includes(value.kind)) {
    throw new TypeError('未知 Provider submit kind: ' + String(value.kind));
  }
  if (value.kind === 'completed') {
    return { kind: 'completed', acceptance: 'accepted', value: value.value };
  }
  if (value.kind === 'accepted') {
    const remoteTaskId = String(value.remoteTaskId || '').trim();
    if (!remoteTaskId) throw new TypeError('accepted 结果必须包含 remoteTaskId');
    return { kind: 'accepted', acceptance: 'accepted', remoteTaskId };
  }
  const acceptance = value.kind === 'not_accepted' ? 'not_accepted' : 'unknown';
  return {
    kind: value.kind,
    acceptance,
    error: providerErrorRecord(value.error, { acceptance })
  };
}

export function resultFromThrown(error) {
  const safe = providerErrorRecord(error);
  if (safe.acceptance === 'not_accepted') {
    return normalizeSubmissionResult({ kind: 'not_accepted', error: safe });
  }
  return normalizeSubmissionResult({ kind: 'acceptance_unknown', error: safe });
}

function safeAttemptSnapshot(attempt, result) {
  const out = {
    id: attempt.id,
    ordinal: attempt.ordinal,
    providerId: attempt.providerId,
    model: attempt.model,
    acceptance: result.acceptance,
    resultKind: result.kind
  };
  if (result.remoteTaskId) out.remoteTaskId = result.remoteTaskId;
  if (result.error) out.error = result.error;
  return out;
}

/**
 * 串行尝试 Provider 候选，并强制执行写前记录与受理边界。
 *
 * beforeAttempt 必须把 Attempt 写入持久化存储后再返回。afterResult 的落盘失败
 * 会作为 localError 返回并立即停止；即使结果明确未受理，也不在证据未落盘时继续。
 */
export async function submitWithAcceptanceBoundary(candidates, input, hooks = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError('至少需要一个 Provider 候选');
  }
  if (typeof hooks.beforeAttempt !== 'function') {
    throw new TypeError('beforeAttempt 写前持久化 Hook 必填');
  }

  const attempts = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!candidate || typeof candidate.submit !== 'function') {
      throw new TypeError(`Provider 候选 ${index + 1} 缺少 submit()`);
    }
    const initial = {
      ordinal: index + 1,
      providerId: String(candidate.id || '').trim(),
      model: String(candidate.model || '').trim(),
      acceptance: 'none',
      stage: 'submitting'
    };
    const parsedModel = parseModelRef(initial.model);
    if (!initial.providerId || !parsedModel || parsedModel.providerId !== initial.providerId) {
      throw new TypeError(`Provider 候选 ${index + 1} 缺少 id、复合 model，或两者身份不一致`);
    }

    // 写前 Hook 失败时尚未调用供应商；错误原样抛出，由本地持久化层处理。
    const persisted = await hooks.beforeAttempt({ ...initial });
    const attemptId = persisted && typeof persisted.id === 'string' ? persisted.id.trim() : '';
    if (!attemptId) throw new TypeError('beforeAttempt 必须返回已持久化的稳定 Attempt ID');
    // Hook 只能补充持久化身份和可选元数据，不能改写候选 Provider、模型或 ordinal。
    const attempt = {
      ...initial,
      id: attemptId,
      ...(typeof persisted.startedAt === 'string' ? { startedAt: persisted.startedAt } : {}),
      ...(typeof persisted.idempotencyKey === 'string' ? { idempotencyKey: persisted.idempotencyKey } : {})
    };

    let result;
    try {
      result = normalizeSubmissionResult(await candidate.submit(input, { attempt: { ...attempt } }));
    } catch (error) {
      result = resultFromThrown(error);
    }

    const snapshot = safeAttemptSnapshot(attempt, result);
    attempts.push(snapshot);
    if (typeof hooks.afterResult === 'function') {
      try {
        await hooks.afterResult({ ...snapshot });
      } catch (error) {
        return {
          candidate,
          result,
          attempts,
          localError: providerErrorRecord(error, {
            stage: 'persist',
            category: 'local_io',
            acceptance: result.acceptance
          })
        };
      }
    }

    if (!allowsAutomaticFailover(result)) {
      return { candidate, result, attempts, localError: null };
    }
  }

  return {
    candidate: null,
    result: attempts.length
      ? { kind: 'not_accepted', acceptance: 'not_accepted', error: attempts.at(-1).error }
      : null,
    attempts,
    localError: null
  };
}
