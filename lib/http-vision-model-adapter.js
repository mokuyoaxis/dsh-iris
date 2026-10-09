'use strict';
/** OpenAI-compatible Chat Completions SSE；凭据/端点只留在闭包内。 */
import { ModelPortError, normalizeModelDescriptor, normalizeModelCall, normalizeModelCompletion,
  createModelTextCollector } from './model-port-contract.js';
import { modelCallScope, modelAbortError, waitForModelWork } from './model-call-runtime.js';
import { createHash } from 'node:crypto';
import { isFreeQuotaExhausted, retryAfterDelay } from './provider-health.js';
import { prepareVisionImage } from './vision-image-input.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const FRAME_LIMIT = 1024 * 1024;

function usageSnapshot(value) {
  if (!object(value)) return undefined;
  const usage = {};
  for (const [source, target] of [['prompt_tokens', 'inputTokens'], ['completion_tokens', 'outputTokens'], ['total_tokens', 'totalTokens']]) {
    if (Number.isSafeInteger(value[source]) && value[source] >= 0) usage[target] = value[source];
  }
  const reasoning = value.completion_tokens_details?.reasoning_tokens;
  if (Number.isSafeInteger(reasoning) && reasoning >= 0) usage.reasoningTokens = reasoning;
  return Object.keys(usage).length ? usage : undefined;
}

export function createHttpVisionModelPort({ providerId, modelId, baseUrl, apiKey = '', imageInput, orientImages = false,
  prepareImageRequest, fetch: fetchImpl = globalThis.fetch }) {
  const descriptor = normalizeModelDescriptor({ contractVersion: 0, kind: 'vision',
    identity: { origin: 'provider', backendId: 'iris-provider:' + createHash('sha256').update(JSON.stringify([providerId, modelId])).digest('hex'), providerId, modelId },
    availability: 'available', features: { system: 'supported', temperature: 'supported', maxOutputTokens: 'supported', reasoning: 'unknown' } });
  let endpoint;
  try {
    const url = new URL(String(baseUrl).replace(/\/+$/, '') + '/chat/completions');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
    endpoint = url.href;
  } catch (_) { throw new ModelPortError('IRIS_MODEL_INPUT_INVALID'); }
  return Object.freeze({
    describe: () => normalizeModelDescriptor(descriptor),
    async complete(request, options) {
      const input = normalizeModelCall(descriptor, request, options);
      if (input.options.signal?.aborted) throw modelAbortError(input.options.signal);
      const scope = modelCallScope(input.options.signal, input.options.budget.timeoutMs);
      const { signal } = scope;
      const collector = createModelTextCollector({ maxOutputChars: input.options.budget.maxOutputChars, signal,
        backendId: descriptor.identity.backendId });
      let response, iterator, ended = false, invoked = false, responded = false, finished = false, done = false, usage;
      const protocol = () => new ModelPortError('IRIS_MODEL_PROTOCOL_INVALID', { stage: 'read', invocation: responded ? 'responded' : 'unknown' });
      const consume = data => {
        if (!data) return;
        if (done) throw protocol();
        if (data === '[DONE]') {
          if (!finished) throw new ModelPortError('IRIS_MODEL_INCOMPLETE', { stage: 'read', invocation: responded ? 'responded' : 'unknown' });
          done = true; return;
        }
        let event;
        try { event = JSON.parse(data); } catch (_) { throw protocol(); }
        if (!object(event)) throw protocol();
        if (event.error) throw new ModelPortError('IRIS_MODEL_REQUEST_FAILED', { stage: 'read', invocation: responded ? 'responded' : 'unknown' });
        if (!Array.isArray(event.choices)) throw protocol();
        if (event.usage !== undefined && event.usage !== null) {
          if (!object(event.usage)) throw protocol();
          usage = usageSnapshot(event.usage);
        }
        if (event.choices.length === 0 && object(event.usage)) return;
        if (event.choices.length !== 1 || finished) throw protocol();
        const choice = event.choices[0];
        if (!object(choice) || choice.index !== undefined && choice.index !== 0 || !object(choice.delta)) throw protocol();
        const delta = choice.delta;
        if (delta.tool_calls !== undefined || delta.function_call !== undefined) collector.finish('tool-calls');
        if (delta.refusal) collector.finish('content-blocked');
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== 'string') throw protocol();
          if (delta.content.length) responded = true;
          collector.append(delta.content);
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          const reason = { stop: 'stop', length: 'length', tool_calls: 'tool-calls', function_call: 'tool-calls', content_filter: 'content-blocked' }[choice.finish_reason];
          responded = true; collector.finish(reason || 'unknown'); finished = true;
        }
      };
      try {
        const image = imageInput ? await prepareVisionImage(input.request.image, imageInput, { signal, orient: orientImages }) : input.request.image;
        const prepared = await waitForModelWork(() => prepareImageRequest?.({ request: input.request, image, signal, identity: descriptor.identity }), signal);
        const prompt = prepared?.prompt ?? input.request.prompt;
        normalizeModelCall(descriptor, { ...input.request, image, prompt }, input.options);
        const body = { model: modelId, stream: true, messages: [
          ...(input.request.system === undefined ? [] : [{ role: 'system', content: input.request.system }]),
          { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: {
            url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`
          } }] }
        ] };
        if (input.request.generation?.temperature !== undefined) body.temperature = input.request.generation.temperature;
        if (input.request.generation?.maxOutputTokens !== undefined) body.max_tokens = input.request.generation.maxOutputTokens;
        response = await waitForModelWork(() => {
          invoked = true;
          const pending = Promise.resolve(fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body) }));
          // fetch 不合作时，取消之后才到达的 body 也必须被释放。
          return pending.then(value => {
            if (signal.aborted) {
              Promise.resolve(value?.body?.cancel?.()).catch(() => {});
              throw modelAbortError(signal, 'invoke', 'unknown');
            }
            return value;
          });
        }, signal, 'invoke', 'unknown');
        if (!response.ok) {
          const body = [400, 403, 413, 429].includes(response.status) ? await waitForModelWork(() => response.json().catch(() => null), signal, 'read', 'rejected') : null;
          // 只提取可验证的数值事实，不把供应商原文或凭据带到 UI/CLI。
          const limit = [400, 413].includes(response.status)
            ? /\b(\d+) bytes exceeds the (\d+)-byte limit\b/i.exec(String(body?.error?.message || body?.message || '')) : null;
          const maxBytes = limit && Number(limit[1]) === image.bytes.byteLength && Number.isSafeInteger(Number(limit[2])) && Number(limit[2]) > 0
            ? Number(limit[2]) : undefined;
          if (maxBytes || response.status === 413) {
            throw new ModelPortError('IRIS_MODEL_IMAGE_TOO_LARGE', { stage: 'invoke', invocation: 'rejected', status: response.status,
              imageBytes: image.bytes.byteLength, ...(maxBytes ? { imageMaxBytes: maxBytes } : {}) });
          }
          const quota = isFreeQuotaExhausted({ status: response.status, ...(body?.error || body) });
          const code = quota ? 'IRIS_MODEL_RATE_LIMITED' : [401, 403].includes(response.status) ? 'IRIS_MODEL_AUTH_FAILED'
            : response.status === 429 ? 'IRIS_MODEL_RATE_LIMITED' : response.status === 400 ? 'IRIS_MODEL_INPUT_INVALID' : 'IRIS_MODEL_REQUEST_FAILED';
          const error = new ModelPortError(code, { stage: 'invoke', invocation: code === 'IRIS_MODEL_REQUEST_FAILED' ? 'unknown' : 'rejected', status: response.status });
          error.providerCode = (body?.error || body)?.code;
          if (response.status === 429) error.retryAfterMs = retryAfterDelay(response.headers.get('retry-after'));
          if (quota) error.quotaExhausted = true;
          throw error;
        }
        if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function'
            || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw protocol();
        iterator = response.body[Symbol.asyncIterator]();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let buffer = '', data = [], frameLength = 0;
        const line = value => {
          if (!value) { consume(data.join('\n')); data = []; frameLength = 0; return; }
          frameLength += value.length;
          if (frameLength > FRAME_LIMIT) throw protocol();
          if (value.startsWith(':')) return;
          const split = value.indexOf(':');
          const field = split < 0 ? value : value.slice(0, split);
          let fieldValue = split < 0 ? '' : value.slice(split + 1);
          if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
          if (field === 'data') data.push(fieldValue);
          else if (field === 'event' && fieldValue && fieldValue !== 'message') throw protocol();
        };
        const drain = final => {
          while (true) {
            const index = buffer.search(/[\r\n]/);
            if (index < 0 || !final && index === buffer.length - 1 && buffer[index] === '\r') break;
            const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
            line(buffer.slice(0, index)); buffer = buffer.slice(index + width);
          }
          if (buffer.length > FRAME_LIMIT) throw protocol();
        };
        while (true) {
          const next = await waitForModelWork(() => iterator.next(), signal, 'read', responded ? 'responded' : 'unknown');
          if (next.done) { ended = true; break; }
          if (!(next.value instanceof Uint8Array)) throw protocol();
          // 分段解码限制未换行的帧内存，不依赖底层 chunk 大小。
          for (let offset = 0; offset < next.value.length; offset += 16384) {
            try { buffer += decoder.decode(next.value.subarray(offset, offset + 16384), { stream: true }); }
            catch (_) { throw protocol(); }
            drain(false);
          }
        }
        try { buffer += decoder.decode(); } catch (_) { throw protocol(); }
        drain(true);
        // SSE 未以空行提交的尾帧不算有效终态。
        if (buffer.trim() || data.length) throw new ModelPortError('IRIS_MODEL_INCOMPLETE', { stage: 'read', invocation: responded ? 'responded' : 'unknown' });
        const collected = collector.complete();
        const text = prepared?.mapText ? prepared.mapText(collected) : collected;
        return normalizeModelCompletion(descriptor, { contractVersion: 0, text, finishReason: 'stop', identity: descriptor.identity,
          ...(usage ? { usage } : {}) }, input.options.budget);
      } catch (error) {
        if (signal.aborted) throw modelAbortError(signal, invoked ? 'read' : 'prepare', responded ? 'responded' : invoked ? 'unknown' : 'not_invoked');
        // 保留明确 HTTP 拒绝事实；其余错误让 collector 保留已收到部分正文的事实。
        if (error instanceof ModelPortError && (error.invocation === 'rejected' || !invoked)) throw error;
        collector.fail(error);
      } finally {
        if (!ended) {
          scope.abort(new ModelPortError('IRIS_MODEL_ABORTED'));
          const closing = iterator?.return ? () => iterator.return() : () => response?.body?.cancel?.();
          // 主动启动清理，并处理不合作的 return 的晚到失败。
          const pending = Promise.resolve().then(closing);
          await Promise.race([pending, Promise.resolve()]).catch(() => {});
        }
        scope.dispose();
      }
    }
  });
}
