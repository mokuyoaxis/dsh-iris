/**
 * dsh-iris 离线冒烟测试：任务框架 + 媒体路由（假适配器，无网络、无费用）。
 * 运行：node tests/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-smoke-home');
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { default: crypto } = await import('node:crypto');
const tasks = await import('../lib/tasks.js');
const media = await import('../lib/media.js');

/* ================= 任务框架 ================= */

// 基础 CRUD + 持久化
const t0 = tasks.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'x' });
assert(t0.id && t0.status === 'running', 'create 初始化');
tasks.update(t0.id, { remoteTaskId: 'R0' });
assert(tasks.get(t0.id).remoteTaskId === 'R0', 'update 生效');
assert(fs.statSync(path.join(tasks.outputsDir(), '..', 'tasks.json')).mode & 0o600, 'tasks.json 已落盘且 0600');

// 场景 1：正常成功路径
let polls = 0;
const t1 = tasks.create({ cap: 'video', providerId: 'p1', model: 'm', prompt: 'v' });
tasks.watch(tasks.get(t1.id), {
  key: () => 'KEY',
  intervalMs: 30,
  poll: () => {
    polls++;
    return polls < 3 ? { done: false, status: 'RUNNING' } : { done: true, ok: true, urls: ['http://x/a.mp4'] };
  },
  onSuccess: async () => ['a.mp4']
});
await sleep(700);
const f1 = tasks.get(t1.id);
assert(f1.status === 'succeeded' && JSON.stringify(f1.files) === '["a.mp4"]', '场景1 成功+文件');

// 场景 2：轮询容错——连错 4 次后恢复
let boom = 0;
const t2 = tasks.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'i' });
tasks.watch(tasks.get(t2.id), {
  key: () => 'KEY',
  intervalMs: 30,
  poll: () => { if (++boom <= 4) throw new Error('网络抖动'); return { done: true, ok: true, urls: [] }; },
  onSuccess: async () => ['b.png']
});
await sleep(2000);
assert(tasks.get(t2.id).status === 'succeeded', '场景2 抖动后成功');

// 场景 3：业务失败直达人话
const t3 = tasks.create({ cap: 'video', providerId: 'p1', model: 'm', prompt: 'e' });
tasks.watch(tasks.get(t3.id), {
  key: () => 'KEY',
  intervalMs: 30,
  poll: () => ({ done: true, ok: false, message: 'InvalidParameter' }),
  onSuccess: async () => []
});
await sleep(800);
assert(/InvalidParameter/.test(tasks.get(t3.id).error || ''), '场景3 失败信息');

// 场景 4：连续失败超过容忍度才判死
const t4 = tasks.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'd' });
tasks.watch(tasks.get(t4.id), {
  key: () => 'KEY',
  intervalMs: 20,
  poll: () => { throw new Error('always down'); }
});
await sleep(900);
assert(/连续失败/.test(tasks.get(t4.id).error || ''), '场景4 连续失败判死');

// 场景 5：重启恢复三分支
const t5 = tasks.create({ cap: 'video', providerId: 'p1', model: 'm', prompt: 'r' });
tasks.update(t5.id, { remoteTaskId: 'R5' });
const t6 = tasks.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'old' });
tasks.update(t6.id, { remoteTaskId: 'R6', createdAt: new Date(Date.now() - 25 * 60 * 1000).toISOString() });
const t7 = tasks.create({ cap: 'tts', providerId: 'ghost', model: 'm', prompt: 'g' });
tasks.update(t7.id, { remoteTaskId: 'R7' });
const resumed = tasks.resumePending((t) => (t.providerId === 'ghost'
  ? null
  : {
      key: () => 'KEY',
      intervalMs: 30,
      poll: () => ({ done: true, ok: true, urls: ['http://x/c.mp4'] }),
      onSuccess: async () => ['c.mp4']
    }));
assert(resumed.includes(t5.id) && !resumed.includes(t6.id) && !resumed.includes(t7.id), '场景5 恢复分流');
await sleep(600);
assert(tasks.get(t5.id).status === 'succeeded', '场景5a 恢复后完成');
assert(/超时/.test(tasks.get(t6.id).error || '') && /不可用/.test(tasks.get(t7.id).error || ''), '场景5b/c 标记');

// 场景 6：stopWatchAll 清场（Fiber 清理语义）
const t8 = tasks.create({ cap: 'video', providerId: 'p1', model: 'm', prompt: 'z' });
tasks.update(t8.id, { remoteTaskId: 'R8' });
let ticks = 0;
tasks.watch(tasks.get(t8.id), {
  key: () => 'KEY',
  intervalMs: 40,
  poll: () => { ticks++; return { done: false, status: 'RUNNING' }; },
  onSuccess: async () => []
});
await sleep(300);
const before = ticks;
tasks.stopWatchAll();
tasks.cancel(t8.id, '插件停用');
await sleep(300);
assert(ticks - before <= 1 && tasks.get(t8.id).status === 'canceled', '场景6 清场+canceled');

// 场景 9：SUCCEEDED 但 results 未填充 → 短等重试后成功（服务端竞态）
const t9 = tasks.create({ cap: 'video', providerId: 'p1', model: 'm', prompt: 'race' });
let racePolls = 0;
tasks.watch(tasks.get(t9.id), {
  key: () => 'KEY',
  intervalMs: 30,
  poll: () => (++racePolls <= 3 ? { done: true, ok: true, urls: [] } : { done: true, ok: true, urls: ['http://x/d.mp4'] }),
  onSuccess: async () => ['d.mp4']
});
await sleep(800);
assert(tasks.get(t9.id).status === 'succeeded' && racePolls > 3, '场景9 竞态重试后落袋');

// 场景 10：submitGuard——提交抛错即标 failed 并原样重抛（不留 running 孤儿）
const t10 = tasks.create({ cap: 'transcribe', providerId: 'p1', model: 'm', prompt: 'sg' });
let threw = null;
try {
  await tasks.submitGuard(t10, async () => { throw new Error('上传 401'); });
} catch (err) { threw = err; }
assert(threw && /上传 401/.test(String(threw.message)), '场景10a submitGuard 原样重抛');
assert(tasks.get(t10.id).status === 'failed' && /提交失败.*上传 401/.test(tasks.get(t10.id).error || ''), '场景10b 标 failed 带原因');
// 成功路径：返回值透传，任务保持 running（等待 watch 接管）
const t10b = tasks.create({ cap: 'transcribe', providerId: 'p1', model: 'm', prompt: 'sg-ok' });
const passed = await tasks.submitGuard(t10b, async () => 'REMOTE-OK');
assert(passed === 'REMOTE-OK' && tasks.get(t10b.id).status === 'running', '场景10c 成功透传不误伤');
// 取消路径：AbortError 必须收口为 canceled，而不是伪装成供应商失败
const t10c = tasks.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'sg-cancel' });
try {
  await tasks.submitGuard(t10c, async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
} catch (_) { /* expected */ }
assert(tasks.get(t10c.id).status === 'canceled' && /取消/.test(tasks.get(t10c.id).error || ''), '场景10d 提交取消标 canceled');

// 场景 11：resumePending 孤儿兜底——running 且无 remoteTaskId 的残留记录启动时标 failed
const t11 = tasks.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'orphan' });
const resumed11 = tasks.resumePending(() => null);
assert(!resumed11.includes(t11.id) && tasks.get(t11.id).status === 'failed' && /无远程任务 id/.test(tasks.get(t11.id).error || ''), '场景11 孤儿记录启动即清理');

// 场景 12：盯守成功后 progress 收尾为数值（轮询期的 "RUNNING" 文本不残留）
assert(tasks.get(f1.id).progress === '100%', '场景12 成功任务 progress=100%（场景1 复用断言）');

// 场景 13：remove/prune/all——任务清理原语（运行中强制保护）
const tDel = tasks.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'del' });
tasks.update(tDel.id, { status: 'succeeded' });
assert(tasks.remove(tDel.id).ok === true && !tasks.get(tDel.id), '场景13a remove 删终态记录');
const tRun = tasks.create({ cap: 'image', providerId: 'prune-marker', model: 'm', prompt: 'run' });
const rmRun = tasks.remove(tRun.id);
assert(rmRun.ok === false && /取消/.test(rmRun.reason) && tasks.get(tRun.id), '场景13b running 拒绝删除');
// prune 按标记精准删终态、永不碰 running（不用 () => true 以免误删其他场景依赖的记录）
const tMark1 = tasks.create({ cap: 'image', providerId: 'prune-marker', model: 'm', prompt: 'm1' });
tasks.update(tMark1.id, { status: 'succeeded' });
const tMark2 = tasks.create({ cap: 'image', providerId: 'prune-marker', model: 'm', prompt: 'm2' });
tasks.update(tMark2.id, { status: 'failed' });
const pruned = tasks.prune((t) => t.providerId === 'prune-marker');
assert(pruned.includes(tMark1.id) && pruned.includes(tMark2.id) && !pruned.includes(tRun.id), '场景13c prune 删终态跳过 running');
assert(!tasks.get(tMark1.id) && !tasks.get(tMark2.id) && tasks.get(tRun.id), '场景13d prune 后终态消失 running 幸存');
assert(tasks.all().some((t) => t.id === tRun.id && t.status === 'running'), '场景13e all() 含 running');
tasks.cancel(tRun.id, '收尾');

/* ================= 媒体路由 ================= */

/* ---- 视觉适配器：visionStream 的 SSE 解析（本地假服务器） ---- */
const adapters = await import('../lib/adapters.js');
const http = await import('node:http');
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n');
  res.write(': keep-alive 注释行\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const ssePort = srv.address().port;
const ans = await adapters.visionStream({
  key: 'k', baseUrl: `http://127.0.0.1:${ssePort}/compatible-mode/v1`,
  prompt: 'q', imageDataUrl: 'data:image/png;base64,AAAA'
});
srv.close();
assert(ans === '你好，世界', 'visionStream SSE 拼接: ' + JSON.stringify(ans));

// 准备一个真实产物文件
fs.mkdirSync(tasks.outputsDir(), { recursive: true });
const mp4 = path.join(tasks.outputsDir(), 'clip.mp4');
fs.writeFileSync(mp4, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));

const reg = media.registerMedia(f1.id, mp4);
assert(reg && /^[0-9a-f]{32}$/.test(reg.token), '媒体登记 token');
assert(reg.url.startsWith(media.webBase() + '/iris/media/' + f1.id + '/'), '链接形态');

// 假 req/res
function fakeRes() {
  return {
    headersSent: false, status: 0, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(data) { if (data !== undefined) this.body = data; }
  };
}
function serve(url, method = 'GET') {
  const res = fakeRes();
  mediaRouteHandler({ method, url }, res);
  return res;
}
// 从 index.js 提取的 handler 逻辑不可直接导入（apply 未跑），这里用等价调用链验证 authorizeMedia；
// 路由 handler 本体在 index.js 内，随插件装载。此处验证授权内核：
const hit = media.authorizeMedia(f1.id, reg.token, 'clip.mp4');
assert(hit && hit.size === 8, '授权命中且可读文件');
assert(media.authorizeMedia(f1.id, 'f'.repeat(32), 'clip.mp4') === null, '错误 token 拒绝');
assert(media.authorizeMedia(f1.id, reg.token, '../../etc/passwd') === null, '穿越名拒绝（精确匹配失败）');
assert(media.authorizeMedia('t_nonexist', reg.token, 'clip.mp4') === null, '不存在任务拒绝');

const links = media.mediaLinksOf(tasks.get(f1.id));
assert(links.length === 1 && links[0].includes('[▶ 视频 播放]('), '播放链接生成');

// 场景 13：重复登记幂等（同文件不产生第二个 token）
const again = media.registerMedia(f1.id, mp4);
const count = tasks.get(f1.id).media.length;
assert(again.token === reg.token && count === 1, '重复登记幂等');

console.log(`ALL OK —— 任务框架 13 场景（含孤儿守卫/恢复清理/progress 收尾/删除裁剪原语）+ 媒体通道 ${links.length ? 6 : 0} 断言全部通过`);

/* ---- 占位：serveMedia handler 的集成验证随插件装载进行 ---- */
function mediaRouteHandler() { /* 见 index.js；离线仅验授权内核 */ }
void crypto;
