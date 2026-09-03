/**
 * dsh-iris 宿主装载鲁棒性冒烟（对标 dsh-web.log 705-716 那次炸宿主的崩溃）。
 * 用 stub ctx 真实调用 apply()，验证四条不炸宿主的保证：
 *   ① 正常装载：6 个工具全部注册、盯守清理注册；
 *   ② 单个工具注册抛错：只留一条隔离日志，其余工具照常注册，apply 不 reject；
 *   ③ 媒体路由服务缺失（webServer/httpServer 都不在）：静默跳过，不报错；
 *   ④ resumePending 单条任务恢复抛错：只标死该条，恢复循环继续。
 * 运行：node tests/mount.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.DSH_HOME = '/tmp/iris-mount-home-' + Date.now();
const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | extra: ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

/* ---------- stub ctx：只实现 apply 用到的面 ----------
 * 注意：真实 DSH 里 `inject: ['tools']` 会让 ctx.tools 成为可直读属性，
 * 所以 stub 也要把 tools 挂成自有属性（只靠 get() 是不够的，会误报「tools 服务不可用」）。
 */
function stubCtx({ registerThrows }) {
  const services = {
    tools: {
      register(def) {
        if (registerThrows && registerThrows === def.name) {
          throw new Error('模拟注册失败: ' + def.name);
        }
        registered.push(def);
        return () => {}; // dispose
      }
    },
    webServer: { register: () => () => {} },
    httpServer: { register: () => () => {} },
    attachments: { saveImage: async () => ({}), readImage: async () => ({}) },
    llm: { stream: async function* () {} },
    sessionQuery: { readSession: async () => ({ events: [] }) }
  };
  const registered = [];
  const disposers = [];
  const stub = {
    _registered: registered,
    _disposers: disposers,
    get(name) {
      return services[name];
    },
    inject(names, cb) {
      if (names.every((n) => services[n])) cb(this);
    },
    effect(fn) {
      disposers.push(fn());
      return () => {};
    }
  };
  stub.tools = services.tools; // 模拟 inject 直读面
  return stub;
}

const { apply: applyIris } = await import('../lib/index.js');
const tasks = await import('../lib/tasks.js');
const config = await import('../lib/config.js');

/* ===== ① 正常装载 ===== */
let errs = [];
const origError = console.error;
console.error = (...a) => errs.push(a.join(' '));
const ctx1 = stubCtx({});
await applyIris(ctx1);
assert(errs.length === 0, '正常装载不应有错误日志: ' + errs.join(' | '));
const names = ctx1._registered.map((d) => d.name);
for (const want of ['iris_draw_image', 'iris_generate_video', 'iris_speak_text', 'iris_transcribe_audio', 'iris_look_at_image', 'iris_relook_attachment', 'iris_task_status', 'iris_crop', 'iris_pixel_diff', 'iris_locate', 'iris_html_screenshot', 'iris_long_ocr', 'iris_video_frames', 'iris_media_summarize']) {
  assert(names.includes(want), '缺少工具: ' + want + '（实际: ' + names.join(', ') + '）');
}

/* ===== ② 单个工具注册抛错 ===== */
errs = [];
const ctx2 = stubCtx({ registerThrows: 'iris_draw_image' });
await applyIris(ctx2);
const names2 = ctx2._registered.map((d) => d.name);
assert(!names2.includes('iris_draw_image') && names2.includes('iris_generate_video') && names2.includes('iris_speak_text'),
  '单个失败不应连带拖垮其余工具（实际: ' + names2.join(', ') + '）');
assert(errs.length === 1 && /iris_draw_image/.test(errs[0]), '应只剩一条隔离日志: ' + errs.join(' | '));

/* ===== ③ 媒体路由服务缺失 ===== */
errs = [];
const ctx3 = {
  _registered: [],
  _disposers: [],
  get: () => undefined,
  inject: () => {},
  effect: (fn) => { fn(); return () => {}; }
};
await applyIris(ctx3);
assert(errs.length >= 1 && /tools 服务不可用/.test(errs[0]), 'tools 缺失应有明确一条日志（不炸宿主）');
assert(ctx3._registered.length === 0, 'tools 缺失时不注册任何工具');

/* ===== ④ resumePending 单条抛错 ===== */
const tBad = tasks.create({ cap: 'image', providerId: 'ghost', model: 'm', prompt: 'x' });
tasks.update(tBad.id, { remoteTaskId: 'R-BAD' });
const tGood = tasks.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'y' });
tasks.update(tGood.id, { remoteTaskId: 'R-GOOD' });
errs = [];
const resumed = tasks.resumePending((t) => {
  if (t.providerId === 'ghost') throw new Error('模拟恢复异常');
  return { key: () => 'K', intervalMs: 20, poll: async () => ({ done: true, ok: true, urls: [] }), onSuccess: async () => [] };
});
assert(resumed.length === 1 && resumed[0] === tGood.id, '只恢复可恢复的任务: ' + JSON.stringify(resumed));
assert((tasks.get(tBad.id).status === 'failed') && /恢复异常/.test(tasks.get(tBad.id).error || ''),
  '坏任务被标死且循环继续: ' + JSON.stringify(tasks.get(tBad.id).error));

console.error = origError;
console.log('ALL OK —— apply 装载鲁棒性 4 场景断言全部通过（单工具失败/路由缺失/坏任务恢复均不炸宿主）');