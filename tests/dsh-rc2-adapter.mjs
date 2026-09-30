/** DSH rc.2 Host 边界回归；不依赖安装包，不调用真实模型。 */
import assert from 'node:assert/strict';
import { createDshHostAdapter } from '../lib/dsh-host-adapter.js';
import { hostDoctor } from '../lib/doctor.js';

const ref = { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 100, width: 8, height: 6,
  originalDimensions: { width: 80, height: 60 }, name: 'fixture.png', bearerUrl: 'private-fixture-url' };
let reads = 0;
let resolveCalls = 0;
let modelCalls = 0;
let selection = { provider: 'fixture', model: 'vision' };
let metadata = { provider: 'fixture', id: 'vision', inputModalities: ['text', 'image'] };
let resolve = async () => metadata;
let request;
let streamError = false;
let finishKind = 'stop';
const services = {
  attachments: { async saveImage() { return ref; }, async readImage(value) {
    reads++;
    assert.equal(value.bytes, 100); assert.equal(value.width, 8); assert.equal(value.height, 6);
    return { data: new Uint8Array([1]), ref: value };
  } },
  sessionQuery: { async readSession() { return { events: [{ data: { content: [{ type: 'image', attachment: ref }] } }] }; } },
  agentDefaultModel: { currentSelection: () => selection },
  llm: {
    async resolveModelInfo(provider, model, signal) { resolveCalls++; return resolve(provider, model, signal); },
    async *stream(value) {
      modelCalls++; request = value;
      yield { type: 'text-delta', index: 0, text: 'fixture answer' };
      if (streamError) yield { type: 'error', error: { message: 'private provider error' } };
      yield { type: 'finish', reason: finishKind === 'stop' ? { kind: 'stop' }
        : { kind: finishKind, failure: { message: 'private provider error' } } };
    }
  }
};
const host = createDshHostAdapter({ get: name => services[name] }, { version: '0.2.0-rc.2' });
hostDoctor(host);
assert.equal(resolveCalls, 0, 'describe/Doctor 不触发元数据网络查询');
assert.equal(modelCalls, 0);
const found = await host.ports.sessions.findImageAttachment('fixture', ref.attachmentId);
await host.ports.attachments.readImage(found);
assert.equal(reads, 1);
assert.deepEqual(found.originalDimensions, { width: 80, height: 60 });
assert(Object.isFrozen(found) && Object.isFrozen(found.originalDimensions));
assert(!Object.hasOwn(found, 'bearerUrl'));
ref.originalDimensions.width = 800;
assert.equal(found.originalDimensions.width, 80, '扫描快照不保留可变原始对象');

const signal = new AbortController().signal;
assert.equal(await host.ports.visionModel.analyze({ question: 'q', ref: found, signal }), 'fixture answer');
assert.equal(modelCalls, 1);
assert.equal(request.provider, 'fixture'); assert.equal(request.model, 'vision');
assert.equal(request.signal, signal); assert.equal(request.messages[0].content[1].attachment, found);

for (const invalid of [undefined, { provider: 'fixture', id: 'vision', inputModalities: ['text'] },
  { provider: 'other', id: 'vision', inputModalities: ['image'] },
  { provider: 'fixture', id: 'other', inputModalities: ['image'] }]) {
  metadata = invalid;
  await assert.rejects(host.ports.visionModel.analyze({ question: 'q', ref: found }), /未确认支持图片/);
  assert.equal(modelCalls, 1, '未知/无图片能力/身份漂移不进入生成');
}
selection = { provider: '', model: 'vision' };
const beforeResolve = resolveCalls;
await assert.rejects(host.ports.visionModel.analyze({ question: 'q', ref: found }), /没有明确路由/);
assert.equal(resolveCalls, beforeResolve);
selection = { provider: 'fixture', model: 'vision' };
metadata = { provider: 'fixture', id: 'vision', inputModalities: ['image'] };
const canceled = new AbortController(); canceled.abort(new Error('fixture canceled'));
await assert.rejects(host.ports.visionModel.analyze({ question: 'q', ref: found, signal: canceled.signal }), /fixture canceled/);
assert.equal(resolveCalls, beforeResolve, '预取消在元数据查询前退出');
const duringMetadata = new AbortController();
resolve = async () => { duringMetadata.abort(new Error('metadata canceled')); return metadata; };
await assert.rejects(host.ports.visionModel.analyze({ question: 'q', ref: found, signal: duringMetadata.signal }), /metadata canceled/);
assert.equal(modelCalls, 1, '元数据阶段取消后不调用生成');
resolve = async () => metadata;
streamError = true;
await assert.rejects(host.ports.visionModel.analyze({ question: 'q', ref: found }), error =>
  /DSH 视觉调用失败/.test(error.message) && !error.message.includes('private provider error'));
streamError = false;
for (const kind of ['error', 'aborted']) {
  finishKind = kind;
  await assert.rejects(host.ports.visionModel.analyze({ question: 'q', ref: found }), error =>
    /DSH 视觉调用(?:失败|已取消)/.test(error.message) && !error.message.includes('private provider error'),
  'rc.2 失败/取消终态不能返回已收到的部分文本');
}
const missing = createDshHostAdapter({ get: name => name === 'llm' ? services.llm : undefined }, { version: '0.2.0-rc.2' });
assert(!missing.ports.visionModel && missing.unavailable.visionModel.kind === 'unavailable');

console.log('ALL OK —— rc.2 附件完整引用、精确视觉路由、图片能力确认、取消与宿主错误边界通过');
