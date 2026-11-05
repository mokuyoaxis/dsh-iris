import assert from 'node:assert/strict';
import { visionStream } from '../lib/adapters.js';
import { PROVIDER_RESPONSE_LIMITS } from '../lib/provider-response.js';
import { setTimeout as delay } from 'node:timers/promises';

const frame = text => Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
const base = { key: 'synthetic-key', baseUrl: 'http://fixture.invalid/v1', prompt: 'describe', imageDataUrl: 'data:image/png;base64,AA==' };
const limit = PROVIDER_RESPONSE_LIMITS.json;
function reply(chunks, { headers = {}, after, onCancel = () => {} } = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (index < chunks.length) { controller.enqueue(chunks[index++]); return; }
      await after?.(); controller.close();
    }, cancel() { onCancel(); }
  }, { highWaterMark: 0 }), { headers });
}
const data = frame('红色鸢尾');
assert.equal(await visionStream({ ...base, fetchPort: async () => reply([data.subarray(0, 52), data.subarray(52)]) }), '红色鸢尾');
assert.equal(await visionStream({ ...base, fetchPort: async () => reply([data, Buffer.alloc(limit - data.length, 32)]) }), '红色鸢尾');
for (const timing of ['pre', 'fetch', 'between', 'end']) {
  const controller = new AbortController(); let sent = 0, canceled = false;
  if (timing === 'pre') controller.abort();
  const pending = visionStream({ ...base, signal: controller.signal, fetchPort: async () => {
    sent++;
    if (timing === 'fetch') controller.abort();
    if (timing === 'between') {
      let index = 0;
      return new Response(new ReadableStream({ pull(stream) {
        if (index++ === 0) stream.enqueue(data);
        else { controller.abort(); stream.enqueue(frame('discarded')); }
      }, cancel() { canceled = true; } }, { highWaterMark: 0 }));
    }
    return reply([data], { after() { if (timing === 'end') controller.abort(); }, onCancel() { canceled = true; } });
  } });
  await assert.rejects(pending, { name: 'AbortError' }, timing + ': cancellation cannot return partial success');
  assert.equal(sent, timing === 'pre' ? 0 : 1);
  if (['fetch', 'between'].includes(timing)) assert(canceled, timing + ': unread response released');
}
for (const declared of [false, true]) {
  let canceled = false;
  await assert.rejects(visionStream({ ...base, fetchPort: async () => reply([data, Buffer.alloc(limit, 32)], {
    headers: declared ? { 'Content-Length': limit + data.length } : {}, onCancel() { canceled = true; }
  }) }), { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' });
  assert(canceled, 'oversize SSE closes the response iterator');
}
await assert.rejects(visionStream({ ...base, timeoutMs: 20, fetchPort: async () => reply([data], { after: () => delay(40) }) }), { name: 'TimeoutError' });
console.log('PASS vision SSE exact byte budget, split UTF-8, four cancellation timings, late timeout and response release; no partial success');
