'use strict';

/**
 * 已支持协议到 Provider Adapter v0 的映射。
 *
 * 凭据和 baseUrl 只被操作闭包捕获，不进入 Adapter 描述或能力快照。
 * transport 默认为现有低层 HTTP 实现；测试可注入零网络 fixture。
 */
import * as defaultTransport from './adapters.js';
import { ProviderContractError, providerErrorRecord } from './provider-contract.js';
import { writePrivateFile } from './private-storage.js';
import { defineProviderAdapter } from './provider-adapter.js';
import { selectMediaProtocol, providerApiKey, providerMediaBaseUrl, unsupportedProtocolError, supportsImageEdit, dashscopeTtsInputIssue, BUILTIN_PROVIDER_PROTOCOLS } from './provider-protocol.js';
import { modelRateLimit, reportModelRateLimit, isFreeQuotaExhausted, recordModelAvailability } from './provider-health.js';
import { modelUnavailable, modelUnavailableReason, modelAvailabilityBinding } from './model-directory.js';
import { prepareVisionImage, visionInputLimits } from './vision-image-input.js';

const AMBIGUOUS_4XX = new Set([408, 409, 425, 499]);

function providerIdentity(provider) {
  const id = String(provider?.id || '').trim();
  const key = providerApiKey(provider);
  const baseUrl = providerMediaBaseUrl(provider);
  if (!id) throw new TypeError('Provider 配置缺少 id');
  if (!baseUrl) throw new TypeError('Provider 配置缺少 baseUrl');
  return { id, key, baseUrl };
}

function mappedCategory(error, status) {
  const raw = String(error?.category || '').toLowerCase();
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'aborted';
  if (error?.name === 'TimeoutError' || raw === 'timeout'
      || ((!raw || raw === 'unknown') && /timeout|timed out|超时/i.test(String(error?.message || '')))) return 'timeout';
  if (isFreeQuotaExhausted(error)) return 'quota';
  if (status === 401 || status === 403 || raw === 'auth') return 'authentication';
  if (status === 429 && raw === 'quota') return 'quota';
  if (status === 429 || raw === 'rate_limit') return 'rate_limit';
  if (raw === 'invalid_parameter' || raw === 'invalid_request') return 'invalid_request';
  if (raw === 'protocol') return 'protocol';
  if (raw === 'network' || error instanceof TypeError) return 'network';
  if (raw === 'server' || status >= 500) return 'provider';
  if (!status && /未返回|响应|协议|结构|json/i.test(String(error?.message || ''))) return 'protocol';
  return 'provider';
}

/** 已支持协议共享的错误映射；不保留 cause、rootCause、正文、URL 或凭据。 */
export function mapProviderAdapterError(error, context = {}) {
  const statusValue = Number(error?.httpStatus ?? error?.status);
  const httpStatus = Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599
    ? statusValue
    : undefined;
  const stage = String(context.stage || error?.stage || 'submit');
  const category = mappedCategory(error, httpStatus);
  let acceptance = context.acceptance || error?.acceptance;
  if (stage === 'validate' || stage === 'prepare' || stage === 'upload') {
    acceptance = 'not_accepted';
  } else if (stage === 'submit') {
    acceptance = httpStatus && httpStatus >= 400 && httpStatus < 500 && !AMBIGUOUS_4XX.has(httpStatus)
      ? 'not_accepted'
      : (error?.acceptance === 'not_accepted' ? 'not_accepted' : 'unknown');
  } else if (!acceptance) {
    acceptance = 'accepted';
  }
  const retryable = Boolean(
    context.retryable ?? error?.retryable
    ?? (httpStatus === 429 || (httpStatus && httpStatus >= 500)
      || category === 'network' || category === 'timeout')
  );
  return providerErrorRecord(error, {
    stage,
    category,
    acceptance,
    retryable,
    ...(httpStatus ? { httpStatus } : {})
  });
}

/** Remove the operation's exact key before generic redaction can truncate it. */
function mapProviderErrorWithKey(error, context, key) {
  const scrub = value => typeof value === 'string' && key ? value.split(key).join('[REDACTED]') : value;
  return providerErrorRecord(mapProviderAdapterError(error, context), {
    safeMessage: scrub(String(error?.safeMessage || error?.message || error)),
    providerCode: scrub(error?.providerCode ?? error?.code)
  });
}

function unsupportedCapability(capability, protocol) {
  return new ProviderContractError(
    '协议 ' + protocol + ' 不支持任务能力 ' + String(capability || ''),
    { stage: 'validate', category: 'invalid_request', acceptance: 'not_accepted' }
  );
}

function pollFailureKind(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'CANCELED' || value === 'CANCELLED') return 'canceled';
  if (value === 'UNKNOWN') return 'unknown';
  return 'failed';
}

function remoteImageArtifacts(urls) {
  return (urls || []).map((url) => ({ kind: 'remote-url', url, mediaType: 'image/png' }));
}

function openAiImageArtifacts(items) {
  return (items || []).map((item) => {
    if (item && item.b64) {
      return { kind: 'inline-base64', data: item.b64, mediaType: item.mediaType || 'image/png' };
    }
    if (item && item.url) {
      return { kind: 'remote-url', url: item.url, mediaType: item.mediaType || 'image/png' };
    }
    throw new ProviderContractError('同步图片结果缺少 b64 或 URL', {
      stage: 'response', category: 'protocol', acceptance: 'accepted'
    });
  });
}

function writeInlineArtifact(artifact, targetPath) {
  const data = String(artifact?.data || '').trim();
  const body = Buffer.from(data, 'base64');
  if (!data || body.length === 0 || body.toString('base64') !== data) {
    throw new ProviderContractError('inline-base64 媒体数据无效', {
      stage: 'download', category: 'protocol', acceptance: 'accepted'
    });
  }
  writePrivateFile(targetPath, body, { flag: 'wx' });
  return { bytes: body.length };
}

function operationsForDashScope(provider, transport) {
  const { key, baseUrl } = providerIdentity(provider);
  return {
    async discover({ signal, timeoutMs } = {}) {
      return { models: await transport.listModels({ key, baseUrl, signal, timeoutMs }) };
    },

    async submit(request = {}) {
      const input = request.input || {};
      const common = {
        key, baseUrl, model: request.model, signal: request.signal,
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
      };
      if (request.capability === 'image') {
        let image;
        if (input.image) {
          if (!supportsImageEdit('dashscope', request.model)) throw new ProviderContractError('该 DashScope 模型尚未接入原生改图', {
            stage: 'validate', category: 'invalid_request', acceptance: 'not_accepted'
          });
          const limits = visionInputLimits(provider, request.model);
          image = await prepareVisionImage(input.image, { ...limits, maxBytes: Math.min(limits.maxBytes, 10 * 1024 * 1024) },
            { signal: request.signal, orient: true });
        }
        if (transport.dashscopeImageMode(request.model) === 'legacy-async') {
          const remoteTaskId = await transport.submitImage({
            ...common, prompt: input.prompt, size: input.size, n: input.n
          });
          return { kind: 'accepted', remoteTaskId };
        }
        const urls = await transport.generateImageMultimodal({
          ...common, prompt: input.prompt, size: input.size, n: input.n, ...(image ? { image } : {})
        });
        return {
          kind: 'completed', value: { kind: 'urls', items: urls },
          artifacts: remoteImageArtifacts(urls)
        };
      }
      if (request.capability === 'video') {
        const remoteTaskId = await transport.submitVideo({
          ...common,
          prompt: input.prompt,
          imgDataUrl: input.imgDataUrl,
          size: input.size,
          duration: input.duration,
          audioUrl: input.audioUrl,
          resolution: input.resolution
        });
        return { kind: 'accepted', remoteTaskId };
      }
      if (request.capability === 'transcribe') {
        const remoteTaskId = await transport.submitTranscription({
          ...common, audioUrl: input.audioUrl
        });
        return { kind: 'accepted', remoteTaskId };
      }
      if (request.capability === 'tts') {
        const issue = dashscopeTtsInputIssue(request.model, input.voice);
        if (issue) throw new ProviderContractError(issue, {
          stage: 'validate', category: 'invalid_request', acceptance: 'not_accepted'
        });
        const value = await transport.synthesizeTts({
          ...common, text: input.text, voice: input.voice
        });
        // E2：同步合成产物物化为 Core Artifact——URL 走下载，inline base64 直接落盘。
        const artifacts = value.audioUrl
          ? [{ kind: 'remote-url', url: value.audioUrl, mediaType: 'audio/mpeg' }]
          : [{ kind: 'inline-base64', data: value.audioB64, mediaType: 'audio/mpeg' }];
        return { kind: 'completed', value, artifacts };
      }
      throw unsupportedCapability(request.capability, 'dashscope');
    },

    async poll(request = {}) {
      const common = {
        key, baseUrl, remoteTaskId: request.remoteTaskId, signal: request.signal,
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
      };
      if (request.capability === 'transcribe') {
        const result = await transport.pollTranscriptionTask(common);
        if (!result.done) return { kind: 'pending', progress: result.status || 'running' };
        if (!result.ok) {
          return {
            kind: pollFailureKind(result.status),
            error: mapProviderErrorWithKey(result.message || '转写任务失败', {
              stage: 'poll', acceptance: 'accepted'
            }, key)
          };
        }
        // E3：转写正文物化为 text/plain Artifact（inline-base64，不再依赖签名 URL 生命周期）。
        const text = String(result.text || '');
        return {
          kind: 'succeeded',
          value: { kind: 'text', text },
          artifacts: [{ kind: 'inline-base64', data: Buffer.from(text, 'utf8').toString('base64'), mediaType: 'text/plain' }]
        };
      }
      if (request.capability === 'image' || request.capability === 'video') {
        const result = await transport.pollTask(common);
        if (!result.done) return { kind: 'pending', progress: result.status || 'running' };
        if (!result.ok) {
          return {
            kind: pollFailureKind(result.status),
            error: mapProviderErrorWithKey(result.message || '生成任务失败', {
              stage: 'poll', acceptance: 'accepted'
            }, key)
          };
        }
        return {
          kind: 'succeeded',
          artifacts: (result.urls || []).map((url) => ({ kind: 'remote-url', url }))
        };
      }
      throw unsupportedCapability(request.capability, 'dashscope');
    },

    async download(request = {}) {
      const artifact = request.artifact || {};
      const targetPath = String(request.targetPath || '').trim();
      if (!targetPath) {
        throw new ProviderContractError('download 需要 targetPath', {
          stage: 'download', category: 'local_io', acceptance: 'accepted'
        });
      }
      if (artifact.kind === 'inline-base64') {
        return writeInlineArtifact(artifact, targetPath);
      }
      if (artifact.kind !== 'remote-url' || !artifact.url) {
        throw new ProviderContractError('download 需要 remote-url artifact', {
          stage: 'download', category: 'protocol', acceptance: 'accepted'
        });
      }
      return {
        bytes: await transport.downloadTo(artifact.url, targetPath, {
          signal: request.signal,
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
        })
      };
    },

    mapError: (error, context) => mapProviderErrorWithKey(error, context, key)
  };
}

export function createDashScopeProviderAdapter(provider, { transport = defaultTransport } = {}) {
  const { key, baseUrl } = providerIdentity(provider);
  return defineProviderAdapter({
    id: providerIdentity(provider).id,
    protocol: 'dashscope',
    capabilities: ['image', 'video', 'tts', 'transcribe'],
    operations: operationsForDashScope(provider, transport),
    async prepareInput({ model, filePath, signal, timeoutMs } = {}) {
      return { url: await transport.uploadTempFile({ key, baseUrl, model, filePath, signal, timeoutMs }) };
    },
    unsupported: {
      cancel: '当前 DashScope 媒体协议未提供经过验证的远端取消实现'
    }
  });
}

function operationsForOpenAiImages(provider, transport, protocol = 'openai-images') {
  const { key, baseUrl } = providerIdentity(provider);
  return {
    async discover({ signal, timeoutMs } = {}) {
      return { models: await transport.listModels({ key, baseUrl, signal, timeoutMs }) };
    },

    async submit(request = {}) {
      if (request.capability !== 'image') {
        throw unsupportedCapability(request.capability, protocol);
      }
      const input = request.input || {};
      let image;
      if (input.image) {
        if (protocol !== 'openai-chat-images') throw new ProviderContractError('该图片协议不支持聊天改图', {
          stage: 'validate', category: 'invalid_request', acceptance: 'not_accepted'
        });
        image = await prepareVisionImage(input.image, visionInputLimits(provider, request.model), { signal: request.signal, orient: true });
      }
      const method = {
        'openai-images': 'openAiGenerateImage',
        'openai-chat-images': 'openAiChatGenerateImage',
        'openai-responses-images': 'openAiResponsesGenerateImage'
      }[protocol];
      const items = await transport[method]({
        key,
        baseUrl,
        model: request.model,
        prompt: input.prompt,
        ...(image ? { image } : {}),
        size: input.size,
        n: input.n,
        signal: request.signal,
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
      });
      return {
        kind: 'completed', value: { kind: 'openai', items },
        artifacts: openAiImageArtifacts(items)
      };
    },

    async download(request = {}) {
      const artifact = request.artifact || {};
      const targetPath = String(request.targetPath || '').trim();
      if (!targetPath) {
        throw new ProviderContractError('download 需要 targetPath', {
          stage: 'download', category: 'local_io', acceptance: 'accepted'
        });
      }
      if (artifact.kind === 'inline-base64') return writeInlineArtifact(artifact, targetPath);
      if (artifact.kind !== 'remote-url' || !artifact.url) {
        throw new ProviderContractError('download 需要可物化的图片 artifact', {
          stage: 'download', category: 'protocol', acceptance: 'accepted'
        });
      }
      return {
        bytes: await transport.downloadTo(artifact.url, targetPath, {
          signal: request.signal,
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
        })
      };
    },

    mapError: (error, context) => mapProviderErrorWithKey(error, context, key)
  };
}

export function createOpenAiImagesProviderAdapter(provider, { transport = defaultTransport } = {}) {
  return defineProviderAdapter({
    id: providerIdentity(provider).id,
    protocol: 'openai-images',
    capabilities: ['image'],
    operations: operationsForOpenAiImages(provider, transport),
    unsupportedPreparation: 'OpenAI Images 兼容路径未实现临时输入上传',
    unsupported: {
      poll: 'OpenAI Images 兼容路径在当前实现中同步返回结果',
      cancel: '同步图片响应没有可验证的远端取消任务'
    }
  });
}

export function createOpenAiChatImagesProviderAdapter(provider, { transport = defaultTransport } = {}) {
  return defineProviderAdapter({
    id: providerIdentity(provider).id,
    protocol: 'openai-chat-images',
    capabilities: ['image'],
    operations: operationsForOpenAiImages(provider, transport, 'openai-chat-images'),
    unsupported: {
      poll: 'Chat Completions 生图为同步协议，不提供远端任务轮询',
      cancel: 'Chat Completions 生图不提供远端取消'
    },
    unsupportedPreparation: 'Chat Completions 生图未实现临时输入上传'
  });
}

export function createOpenAiResponsesImagesProviderAdapter(provider, { transport = defaultTransport } = {}) {
  return defineProviderAdapter({
    id: providerIdentity(provider).id,
    protocol: 'openai-responses-images',
    capabilities: ['image'],
    operations: operationsForOpenAiImages(provider, transport, 'openai-responses-images'),
    unsupported: {
      poll: 'Responses 生图当前只接同步结果，不提供后台任务轮询',
      cancel: '同步 Responses 生图不提供远端取消'
    },
    unsupportedPreparation: 'Responses 生图未实现临时输入上传'
  });
}

export function createGeminiWebMusicProviderAdapter(provider, { transport = defaultTransport } = {}) {
  const { id, key, baseUrl } = providerIdentity(provider);
  return defineProviderAdapter({
    id, protocol: 'gemini-web-music', capabilities: ['music'],
    operations: {
      async discover({ signal, timeoutMs } = {}) {
        return { models: await transport.listModels({ key, baseUrl, signal, timeoutMs }) };
      },
      async submit(request) {
        if (request.capability !== 'music') throw unsupportedCapability(request.capability, 'gemini-web-music');
        const artifacts = await transport.generateMusic({ key, baseUrl, model: request.model,
          prompt: request.input.prompt, timeoutMs: request.input.timeoutMs, signal: request.signal });
        return { kind: 'completed', artifacts };
      },
      async download({ artifact, targetPath }) { return writeInlineArtifact(artifact, targetPath); },
      mapError: (error, context) => mapProviderErrorWithKey(error, context, key)
    },
    unsupported: { poll: '网关 Music 没有客户端可恢复的远端任务ID', cancel: '网关 Music 不提供远端取消' },
    unsupportedPreparation: 'Music 描述输入不需要上传'
  });
}

const PROTOCOL_FACTORIES = Object.freeze({
  'gemini-web-music': createGeminiWebMusicProviderAdapter,
  dashscope: createDashScopeProviderAdapter,
  'openai-images': createOpenAiImagesProviderAdapter,
  'openai-chat-images': createOpenAiChatImagesProviderAdapter,
  'openai-responses-images': createOpenAiResponsesImagesProviderAdapter
});

export function builtinProviderExtension() {
  return { contractVersion: 0, id: 'iris.builtin-media', version: '0.1.0',
    protocols: BUILTIN_PROVIDER_PROTOCOLS.map(descriptor => ({ ...descriptor, createAdapter: PROTOCOL_FACTORIES[descriptor.id] })) };
}

export function createConfiguredProviderAdapter(provider, options = {}) {
  const selection = options.protocol
    ? selectMediaProtocol({ ...provider, mediaProtocol: options.protocol, protocolInferred: false })
    : selectMediaProtocol(provider);
  const factory = Object.hasOwn(PROTOCOL_FACTORIES, selection.mediaProtocol) ? PROTOCOL_FACTORIES[selection.mediaProtocol] : null;
  if (!options.registry && !factory) throw unsupportedProtocolError(selection.mediaProtocol);
  const adapter = options.registry ? options.registry.createAdapter(selection.mediaProtocol, provider, options) : factory(provider, options);
  const operations = { ...adapter.operations };
  const key = providerApiKey(provider);
  const scrub = value => typeof value === 'string' && key ? value.split(key).join('[REDACTED]') : value;
  operations.mapError = (error, context) => {
    let mapped;
    try { mapped = adapter.operations.mapError(error, context); } catch (failure) { mapped = failure; }
    mapped ||= error;
    const defaults = {};
    for (const field of ['stage', 'category', 'acceptance', 'retryable']) {
      if (mapped?.[field] === undefined) defaults[field] = context?.[field];
    }
    return providerErrorRecord(mapped, {
      ...defaults,
      safeMessage: scrub(String(mapped?.safeMessage || mapped?.message || mapped)),
      providerCode: scrub(mapped?.providerCode ?? mapped?.code)
    });
  };
  for (const name of ['submit', 'poll']) {
    if (!operations[name]) continue;
    const run = operations[name];
    operations[name] = async request => {
      const modelId = request.model || options.modelId;
      const report = error => reportModelRateLimit(provider, modelId, {
        httpStatus: error.httpStatus ?? error.status, category: error.category,
        code: scrub(error.code), providerCode: scrub(error.providerCode), message: scrub(error.safeMessage || error.message),
        retryAfterMs: error.retryAfterMs,
        source: options.allowRateLimited ? 'probe' : 'task'
      }, options.onRateLimit, request.capability);
      const availability = result => {
        if (name !== 'submit') return;
        const event = { ok: result.ok === true, category: result.category,
          httpStatus: result.httpStatus ?? result.status, providerCode: scrub(result.providerCode || result.code),
          note: scrub(result.safeMessage || result.message),
          stage: 'submit', source: options.allowRateLimited ? 'probe' : 'task',
          binding: modelAvailabilityBinding(provider, modelId, capability) };
        if (!recordModelAvailability(provider, modelId, request.capability, event)) return;
        try { options.onModelAvailability?.({ providerId: provider.id, modelId, capability: request.capability, ...event }); }
        catch (_) { console.warn('[iris] 模型可用性未能持久化，请检查配置写入权限'); }
      };
      const capability = { image: 'image-gen', video: 'video-gen', music: 'music-gen' }[request.capability] || request.capability;
      if (name === 'submit' && !options.allowRateLimited && modelUnavailable(provider, modelId, capability)) {
        throw new ProviderContractError(modelUnavailableReason(), {
          stage: 'validate', category: 'invalid_request', acceptance: 'not_accepted'
        });
      }
      if (name === 'submit' && !options.allowRateLimited && modelRateLimit(provider, modelId)) {
        const blocked = modelRateLimit(provider, modelId);
        throw new ProviderContractError(blocked.until ? '该模型正在限流冷却，请稍后使用' : '该模型额度或预算耗尽，请手动实测成功后再使用', {
          stage: 'validate', category: 'rate_limit', acceptance: 'not_accepted'
        });
      }
      try {
        const result = await run(request);
        if (result.error) report(result.error);
        availability(result.error || { ok: ['completed', 'accepted'].includes(result.kind) });
        return result;
      } catch (error) {
        report(error);
        availability(error);
        throw error;
      }
    };
  }
  return Object.freeze({ ...adapter, operations: Object.freeze(operations) });
}
