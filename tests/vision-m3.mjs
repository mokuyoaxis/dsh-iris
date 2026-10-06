import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
const { root } = useTempDshHome('iris-vision-m3');
const { runVisionRequest, buildVisionModelCandidates, probeVisionModel, visionImageFromDataUrl } = await import('../lib/vision-model-routing.js');
const { createDshHostAdapter } = await import('../lib/dsh-host-adapter.js');
const { createDshVisionFixture } = await import('./fixtures/vision-models.mjs');
const { VISION_BUDGET } = await import('../lib/vision-core.js');
const { RED_TEST_IMAGE } = await import('../lib/vision.js');
const { runAction } = await import('../lib/actions.js');
const config = await import('../lib/config.js');
const iris = await import('../lib/index.js');
const fixture = createDshVisionFixture({ steps: [{ text: 'DSH answer' }] });
let resolves = 0;
const textModel = { ...fixture.textModel, currentSelection: () => ({ provider: 'fixture', model: 'vision-v0' }),
  async resolveModelInfo() { resolves++; return { provider: 'fixture', id: 'vision-v0', inputModalities: ['image'] }; } };
const host = { ports: { textModel, attachments: fixture.attachments } };
const provider = { id: 'p', type: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'private-fixture-key',
  models: [{ id: 'vision', capabilities: ['vision'] }], visionModel: 'vision' };
const image = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' };
const candidates = buildVisionModelCandidates(host, { providers: [provider] });
candidates.forEach(candidate => candidate.port.describe());
assert.equal(resolves + fixture.bridge.saves + fixture.stats.invocations, 0, '候选快照零元数据/模型/附件调用');
assert.equal(buildVisionModelCandidates({}, {})[0].port.describe().availability, 'unavailable');
const originalFetch = globalThis.fetch;
const stop = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
let calls = 0, httpImage;
globalThis.fetch = async (_url, options) => {
  calls++;
  const body = JSON.parse(options.body);
  httpImage = visionImageFromDataUrl(body.messages[0].content[1].image_url.url);
  return new Response('data: {"choices":[{"delta":{"content":"HTTP answer"}}]}\n\n' + stop + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
};
try {
  const self = await runVisionRequest(host, { providers: [provider], question: 'fixture', image });
  assert.equal(self.answer, 'HTTP answer'); assert.equal(self.via, 'selfstack');
  assert.equal(resolves, 0); assert.equal(fixture.bridge.saves, 0);
  assert.deepEqual(httpImage, image);
  globalThis.fetch = async () => { calls++; return new Response('private rejection', { status: 401 }); };
  const result = await runVisionRequest(host, { providers: [provider], question: 'fixture', image });
  assert.equal(result.answer, 'DSH answer'); assert.equal(result.model, 'vision-v0');
  assert.equal(result.errors[0].category, 'auth'); assert.equal(result.errors[0].backendId, 'p');
  assert.deepEqual(fixture.calls[0].request.image, httpImage);
  assert(!JSON.stringify(result).includes('private'));
  const controller = new AbortController(); controller.abort();
  let prepares = 0;
  const before = calls;
  await assert.rejects(runVisionRequest(host, { providers: [provider], question: 'fixture', signal: controller.signal,
    prepareImage() { prepares++; return image; } }), e => e.code === 'IRIS_MODEL_ABORTED');
  assert.equal(prepares, 0); assert.equal(calls, before);
  await assert.rejects(runVisionRequest(host, { providers: [provider], question: ' ', prepareImage() { prepares++; return image; } }), e => e.code === 'IRIS_MODEL_INPUT_INVALID');
  assert.equal(prepares, 0);
  await assert.rejects(runVisionRequest(host, { providers: [provider], question: 'fixture', prepareImage: () => new Promise(() => {}),
    budget: { ...VISION_BUDGET, timeoutMs: 30 } }), e => e.code === 'IRIS_MODEL_TIMEOUT');
  assert.equal(calls, before);
  for (const dataUrl of ['data:image/png;base64,A', 'data:text/plain;base64,YQ==', 'data:image/png;base64,YQ=A']) {
    await assert.rejects(runVisionRequest(host, { providers: [provider], question: 'fixture', dataUrl }), e => e.code === 'IRIS_MODEL_INPUT_INVALID');
  }

  // 同一供应商不同模型的切换投影必须对应实际胜出模型。
  let modelCalls = [];
  globalThis.fetch = async (_url, options) => {
    const model = JSON.parse(options.body).model; modelCalls.push(model);
    return model === 'vision' ? new Response('', { status: 429 })
      : new Response('data: {"choices":[{"delta":{"content":"success"}}]}\n\n' + stop, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const pair = await runVisionRequest({}, { providers: [provider, { ...provider, visionModel: 'other', models: [{ id: 'other', capabilities: ['vision'] }] }], question: 'fixture', image });
  assert.equal(pair.model, 'other'); assert.equal(pair.errors[0].model, 'vision');
  assert.deepEqual(modelCalls, ['vision', 'other']);

  // 真正的动作与工具共用结果语义；只写明确的 Provider 健康反馈，没有 Core/legacy Task/Artifact。
  const configured = config.upsert({ ...provider, id: undefined });
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"红色"}}]}\n\n' + stop,
    { headers: { 'Content-Type': 'text/event-stream' } });
  const file = path.join(root, 'input.png'); fs.writeFileSync(file, image.bytes);
  const look = await runAction({}, 'look', { image_path: file, question: 'fixture' });
  assert(look.text.includes('红色'));
  const tool = await iris.runVisionTool({}, { signal: new AbortController().signal }, { origin: 'relook', question: 'fixture', image });
  assert(tool.includes('重看回答') && tool.includes('红色'));
  const probe = await runAction({}, 'providers_test_model', { id: configured.id, model_id: 'vision', capability: 'vision', confirm_paid: true });
  assert(probe.passed);
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'tasks.json')), false);
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'core-v0')), false);
  assert.equal(fs.existsSync(path.join(config.irisHome(), 'artifacts.json')), false);

  const tasks = await import('../lib/tasks.js');
  const task = tasks.create({ cap: 'image', providerId: configured.id, model: 'vision', prompt: 'fixture',
    attachments: [{ attachmentId: 'legacy-fixture', file: 'legacy.png', mediaType: 'image/png' }] });
  fs.mkdirSync(tasks.outputsDir(), { recursive: true });
  fs.writeFileSync(path.join(tasks.outputsDir(), 'legacy.png'), image.bytes);
  const taskBefore = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'));
  const relook = await runAction({}, 'relook', { attachment_id: task.attachments[0].attachmentId, question: 'fixture' });
  assert(relook.text.includes('重看回答') && relook.text.includes('红色'));
  assert.deepEqual(fs.readFileSync(path.join(config.irisHome(), 'tasks.json')), taskBefore, 'GUI 重看不改任务事实');
  const preCanceled = new AbortController(); preCanceled.abort();
  await assert.rejects(runAction({}, 'relook', { attachment_id: 'unknown', question: 'fixture' }, { signal: preCanceled.signal }),
    e => e.code === 'IRIS_MODEL_ABORTED', '预取消应在任务扫描前停止');

  // 显式实测超时必须 abort 底层，不进入 Host fallback。
  let received;
  globalThis.fetch = async (_url, options) => {
    received = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const timed = await probeVisionModel(provider, 'vision', visionImageFromDataUrl(RED_TEST_IMAGE), { timeoutMs: 30 });
  assert(timed.timedOut); assert(received.aborted);
} finally { globalThis.fetch = originalFetch; }
console.log('ALL OK —— M3 单图字节一致、候选/身份/健康投影、入口预算与预取消、零 Task/Artifact、显式实测取消通过');
