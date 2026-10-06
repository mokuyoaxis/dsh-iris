import { createDshTextModelPort } from '../../lib/dsh-text-model-adapter.js';

/** rc.2 的源事件与真实 AbortSignal 消费；仅留测试进程的计数/请求。 */
export function createDshTextFixture(options = {}) {
  const stats = { invocations: 0, active: 0, aborted: 0, cleanedUp: 0, chunksRead: 0 };
  const calls = [];
  const steps = [...(options.steps || [])];
  const textModel = {
    async *stream(request) {
      stats.invocations++; stats.active++;
      calls.push({ request: { prompt: request.messages[0].content[0].text }, source: request });
      const step = steps.shift() || { text: 'fixture 完整结果' };
      let rejectWaiting;
      const onAbort = () => { stats.aborted++; rejectWaiting?.(request.signal.reason); };
      request.signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (step.waitForAbort) await new Promise((_, reject) => { rejectWaiting = reject; });
        if (step.error) throw step.error;
        const chunks = step.sourceChunks || (step.chunks ? step.chunks.map(chunk => {
          const index = chunk.blockId === 'b' ? 1 : 0;
          if (chunk.type === 'append') return { type: 'text-delta', index, text: chunk.text };
          if (chunk.type === 'replace') return { type: 'block-end', index, block: { type: 'text', text: chunk.text } };
          if (chunk.type === 'finish') return { type: 'finish', reason: { kind: chunk.reason } };
          return chunk;
        }) : [{ type: 'text-delta', index: 0, text: step.text ?? 'fixture 完整结果' },
          ...(step.usage ? [{ type: 'usage', usage: step.usage }] : []),
          { type: 'finish', reason: { kind: step.finishReason ?? 'stop' } }]);
        for (const chunk of chunks) {
          stats.chunksRead++;
          if (chunk.type === 'error') throw chunk.error;
          yield chunk;
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        stats.active--; stats.cleanedUp++;
      }
    }
  };
  const { port } = createDshTextModelPort(textModel, { provider: 'fixture', model: 'text-v0', sessionId: 'fixture-session' },
    { metadata: options.metadata });
  return { port, stats, calls, textModel };
}
