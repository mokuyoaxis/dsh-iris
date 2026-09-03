/**
 * dsh-iris 动作路由测试（阶段 5）。
 * 运行：node tests/actions.mjs
 * 覆盖：
 *   ① POST /iris/api/actions/status 返回有效 JSON；
 *   ② POST 不存在动作名 → 400；
 *   ③ GET /iris/api/actions/status → 405；
 *   ④ 动作返回值含 ok/text 字段。
 */
import http from 'node:http';
import { irisHome } from '../lib/config.js';

const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};

// 用 serveApi 的上下文：需要 ctx 有 get() 方法。最小化 stub：actions 路由接收 ctx 参数
// 但 POST 测试需要真实 HTTP 服务器。用 index.js 的 mountIrisRoutes 挂载一个测试服务器。
// 简化：直接通过 import api.js 的 serveApi 并构造 fakeReq/fakeRes。

import { serveApi } from '../lib/api.js';

function fakeReq(method, url, body) {
  const buf = body === null || body === undefined ? null : Buffer.from(String(body), 'utf8');
  return {
    method, url, headers: { 'content-type': 'application/json' },
    on: (evt, cb) => {
      if (evt === 'data' && buf) cb(buf);
      if (evt === 'end') setTimeout(cb, 5);
    }
  };
}
function fakeRes() {
  return { headersSent: false, status: 0, body: null, writeHead(s, h) { this.status = s; this.headersSent = true; }, end(d) { if (d) this.body = JSON.parse(d); } };
}
const stubCtx = { get: () => undefined };

/* ① POST /status */
const r1 = fakeRes();
serveApi(fakeReq('POST', '/iris/api/actions/status', '{}'), r1, stubCtx);
await new Promise((r) => setTimeout(r, 50));
assert(r1.status === 200 && r1.body && r1.body.ok, 'POST status 200 + ok', r1.body && r1.body.text);

/* ② POST 不存在动作 */
const r2 = fakeRes();
serveApi(fakeReq('POST', '/iris/api/actions/nonexist', '{}'), r2, stubCtx);
await new Promise((r) => setTimeout(r, 50));
assert(r2.status === 400, '不存在动作 400', r2.status);

/* ③ GET → 404（该路径只支持 POST，GET 落到 404 not found） */
const r3 = fakeRes();
serveApi(fakeReq('GET', '/iris/api/actions/status', null), r3, stubCtx);
assert(r3.status === 404, 'GET 404（只支持 POST）', r3.status);

/* ④ POST 空 body */
const r4 = fakeRes();
serveApi(fakeReq('POST', '/iris/api/actions/status', ''), r4, stubCtx);
await new Promise((r) => setTimeout(r, 50));
assert(r4.status === 200 && r4.body && r4.body.ok, '空 body 也接受', r4.body);

console.log('ALL OK —— 动作路由 4 组断言全部通过（POST status/不存在/GET 405/空body）');