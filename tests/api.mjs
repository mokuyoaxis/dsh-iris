/**
 * dsh-iris /iris/api/state 离线冒烟（M4 host 侧数据层）。
 * 运行：node tests/api.mjs
 * 验证四条输出纪律：
 *   ① apiKey 永不明文（只给 hint）；② running/recent 正确分组；
 *   ③ 媒体链接为授权 URL（含 token，不含绝对路径）；④ 输出全标量可 JSON 序列化。
 * 全部用本地假数据，零网络、零费用。
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.DSH_HOME = '/tmp/iris-api-home-' + Date.now();
const irisV1 = path.join(process.env.DSH_HOME, 'iris', 'v1');
fs.mkdirSync(path.join(irisV1, 'outputs'), { recursive: true });

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : ' | ' + JSON.stringify(extra));
    process.exit(1);
  }
};

/* ---------- 假数据：一个供应商（带明文 key，必须被掩码） + 三条任务 ---------- */
fs.writeFileSync(path.join(irisV1, 'providers.json'), JSON.stringify({
  version: 1,
  providers: [{
    id: 'iris_testp',
    name: '本地测试供应商',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:9999/compatible-mode/v1',
    apiKey: 'test-api-key-that-must-never-leak-123456',
    enabled: true,
    mediaProtocol: 'dashscope',
    imageModel: 'wan2.2-t2i-flash',
    videoModel: 'wan2.2-t2v-flash',
    ttsModel: 'qwen-tts-latest',
    visionModel: 'qwen-vl-plus'
  }]
}, null, 2));

const now = new Date();
const iso = (minAgo) => new Date(now.getTime() - minAgo * 60000).toISOString();
fs.writeFileSync(path.join(irisV1, 'tasks.json'), JSON.stringify({
  version: 1,
  tasks: [
    {
      id: 't_running_1', cap: 'video', status: 'running', progress: 'RUNNING',
      model: 'wan2.2-t2v-flash', providerId: 'iris_testp', providerName: '本地测试供应商',
      prompt: 'a small pixel cottage on a hill', remoteTaskId: 'R1',
      createdAt: iso(0.2), updatedAt: iso(0.1)
    },
    {
      id: 't_done_1', cap: 'image', status: 'succeeded', saved: true,
      model: 'wan2.2-t2i-flash', providerId: 'iris_testp', providerName: '本地测试供应商',
      prompt: 'pixel art scene', files: ['t_done_1-0.png'],
      media: [{ file: 't_done_1-0.png', token: 'ab'.repeat(16), mime: 'image/png', createdAt: iso(5) }],
      createdAt: iso(5), finishedAt: iso(4)
    },
    {
      id: 't_failed_1', cap: 'tts', status: 'failed', error: '配额不足',
      model: 'qwen-tts-latest', providerId: 'iris_testp', providerName: '本地测试供应商',
      prompt: 'hello', createdAt: iso(30), finishedAt: iso(29)
    }
  ]
}, null, 2));

/* ---------- 载入被测模块 ---------- */
const { buildState } = await import('../lib/api.js');

const state = buildState();

/* ① apiKey 掩码 */
const p0 = state.providers[0];
assert(p0 && typeof p0.apiKey === 'undefined', 'apiKey 绝不出现在输出', state.providers);
assert(typeof p0.apiKeyHint === 'string' && p0.apiKeyHint.includes('****'), 'key 只给 hint', p0.apiKeyHint);
assert(!JSON.stringify(state).includes('must-never-leak'), '序列化后不得含明文 key');

/* ② 分组：running 1 条，recent 2 条（succeeded+failed） */
assert(state.tasks.running.length === 1 && state.tasks.running[0].id === 't_running_1', 'running 分组', state.tasks.running.map((t) => t.id));
assert(state.tasks.recent.length === 2, 'recent 分组（排除 running）', state.tasks.recent.map((t) => t.id));
assert(state.tasks.recentTotal === 2, 'recentTotal 计数终态总数（泡泡查看全部用）', state.tasks.recentTotal);

/* ③ 媒体链接：授权 URL 形态，且不含绝对路径 */
const done = state.tasks.recent.find((t) => t.id === 't_done_1');
const media = done && done.media && done.media[0];
assert(media && typeof media.url === 'string' && media.url.includes('/iris/media/t_done_1/'), '媒体给授权播放链接', media && media.url);
assert(media && !media.url.includes('/tmp/'), '链接不含本地绝对路径', media && media.url);
assert(media && typeof media.token === 'undefined' && typeof media.mime === 'string' && typeof media.file === 'string', '媒体条目只透 file/mime/url，token 不出 JSON', media);
assert(done && done.saved === true, 'saved 标记透传');

/* ④ 全标量可序列化 */
let roundtrip = null;
try {
  roundtrip = JSON.parse(JSON.stringify(state));
} catch (err) {
  roundtrip = null;
}
assert(roundtrip && Array.isArray(roundtrip.providers), 'state 全标量可 JSON 往返');

/* ⑤ 任务字段最小透出（不给枚举全量，只给面板需要的） */
const r0 = state.tasks.running[0];
assert(r0 && typeof r0.id === 'string' && typeof r0.cap === 'string' && typeof r0.status === 'string'
  && typeof r0.progress === 'string' && typeof r0.model === 'string' && typeof r0.prompt === 'string'
  && Array.isArray(r0.media), 'running 任务最小标量字段（media 恒为数组）');

/* ---------- ⑥ /iris/api/task/:id 详情端点（阶段 4 抽屉数据源） ---------- */
const { serveApi, closeAllSse, sseClientCount, purgeStaleUploads, UPLOAD_TTL_MS } = await import('../lib/api.js');
const tasks = await import('../lib/tasks.js');
const config = await import('../lib/config.js');
tasks.resetCache(); // 让任务注册表重新读盘（fixture 里写好的任务）
config.resetCache();

function fakeRes() {
  return { headersSent: false, status: 0, headers: null, body: null, wrote: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(data) { this.wrote = true; if (data !== undefined) this.body = data; } };
}
function hitApi(url, method = 'GET') {
  const res = fakeRes();
  serveApi({ method, url, headers: {} }, res);
  return res;
}

const r404 = hitApi('/iris/api/task/nonexist');
assert(r404.status === 404, '不存在任务 → 404', r404.status);
const r405 = hitApi('/iris/api/task/t_done_1', 'POST');
assert(r405.status === 405, '非 GET/HEAD → 405', r405.status);
const detail = hitApi('/iris/api/task/t_done_1');
assert(detail.status === 200, '详情端点 200', detail.status);
const d = JSON.parse(detail.body);
assert(d.id === 't_done_1' && d.cap === 'image' && d.status === 'succeeded', '详情基础字段');
assert(typeof d.prompt === 'string' && Array.isArray(d.media) && Array.isArray(d.files), '详情完整字段');
assert(d.media[0] && d.media[0].url && d.media[0].url.includes('/iris/media/t_done_1/'), '详情媒体链接');
assert(typeof d.remoteTaskId === 'string' && Array.isArray(d.attachments), '详情 remoteTaskId/attachments');
assert(!JSON.stringify(d).includes('must-never-leak'), '详情不含明文 key');

/* ---------- ⑦ SSE 端点（阶段 4：真实 HTTP 服务器 + 事件流验证） ---------- */
const http = await import('node:http');
const srv = http.createServer((req, res) => serveApi(req, res));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const sseUrl = `http://127.0.0.1:${port}/iris/api/state/events`;

// 7a. 连接后立即收到初始状态
function connectSse() {
  return new Promise((resolve, reject) => {
    const req = http.get(sseUrl, (res) => {
      assert(res.statusCode === 200, 'SSE 状态码 200', res.statusCode);
      assert(res.headers['content-type'] === 'text/event-stream; charset=utf-8', 'SSE Content-Type');
      let data = '';
      res.on('data', (c) => { data += c; });
      const close = () => { res.destroy(); };
      resolve({ res, close, getData: () => data });
    });
    req.on('error', reject);
  });
}
async function waitUntil(test, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}
const sse = await connectSse();
await waitUntil(() => sse.getData().includes('data: {'));
const firstData = sse.getData();
assert(firstData.includes('data: {'), 'SSE 初始消息含 data: {...}', firstData.slice(0, 50));
assert(firstData.includes('t_running_1'), '初始状态含 running 任务');
assert(firstData.includes('retry: 3000'), 'SSE 含断线重连指令');

// 7b. 触发任务变更后收到新推送
tasks.create({ cap: 'image', providerId: 'iris_testp', model: 'm', prompt: 'sse test' });
await waitUntil(() => sse.getData().includes('sse test'));
const afterCreate = sse.getData();
const secondPayload = afterCreate.slice(firstData.length);
assert(secondPayload.includes('sse test'), 'SSE 收到新任务的推送', secondPayload.slice(0, 100));

// 7c. sseClientCount 正确
assert(sseClientCount() >= 1, 'SSE 连接计数 ≥1', sseClientCount());

// 7d. closeAllSse 关闭所有连接
const beforeClose = sseClientCount();
sse.close();
closeAllSse();
await new Promise((r) => setTimeout(r, 50));
assert(sseClientCount() === 0, 'closeAllSse 后连接数为 0', sseClientCount());

// 7e. 重新连接：触发供应商变更测试
const sse2 = await connectSse();
await waitUntil(() => sse2.getData().includes('data: {'));
const afterReconnect = sse2.getData();
assert(afterReconnect.includes('data: {'), '重连后收到初始状态');
config.upsert({ id: 'sse_test', name: 'SSE Test', type: 'openai', apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9999/v1' });
await waitUntil(() => sse2.getData().includes('SSE Test'));
const afterConfig = sse2.getData().slice(afterReconnect.length);
assert(afterConfig.includes('SSE Test'), 'SSE 收到供应商变更推送', afterConfig.slice(0, 100));
// 清理配置
config.removeProvider('sse_test');
sse2.close();
closeAllSse();

// 8. 文件选择器 L2：POST /iris/api/upload 存 uploads/ 返回路径（阶段 10，服务器仍开）
const upl = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/iris/api/upload?name=cat%3Aphoto.png' }, (res) => {
    let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }));
  });
  req.on('error', () => resolve({ status: 0, json: {} }));
  req.end(Buffer.from('HELLO-IRIS-UPLOAD'));
});
assert(upl.status === 200 && upl.json.ok && upl.json.path && fs.existsSync(upl.json.path), 'upload 存盘返回真实路径', upl.json);
assert(upl.json.expiresInMs === UPLOAD_TTL_MS, 'upload 返回临时副本 TTL', upl.json.expiresInMs);
assert(fs.readFileSync(upl.json.path).toString() === 'HELLO-IRIS-UPLOAD' && /cat_photo\.png$/.test(upl.json.path), 'upload 内容一致 + 文件名安全化保留', upl.json.path);
const uplEmpty = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/iris/api/upload?name=x.png' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0)); req.end();
});
assert(uplEmpty === 400, '空上传 400', uplEmpty);
if (upl.json.path) fs.rmSync(upl.json.path, { force: true });
// 8b. 生命周期：超过 TTL 的上传副本会被清理，新文件保留
const uploads = path.join(irisV1, 'uploads');
fs.mkdirSync(uploads, { recursive: true });
const stale = path.join(uploads, 'stale.bin');
const fresh = path.join(uploads, 'fresh.bin');
fs.writeFileSync(stale, 'old'); fs.writeFileSync(fresh, 'new');
const oldTime = new Date(Date.now() - UPLOAD_TTL_MS - 60000);
fs.utimesSync(stale, oldTime, oldTime);
const purged = purgeStaleUploads();
assert(purged.deleted === 1 && !fs.existsSync(stale) && fs.existsSync(fresh), '过期上传清理且保留新文件', purged);
assert(!fs.readdirSync(uploads).some((n) => n.endsWith('.part')), '上传完成后无 .part 残留');
fs.rmSync(fresh, { force: true });

srv.close();
console.log('ALL OK —— /iris/api/state 数据层 5 项 + /iris/api/task/:id 6 项 + SSE 7 项 + 上传路由 3 项断言全部通过');