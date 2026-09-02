/**
 * dsh-iris 视觉后端链测试（阶段 1）。
 * 运行：node tests/vision-backend.mjs
 * 覆盖 PLAN 阶段 1 验收门槛的离线部分：
 *   ① 后端组装顺序：自持栈按 provider 顺序在前，全局模型兜底在后；
 *   ② 429 → 分类 rate_limit/quota，自动降级到下一个后端；
 *   ③ 401 → 分类 auth；
 *   ④ 取消：AbortSignal 传播到视觉请求；
 *   ⑤ 双失败 → 抛人话错误且 errors 现场完整；
 *   ⑥ 单后端成功但返回空串 → 视为未成功继续降级。
 * 全部用本地假 HTTP 服务器，零网络、零费用。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

process.env.DSH_HOME = '/tmp/iris-vb-home-' + Date.now();
const irisV1 = path.join(process.env.DSH_HOME, 'iris', 'v1');
fs.mkdirSync(path.join(irisV1, 'outputs'), { recursive: true });

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

/* ---------- 三个本地服务器：429 / 401 / 正常 SSE ---------- */
function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
const rateLimit = await listen((req, res) => {
  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Requests rate limit exceeded', code: 'Throttling.RateQuota' } }));
});
const auth = await listen((req, res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Invalid API-key provided', code: 'InvalidApiKey' } }));
});
const okSrv = await listen((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"content":"来自后端 C 的回答"}}]}\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});

/* ---------- 被测模块 ---------- */
const { SelfStackVisionBackend, GlobalLlmVisionBackend, buildVisionBackends, askWithBackends } = await import('../lib/vision.js');
const adapters = await import('../lib/adapters.js');
const cap = await import('../lib/capability.js');

const pA = (base) => ({ id: 'pA', type: 'openai', baseUrl: base, apiKey: 'kA', visionModel: 'm-a' });
const pB = (base) => ({ id: 'pB', type: 'openai', baseUrl: base, apiKey: 'kB', visionModel: 'm-b' });

const globalLlm = {
  stream: async function* () {
    yield { delta: '全局兜底回答' };
  }
};
const stubCtx = (services = {}) => ({ get: (name) => services[name] });

/* ---------- ① 组装顺序 ---------- */
const backends = buildVisionBackends(stubCtx({ llm: globalLlm }), {
  providers: [pA(`http://127.0.0.1:${rateLimit.port}/v1`), pB(`http://127.0.0.1:${okSrv.port}/v1`)]
});
assert(backends.length === 3, '自持栈2 + 全局1', backends.length);
assert(backends[0] instanceof SelfStackVisionBackend && backends[1] instanceof SelfStackVisionBackend
  && backends[2] instanceof GlobalLlmVisionBackend, '顺序：自持栈在前、全局在后');
assert(backends[0].model === 'm-a' && backends[1].model === 'm-b' && backends[2].model === '全局视觉模型', 'model 透出');

/* ---------- ② 429 → 自动降级到后端 B ---------- */
const r1 = await askWithBackends(buildVisionBackends(stubCtx({ llm: globalLlm }), {
  providers: [pA(`http://127.0.0.1:${rateLimit.port}/v1`), pB(`http://127.0.0.1:${okSrv.port}/v1`)]
}), { question: 'q', imageDataUrl: 'data:image/png;base64,AAAA' });
assert(r1.answer === '来自后端 C 的回答' && r1.backendId === 'pB' && r1.via === 'selfstack', '429 后降级到 pB', JSON.stringify(r1));
assert(r1.errors.length === 1 && r1.errors[0].category === 'rate_limit', '429 分类 rate_limit', JSON.stringify(r1.errors));

/* ---------- ③ 401 → 分类 auth，继续降级到全局 ---------- */
const r2 = await askWithBackends(buildVisionBackends(stubCtx({ llm: globalLlm }), {
  providers: [pA(`http://127.0.0.1:${auth.port}/v1`)]
}), { question: 'q', ref: { attachmentId: 'x', mediaType: 'image/png' }, imageDataUrl: 'data:image/png;base64,AAAA' });
assert(r2.answer === '全局兜底回答' && r2.via === 'global', '401 降级到全局', JSON.stringify(r2));
assert(r2.errors[0].category === 'auth', '401 分类 auth', JSON.stringify(r2.errors));

/* ---------- ④ 取消：AbortSignal 已中止 → 请求被中断 ---------- */
const ac = new AbortController();
ac.abort();
const r4 = await askWithBackends(buildVisionBackends(stubCtx({ llm: globalLlm }), {
  providers: [pA(`http://127.0.0.1:${okSrv.port}/v1`)]
}), { question: 'q', imageDataUrl: 'data:image/png;base64,AAAA', signal: ac.signal });
assert(r4.answer === '全局兜底回答', '中止信号让自持栈失效后仍全局兜底', JSON.stringify(r4));

/* ---------- ⑤ 双失败 → 抛错 + errors 现场 ---------- */
let thrown = null;
try {
  await askWithBackends(buildVisionBackends(stubCtx({}), {
    providers: [pA(`http://127.0.0.1:${rateLimit.port}/v1`), pB(`http://127.0.0.1:${auth.port}/v1`)]
  }), { question: 'q', imageDataUrl: 'data:image/png;base64,AAAA' });
} catch (err) {
  thrown = err;
}
assert(thrown && /视觉模型不可用/.test(thrown.message), '双失败抛人话错误');
assert(thrown && thrown.errors && thrown.errors.length === 2
  && thrown.errors[0].category === 'rate_limit' && thrown.errors[1].category === 'auth', 'errors 现场完整', thrown && JSON.stringify(thrown.errors));

/* ---------- ⑥ 返回空串视为未成功 → 继续降级 ---------- */
const emptySrv = await listen((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: [DONE]\n\n');
});
const r6 = await askWithBackends(buildVisionBackends(stubCtx({ llm: globalLlm }), {
  providers: [pA(`http://127.0.0.1:${emptySrv.port}/v1`)]
}), { question: 'q', imageDataUrl: 'data:image/png;base64,AAAA' });
assert(r6.answer === '全局兜底回答' && r6.via === 'global', '空回答后端继续降级', JSON.stringify(r6));

/* ---------- ⑦ ProviderError 结构与网络错误分类 ---------- */
try {
  await adapters.visionStream({ key: 'k', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', prompt: 'q', imageDataUrl: 'data:image/png;base64,AA==' });
  assert(false, '连接失败应抛错');
} catch (err) {
  assert(err.name === 'ProviderError' && err.category === 'network', '网络错误分类 network', JSON.stringify(err));
}

for (const s of [rateLimit.srv, auth.srv, okSrv.srv, emptySrv.srv]) s.close();
console.log('ALL OK —— 视觉后端链 7 组断言全部通过（顺序/429降级/401鉴权/取消/双失败/空串/网络分类）');
