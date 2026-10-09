'use strict';
/** DSH textModel 的单轮协议映射；宿主路由/会话封闭在适配器，不进入共享请求。 */
import crypto from 'node:crypto';
import { ModelPortError, modelErrorRecord, normalizeModelDescriptor, normalizeModelCall,
  normalizeModelCompletion, createModelTextCollector } from './model-port-contract.js';

const OFF_IDS = new Set(['off', 'none', 'disabled', 'disable', 'no-thinking']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith('/') && !value.includes('://');

function abortError(signal, stage, invocation) {
  const code = modelErrorRecord(signal?.reason).code === 'IRIS_MODEL_TIMEOUT' ? 'IRIS_MODEL_TIMEOUT' : 'IRIS_MODEL_ABORTED';
  return new ModelPortError(code, { stage, invocation });
}

/** 信号传入底层；race 仅保证不合作的元数据/迭代器不会让本地永远挂住。 */
async function wait(work, signal, stage, invocation) {
  if (!signal) return work;
  let onAbort;
  const canceled = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal, stage, invocation));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, canceled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function descriptorFor(binding, metadata, kind = 'text') {
  const efforts = metadata?.reasoning?.efforts;
  const ids = Array.isArray(efforts) ? [...new Set(efforts.map(value => value?.id).filter(validId))] : [];
  const offId = ids.find(id => OFF_IDS.has(id.toLowerCase()));
  const known = Array.isArray(efforts) && efforts.every(value => validId(value?.id));
  return { descriptor: normalizeModelDescriptor({ contractVersion: 0, kind,
    identity: { origin: 'host', backendId: 'dsh-' + kind + ':' + crypto.createHash('sha256').update(JSON.stringify([binding.provider, binding.model])).digest('hex'),
      providerId: binding.provider, modelId: binding.model }, availability: 'available',
    // 这些字段有明确的 DSH GenerateOptions 映射，不代表已证明远端模型能力。
    features: { system: 'supported', temperature: 'supported', maxOutputTokens: 'supported', reasoning: known ? 'supported' : 'unknown' },
    ...(known ? { reasoning: { off: offId ? 'supported' : 'unsupported', effortIds: ids } } : {}) }), offId: known ? offId : undefined };
}

function usageSnapshot(value) {
  if (!value || typeof value !== 'object') return undefined;
  const usage = {};
  for (const key of ['outputTokens', 'totalTokens', 'reasoningTokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
  }
  // rc.2 inputTokens 不含缓存；这里只把权威的三个不重叠输入计数相加。
  const inputs = [value.inputTokens, value.cacheReadTokens ?? 0, value.cacheWriteTokens ?? 0];
  const inputTotal = inputs.reduce((sum, count) => sum + count, 0);
  if (inputs.every(count => Number.isSafeInteger(count) && count >= 0) && Number.isSafeInteger(inputTotal)) usage.inputTokens = inputTotal;
  return Object.keys(usage).length ? usage : undefined;
}

/** 元数据解析显式进行且受同一操作信号约束；describe 永远只复制已绑定事实。 */
export async function prepareDshTextModelPort(textModel, binding, { signal } = {}) {
  if (signal?.aborted) throw abortError(signal, 'prepare', 'not_invoked');
  if (!textModel || typeof textModel.stream !== 'function') throw new ModelPortError('IRIS_MODEL_UNAVAILABLE');
  if (!validId(binding?.provider) || !validId(binding?.model)) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
  const route = { provider: binding.provider, model: binding.model };
  const sessionId = typeof binding.sessionId === 'string' && binding.sessionId.trim() && binding.sessionId.length <= 256 ? binding.sessionId.trim() : undefined;
  let metadata;
  if (typeof textModel.resolveModelInfo === 'function') {
    try { metadata = await wait(Promise.resolve().then(() => {
      if (signal?.aborted) throw abortError(signal, 'prepare', 'not_invoked');
      return textModel.resolveModelInfo(route.provider, route.model, signal);
    }), signal, 'prepare', 'not_invoked'); }
    catch (_) { if (signal?.aborted) throw abortError(signal, 'prepare', 'not_invoked'); }
  }
  if (signal?.aborted) throw abortError(signal, 'prepare', 'not_invoked');
  return createDshTextModelPort(textModel, { ...route, sessionId }, { metadata });
}

/** 已绑定事实的纯构造；用于缓存元数据/协议 fixture，不执行元数据查询。 */
export function createDshTextModelPort(textModel, binding, { metadata } = {}) {
  return createDshBoundModelPort(textModel, binding, { metadata });
}

/** 文本与视觉共用经过验证的 DSH 事件读取器；图片桥接仅由视觉适配器注入。 */
export function createDshBoundModelPort(textModel, binding, { metadata, prepareImage, prepareImageRequest, kind = 'text' } = {}) {
  if (!textModel || typeof textModel.stream !== 'function') throw new ModelPortError('IRIS_MODEL_UNAVAILABLE');
  if (!validId(binding?.provider) || !validId(binding?.model)) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
  const route = { provider: binding.provider, model: binding.model };
  // 不接受绑定身份与解析出的模型漂移；旧 fixture 未提供身份时保持 unknown。
  if (metadata && (metadata.provider !== undefined && metadata.provider !== route.provider || metadata.id !== undefined && metadata.id !== route.model)) {
    throw new ModelPortError('IRIS_MODEL_INCOMPATIBLE', { stage: 'prepare', invocation: 'not_invoked' });
  }
  const sessionId = typeof binding.sessionId === 'string' && binding.sessionId.trim() && binding.sessionId.length <= 256 ? binding.sessionId.trim() : undefined;
  const { descriptor, offId } = descriptorFor(route, metadata, kind);
  const port = Object.freeze({
    describe() { return normalizeModelDescriptor(descriptor); },
    async complete(request, options) {
      const input = normalizeModelCall(descriptor, request, options);
      if (input.options.signal?.aborted) throw abortError(input.options.signal, 'invoke', 'not_invoked');
      const controller = new AbortController();
      const parent = input.options.signal;
      const onAbort = () => controller.abort(parent.reason);
      parent?.addEventListener('abort', onAbort, { once: true });
      const deadline = performance.now() + input.options.budget.timeoutMs;
      let timer;
      const scheduleDeadline = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) controller.abort(new ModelPortError('IRIS_MODEL_TIMEOUT'));
        else timer = setTimeout(scheduleDeadline, Math.min(2147483647, Math.ceil(remaining)));
      };
      scheduleDeadline();
      const signal = controller.signal;
      const collector = createModelTextCollector({ maxOutputChars: input.options.budget.maxOutputChars, signal, backendId: descriptor.identity.backendId });
      const sourceRequest = { ...route, messages: [{ role: 'user', content: [{ type: 'text', text: input.request.prompt }] }],
        ...(input.request.system === undefined ? {} : { system: input.request.system }), signal,
        ...(sessionId ? { sessionId } : {}) };
      if (input.request.generation?.temperature !== undefined) sourceRequest.temperature = input.request.generation.temperature;
      if (input.request.generation?.maxOutputTokens !== undefined) sourceRequest.maxTokens = input.request.generation.maxOutputTokens;
      const reasoning = input.request.generation?.reasoning;
      if (reasoning?.mode === 'off') sourceRequest.reasoningEffort = offId;
      if (reasoning?.mode === 'effort') sourceRequest.reasoningEffort = reasoning.effortId;
      let iterator;
      let usage;
      let finished = false;
      let ended = false;
      let invoked = false;
      let responded = false;
      let prepared;
      const blocks = new Map();
      const blockId = index => {
        if (!Number.isSafeInteger(index) || index < 0) throw new ModelPortError('IRIS_MODEL_PROTOCOL_INVALID', { stage: 'read', invocation: 'unknown' });
        return String(index);
      };
      try {
        if (kind === 'vision') {
          if (typeof prepareImage !== 'function') throw new ModelPortError('IRIS_MODEL_UNAVAILABLE', { stage: 'prepare' });
          const preparedImage = await wait(Promise.resolve().then(() => {
            if (signal.aborted) throw abortError(signal, 'prepare', 'not_invoked');
            return prepareImage(input.request.image, signal);
          }), signal, 'prepare', 'not_invoked');
          if (signal.aborted) throw abortError(signal, 'prepare', 'not_invoked');
          prepared = await wait(Promise.resolve().then(() => prepareImageRequest?.({ request: input.request,
            image: preparedImage.image, signal, identity: descriptor.identity })), signal, 'prepare', 'not_invoked');
          const prompt = prepared?.prompt ?? input.request.prompt;
          normalizeModelCall(descriptor, { ...input.request, image: preparedImage.image, prompt }, input.options);
          sourceRequest.messages[0].content[0].text = prompt;
          sourceRequest.messages[0].content.push({ type: 'image', attachment: preparedImage.attachment });
        }
        invoked = true;
        const stream = textModel.stream(sourceRequest);
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new ModelPortError('IRIS_MODEL_PROTOCOL_INVALID', { stage: 'invoke', invocation: 'unknown' });
        iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = await wait(Promise.resolve().then(() => iterator.next()), signal, 'read', responded ? 'responded' : 'unknown');
          if (signal.aborted) throw abortError(signal, 'read', responded ? 'responded' : 'unknown');
          if (next.done) { ended = true; break; }
          const chunk = next.value;
          if (!chunk || typeof chunk !== 'object' || finished) throw new ModelPortError('IRIS_MODEL_PROTOCOL_INVALID', { stage: 'read', invocation: 'responded' });
          if (chunk.type === 'block-start') {
            const id = blockId(chunk.index);
            if (!['text', 'reasoning'].includes(chunk.blockType)) collector.finish(chunk.blockType === 'tool-call' ? 'tool-calls' : 'unknown');
            if (blocks.has(id)) collector.finish('unknown');
            blocks.set(id, chunk.blockType);
            if (chunk.blockType === 'text') collector.append('', id);
          } else if (chunk.type === 'text-delta') {
            const id = blockId(chunk.index);
            if (blocks.has(id) && blocks.get(id) !== 'text') collector.finish('unknown');
            blocks.set(id, 'text');
            if (typeof chunk.text === 'string' && chunk.text.length) responded = true;
            collector.append(chunk.text, id);
          } else if (chunk.type === 'reasoning-delta') {
            const id = blockId(chunk.index);
            if (typeof chunk.text !== 'string' || blocks.has(id) && blocks.get(id) !== 'reasoning') collector.finish('unknown');
            blocks.set(id, 'reasoning');
          } else if (chunk.type === 'block-end') {
            const id = blockId(chunk.index);
            if (chunk.block?.type === 'text') {
              if (blocks.has(id) && blocks.get(id) !== 'text') collector.finish('unknown');
              blocks.set(id, 'text');
              if (typeof chunk.block.text === 'string' && chunk.block.text.length) responded = true;
              collector.replace(chunk.block.text, id);
            } else if (chunk.block?.type === 'reasoning') {
              if (typeof chunk.block.text !== 'string' || blocks.has(id) && blocks.get(id) !== 'reasoning') collector.finish('unknown');
              blocks.set(id, 'reasoning');
            } else collector.finish(chunk.block?.type === 'tool-call' ? 'tool-calls' : 'unknown');
          } else if (chunk.type === 'tool-call-delta') collector.finish('tool-calls');
          else if (chunk.type === 'usage') usage = usageSnapshot(chunk.usage);
          else if (chunk.type === 'finish') {
            const kind = chunk.reason?.kind;
            if (kind === 'aborted') throw new ModelPortError('IRIS_MODEL_ABORTED', { stage: 'read', invocation: responded ? 'responded' : 'unknown' });
            if (kind === 'error') collector.fail(new ModelPortError('IRIS_MODEL_REQUEST_FAILED', { stage: 'read', invocation: 'unknown' }));
            collector.finish(kind); finished = true;
          } else if (chunk.type === 'error') collector.fail(chunk.error);
          else if (chunk.type === undefined && typeof chunk.delta === 'string') {
            if (chunk.delta.length) responded = true;
            collector.append(chunk.delta, '0');
          }
          else collector.finish('unknown');
        }
        const collected = collector.complete();
        const text = prepared?.mapText ? prepared.mapText(collected) : collected;
        return normalizeModelCompletion(descriptor, { contractVersion: 0, text, finishReason: 'stop', identity: descriptor.identity,
          ...(usage ? { usage } : {}) }, input.options.budget);
      } catch (error) {
        if (signal.aborted) throw abortError(signal, invoked ? 'read' : 'prepare', responded ? 'responded' : invoked ? 'unknown' : 'not_invoked');
        if (!invoked) {
          controller.abort(error);
          const record = modelErrorRecord(error);
          throw new ModelPortError(record.code, { stage: 'prepare', invocation: 'not_invoked',
            ...(record.imageBytes ? { imageBytes: record.imageBytes } : {}),
            ...(record.imageMaxBytes ? { imageMaxBytes: record.imageMaxBytes } : {}) });
        }
        // 只有受控模型错误可以离开协议边界；供应商原文不进入 UI/日志。
        try { collector.fail(error); }
        finally { controller.abort(error); }
      } finally {
        try {
          if (!ended && iterator && typeof iterator.return === 'function') {
            const closing = Promise.resolve().then(() => iterator.return());
            await wait(closing, signal, 'read', 'unknown').catch(() => {});
          }
        } finally { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); }
      }
    }
  });
  return Object.freeze({ port, offId });
}
