'use strict';

/**
 * 已支持协议到 Provider Adapter v0 的映射。
 *
 * 凭据和 baseUrl 只被操作闭包捕获，不进入 Adapter 描述或能力快照。
 * transport 默认为现有低层 HTTP 实现；测试可注入零网络 fixture。
 */
import * as defaultTransport from './adapters.js';
import { ProviderContractError, providerErrorRecord } from './provider-contract.js';
import { defineProviderAdapter } from './provider-adapter.js';
import { inferMediaProtocol } from './provider-protocol.js';

const AMBIGUOUS_4XX = new Set([408, 409, 425, 499]);

function providerIdentity(provider) {
  const id = String(provider?.id || '').trim();
  const key = String(provider?.apiKey || '');
  const baseUrl = String(provider?.baseUrl || '').trim();
  if (!id) throw new TypeError('Provider 配置缺少 id');
  if (!baseUrl) throw new TypeError('Provider 配置缺少 baseUrl');
  return { id, key, baseUrl };
}

function mappedCategory(error, status) {
  const raw = String(error?.category || '').toLowerCase();
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'aborted';
  if (error?.name === 'TimeoutError' || /timeout|timed out|超时/i.test(String(error?.message || ''))) return 'timeout';
  if (status === 401 || status === 403 || raw === 'auth') return 'authentication';
  if (status === 429 && raw === 'quota') return 'quota';
  if (status === 429 || raw === 'rate_limit') return 'rate_limit';
  if (raw === 'invalid_parameter') return 'invalid_request';
  if (raw === 'network' || error instanceof TypeError) return 'network';
  if (raw === 'server' || status >= 500) return 'provider';
  if (!status && /未返回|响应|协议|结构|json/i.test(String(error?.message || ''))) return 'protocol';
  return 'provider';
}

/** 当前两个协议共享的错误映射；不保留 cause、rootCause、正文、URL 或凭据。 */
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
        if (transport.dashscopeImageMode(request.model) === 'legacy-async') {
          const remoteTaskId = await transport.submitImage({
            ...common, prompt: input.prompt, size: input.size, n: input.n
          });
          return { kind: 'accepted', remoteTaskId };
        }
        const urls = await transport.generateImageMultimodal({
          ...common, prompt: input.prompt, size: input.size, n: input.n
        });
        return { kind: 'completed', value: { kind: 'urls', items: urls } };
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
        const value = await transport.synthesizeTts({
          ...common, text: input.text, voice: input.voice
        });
        return { kind: 'completed', value };
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
            error: mapProviderAdapterError(result.message || '转写任务失败', {
              stage: 'poll', acceptance: 'accepted'
            })
          };
        }
        return { kind: 'succeeded', value: { kind: 'text', text: String(result.text || '') } };
      }
      if (request.capability === 'image' || request.capability === 'video') {
        const result = await transport.pollTask(common);
        if (!result.done) return { kind: 'pending', progress: result.status || 'running' };
        if (!result.ok) {
          return {
            kind: pollFailureKind(result.status),
            error: mapProviderAdapterError(result.message || '生成任务失败', {
              stage: 'poll', acceptance: 'accepted'
            })
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
      if (artifact.kind !== 'remote-url' || !artifact.url) {
        throw new ProviderContractError('download 需要 remote-url artifact', {
          stage: 'download', category: 'protocol', acceptance: 'accepted'
        });
      }
      const targetPath = String(request.targetPath || '').trim();
      if (!targetPath) {
        throw new ProviderContractError('download 需要 targetPath', {
          stage: 'download', category: 'local_io', acceptance: 'accepted'
        });
      }
      return {
        bytes: await transport.downloadTo(artifact.url, targetPath, {
          signal: request.signal,
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
        })
      };
    },

    mapError: mapProviderAdapterError
  };
}

export function createDashScopeProviderAdapter(provider, { transport = defaultTransport } = {}) {
  return defineProviderAdapter({
    id: providerIdentity(provider).id,
    protocol: 'dashscope',
    capabilities: ['image', 'video', 'tts', 'transcribe'],
    operations: operationsForDashScope(provider, transport),
    unsupported: {
      cancel: '当前 DashScope 媒体协议未提供经过验证的远端取消实现'
    }
  });
}

function operationsForOpenAiImages(provider, transport) {
  const { key, baseUrl } = providerIdentity(provider);
  return {
    async discover({ signal, timeoutMs } = {}) {
      return { models: await transport.listModels({ key, baseUrl, signal, timeoutMs }) };
    },

    async submit(request = {}) {
      if (request.capability !== 'image') {
        throw unsupportedCapability(request.capability, 'openai-images');
      }
      const input = request.input || {};
      const items = await transport.openAiGenerateImage({
        key,
        baseUrl,
        model: request.model,
        prompt: input.prompt,
        size: input.size,
        n: input.n,
        signal: request.signal,
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
      });
      return { kind: 'completed', value: { kind: 'openai', items } };
    },

    async download(request = {}) {
      const artifact = request.artifact || {};
      if (artifact.kind !== 'remote-url' || !artifact.url) {
        throw new ProviderContractError('download 需要 remote-url artifact', {
          stage: 'download', category: 'protocol', acceptance: 'accepted'
        });
      }
      const targetPath = String(request.targetPath || '').trim();
      if (!targetPath) {
        throw new ProviderContractError('download 需要 targetPath', {
          stage: 'download', category: 'local_io', acceptance: 'accepted'
        });
      }
      return {
        bytes: await transport.downloadTo(artifact.url, targetPath, {
          signal: request.signal,
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
        })
      };
    },

    mapError: mapProviderAdapterError
  };
}

export function createOpenAiImagesProviderAdapter(provider, { transport = defaultTransport } = {}) {
  return defineProviderAdapter({
    id: providerIdentity(provider).id,
    protocol: 'openai-images',
    capabilities: ['image'],
    operations: operationsForOpenAiImages(provider, transport),
    unsupported: {
      poll: 'OpenAI Images 兼容路径在当前实现中同步返回结果',
      cancel: '同步图片响应没有可验证的远端取消任务'
    }
  });
}

export function createConfiguredProviderAdapter(provider, options = {}) {
  const protocol = options.protocol || provider?.mediaProtocol || inferMediaProtocol(provider?.baseUrl);
  if (protocol === 'dashscope') return createDashScopeProviderAdapter(provider, options);
  if (protocol === 'openai-images') return createOpenAiImagesProviderAdapter(provider, options);
  throw new TypeError('iris: 不支持的 Provider 协议：' + String(protocol));
}
