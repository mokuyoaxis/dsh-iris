/** DSH capability detection and DTO mapping; no DSH package, network, or paid request. */
import fs from 'node:fs';
import path from 'node:path';
import { createDshHostAdapter, detectDshVersion } from '../lib/dsh-host-adapter.js';
import { defineHostAdapter, hostCapabilitySnapshot } from '../lib/host-contract.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-dsh-host-adapter');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const fakeDsh = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
fs.mkdirSync(path.join(fakeDsh, 'lib'), { recursive: true });
fs.writeFileSync(path.join(fakeDsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.9' }));
const fakeEntry = path.join(fakeDsh, 'lib', 'bin.js');
fs.writeFileSync(fakeEntry, '');
assert(detectDshVersion({ entry: fakeEntry }) === '0.1.2-rc.9', '应从 DSH CLI 入口向上识别包版本');
assert(detectDshVersion({ entry: path.join(root, 'outside.js') }) === 'unknown', '非 DSH 入口应安全降级为 unknown');

const registered = { tools: [], skills: [], routes: [] };
const effects = [];
const events = [{ payload: {
  content: [
    { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', name: 'one.png' } },
    { attachmentId: 'att-1', mediaType: 'image/png' },
    { attachmentId: 'att-2', mediaType: 'image/jpeg', name: 'two.jpg' }
  ]
} }];
const services = {
  attachments: {
    async saveImage(input) { return { attachmentId: 'saved', mediaType: input.mediaType }; },
    async readImage(ref) { return { data: new Uint8Array([1, 2, 3]), mediaType: ref.mediaType }; }
  },
  browser: { async open() {}, async openUrl() {}, async screenshot() {}, async close() {} },
  webServer: { register(definition) { registered.routes.push(definition); return () => {}; } },
  sessionQuery: { async readSession(id) { return { id, events }; } },
  skills: { register(definition) { registered.skills.push(definition); return () => {}; } },
  tools: { register(definition) { registered.tools.push(definition); return () => {}; } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  llm: {
    async resolveModelInfo(provider, model) { return { provider, model }; },
    async *stream() { yield { delta: '宿主' }; yield { type: 'text-delta', text: '视觉' }; }
  }
};
const ctx = {
  tools: services.tools,
  get: (name) => services[name],
  effect(fn) { effects.push(fn()); return () => {}; }
};
const host = createDshHostAdapter(ctx, { version: '0.1.2-rc.1' });
const snapshot = hostCapabilitySnapshot(host);
for (const name of ['attachments', 'browser', 'routes', 'sessions', 'skills', 'textModel', 'tools', 'visionModel']) {
  assert(snapshot.capabilities[name].status === 'available', `${name} 应检测为 available`, snapshot.capabilities[name]);
}
assert(snapshot.capabilities.clientSlots.status === 'unavailable', 'server ctx 不应伪造 clientSlots');
assert(JSON.stringify(snapshot).includes('0.1.2-rc.1') && !JSON.stringify(snapshot).includes('currentSelection'),
  '能力快照只含版本和状态，不含 live object');

const images = await host.ports.sessions.listImageAttachments('s-1');
assert(images.length === 2 && images[0].attachmentId !== images[1].attachmentId, '会话图片应映射并去重', images);
assert((await host.ports.sessions.findImageAttachment('s-1', 'att-2')).name === 'two.jpg', '应按稳定 ID 查找图片 DTO');
assert((await host.ports.attachments.readImage(images[0])).data.length === 3, '附件读取应透传稳定 DTO');
assert(host.ports.textModel.currentSelection().model === 'm', '文本端口应给出宿主默认选择');
assert((await host.ports.textModel.resolveModelInfo('p', 'm')).model === 'm', '文本模型元数据应透传');
let text = '';
for await (const chunk of host.ports.textModel.stream({})) text += chunk.delta || chunk.text || '';
assert(text === '宿主视觉', '文本流应保持 DSH chunk');
assert(await host.ports.visionModel.analyze({ question: 'q', ref: images[0] }) === '宿主视觉', '视觉端口应收口 DSH 流形状');

host.ports.tools.register({ name: 'tool' });
host.ports.skills.register({ name: 'skill' });
host.ports.routes.register({ path: '/x' });
assert(registered.tools.length === 1 && registered.skills.length === 1 && registered.routes.length === 1,
  '注册端口应映射到对应 DSH registry', registered);
assert(effects.length === 2, '工具与 Skill 注册必须进入 DSH effect 生命周期');

const { runAction } = await import('../lib/actions.js');
const status = await runAction(host, 'status', {});
assert(status.ok, 'DSH Adapter 应可直接运行无宿主依赖动作');
let rawContextError;
try { await runAction(ctx, 'status', {}); } catch (error) { rawContextError = error; }
assert(rawContextError instanceof TypeError && /不接受原始 ctx/.test(rawContextError.message),
  'Action 必须拒绝原始 DSH ctx');
let malformedAdapterError;
try {
  await runAction({ contractVersion: 0, ports: {}, unavailable: {} }, 'status', {});
} catch (error) { malformedAdapterError = error; }
assert(malformedAdapterError instanceof TypeError && /有效的 Host Adapter/.test(malformedAdapterError.message),
  'Action 必须拒绝只伪造版本字段的不完整 Adapter');
const browserActionHost = defineHostAdapter({
  id: 'browser-action-test',
  ports: { browser: { async renderHtml() { return { bytes: new Uint8Array([1, 2]), mediaType: 'image/png' }; } } }
});
const html = await runAction(browserActionHost, 'html', { html: '<h1>x</h1>' });
assert(html.ok && html.imageDataUrl === 'data:image/png;base64,AQI=', 'HTML action 必须只消费 browser port', html);

const slotCalls = [];
const clientHost = createDshHostAdapter({
  slots: {
    inject(...args) { slotCalls.push(['inject', ...args]); },
    register(...args) { slotCalls.push(['register', ...args]); return () => {}; }
  }
});
clientHost.ports.clientSlots.inject('input', () => {});
clientHost.ports.clientSlots.register({ name: 'bubble' }, 'component');
assert(slotCalls[0][0] === 'inject' && slotCalls[1].length === 3 && slotCalls[1][2] === 'component',
  'clientSlots 必须透传 seat callback 与 definition component 双参数');

const broken = createDshHostAdapter({ get: (name) => name === 'browser' ? {} : undefined });
const brokenSnapshot = hostCapabilitySnapshot(broken);
assert(brokenSnapshot.capabilities.browser.status === 'incompatible'
  && brokenSnapshot.capabilities.attachments.status === 'unavailable', '存在但形状错误与完全缺失必须区分');

console.log('ALL OK —— DSH 8 类服务与客户端 Slot 探测、DTO 映射、模型桥接、生命周期注册和降级分类通过');
