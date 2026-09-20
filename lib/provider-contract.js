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
// 凭据查询参数：允许厂商前缀（x-amz- / x-oss- / OSSAccessKeyId 这类驼峰），但**限制尾部后缀**
// （审计 C-9 要求覆盖带前缀参数名）。
//
// 正则分两级，是为了同时满足两个方向：
//   ① 强凭据词（key/credential/signature/secret）：允许任意字母前缀 + 有限后缀（id|secret|ids），
//      保证 OSSAccessKeyId / X-Amz-Credential / gemini-signature 一律脱敏；
//   ② 弱凭据词（token/auth/authorization）：只允许【白名单厂商前缀】，且后缀限 id|secret|ids。
//      这是 C-9 首版修复的更正——首版给两级都开了无限 `[a-z0-9_-]*` 后缀，导致
//      page_token / tokenizer / signature_mode 这类非凭据参数被误脱敏，诊断信息丢失。
const SECRET_STRONG = '(?:access[_-]?key|api[_-]?key|apikey|credential|signature|secret)';
const SECRET_WEAK = '(?:token|auth|authorization)';
const SECRET_SUFFIX = '(?:id|secret|ids)?';
const SECRET_VENDOR = '(?:(?:x|amz|oss|aliyun|aws|s3|gcp|azure|sts|sec|security|sig|sign|auth|oauth|bearer|jwt|session|csrf|access|api|private|secret|refresh|id|tmp|temp)[-_]?)*';
const SECRET_NAME = '(?:' + '(?:[a-z0-9]+[-_])*[a-z0-9]*' + SECRET_STRONG + SECRET_SUFFIX
  + '|' + SECRET_VENDOR + SECRET_WEAK + SECRET_SUFFIX + ')';
const SECRET_QUERY = new RegExp('([?&]' + SECRET_NAME + '=)[^&#\\s]+', 'gi');
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const API_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
// 结构化凭据字段：与 SECRET_QUERY 同构，同样限制弱凭据词的后缀。
// 左边界 `NAME_START` 不可省：否则 `page_token=x` 里的子串 `token=x` 也会被匹配，
// 非凭据参数将被误脱敏（本次收紧时发现，旧实现同样存在该缺陷）。
const NAME_START = '(?<![A-Za-z0-9_-])';
const JSON_SECRET = new RegExp('(\"?\'?' + NAME_START
  + '(?:' + '(?:[A-Za-z0-9]+[-_])*' + SECRET_STRONG + SECRET_SUFFIX
  + '|' + SECRET_VENDOR.replace(/\[-_\]\?/g, '[-_]?') + SECRET_WEAK + SECRET_SUFFIX + ')'
  + '[\"\']?\\s*[:=]\\s*[\"\']?)[^\"\',\\s}]+', 'gi');
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

/**
 * Provider 交付描述只允许远端 URL 或短生命周期的内联 base64。内联正文故意设为
 * non-enumerable：Runner 可以物化它，但日志、JSON 和 Task 持久化不会顺手复制图片。
 */
export function normalizeProviderArtifacts(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('Provider artifacts 必须是数组');
  return Object.freeze(value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('Provider artifact 必须是对象');
    }
    const mediaType = typeof item.mediaType === 'string' && item.mediaType.trim()
      ? item.mediaType.trim()
      : undefined;
    if (item.kind === 'remote-url') {
      const url = String(item.url || '').trim();
      if (!url) throw new TypeError('Provider remote-url artifact 缺少 url');
      return Object.freeze({ kind: 'remote-url', url, ...(mediaType ? { mediaType } : {}) });
    }
    if (item.kind === 'inline-base64') {
      const data = String(item.data || '').trim();
      if (!data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw new TypeError('Provider inline-base64 artifact 数据无效');
      }
      const padding = data.endsWith('==') ? 2 : (data.endsWith('=') ? 1 : 0);
      const artifact = {
        kind: 'inline-base64',
        byteLength: (data.length / 4) * 3 - padding,
        ...(mediaType ? { mediaType } : {})
      };
      Object.defineProperty(artifact, 'data', { value: data, enumerable: false });
      return Object.freeze(artifact);
    }
    throw new TypeError('Provider artifact kind 仅支持 remote-url/inline-base64');
  }));
}

export function normalizeSubmissionResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Provider submit 必须返回结构化结果');
  }
  if (!SUBMISSION_KINDS.includes(value.kind)) {
    throw new TypeError('未知 Provider submit kind: ' + String(value.kind));
  }
  if (value.kind === 'completed') {
    const result = {
      kind: 'completed', acceptance: 'accepted',
      ...(value.artifacts !== undefined ? { artifacts: normalizeProviderArtifacts(value.artifacts) } : {})
    };
    if (value.value !== undefined) {
      Object.defineProperty(result, 'value', {
        value: value.value,
        enumerable: value.artifacts === undefined
      });
    }
    return result;
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
