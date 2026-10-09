import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-vision-candidate-routing');
const config = await import('../lib/config.js');
const { modelRef } = await import('../lib/models.js');
const { buildVisionModelCandidates, runVisionRequest } = await import('../lib/vision-model-routing.js');
const { runLocateRequest, runSummaryRequest } = await import('../lib/composite-vision-routing.js');
const { runOcrRequest } = await import('../lib/ocr-model-routing.js');
const { runAction } = await import('../lib/actions.js');
const { defineHostAdapter } = await import('../lib/host-contract.js');
const { createDshVisionFixture } = await import('./fixtures/vision-models.mjs');
const modelIds = ['vision-main', 'vision-other', 'shared/vision'];
const makeProvider = name => config.upsert({ name, type: 'openai', baseUrl: 'https://fixture.invalid/v1',
  apiKey: name + '-fixture-key', models: modelIds.map(id => ({ id, capabilities: ['vision'] })) });
const first = makeProvider('first'), second = makeProvider('second');
const assigned = [modelRef(first.id, modelIds[1]), modelRef(second.id, modelIds[2])];
config.setAssignmentOrder('vision', assigned);
const providers = config.pickAllFor('vision');
const expectedOrder = [...assigned, modelRef(first.id, modelIds[0]), modelRef(first.id, modelIds[2]),
  modelRef(second.id, modelIds[0]), modelRef(second.id, modelIds[1])];
assert.equal(providers.length, 6, '真实配置返回同账号的多份模型候选');

function makeHost(answers) {
  const fixture = createDshVisionFixture({ steps: answers.map(text => ({ text })) });
  let resolves = 0;
  const host = defineHostAdapter({ id: 'vision-fixture', ports: { attachments: fixture.attachments, textModel: { ...fixture.textModel,
    currentSelection: () => ({ provider: 'fixture', model: 'vision-v0' }),
    async resolveModelInfo() { resolves++; return { provider: 'fixture', id: 'vision-v0', inputModalities: ['image'] }; }
  } } });
  return { host, fixture, resolutions: () => resolves };
}
const png = await sharp({ create: { width: 120, height: 220, channels: 3, background: '#fff' } }).png().toBuffer();
const image = { bytes: new Uint8Array(png), mediaType: 'image/png' };
const imageFile = path.join(root, 'input.png'); fs.writeFileSync(imageFile, png);
const originalFetch = globalThis.fetch;
const requests = [];
const success = text => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] })
  + '\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
{ headers: { 'Content-Type': 'text/event-stream' } });
function respond(handler) {
  requests.length = 0;
  globalThis.fetch = async (_url, options) => {
    const request = { model: JSON.parse(options.body).model, authorization: options.headers.Authorization };
    requests.push(request);
    return handler(request);
  };
}
try {
  // 先检查实际 DSH 动作的 401 副作用；旧实现会请求同一个模型三次。
  respond(() => new Response('', { status: 401 }));
  const fallback = makeHost(['host answer']);
  const looked = await runAction(fallback.host, 'look', { image_path: imageFile, question: 'fixture',
    model: modelRef(first.id, modelIds[0]) });
  assert.equal(requests.length, 1, '显式模型遇到 401 只允许一次 HTTP 请求');
  assert.deepEqual(requests[0], { model: modelIds[0], authorization: 'Bearer first-fixture-key' });
  assert(looked.text.includes('host answer') && looked.text.includes('DSH 全局视觉模型'));
  assert.equal(fallback.fixture.stats.invocations, 1);
  assert.equal(fallback.resolutions(), 1);

  const lazy = makeHost([]);
  const implicit = buildVisionModelCandidates(lazy.host, { providers });
  assert.deepEqual(implicit.filter(candidate => candidate.via === 'selfstack')
    .map(candidate => modelRef(candidate.backendId, candidate.model)), expectedOrder,
  '默认选型保留分配顺序、同账号不同模型和跨账号同名模型');
  const explicit = buildVisionModelCandidates(lazy.host, { providers, model: modelRef(second.id, modelIds[2]) });
  assert.equal(explicit.filter(candidate => candidate.port.describe().availability === 'available' && candidate.via === 'selfstack').length, 1);
  assert.equal(explicit.filter(candidate => candidate.via === 'global').length, 1);
  assert.equal(lazy.resolutions() + lazy.fixture.bridge.saves + lazy.fixture.stats.invocations, 0, '构造候选不读取宿主元数据或调用模型');

  respond(() => success('explicit second account'));
  const selected = await runVisionRequest(lazy.host, { providers, model: modelRef(second.id, modelIds[2]), question: 'fixture', image });
  assert.deepEqual(requests, [{ model: modelIds[2], authorization: 'Bearer second-fixture-key' }]);
  assert.equal(selected.backendId, second.id); assert.equal(selected.model, modelIds[2]);

  respond(request => request.model === modelIds[1] ? new Response('', { status: 401 }) : success('next model'));
  const next = await runVisionRequest(lazy.host, { providers: providers.filter(provider => provider.id === first.id), question: 'fixture', image });
  assert.deepEqual(requests.map(request => request.model), [modelIds[1], modelIds[0]], '同账号不同模型仍可按分配顺序回退');
  assert.equal(next.model, modelIds[0]); assert.equal(next.errors[0].model, modelIds[1]);

  // 裸名称沿用跨账号回退；账号认证和成功结果不能因去重合并。
  respond(request => request.authorization === 'Bearer first-fixture-key'
    ? new Response('', { status: 401 }) : success('second account'));
  const shared = await runVisionRequest(lazy.host, { providers, model: modelIds[0], question: 'fixture', image });
  assert.deepEqual(requests.map(request => request.authorization), ['Bearer first-fixture-key', 'Bearer second-fixture-key']);
  assert.equal(shared.backendId, second.id); assert.equal(shared.model, modelIds[0]);
  assert.equal(shared.errors.filter(error => error.category === 'auth').length, 1);
  assert.equal(lazy.resolutions(), 0, '自持栈成功仍不解析宿主');

  // 定位与摘要使用同一候选边界，401 之后各只回退一次。
  respond(() => new Response('', { status: 401 }));
  const locator = makeHost(['{"x1":83.34,"y1":90.91,"x2":416.66,"y2":363.63}']);
  const located = await runLocateRequest(locator.host, { providers, model: modelRef(first.id, modelIds[0]), target: 'box', image });
  assert.equal(requests.length, 1); assert.equal(located.x1, 10); assert.equal(located.via, 'global');
  assert.equal(located.errors.filter(error => error.category === 'auth').length, 1);
  respond(() => new Response('', { status: 401 }));
  const summaryHost = makeHost(['summary answer']);
  const summarized = await runSummaryRequest(summaryHost.host, { providers, model: modelRef(first.id, modelIds[0]),
    frames: [{ buffer: png, width: 120, height: 220, atSec: 0 }] });
  assert.equal(requests.length, 1); assert.equal(summarized.answer, 'summary answer');
  assert.equal(summaryHost.fixture.stats.invocations, 1);

  // 健康记录尚不存在的账号：首次 429 不能依赖旧共享 health 对象阻止重复调用。
  const fresh = makeProvider('fresh');
  assert.equal(fresh.health, undefined);
  const freshRows = config.pickAllFor('vision').filter(provider => provider.id === fresh.id);
  respond(() => Response.json({ error: { code: 'RateLimitExceeded', message: 'Too many requests' } },
    { status: 429, headers: { 'Retry-After': '120' } }));
  const cooldownHost = makeHost(['cooldown fallback', 'reloaded fallback']);
  const limited = await runVisionRequest(cooldownHost.host, { providers: freshRows, model: modelRef(fresh.id, modelIds[0]),
    question: 'fixture', image, onRateLimit: config.recordRateLimit });
  assert.equal(requests.length, 1); assert.equal(limited.answer, 'cooldown fallback');
  assert.equal(limited.errors.filter(error => error.category === 'rate_limit').length, 1);
  assert.equal(config.modelHealth(fresh.id, modelIds[0], 'vision').rateLimited, true);
  config.resetCache();
  await runVisionRequest(cooldownHost.host, { providers: config.pickAllFor('vision').filter(provider => provider.id === fresh.id),
    model: modelRef(fresh.id, modelIds[0]), question: 'fixture', image, onRateLimit: config.recordRateLimit });
  assert.equal(requests.length, 1, '持久化并重载后不再次请求冷却中的显式模型');
  const reloaded = config.providerById(fresh.id);
  respond(() => success('sibling answer'));
  const sibling = await runVisionRequest(lazy.host, { providers: config.pickAllFor('vision').filter(provider => provider.id === fresh.id),
    model: modelRef(fresh.id, modelIds[1]), question: 'fixture', image });
  assert.equal(requests.length, 1); assert.equal(sibling.answer, 'sibling answer');
  assert.equal(config.modelHealth(reloaded.id, modelIds[1], 'vision').rateLimited, undefined, '停用不扩大到账号其他模型');

  // 新账号 OCR 多切片：第一块首次耗尽，随后各块复用宿主，HTTP 总计一次。
  const ocrProvider = makeProvider('ocr');
  assert.equal(ocrProvider.health, undefined);
  respond(() => Response.json({ error: { code: 'BudgetLimitExceeded', message: 'Budget exceeded' } }, { status: 429 }));
  const ocrHost = makeHost(['OCR one', 'OCR two', 'OCR three']);
  const ocr = await runOcrRequest(ocrHost.host, {
    providers: config.pickAllFor('vision').filter(provider => provider.id === ocrProvider.id),
    model: modelRef(ocrProvider.id, modelIds[0]), image, chunkHeight: 100, overlap: 0, onRateLimit: config.recordRateLimit });
  assert.equal(ocr.status, 'complete'); assert.equal(ocr.totalChunks, 3);
  assert.equal(requests.length, 1); assert.equal(ocrHost.fixture.stats.invocations, 3);
  assert.equal(ocrHost.resolutions(), 1, '切片沿用同一宿主路由');
  assert.equal(ocr.invocations, 4, '一次自持请求加三次宿主请求');
  assert.equal(config.modelHealth(ocrProvider.id, modelIds[0], 'vision').reason, 'budget');
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'core-v0')), false);
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'tasks.json')), false);
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'artifacts.json')), false);
} finally { globalThis.fetch = originalFetch; }
console.log('PASS 视觉候选去重：DSH 401 单次请求、账号/模型顺序与隔离、定位/摘要、首次 429 与重载、OCR 三切片总计一次受阻 HTTP');
