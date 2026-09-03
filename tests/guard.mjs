/**
 * dsh-iris 请求守卫测试（O2，发布安全版）。
 * 运行：node tests/guard.mjs
 * 核心断言方向：**任何部署拓扑都不拦合法用户**，只挡跨站 CSRF 驱动付费 POST。
 */
import { checkRequest, guarded } from '../lib/guard.js';

const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};

/* ---------- ① 读接口全放开（跨源读受 CORS 挡，媒体有 token） ---------- */
assert(checkRequest({ method: 'GET', headers: { host: '127.0.0.1:3080' } }).ok, '①a 回环 GET 放行');
assert(checkRequest({ method: 'GET', headers: { host: 'evil.example.com' } }).ok, '①b 任意 Host 的 GET 放行（读不设限）');
assert(checkRequest({ method: 'HEAD', headers: { host: '192.168.1.5:3080' } }).ok, '①c LAN HEAD 放行');
assert(checkRequest({ method: 'GET', headers: {} }).ok, '①d 无 Host 的 GET 也放行（读不拦）');

/* ---------- ② 同源 POST 在任何 host 都放行（发布不锁死的证明） ---------- */
assert(checkRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } }).ok, '②a 回环同源 POST 放行');
assert(checkRequest({ method: 'POST', headers: { host: '192.168.1.5:3080', origin: 'http://192.168.1.5:3080' } }).ok, '②b LAN 同源 POST 放行（旧白名单会锁死）');
assert(checkRequest({ method: 'POST', headers: { host: 'dsh.example.com', origin: 'https://dsh.example.com' } }).ok, '②c 反代域名同源 POST 放行');
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
wrapped({ method: 'GET', headers: { host: 'anything.example.com' } }, r200);
assert(called === 1 && r200.status === 0, '⑤b 读请求透传 handler');
const dead = { headersSent: true, writeHead() { throw new Error('boom'); }, end() {} };
wrapped({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://evil' } }, dead);
assert(true, '⑤c 已发送头的连接静默跳过');

console.log('ALL OK —— 请求守卫（发布安全版）5 组断言全部通过：读全放开 / 同源 POST 任意 host 放行 / 跨站 CSRF 挡 / 端口敏感 / 包装器');
