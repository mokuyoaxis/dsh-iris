import {
  ModelPortError, normalizeModelDescriptor, normalizeModelCall, createModelTextCollector
} from '../../lib/model-port-contract.js';

/** 零网络 Text/Vision fixture；故障、延迟与调用输入只保留在测试进程。 */
export function createFakeModelPort(options = {}) {
  const kind = options.kind || 'text';
  const descriptor = normalizeModelDescriptor({
    contractVersion: 0, kind,
    identity: options.identity || { origin: 'provider', backendId: options.backendId || `fixture:${kind}`,
      providerId: 'fixture', modelId: `${kind}-v0` },
    availability: options.availability || 'available',
    ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
    features: { system: 'supported', temperature: 'supported', maxOutputTokens: 'supported', reasoning: 'unknown', ...options.features },
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.image ? { image: options.image } : {})
  });
  const steps = [...(options.steps || [])];
  const calls = [];
  const stats = { describes: 0, completeCalls: 0, invocations: 0, active: 0, aborted: 0, cleanedUp: 0, chunksRead: 0 };

  const port = Object.freeze({
    describe() { stats.describes++; return normalizeModelDescriptor(descriptor); },
    async complete(request, callOptions) {
      const input = normalizeModelCall(descriptor, request, callOptions);
      const signal = input.options.signal;
      if (signal?.aborted) throw new ModelPortError('IRIS_MODEL_ABORTED');
      stats.completeCalls++;
      const step = steps.length ? steps.shift() : { text: 'fixture 完整结果' };
      if (step?.prepareError !== undefined) throw step.prepareError;
      stats.invocations++;
      stats.active++;
      calls.push(input);
      const timers = new Set();
      const interrupted = new Set();
      const onAbort = () => {
        stats.aborted++;
        if (!step?.ignoreAbort) {
          for (const reject of interrupted) reject(signal.reason);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const pause = (ms) => new Promise((resolve, reject) => {
        interrupted.add(reject);
        const timer = setTimeout(() => { timers.delete(timer); interrupted.delete(reject); resolve(); }, ms);
        timers.add(timer);
      });
      try {
        if (typeof step === 'function') return await step(input, { stats });
        if (step.waitForAbort) await new Promise((_, reject) => interrupted.add(reject));
        if (step.delayMs) await pause(step.delayMs);
        if (step.error !== undefined) throw step.error;
        if (Object.hasOwn(step, 'completion')) return step.completion;
        let text = step.text ?? 'fixture 完整结果';
        if (step.chunks) {
          const collector = createModelTextCollector({ maxOutputChars: input.options.budget.maxOutputChars,
            ...(step.ignoreAbort ? {} : { signal }), backendId: descriptor.identity.backendId });
          for (const chunk of step.chunks) {
            if (step.chunkDelayMs) await pause(step.chunkDelayMs);
            stats.chunksRead++;
            if (chunk.type === 'append') collector.append(chunk.text, chunk.blockId);
            else if (chunk.type === 'replace') collector.replace(chunk.text, chunk.blockId);
            else if (chunk.type === 'finish') collector.finish(chunk.reason);
            else if (chunk.type === 'error') collector.fail(chunk.error);
            else collector.fail(new ModelPortError('IRIS_MODEL_PROTOCOL_INVALID', { stage: 'read', invocation: 'unknown' }));
          }
          text = collector.complete();
        }
        return { contractVersion: 0, text, finishReason: step.finishReason ?? 'stop', identity: descriptor.identity,
          ...(step.usage ? { usage: step.usage } : {}) };
      } finally {
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        interrupted.clear();
        stats.active--;
        stats.cleanedUp++;
      }
    }
  });
  return Object.freeze({ port, calls, stats });
}
