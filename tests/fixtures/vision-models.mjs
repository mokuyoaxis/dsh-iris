import { createHttpVisionModelPort } from '../../lib/http-vision-model-adapter.js';
import { createDshVisionModelPort } from '../../lib/dsh-vision-model-adapter.js';
import { createDshTextFixture } from './dsh-text-model.mjs';

export function createDshVisionFixture(options = {}) {
  const fixture = createDshTextFixture(options);
  const images = new Map();
  const bridge = { saves: 0, reads: 0 };
  const attachments = {
    async saveImage(input) {
      bridge.saves++;
      const ref = { attachmentId: 'fixture-' + bridge.saves, mediaType: input.mediaType };
      images.set(ref.attachmentId, new Uint8Array(input.data));
      return ref;
    },
    async readImage(ref) { bridge.reads++; return { data: images.get(ref.attachmentId), mediaType: ref.mediaType }; }
  };
  const metadata = { provider: 'fixture', id: 'vision-v0', inputModalities: ['image', 'text'], ...options.metadata };
  const port = createDshVisionModelPort(fixture.textModel, attachments, { provider: 'fixture', model: 'vision-v0' }, { metadata });
  return { ...fixture, port, attachments, bridge, get calls() {
    return fixture.calls.map(call => {
      const ref = call.source.messages[0].content[1].attachment;
      return { ...call, request: { ...call.request, image: { bytes: images.get(ref.attachmentId), mediaType: ref.mediaType } } };
    });
  } };
}

const frame = value => 'data: ' + JSON.stringify(value) + '\n\n';
export function createHttpVisionFixture(options = {}) {
  const stats = { invocations: 0, active: 0, aborted: 0, cleanedUp: 0, chunksRead: 0 };
  const calls = [];
  const steps = [...(options.steps || [])];
  const fetch = async (_endpoint, source) => {
    stats.invocations++;
    const body = JSON.parse(source.body), user = body.messages.at(-1);
    const url = user.content[1].image_url.url;
    const match = /^data:([^;]+);base64,(.*)$/.exec(url);
    calls.push({ source, body, request: { prompt: user.content[0].text,
      image: { bytes: new Uint8Array(Buffer.from(match[2], 'base64')), mediaType: match[1] } } });
    const step = steps.shift() || { text: 'fixture 完整结果' };
    if (step.error) { stats.cleanedUp++; throw step.error; }
    if (step.status) return { ok: false, status: step.status, body: { async cancel() { stats.cleanedUp++; } } };
    const reason = value => ({ 'max-tokens': 'length', 'tool-calls': 'tool_calls', 'content-blocked': 'content_filter' }[value] || value);
    const parts = step.rawParts || (step.chunks ? step.chunks.map(chunk => {
      if (chunk.type === 'append') return frame({ choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] });
      if (chunk.type === 'finish') return frame({ choices: [{ index: 0, delta: {}, finish_reason: reason(chunk.reason) }] });
      if (chunk.type === 'error') return { error: chunk.error };
      return frame({ choices: 'invalid-event' });
    }) : [frame({ choices: [{ index: 0, delta: { content: step.text ?? 'fixture 完整结果' }, finish_reason: null }] }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: reason(step.finishReason ?? 'stop') }] }),
      ...(step.usage ? [frame({ choices: [], usage: { completion_tokens: step.usage.outputTokens } })] : []),
      'data: [DONE]\n\n']);
    const bodyIterator = (async function* () {
      stats.active++;
      let rejectWaiting;
      const onAbort = () => { stats.aborted++; rejectWaiting?.(source.signal.reason); };
      source.signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (step.waitForAbort) await new Promise((_, reject) => { rejectWaiting = reject; });
        for (const part of parts) {
          stats.chunksRead++;
          if (part.error) throw part.error;
          yield part instanceof Uint8Array ? part : new TextEncoder().encode(part);
        }
      } finally {
        stats.active--; stats.cleanedUp++;
        source.signal.removeEventListener('abort', onAbort);
      }
    })();
    return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: { [Symbol.asyncIterator]: () => bodyIterator, cancel: () => bodyIterator.return() } };
  };
  const port = createHttpVisionModelPort({ providerId: 'fixture', modelId: 'vision-v0', baseUrl: 'https://fixture.invalid/v1',
    apiKey: 'private-fixture-key', fetch });
  return { port, stats, calls, fetch };
}
