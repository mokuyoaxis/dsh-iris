import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { createDshVisionFixture } from './fixtures/vision-models.mjs';
import { longOcr, OCR_BUDGET, formatOcrResult } from '../lib/ocr.js';
import { runOcrRequest } from '../lib/ocr-model-routing.js';
import { ModelPortError } from '../lib/model-port-contract.js';

const { root } = useTempDshHome('iris-ocr-m4');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const iris = await import('../lib/index.js');
const bytes = await sharp({ create: { width: 128, height: 300, channels: 3, background: '#ff0000' } }).png().toBuffer();
const image = { bytes: new Uint8Array(bytes), mediaType: 'image/png' };
const budget = { ...OCR_BUDGET, timeoutMs: 2000 };
const input = { image, chunkHeight: 100, overlap: 0, budget };
const fake = options => createFakeModelPort({ kind: 'vision', ...options });
const rejectCode = code => error => error.code === code;

// 失败块的位置不能丢失，也不能把失败伪装成“没有文字”或完整全文。
const partial = fake({ steps: [{ text: 'one' }, { error: new Error('sk-private /private/image https://private.invalid') }, { text: 'three' }] });
const partialResult = await longOcr({ ...input, ports: [partial.port] });
assert.equal(partialResult.status, 'partial');
assert.equal(partialResult.fullText, '[第1段 y=0] one\n[第3段 y=200] three');
assert.equal(partialResult.failedChunks, 1);
assert(formatOcrResult(partialResult).includes('部分完成'));
assert(!JSON.stringify(partialResult).includes('private'));
assert.equal(partial.stats.invocations, 3);
const failed = fake({ steps: [{ text: '' }, { text: '' }, { text: '' }] });
const failedResult = await longOcr({ ...input, ports: [failed.port] });
assert.equal(failedResult.status, 'failed'); assert.equal(failedResult.fullText, '');
assert(formatOcrResult(failedResult).includes('OCR 失败'));

// 明确拒绝允许同块下一候选；截断/协议等失败不允许该块换模型取答案。
const rejected = fake({ backendId: 'fixture:reject', steps: Array.from({ length: 3 }, () => ({
  error: new ModelPortError('IRIS_MODEL_RATE_LIMITED', { stage: 'invoke', invocation: 'rejected', status: 429 }) })) });
const fallback = fake({ backendId: 'fixture:fallback' });
const routed = await longOcr({ ...input, ports: [rejected.port, fallback.port] });
assert.equal(routed.status, 'complete'); assert.equal(routed.invocations, 6);
assert(routed.chunks.every(chunk => chunk.errors[0].code === 'IRIS_MODEL_RATE_LIMITED'));
for (const finishReason of ['length', 'tool-calls', 'content-blocked', 'unknown']) {
  const first = fake({ steps: [{ text: 'truncated secret body', finishReason }, { text: 'two' }, { text: 'three' }] });
  const next = fake();
  const result = await longOcr({ ...input, ports: [first.port, next.port] });
  assert.equal(result.status, 'partial'); assert.equal(result.chunks[0].text, '');
  assert(!JSON.stringify(result).includes('truncated secret body'));
  assert.equal(next.stats.invocations, 0);
}
const missing = fake({ availability: 'unavailable', reasonCode: 'IRIS_MODEL_UNAVAILABLE' });
const available = fake();
assert.equal((await longOcr({ ...input, ports: [missing.port, available.port], maxInvocations: 3 })).status, 'complete');
assert.equal(missing.stats.invocations, 0);

// 达到总次数时停止后续切片；候选切换也占总额度。
const limited = fake();
const limitedResult = await longOcr({ ...input, ports: [limited.port], maxInvocations: 1 });
assert.equal(limitedResult.status, 'partial'); assert.equal(limitedResult.invocations, 1);
assert.equal(limitedResult.skippedChunks, 2); assert.equal(limitedResult.failedChunks, 0);
assert.equal(limitedResult.stopCode, 'IRIS_MODEL_CALL_LIMIT');
assert.equal(limited.stats.invocations, 1); assert(formatOcrResult(limitedResult).includes('调用上限'));
const quota = fake({ steps: [{ error: new ModelPortError('IRIS_MODEL_AUTH_FAILED', { stage: 'invoke', invocation: 'rejected', status: 401 }) }] });
const afterQuota = fake();
const emptyLimit = await longOcr({ ...input, ports: [quota.port, afterQuota.port], maxInvocations: 1 });
assert.equal(emptyLimit.status, 'failed'); assert.equal(emptyLimit.skippedChunks, 3);
assert.equal(afterQuota.stats.invocations, 0);

// 取消/超时不形成 partial 返回，也不调用下一块/下一候选。
const pre = new AbortController(); pre.abort();
const preFixture = fake();
await assert.rejects(longOcr({ ...input, image: undefined, ports: [preFixture.port], signal: pre.signal }), rejectCode('IRIS_MODEL_ABORTED'));
assert.equal(preFixture.stats.invocations, 0);
const controller = new AbortController();
const cancelFixture = fake({ steps: [{ text: 'one' }, { waitForAbort: true }] });
const nextCandidate = fake();
const cancelPort = { describe: () => cancelFixture.port.describe(), complete(request, options) {
  const pending = cancelFixture.port.complete(request, options);
  if (cancelFixture.stats.invocations === 2) setTimeout(() => controller.abort(), 10);
  return pending;
} };
await assert.rejects(longOcr({ ...input, ports: [cancelPort, nextCandidate.port], signal: controller.signal }), rejectCode('IRIS_MODEL_ABORTED'));
assert.equal(cancelFixture.stats.invocations, 2); assert.equal(nextCandidate.stats.invocations, 0);
assert.equal(cancelFixture.stats.aborted, 1); assert.equal(cancelFixture.stats.active, 0);
const timed = fake({ steps: [{ text: 'one', delayMs: 70 }, { waitForAbort: true }] });
await assert.rejects(longOcr({ ...input, ports: [timed.port, nextCandidate.port], budget: { ...budget, timeoutMs: 250 } }), rejectCode('IRIS_MODEL_TIMEOUT'));
assert.equal(timed.stats.invocations, 2);
assert(timed.calls[1].options.budget.timeoutMs < timed.calls[0].options.budget.timeoutMs);
assert.equal(timed.stats.aborted, 1); assert.equal(nextCandidate.stats.invocations, 0);

// 准备阶段也消费同一 deadline；不合作的附件读取有界退出，无晚到生成。
let preparations = 0, prepareSignal;
await assert.rejects(runOcrRequest({}, { signal: pre.signal, prepareImage() { preparations++; return image; } }), rejectCode('IRIS_MODEL_ABORTED'));
assert.equal(preparations, 0);
await assert.rejects(runOcrRequest({}, { prepareImage(signal) { prepareSignal = signal; return new Promise(() => {}); },
  budget: { ...budget, timeoutMs: 30 } }), rejectCode('IRIS_MODEL_TIMEOUT'));
assert(prepareSignal.aborted);
for (const settings of [{ chunkHeight: NaN }, { chunkHeight: Infinity }, { overlap: NaN }, { maxDimension: 0 }, { maxInvocations: 0 }]) {
  await assert.rejects(runOcrRequest({}, { ...settings, prepareImage() { preparations++; return image; } }), rejectCode('IRIS_MODEL_INPUT_INVALID'));
}
assert.equal(preparations, 0);
const overPlanned = await sharp({ create: { width: 32, height: 3300, channels: 3, background: '#000000' } }).png().toBuffer();
const planFixture = fake();
await assert.rejects(longOcr({ ...input, image: { ...image, bytes: new Uint8Array(overPlanned) }, ports: [planFixture.port] }), rejectCode('IRIS_MODEL_INPUT_INVALID'));
assert.equal(planFixture.stats.invocations, 0);
await assert.rejects(longOcr({ ...input, image: { ...image, bytes: new Uint8Array([1, 2]) }, ports: [planFixture.port] }), error =>
  error.code === 'IRIS_MODEL_INPUT_INVALID' && !error.message.includes('buffer'));

// 实际 DSH 桥接每块同字节；一轮默认路由/元数据只解析一次。
const dsh = createDshVisionFixture({ steps: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] });
let selections = 0, metadataReads = 0;
const host = { ports: { attachments: dsh.attachments, textModel: { ...dsh.textModel,
  currentSelection() { selections++; return { provider: 'fixture', model: selections === 1 ? 'vision-v0' : 'drifted' }; },
  async resolveModelInfo(provider, id) { metadataReads++; return { provider, id, inputModalities: ['image', 'text'] }; }
} } };
const dshResult = await runOcrRequest(host, input);
assert.equal(dshResult.status, 'complete'); assert.equal(selections, 1); assert.equal(metadataReads, 1);
assert.equal(dsh.bridge.saves, 3);
for (let i = 0; i < 3; i++) {
  const expected = await sharp(bytes).extract({ left: 0, top: i * 100, width: 128, height: 100 }).png().toBuffer();
  assert.deepEqual(Buffer.from(dsh.calls[i].request.image.bytes), expected);
}

// 真正的 GUI/Agent 入口使用严格 HTTP，保留 overlap=0，且不写任何 Task/Artifact。
const provider = config.upsert({ type: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'private-key',
  models: [{ id: 'vision', capabilities: ['vision'] }], visionModel: 'vision', enabled: true });
const file = path.join(root, 'input.png'); fs.writeFileSync(file, bytes);
const fetchOriginal = globalThis.fetch;
let requests = 0, imageReads = 0, saved = 0, sessionReads = 0;
const receivedHeights = [];
const definitions = new Map(), disposers = [];
const services = { tools: { register(definition) { definitions.set(definition.name, definition); return () => {}; } },
  attachments: {
    async saveImage() { saved++; throw new Error('self success must not save'); },
    async readImage(_ref, signal) { imageReads++; assert(signal instanceof AbortSignal); return { data: new Uint8Array(bytes), mediaType: 'image/png' }; }
  }, sessionQuery: { async readSession() { sessionReads++; return { events: [{ data: { content: [{ type: 'image',
    attachment: { attachmentId: 'session-image', mediaType: 'image/png', bytes: bytes.length, width: 128, height: 300 } }] } }] }; } } };
const ctx = { get: name => services[name], inject() {}, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); } };
await iris.apply(ctx);
const tool = definitions.get('iris_long_ocr'); assert(tool);
const dataRoot = config.irisHome();
const beforeFiles = fs.readdirSync(dataRoot).sort();
const beforeTasks = fs.readFileSync(path.join(dataRoot, 'tasks.json'));
const beforeProviders = fs.readFileSync(path.join(dataRoot, 'providers.json'));
let responseKind = 'normal';
globalThis.fetch = async (_url, options) => {
  requests++;
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'vision'); assert.equal(body.messages.length, 1); assert.equal(body.tools, undefined);
  const png = Buffer.from(body.messages[0].content[1].image_url.url.split(',')[1], 'base64');
  receivedHeights.push((await sharp(png).metadata()).height);
  if (responseKind === 'cancel') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  const finish = responseKind === 'truncated' ? 'length' : 'stop';
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fixture text' }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n` + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } });
};
try {
  const gui = await runAction({}, 'ocr', { image_path: file, chunk_height: 100, overlap: 0 });
  assert(gui.ok); assert(gui.text.includes('OCR 完成') && gui.text.includes('[第3段 y=200]'));
  assert.deepEqual(receivedHeights, [100, 100, 100]);
  receivedHeights.length = 0;
  const toolResult = await tool.execute({ attachment_id: 'session-image', chunk_height: 100, overlap: 0 },
    { signal: new AbortController().signal, agent: { session: { id: 'fixture' } } });
  assert(toolResult.includes('OCR 完成')); assert.deepEqual(receivedHeights, [100, 100, 100]);
  assert.equal(imageReads, 1); // 会话中引用的图片只取一次源字节。
  const before = requests, readsBefore = imageReads + sessionReads;
  await assert.rejects(tool.execute({ attachment_id: 'session-image' }, { signal: pre.signal, agent: { session: { id: 'fixture' } } }), rejectCode('IRIS_MODEL_ABORTED'));
  await assert.rejects(runAction({}, 'ocr', { image_path: path.join(root, 'missing.png') }, { signal: pre.signal }), rejectCode('IRIS_MODEL_ABORTED'));
  assert.equal(requests, before); assert.equal(imageReads + sessionReads, readsBefore);
  responseKind = 'truncated';
  const guiFailure = await runAction({}, 'ocr', { image_path: file, chunk_height: 100, overlap: 0 });
  assert.equal(guiFailure.ok, false); assert(guiFailure.text.includes('OCR 失败'));
  assert(!guiFailure.text.includes('fixture text'));
  responseKind = 'cancel';
  const canceled = new AbortController();
  const pending = runAction({}, 'ocr', { image_path: file, chunk_height: 100, overlap: 0 }, { signal: canceled.signal });
  pending.catch(() => {});
  const startedBefore = requests;
  const deadline = performance.now() + 2000;
  while (requests === startedBefore && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(requests, startedBefore + 1);
  canceled.abort();
  await assert.rejects(pending, rejectCode('IRIS_MODEL_ABORTED'));
  assert.equal(requests, startedBefore + 1);
  assert.deepEqual(fs.readdirSync(dataRoot).sort(), beforeFiles);
  assert.deepEqual(fs.readFileSync(path.join(dataRoot, 'tasks.json')), beforeTasks);
  assert.deepEqual(fs.readFileSync(path.join(dataRoot, 'providers.json')), beforeProviders);
  assert.equal(fs.existsSync(path.join(dataRoot, 'artifacts.json')), false);
  assert.equal(fs.existsSync(path.join(dataRoot, 'core-v0')), false);
  assert.equal(saved, 0);
  assert(config.providerById(provider.id));
} finally { globalThis.fetch = fetchOriginal; for (const dispose of disposers.reverse()) dispose(); }
console.log('ALL OK —— M4 OCR 完整/部分/失败、有限分块/总预算/候选次数、取消终止、同图桥接、默认路由冻结及真实入口零 Task/Artifact 写入通过');
