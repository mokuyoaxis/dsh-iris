/**
 * dsh-iris 视觉路由降级链（M3 补全）离线冒烟测试。
 * 运行：node tests/vision.mjs
 * 要点：不依赖 DSH 运行时 —— 本地假 SSE 服务器模拟自持栈，
 *       stub ctx（attachments/llm/sessionQuery）逐段验证：
 *       findOwnAttachment（自家产物兜底）、sessionAttachmentRef（会话事件扫描）、
 *       askVision 降级链（自持栈 → 全局 → 双失败抛错）、runVisionTool（结果格式）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

process.env.DSH_HOME = '/tmp/iris-vision-home-' + Date.now();
const irisHome = path.join(process.env.DSH_HOME, 'iris', 'v1');
fs.mkdirSync(path.join(irisHome, 'outputs'), { recursive: true });

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
};

/* ---------- 本地假 SSE 服务器（模拟百炼 OpenAI 兼容视觉通道） ---------- */
const sseServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"content":"这是一只"}}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"像素小猫。"}}]}\n\n');
  res.write(': keep-alive 注释行\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => sseServer.listen(0, '127.0.0.1', r));
const fakePort = sseServer.address().port;

function writeProviders(patch) {
  fs.writeFileSync(path.join(irisHome, 'providers.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'iris_testp',
      name: '本地假供应商',
      type: 'openai',
      baseUrl: `http://127.0.0.1:${fakePort}/compatible-mode/v1`,
      apiKey: 'test-key',
      enabled: true,
      mediaProtocol: 'dashscope',
      ...patch
    }]
  }, null, 2));
}
writeProviders({});

/* ---------- 载入被测模块（index.js 顶层无副作用，import 即得全部导出） ---------- */
const iris = await import('../lib/index.js');
const tasks = await import('../lib/tasks.js');
const config = await import('../lib/config.js');

/* ======= ① findOwnAttachment：本插件产物兜底 ======= */
const t1 = tasks.create({
  cap: 'image', providerId: 'p1', model: 'm', prompt: 'x',
  attachments: [{ attachmentId: 'own-img', file: 'pic.png', mediaType: 'image/png' }]
});
fs.writeFileSync(path.join(tasks.outputsDir(), 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const own = iris.findOwnAttachment('own-img');
assert(own && own.ref.attachmentId === 'own-img' && own.absPath.endsWith('pic.png'), 'findOwnAttachment 命中自家产物');
assert(iris.findOwnAttachment('nope') === null, 'findOwnAttachment 未知 id 返回 null');
fs.unlinkSync(own.absPath);
assert(iris.findOwnAttachment('own-img') === null, 'findOwnAttachment 本地缓存被清 → null');

/* ======= ② sessionAttachmentRef：会话事件扫描 ======= */
const eventsFixture = [
  { seq: 1, type: 'user', payload: { message: { content: [
    { type: 'image', attachment: { attachmentId: 'sess-img', mediaType: 'image/png', bytes: 10, width: 1, height: 1, name: 'clip.png' } }
  ] } } },
  { seq: 2, type: 'tool-result', payload: { toolName: 'other_tool', content: [{ type: 'text', text: 'ok' }] } },
  { seq: 3, type: 'tool-result', payload: { toolName: 'iris_draw_image', content: [
    { type: 'text', text: '生成完成' },
    { type: 'image', attachmentId: 'iris-img', mediaType: 'image/png' } // 形态 2：引用对象本身（兜底匹配）
  ] } }
];
const fakeSessionQuery = {
  readSession: async () => ({ session: { id: 's1' }, events: eventsFixture })
};
const stubCtx = (services) => ({ get: (name) => services[name] });
const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal };

const hit1 = await iris.sessionAttachmentRef(stubCtx({ sessionQuery: fakeSessionQuery }), exec, 'sess-img');
assert(hit1 && hit1.ref.attachmentId === 'sess-img' && hit1.ref.mediaType === 'image/png', 'sessionAttachmentRef 形态1（attachment 块）命中');
const hit2 = await iris.sessionAttachmentRef(stubCtx({ sessionQuery: fakeSessionQuery }), exec, 'iris-img');
assert(hit2 && hit2.ref.attachmentId === 'iris-img', 'sessionAttachmentRef 形态2（裸 attachmentId）命中');
assert(await iris.sessionAttachmentRef(stubCtx({ sessionQuery: fakeSessionQuery }), exec, 'missing') === null, 'sessionAttachmentRef 不存在 → null');
assert(await iris.sessionAttachmentRef(stubCtx({}), exec, 'sess-img') === null, '无 sessionQuery 服务 → null');
const brokenSq = { readSession: async () => { throw new Error('boom'); } };
assert(await iris.sessionAttachmentRef(stubCtx({ sessionQuery: brokenSq }), exec, 'sess-img') === null, 'readSession 失败 → null（防御）');
const noAgent = { agent: undefined };
assert(await iris.sessionAttachmentRef(stubCtx({ sessionQuery: fakeSessionQuery }), noAgent, 'sess-img') === null, '无 agent → null（防御）');

/* ======= ③ askVision：降级链 ======= */
// a) 自持栈为主（假 SSE 服务器）
const ra = await iris.askVision(stubCtx({}), {
  question: '这是什么？', ref: { attachmentId: 'sess-img', mediaType: 'image/png' },
  dataUrl: 'data:image/png;base64,aGk=', signal: undefined
});
assert(ra.answer === '这是一只像素小猫。' && ra.via === 'selfstack' && ra.model === 'qwen-vl-plus', 'askVision 自持栈命中: ' + JSON.stringify(ra));

// b) 自持栈不可用（供应商类型不是 openai）→ 降级全局 llm
writeProviders({ type: 'anthropic' });
config.resetCache();
const fakeLlm = {
  stream: async function* () {
    yield { delta: '全局' };
    yield { delta: '视觉回答' };
  }
};
const rb = await iris.askVision(stubCtx({ llm: fakeLlm }), {
  question: '这是什么？', ref: { attachmentId: 'sess-img', mediaType: 'image/png' },
  dataUrl: 'data:image/png;base64,aGk=', signal: undefined
});
assert(rb.answer === '全局视觉回答' && rb.via === 'global', 'askVision 全局降级命中: ' + JSON.stringify(rb));

// c) 双失败 → 抛人话错误
let thrown = '';
try {
  await iris.askVision(stubCtx({}), {
    question: '这是什么？', ref: { attachmentId: 'sess-img', mediaType: 'image/png' },
    dataUrl: 'data:image/png;base64,aGk=', signal: undefined
  });
} catch (err) {
  thrown = String(err.message || err);
}
assert(/视觉模型不可用/.test(thrown), 'askVision 双失败抛错: ' + thrown);

// d) 恢复自持栈 provider（还原，供 runVisionTool 测试）
writeProviders({});
config.resetCache();

/* ======= ④ runVisionTool：look/relook 共用执行器 ======= */
const out = await iris.runVisionTool(stubCtx({}), exec, {
  origin: 'tool', model: undefined, question: '这是什么？',
  ref: { attachmentId: 'sess-img', mediaType: 'image/png' },
  dataUrl: 'data:image/png;base64,aGk='
});
assert(typeof out === 'string' && out.startsWith('[iris] 看图回答（qwen-vl-plus · iris 自持栈）') && out.includes('像素小猫'), 'runVisionTool 格式: ' + out);
const outRelook = await iris.runVisionTool(stubCtx({}), exec, {
  origin: 'relook', model: undefined, question: '再问一次？',
  ref: { attachmentId: 'sess-img', mediaType: 'image/png' },
  dataUrl: 'data:image/png;base64,aGk='
});
assert(outRelook.startsWith('[iris] 重看回答（'), 'runVisionTool relook 标签: ' + outRelook);

sseServer.close();
console.log('ALL OK —— 视觉降级链 12 项断言全部通过（自持栈/全局/双失败/会话扫描/兜底）');