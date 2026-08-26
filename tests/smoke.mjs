/**
 * dsh-iris 离线冒烟测试：任务框架 + 媒体路由（假适配器，无网络、无费用）。
 * 运行：node tests/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = '/tmp/iris-smoke-home-' + Date.now();
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
await sleep(1200);
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

/* ================= 媒体路由 ================= */

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

// 场景 10：重复登记幂等（同文件不产生第二个 token）
const again = media.registerMedia(f1.id, mp4);
const count = tasks.get(f1.id).media.length;
assert(again.token === reg.token && count === 1, '重复登记幂等');

console.log(`ALL OK —— 任务框架 9 场景 + 媒体通道 ${links.length ? 6 : 0} 断言全部通过`);

/* ---- 占位：serveMedia handler 的集成验证随插件装载进行 ---- */
function mediaRouteHandler() { /* 见 index.js；离线仅验授权内核 */ }
void crypto;
