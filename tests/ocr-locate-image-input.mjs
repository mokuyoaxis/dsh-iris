import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { runOcrRequest } from '../lib/ocr-model-routing.js';
import { runLocateRequest } from '../lib/composite-vision-routing.js';
import { formatOcrResult } from '../lib/ocr.js';
import { useTempDshHome } from './test-env.js';
useTempDshHome('iris-ocr-locate-budget');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#ed3452' } }).png().toBuffer();
const image = { bytes: new Uint8Array(png), mediaType: 'image/png' };
const originalHash = hash(png);
const provider = (id, dimension) => ({ id, type: 'openai', auth: 'none', baseUrl: `https://${id}.invalid/v1`,
  visionInput: { maxDimension: 300 }, models: [{ id: 'same', capabilities: ['vision'], visionInput: { maxDimension: dimension } }] });
const a = provider('a', 200), b = provider('b', 400);
const sse = text => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
  + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const calls = [];
let answer = 'OCR LINE', rejectA = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body), content = body.messages.at(-1).content;
  const prompt = content[0].text, data = content[1].image_url.url;
  const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  const metadata = await sharp(bytes).metadata();
  calls.push({ provider: new URL(url).hostname, model: body.model, prompt, width: metadata.width,
    height: metadata.height, orientation: metadata.orientation, bytes: bytes.length });
  if (rejectA && new URL(url).hostname === 'a.invalid') return new Response('', { status: 401 });
  return sse(typeof answer === 'function' ? answer(calls.at(-1)) : answer);
};
try {
  const ocr = await runOcrRequest({}, { providers: [a], image, chunkHeight: 300, overlap: 0 });
  assert.equal(ocr.totalChunks, 2); assert.equal(ocr.successfulChunks, 2);
  assert.deepEqual(calls.map(call => [call.width, call.height]), [[200, 75], [200, 50]], '预算用于每块而不是整张长图');
  assert.deepEqual(ocr.chunks.map(chunk => chunk.input.source.height), [300, 200]);
  assert.deepEqual(ocr.chunks.map(chunk => chunk.input.sent.height), [75, 50]);
  assert.match(formatOcrResult(ocr), /细小文字可能丢失/);
  assert.match(formatOcrResult(ocr), /800x300 → 200x75/);
  rejectA = true; calls.length = 0;
  const fallbackOcr = await runOcrRequest({}, { providers: [a, b], image, chunkHeight: 300, overlap: 0 });
  assert.equal(fallbackOcr.invocations, 4);
  assert.deepEqual(fallbackOcr.chunks.map(chunk => chunk.input.sent.width), [400, 400]);
  assert(fallbackOcr.chunks.every(chunk => chunk.identity.providerId === 'b'));
  assert.deepEqual(calls.map(call => call.width), [200, 400, 200, 400]);

  calls.length = 0;
  answer = call => {
    assert.match(call.prompt, new RegExp(`尺寸 ${call.width}x${call.height}`));
    assert.match(call.prompt, /0–1000 归一化坐标/);
    return JSON.stringify({ x1: 10.2 / call.width * 1000, y1: 20.3 / call.height * 1000,
      x2: 30.4 / call.width * 1000, y2: 40.5 / call.height * 1000 });
  };
  const location = await runLocateRequest({}, { providers: [a, b], target: 'red', image });
  assert.equal(location.backendId, 'b'); assert.equal(location.errors[0].code, 'IRIS_MODEL_AUTH_FAILED');
  assert.deepEqual([location.input.sent.width, location.input.sent.height], [400, 250]);
  assert.deepEqual({ x1: location.x1, y1: location.y1, x2: location.x2, y2: location.y2 },
    { x1: 20, y1: 40, x2: 61, y2: 81 }, '按成功候选输入映射，先换算浮点再向外取整');
  assert.deepEqual(calls.map(call => call.width), [200, 400]);
  answer = '{"found":false}';
  assert.equal((await runLocateRequest({}, { providers: [b], target: 'absent', image })).found, false);
  calls.length = 0; answer = '{"x1":1900,"y1":1,"x2":1950,"y2":5}';
  await assert.rejects(runLocateRequest({}, { providers: [b, a], target: 'red', image }), { code: 'IRIS_MODEL_PROTOCOL_INVALID' });
  assert.equal(calls.length, 1, '已返回错误坐标时不向其他模型重复请求');

  // 明确的八种 EXIF 方向与独立预计算的输入矩形，输出始终属于原始 80x60 像素。
  const boxes = [[10, 20, 40, 50], [40, 20, 70, 50], [40, 10, 70, 40], [10, 10, 40, 40],
    [20, 10, 50, 40], [10, 10, 40, 40], [10, 40, 40, 70], [20, 40, 50, 70]];
  for (let orientation = 1; orientation <= 8; orientation++) {
    const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#e35' } })
      .withMetadata({ orientation }).jpeg().toBuffer();
    const [x1, y1, x2, y2] = boxes[orientation - 1];
    answer = call => JSON.stringify({ x1: x1 / call.width * 1000, y1: y1 / call.height * 1000,
      x2: x2 / call.width * 1000, y2: y2 / call.height * 1000 });
    const result = await runLocateRequest({}, { providers: [b], target: 'red', image: { bytes: new Uint8Array(jpeg), mediaType: 'image/jpeg' } });
    assert.deepEqual([result.x1, result.y1, result.x2, result.y2], [10, 20, 40, 50], 'EXIF ' + orientation);
    assert.deepEqual([result.width, result.height], [80, 60]);
    assert(!calls.at(-1).orientation || calls.at(-1).orientation === 1, '输入明确转正');
  }
  answer = 'LINE';
  const rotated = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#fff' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const rotatedOcr = await runOcrRequest({}, { providers: [b], image: { bytes: new Uint8Array(rotated), mediaType: 'image/jpeg' }, chunkHeight: 100, overlap: 0 });
  assert.deepEqual([rotatedOcr.width, rotatedOcr.height, rotatedOcr.totalChunks], [100, 300, 3], 'OCR 按转正后的长图切片');

  // 字节预算与不可满足预算：无额外 HTTP 重试，失败不会写成识别成功。
  const entropy = Buffer.alloc(800 * 300 * 3);
  for (let i = 0; i < entropy.length; i++) entropy[i] = (i * 73 + (i >>> 8) * 31) & 255;
  const noisy = await sharp(entropy, { raw: { width: 800, height: 300, channels: 3 } }).png().toBuffer();
  const limited = { ...b, visionInput: { maxBytes: 15000 }, models: [{ id: 'same', capabilities: ['vision'] }] };
  const byteOcr = await runOcrRequest({}, { providers: [limited], image: { bytes: new Uint8Array(noisy), mediaType: 'image/png' }, chunkHeight: 300, overlap: 0 });
  assert.equal(byteOcr.status, 'complete'); assert(byteOcr.chunks[0].input.sent.bytes <= 15000);
  const impossible = { ...limited, visionInput: { maxBytes: 1 } };
  calls.length = 0;
  const failed = await runOcrRequest({}, { providers: [impossible], image, chunkHeight: 300, overlap: 0 });
  assert.equal(failed.status, 'failed'); assert.equal(calls.length, 0); assert.equal(failed.invocations, 0);
  assert(failed.chunks.every(chunk => chunk.code === 'IRIS_MODEL_IMAGE_TOO_LARGE'));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(runLocateRequest({}, { providers: [b], target: 'red', image, signal: aborted.signal }), { code: 'IRIS_MODEL_ABORTED' });
  assert.equal(calls.length, 0);
  assert.equal(hash(image.bytes), originalHash);

  // DSH 保存后还会变成 JPEG；提示词和映射必须使用附件真正的 100x63，而非 Iris 的 200x125。
  const stored = new Map();
  let streamCalls = 0, preparedPrompt = '';
  const host = { ports: {
    attachments: {
      async saveImage({ data }) {
        const bytes = await sharp(Buffer.from(data)).autoOrient().resize({ width: 100 }).jpeg().toBuffer();
        const source = await sharp(Buffer.from(data)).metadata(), sent = await sharp(bytes).metadata();
        const attachmentId = 'sha256:' + hash(bytes); stored.set(attachmentId, bytes);
        return { attachmentId, mediaType: 'image/jpeg', bytes: bytes.length, width: sent.width, height: sent.height,
          originalDimensions: { width: source.width, height: source.height } };
      },
      async readImage(ref) { return { data: stored.get(ref.attachmentId), mediaType: ref.mediaType }; }
    },
    textModel: {
      currentSelection: () => ({ provider: 'native', model: 'same' }),
      resolveModelInfo: () => ({ provider: 'native', id: 'same', inputModalities: ['text', 'image'] }),
      async *stream(request) {
        streamCalls++; preparedPrompt = request.messages[0].content[0].text;
        const ref = request.messages[0].content[1].attachment;
        const isOcr = preparedPrompt.includes('完整读出图片');
        if (!isOcr) assert.match(preparedPrompt, new RegExp(`尺寸 ${ref.width}x${ref.height}`));
        yield { type: 'text-delta', index: 0, text: isOcr ? 'DSH OCR LINE' : '{"x1":100,"y1":160,"x2":200,"y2":320}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  } };
  const dsh = await runLocateRequest(host, { image, target: 'red' });
  assert.equal(streamCalls, 1); assert.equal(dsh.via, 'global');
  assert.deepEqual([dsh.input.sent.width, dsh.input.sent.height], [100, 63]);
  assert.deepEqual([dsh.x1, dsh.y1, dsh.x2, dsh.y2], [80, 80, 160, 160]);
  const dshOcr = await runOcrRequest(host, { image, chunkHeight: 300, overlap: 0 });
  assert.equal(dshOcr.status, 'complete');
  assert.deepEqual(dshOcr.chunks.map(chunk => [chunk.input.sent.width, chunk.input.sent.height]), [[100, 38], [100, 25]]);
  assert.equal(hash(image.bytes), originalHash);
} finally { globalThis.fetch = originalFetch; }
console.log('PASS OCR/定位预算：每块尺寸与字节、账号/模型隔离、候选切换、浮点外扩、八种 EXIF、取消/格式终态、DSH 最终附件映射、原图不变');
