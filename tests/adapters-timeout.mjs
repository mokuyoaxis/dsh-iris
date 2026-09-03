/**
 * dsh-iris 网络超时与原子落盘测试（2026-09-03 健康检查）。
 * 运行：node tests/adapters-timeout.mjs
 *
 * 背景：adapters.js 的 fetch 曾全部无超时——挂死的 TCP 连接会冻住盯守 tick
 * （MAX_WATCH_MS 只在 tick 顶部检查，await 挂起永远走不到），提交类调用则吊死工具。
 * 本测试用「只接连接不回响应」的本地服务器实证超时档位生效，并验证
 * downloadTo 原子落盘（失败不留半截产物）。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};

const adapters = await import('../lib/adapters.js');

/* 黑 hole 服务器：接受连接但永不响应（HEAD 事件也不回 body） */
const hole = http.createServer(() => { /* 故意悬挂 */ });
await new Promise((r) => hole.listen(0, '127.0.0.1', r));
const holeBase = `http://127.0.0.1:${hole.address().port}`;

/* 半截 body 服务器：回 200 头 + 一部分 body 后悬挂（模拟下载中途断流） */
const trickle = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.write(Buffer.alloc(1024, 0x42)); // 先给 1KB
  // 不 end：body 永远读不完
});
await new Promise((r) => trickle.listen(0, '127.0.0.1', r));
const trickleBase = `http://127.0.0.1:${trickle.address().port}`;

/* 正常服务器：downloadTo 成功路径 */
const good = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(Buffer.from('hello-iris'));
});
await new Promise((r) => good.listen(0, '127.0.0.1', r));
const goodBase = `http://127.0.0.1:${good.address().port}`;

const T = 300; // 测试用短超时

/* ① openAiGenerateImage：挂起服务器 → TimeoutError */
let err = null;
try { await adapters.openAiGenerateImage({ key: 'k', baseUrl: holeBase, model: 'm', prompt: 'p', timeoutMs: T }); }
catch (e) { err = e; }
assert(err && /TimeoutError|abort|timeout/i.test(String(err.name) + String(err.message)), '① 同步生成超时生效', String(err && (err.name || err.message)));

/* ② visionStream：挂起服务器 → 超时抛错（不再无限等） */
err = null;
try { await adapters.visionStream({ key: 'k', baseUrl: holeBase, prompt: 'q', imageDataUrl: 'data:image/png;base64,AAAA', timeoutMs: T }); }
catch (e) { err = e; }
assert(err && /TimeoutError|abort|timeout/i.test(String(err.name) + String(err.message)), '② 视觉流超时生效', String(err && (err.name || err.message)));

/* ③ visionStream：外部 signal 取消仍即时生效（AbortSignal.any 组合不吞取消） */
err = null;
const ac = new AbortController();
setTimeout(() => ac.abort(), 80);
try { await adapters.visionStream({ key: 'k', baseUrl: holeBase, prompt: 'q', imageDataUrl: 'data:image/png;base64,AAAA', signal: ac.signal, timeoutMs: 30000 }); }
catch (e) { err = e; }
assert(err && /AbortError|abort/i.test(String(err.name) + String(err.message)), '③ 外部取消即时传播', String(err && (err.name || err.message)));

/* ④ downloadTo：半截 body → 超时抛错且目标文件不存在（原子落盘不留半截） */
const outPath = path.join(os.tmpdir(), 'iris-dl-test-' + Date.now() + '.bin');
err = null;
try { await adapters.downloadTo(trickleBase + '/clip.mp4', outPath, { timeoutMs: T }); }
catch (e) { err = e; }
assert(err, '④a 半截下载必须报错', String(err));
assert(!fs.existsSync(outPath) && !fs.existsSync(outPath + '.tmp'), '④b 失败不留目标文件也不留 .tmp');

/* ⑤ downloadTo：成功路径落盘且无 .tmp 残留 */
const n = await adapters.downloadTo(goodBase + '/ok.bin', outPath);
assert(n === 10 && fs.readFileSync(outPath).toString() === 'hello-iris', '⑤a 成功下载内容正确');
assert(!fs.existsSync(outPath + '.tmp'), '⑤b 成功后 .tmp 已 rename 消失');
fs.rmSync(outPath, { force: true });

/* ⑥ 档位常量存在（盯守/提交/下载分层） */
assert(adapters.T_POLL === 15000 && adapters.T_SUBMIT === 30000 && adapters.T_DOWNLOAD === 120000, '⑥ 超时档位常量导出');

/* ⑦ listModels（P2 发现）：OpenAI 兼容 {data:[{id}]} 解析 + 去重 */
const modelsSrv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: [{ id: 'wan2.7-image' }, { id: 'qwen3-tts-flash' }, { id: 'wan2.7-image' }, { id: 'text-embedding-v3' }] }));
});
await new Promise((r) => modelsSrv.listen(0, '127.0.0.1', r));
const mids = await adapters.listModels({ key: 'k', baseUrl: `http://127.0.0.1:${modelsSrv.address().port}/v1` });
assert(JSON.stringify(mids) === JSON.stringify(['wan2.7-image', 'qwen3-tts-flash', 'text-embedding-v3']), '⑦ listModels 解析+去重', mids);
modelsSrv.close();

hole.close(); trickle.close(); good.close();
console.log('ALL OK —— 网络超时（生成/视觉/取消传播）+ 原子落盘 + listModels 7 组断言全部通过');
