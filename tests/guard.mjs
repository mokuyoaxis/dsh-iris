/**
 * dsh-iris 请求守卫测试（O2 授权边界）。
 * 运行：node tests/guard.mjs
 * 覆盖：Host 白名单（回环 + DSH_WEB_BASE）、DNS 重绑定拒绝、
 *       POST Origin/Sec-Fetch-Site 策略、非浏览器本机客户端放行、guarded 包装器。
 * 纯函数 + 假 res，零网络。
 */
import { checkRequest, guarded, allowedHosts } from '../lib/guard.js';

const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};

/* ---------- ① Host 白名单 ---------- */
assert(checkRequest({ method: 'GET', headers: { host: '127.0.0.1:3080' } }).ok, '①a 回环 GET 放行');
assert(checkRequest({ method: 'GET', headers: { host: 'localhost:3080' } }).ok, '①b localhost 放行');
assert(checkRequest({ method: 'GET', headers: { host: '[::1]:3080' } }).ok, '①c IPv6 回环放行');
const rebind = checkRequest({ method: 'GET', headers: { host: 'evil.example.com' } });
assert(!rebind.ok && rebind.status === 403, '①d DNS 重绑定 Host 拒绝', rebind);
assert(!checkRequest({ method: 'GET', headers: {} }).ok, '①e 缺 Host 拒绝');
assert(!checkRequest({ method: 'GET', headers: { host: '0.0.0.0:3080' } }).ok, '①f 非白名单主机拒绝');

/* ---------- ② POST 跨站策略 ---------- */
const csrf = checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example.com' } });
assert(!csrf.ok && csrf.status === 403, '②a 跨站 Origin POST 拒绝（驱动式 CSRF）', csrf);
const sfs = checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } });
assert(!sfs.ok && /cross-site/.test(sfs.error), '②b Sec-Fetch-Site cross-site 拒绝');
const sfsSameSite = checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-site' } });
assert(!sfsSameSite.ok, '②c same-site（子域发起）也拒绝——iris 只信精确同源');
assert(checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } }).ok, '②d 同源 POST 放行');
assert(checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080' } }).ok, '②e 无 Origin 的本机 CLI/curl 放行（受 Host 关约束）');
const badOrigin = checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'not-a-url' } });
assert(!badOrigin.ok && /bad origin/.test(badOrigin.error), '②f 非法 Origin 拒绝');

/* ---------- ③ DSH_WEB_BASE 扩展白名单（反代/远程部署） ---------- */
const saved = process.env.DSH_WEB_BASE;
process.env.DSH_WEB_BASE = 'http://iris.lan:3080';
assert(allowedHosts().has('iris.lan'), '③a DSH_WEB_BASE 主机进入白名单');
assert(checkRequest({ method: 'GET', headers: { host: 'iris.lan:3080' } }).ok, '③b 声明基址放行');
assert(!checkRequest({ method: 'GET', headers: { host: 'other.lan:3080' } }).ok, '③c 未声明主机仍拒绝');
assert(checkRequest({ method: 'POST', headers: { host: 'iris.lan:3080', origin: 'http://iris.lan:3080' } }).ok, '③d 声明基址的同源 POST 放行');
if (saved === undefined) delete process.env.DSH_WEB_BASE; else process.env.DSH_WEB_BASE = saved;
assert(!allowedHosts().has('iris.lan'), '③e 还原后扩展主机移除');

/* ---------- ④ guarded 包装器 ---------- */
function fakeRes() {
  return { headersSent: false, status: 0, body: null, writeHead(s, h) { this.status = s; this.headersSent = true; }, end(d) { this.body = d; } };
}
let called = 0;
const wrapped = guarded(() => { called++; });
const r403 = fakeRes();
wrapped({ method: 'POST', headers: { host: 'evil.example.com' } }, r403);
assert(r403.status === 403 && called === 0 && JSON.parse(r403.body).error, '④a 未授权请求 403 JSON 且不进 handler');
const r200 = fakeRes();
wrapped({ method: 'GET', headers: { host: '127.0.0.1:3080' } }, r200);
assert(called === 1 && r200.status === 0, '④b 授权请求透传 handler');
// 已死连接不抛错
const dead = { headersSent: true, writeHead() { throw new Error('boom'); }, end() {} };
wrapped({ method: 'GET', headers: { host: 'evil' } }, dead);
assert(true, '④c 已发送头的连接静默跳过');

console.log('ALL OK —— 请求守卫 4 组断言全部通过（Host 白名单/重绑定/CSRF 策略/DSH_WEB_BASE/包装器）');
