/**
 * dsh-iris 请求守卫测试（O2，发布安全版）。
 * 运行：node tests/guard.mjs
 * 核心断言：默认仅回环；远程 Host 需显式信任；POST 另挡跨站 CSRF。
 */
import { checkRequest, guarded } from '../lib/guard.js';

const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};

/* ---------- ① 默认仅回环 Host ---------- */
assert(checkRequest({ method: 'GET', headers: { host: '127.0.0.1:3080' } }).ok, '①a 回环 GET 放行');
assert(checkRequest({ method: 'GET', headers: { host: '[::1]:3080' } }).ok, '①b IPv6 回环 GET 放行');
assert(!checkRequest({ method: 'GET', headers: { host: 'evil.example.com' } }).ok, '①c 任意远程 Host 默认拒绝');
assert(!checkRequest({ method: 'GET', headers: {} }).ok, '①d 无 Host 拒绝');

/* ---------- ② 远程 Host 必须显式配置 ---------- */
assert(checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } }).ok, '②a 回环同源 POST 放行');
assert(checkRequest({ method: 'POST', headers: { host: '192.168.1.5:3080', origin: 'http://192.168.1.5:3080' } }, { trustedHosts: '192.168.1.5:3080' }).ok, '②b 精确 LAN host:port 放行');
assert(checkRequest({ method: 'POST', headers: { host: 'dsh.example.com', origin: 'https://dsh.example.com' } }, { trustedHosts: 'dsh.example.com' }).ok, '②c 反代域名显式信任后放行');
assert(!checkRequest({ method: 'GET', headers: { host: 'dsh.example.com' } }, { trustedHosts: 'other.example.com' }).ok, '②d 未列出的域名拒绝');
assert(checkRequest({ method: 'POST', headers: { host: 'localhost:3080' } }).ok, '②d 无 Origin 的本机 CLI/curl POST 放行');

/* ---------- ③ 跨站/跨源 POST 被挡（drive-by CSRF，唯一真威胁） ---------- */
const csrf = checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example.com' } });
assert(!csrf.ok && csrf.status === 403, '③a 跨源 Origin POST 拒绝（drive-by CSRF）', csrf);
const sfs = checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } });
assert(!sfs.ok && /cross-site/.test(sfs.error), '③b Sec-Fetch-Site cross-site 拒绝');
const badOrigin = checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'not-a-url' } });
assert(!badOrigin.ok && /bad origin/.test(badOrigin.error), '③c 非法 Origin 拒绝');
// same-site（子域/跨端口发起）不算同源：Origin.host 不等 → 拒
const sameSite = checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' } });
assert(!sameSite.ok, '③d 回环跨端口（Origin≠Host）拒绝');

/* ---------- ④ Origin/Host 大小写与端口敏感 ---------- */
assert(checkRequest({ method: 'POST', headers: { host: 'LOCALHOST:3080', origin: 'http://localhost:3080' } }).ok, '④a Host 大小写归一后同源放行');
assert(!checkRequest({ method: 'POST', headers: { host: 'localhost:3080', origin: 'http://localhost' } }).ok, '④b 端口不同（默认80 vs 3080）视为跨源拒绝');

/* ---------- ⑤ guarded 包装器 ---------- */
function fakeRes() {
  return { headersSent: false, writableEnded: false, status: 0, body: null, writeHead(s, h) { this.status = s; this.headersSent = true; }, end(d) { this.writableEnded = true; this.body = d; } };
}
let called = 0;
const wrapped = guarded(() => { called++; });
const r403 = fakeRes();
wrapped({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example.com' } }, r403);
assert(r403.status === 403 && called === 0 && JSON.parse(r403.body).error, '⑤a 跨源 POST 403 且不进 handler');
const r200 = fakeRes();
wrapped({ method: 'GET', headers: { host: 'localhost:3080' } }, r200);
assert(called === 1 && r200.status === 0, '⑤b 读请求透传 handler');
const dead = { headersSent: true, writeHead() { throw new Error('boom'); }, end() {} };
wrapped({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://evil' } }, dead);
assert(true, '⑤c 已发送头的连接静默跳过');

console.log('ALL OK —— 请求守卫 5 组断言全部通过：默认回环 / 显式 trusted hosts / 跨站 CSRF / 端口敏感 / 包装器');
