import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { prepareVisionImage, visionInputLimits, normalizeVisionInputLimits } from '../lib/vision-image-input.js';
import { createHttpVisionModelPort } from '../lib/http-vision-model-adapter.js';
import { createDshVisionModelPort } from '../lib/dsh-vision-model-adapter.js';
import { invokeModel } from '../lib/model-invoker.js';
import { modelErrorRecord, ModelPortError, normalizeModelError } from '../lib/model-port-contract.js';
import { createConfiguredVisionModelPort } from '../lib/vision-model-routing.js';
import { modelRateLimit } from '../lib/provider-health.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pixels = Buffer.alloc(1024 * 576 * 3);
let seed = 1;
for (let i = 0; i < pixels.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[i] = seed & 255; }
const raw = () => sharp(pixels, { raw: { width: 1024, height: 576, channels: 3 } });
const png = await raw().png().toBuffer();
const image = { bytes: png, mediaType: 'image/png' }, originalHash = hash(png);
assert.equal(await prepareVisionImage(image, { maxBytes: png.length + 1 }), image, '合预算的小图必须逐字节透传');
assert.equal(await prepareVisionImage(image, { maxBytes: png.length + 1, maxDimension: 2048 }), image);
for (const [format, mediaType] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
  const bytes = await raw().toFormat(format).toBuffer();
  const prepared = await prepareVisionImage({ bytes, mediaType }, { maxBytes: 64 * 1024, maxDimension: 512 });
  const metadata = await sharp(prepared.bytes).metadata();
  assert.equal(prepared.mediaType, mediaType); assert.equal(metadata.format, format);
  assert(prepared.bytes.length <= 64 * 1024); assert(metadata.width <= 512);
  assert(Math.abs(metadata.width / metadata.height - 1024 / 576) < 0.02);
}
assert.equal(hash(png), originalHash, '处理不能改写原字节');
const dimensionCapped = await prepareVisionImage(image, { maxBytes: 1024 * 1024, maxDimension: 512 });
assert.equal((await sharp(dimensionCapped.bytes).metadata()).width, 512, '最长边已足够满足大小预算时不额外缩小');
const rotated = await sharp({ create: { width: 640, height: 320, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
const oriented = await prepareVisionImage({ bytes: rotated, mediaType: 'image/jpeg' }, { maxDimension: 320 });
const orientedMeta = await sharp(oriented.bytes).metadata();
assert.equal(orientedMeta.width, 160); assert.equal(orientedMeta.height, 320, '缩放必须应用 EXIF 方向，不把人物转倒');
assert.deepEqual(visionInputLimits({ visionInput: { maxBytes: 100, maxDimension: 2048 }, models: [
  { id: 'a', visionInput: { maxBytes: 50 } }, { id: 'b' }
] }, 'a'), { maxBytes: 50, maxDimension: 2048 });
assert.deepEqual(visionInputLimits({ models: [] }, 'a'), { maxBytes: 8388608 });
for (const value of [{ maxBytes: 0 }, { maxDimension: 1.5 }, { extra: 1 }, [], '12']) {
  assert.throws(() => normalizeVisionInputLimits(value), { code: 'IRIS_CONFIG_INPUT_INVALID' });
}
const controller = new AbortController(); controller.abort();
await assert.rejects(prepareVisionImage(image, { maxBytes: 100 }, { signal: controller.signal }), { code: 'IRIS_MODEL_ABORTED' });
await assert.rejects(prepareVisionImage(image, { maxBytes: 1 }), error => error.code === 'IRIS_MODEL_IMAGE_TOO_LARGE'
  && error.invocation === 'not_invoked' && error.imageBytes === png.length && error.imageMaxBytes === 1);
const gifBytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: 'red' } }).gif().toBuffer();
const gif = { bytes: gifBytes, mediaType: 'image/gif' };
assert.equal(await prepareVisionImage(gif, { maxBytes: 10000, maxDimension: 100 }), gif);
await assert.rejects(prepareVisionImage(gif, { maxDimension: 8 }), { code: 'IRIS_MODEL_IMAGE_TOO_LARGE' });

const budget = { timeoutMs: 10000, maxInputTextBytes: 4096, maxOutputChars: 100, maxImageBytes: 20 * 1024 * 1024 };
const request = { prompt: 'describe', image };
const success = () => new Response('data: {"choices":[{"delta":{"content":"看到了"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });
let calls = 0, sent;
const port = createHttpVisionModelPort({ providerId: 'a', modelId: 'same', baseUrl: 'https://fixture.invalid/v1',
  imageInput: { maxBytes: 64 * 1024 }, async fetch(_url, options) {
    calls++; const body = JSON.parse(options.body); const data = body.messages[0].content[1].image_url.url;
    sent = Buffer.from(data.split(',')[1], 'base64'); assert(data.startsWith('data:image/png;base64,')); return success();
  } });
assert.equal((await invokeModel(port, request, { budget })).text, '看到了');
assert.equal(calls, 1); assert(sent.length <= 64 * 1024); assert.equal(hash(png), originalHash);
const impossible = createHttpVisionModelPort({ providerId: 'a', modelId: 'same', baseUrl: 'https://fixture.invalid/v1',
  imageInput: { maxBytes: 1 }, fetch() { calls++; throw new Error('must not invoke'); } });
await assert.rejects(invokeModel(impossible, request, { budget }), error => error.code === 'IRIS_MODEL_IMAGE_TOO_LARGE'
  && error.stage === 'prepare' && error.invocation === 'not_invoked');
assert.equal(calls, 1);

// 上游 400 的大小事实安全投影；未知原文、密钥和 URL 不进入 CLI/UI，不能当作 429。
const provider = { id: 'a', type: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'private-key',
  models: [{ id: 'same', capabilities: ['vision'] }] };
const oldFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => { calls++; return Response.json({ error: { message:
    `image 1: ${png.length} bytes exceeds the 12582912-byte limit private-key https://private.invalid`, type: 'invalid_request_error' } }, { status: 400 }); };
  const limited = createConfiguredVisionModelPort(provider, 'same');
  await assert.rejects(invokeModel(limited, request, { budget }), error => {
    const record = modelErrorRecord(error);
    assert.equal(record.code, 'IRIS_MODEL_IMAGE_TOO_LARGE'); assert.equal(record.status, 400);
    assert.equal(record.imageBytes, png.length); assert.equal(record.imageMaxBytes, 12582912);
    assert.equal(record.invocation, 'rejected'); assert(!JSON.stringify(record).includes('private'));
    error.message = 'private-key'; error.imageBytes = 9;
    assert.equal(normalizeModelError(error).imageBytes, png.length);
    assert(!JSON.stringify(error).includes('private')); return true;
  });
  assert.equal(modelRateLimit(provider, 'same'), null);
  globalThis.fetch = async () => Response.json({ error: { message: 'private malformed input' } }, { status: 400 });
  await assert.rejects(invokeModel(createConfiguredVisionModelPort(provider, 'same'), request, { budget }),
    error => error.code === 'IRIS_MODEL_INPUT_INVALID' && error.invocation === 'rejected' && error.status === 400);
  globalThis.fetch = async () => Response.json({ error: { message: 'private throttled' } }, { status: 429 });
  await assert.rejects(invokeModel(createConfiguredVisionModelPort(provider, 'same'), request, { budget }), { code: 'IRIS_MODEL_RATE_LIMITED' });
  assert(modelRateLimit(provider, 'same')?.until);
} finally { globalThis.fetch = oldFetch; }

// DSH 看图接受宿主持久化后的压缩图片；坐标业务和损坏引用继续拒绝。
const jpeg = await raw().resize(512).jpeg().toBuffer();
const ref = { attachmentId: 'sha256:' + hash(jpeg), mediaType: 'image/jpeg', bytes: jpeg.length,
  width: 512, height: 288, originalDimensions: { width: 1024, height: 576 } };
const attachments = { async saveImage(input) { assert.equal(hash(input.data), originalHash); return ref; },
  async readImage() { return { data: jpeg, mediaType: 'image/jpeg' }; } };
const binding = { provider: 'host', model: 'vision' }, metadata = { provider: 'host', id: 'vision', inputModalities: ['image'] };
let hostCalls = 0;
const textModel = { async *stream(input) {
  hostCalls++; assert.equal(input.messages[0].content[1].attachment.attachmentId, ref.attachmentId);
  yield { type: 'text-delta', index: 0, text: '已识别' }; yield { type: 'finish', reason: { kind: 'stop' } };
} };
const hostPort = allowImageNormalization => createDshVisionModelPort(textModel, attachments, binding, { metadata, allowImageNormalization });
await assert.rejects(invokeModel(hostPort(false), request, { budget }), { code: 'IRIS_MODEL_INCOMPATIBLE' });
assert.equal(hostCalls, 0);
assert.equal((await invokeModel(hostPort(true), request, { budget })).text, '已识别');
assert.equal(hostCalls, 1);
const bad = createDshVisionModelPort(textModel, { ...attachments, async readImage() { return { data: png }; } }, binding,
  { metadata, allowImageNormalization: true });
await assert.rejects(invokeModel(bad, request, { budget }), { code: 'IRIS_MODEL_INCOMPATIBLE' });
assert.equal(hostCalls, 1);
assert.equal(hash(png), originalHash);
assert(new ModelPortError('IRIS_MODEL_IMAGE_TOO_LARGE').message);
console.log('PASS 看图输入：格式/比例/原图保留、账号模型预算、取消/本地拒绝、一次 HTTP、400/429 隔离、安全错误事实、DSH 规范化与坐标隔离');
