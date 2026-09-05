/**
 * dsh-iris 媒体通道 HTTP 级测试（阶段 0）：Range / HEAD / 大文件流式 / 授权。
 * 运行：node tests/media.mjs
 * 用真实本地 HTTP 服务器 + 真实任务/媒体状态，验证 serveMedia：
 *   ① parseRange 单元：单段 / 后缀 / 越界 416 / 不可解析回退全量；
 *   ② GET 全量流式返回 200 + Content-Length + Accept-Ranges；
 *   ③ GET 单段 Range → 206 + Content-Range + 只返回该段字节；
 *   ④ GET 后缀 Range（bytes=-N）；
 *   ⑤ HEAD 全量/单段（206 HEAD 无 body）；
 *   ⑥ 越界 Range → 416 + `Content-Range: bytes *-of-size`；
 *   ⑦ 无效 token → 404；路径穿越名 → 404（精确匹配拒绝）；
 *   ⑧ 方法限制：POST → 405。
 * 零网络、零费用。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-media-home');

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

const tasks = await import('../lib/tasks.js');
const media = await import('../lib/media.js');

/* ---------- ① parseRange 单元 ---------- */
const pr = media.parseRange;
assert(pr('bytes=0-99', 100) && pr('bytes=0-99', 100).start === 0 && pr('bytes=0-99', 100).end === 99, 'parseRange 闭区间');
assert(pr('bytes=10-', 100).start === 10 && pr('bytes=10-', 100).end === 99, 'parseRange 开右端');
assert(pr('bytes=-20', 100).start === 80 && pr('bytes=-20', 100).end === 99, 'parseRange 后缀');
assert(pr('bytes=-20', 10).start === 0 && pr('bytes=-20', 10).end === 9, 'parseRange 后缀超长截断');
assert(pr('bytes=100-', 100).invalid === true, 'parseRange 越界标记 416');
assert(pr('bytes=5-2', 100) === null, 'parseRange start>end → null 回退全量');
assert(pr('bytes=0-99,100-199', 200) === null, 'parseRange 多段不支持 → 回退全量');
assert(pr('', 100) === null && pr(undefined, 100) === null, 'parseRange 无头 → 回退全量');
assert(pr('garbage', 100) === null, 'parseRange 非法头 → 回退全量');

/* ---------- 准备真实任务 + 产物（用 1MB 大文件验证流式不整读） ---------- */
fs.mkdirSync(tasks.outputsDir(), { recursive: true });
const SIZE = 1024 * 1024 + 37; // 非整数 MB，方便验证
const big = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) big[i] = i % 251;
const bigPath = path.join(tasks.outputsDir(), 'big.mp4');
fs.writeFileSync(bigPath, big);

const t = tasks.create({ cap: 'video', providerId: 'p1', model: 'm', prompt: 'big' });
const reg = media.registerMedia(t.id, bigPath);
assert(reg && reg.token, '媒体登记');

/* ---------- 真实 HTTP 服务器挂 serveMedia ---------- */
const srv = http.createServer((req, res) => media.serveMedia(req, res));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const base = `http://127.0.0.1:${port}/iris/media/${t.id}/${reg.token}/big.mp4`;

function req(url, opts = {}) {
  return new Promise((resolve) => {
    const r = http.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', (e) => resolve({ error: e.message }));
    r.end();
  });
}

/* ② GET 全量：200 + 长度 + Accept-Ranges + 字节完整 */
let r = await req(base);
assert(r.status === 200, 'GET 全量 200', r.status);
assert(Number(r.headers['content-length']) === SIZE, 'GET 全量 Content-Length', r.headers['content-length']);
assert(r.headers['accept-ranges'] === 'bytes', 'GET 全量 Accept-Ranges');
assert(r.body.length === SIZE && r.body.equals(big), 'GET 全量字节完整');

/* ③ GET 单段 Range：206 + Content-Range + 只返回该段 */
r = await req(base, { headers: { Range: 'bytes=100-199' } });
assert(r.status === 206, 'Range 206', r.status);
assert(r.headers['content-range'] === `bytes 100-199/${SIZE}`, 'Range Content-Range', r.headers['content-range']);
assert(r.body.length === 100 && r.body.equals(big.slice(100, 200)), 'Range 只返回该段字节');

/* ④ GET 后缀 Range */
r = await req(base, { headers: { Range: 'bytes=-200' } });
assert(r.status === 206 && r.body.length === 200 && r.body.equals(big.slice(SIZE - 200)), '后缀 Range 200 字节');

/* ⑤ HEAD 全量与单段：无 body，状态正确 */
r = await req(base, { method: 'HEAD' });
assert(r.status === 200 && r.body.length === 0 && Number(r.headers['content-length']) === SIZE, 'HEAD 全量无 body');
r = await req(base, { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
assert(r.status === 206 && r.body.length === 0 && r.headers['content-range'] === `bytes 0-9/${SIZE}`, 'HEAD 单段 206 无 body');

/* ⑥ 越界 Range → 416 */
r = await req(base, { headers: { Range: `bytes=${SIZE}-` } });
assert(r.status === 416 && r.headers['content-range'] === `bytes */${SIZE}`, '越界 416');

/* ⑦ 无效 token / 穿越名 → 404（精确匹配，不给枚举线索） */
r = await req(`http://127.0.0.1:${port}/iris/media/${t.id}/${'f'.repeat(32)}/big.mp4`);
assert(r.status === 404, '无效 token 404', r.status);
r = await req(`http://127.0.0.1:${port}/iris/media/${t.id}/${reg.token}/..%2f..%2fetc%2fpasswd`);
assert(r.status === 404, '穿越名 404');
r = await req(`http://127.0.0.1:${port}/iris/media/nonexist/${reg.token}/big.mp4`);
assert(r.status === 404, '不存在任务 404');

/* ⑧ POST → 405 */
r = await req(base, { method: 'POST' });
assert(r.status === 405, 'POST 405', r.status);

srv.close();
console.log('ALL OK —— 媒体 Range/流式/授权 9 组断言全部通过（单段/后缀/416/HEAD/404/405/大文件）');
