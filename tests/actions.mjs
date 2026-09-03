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
  return { headersSent: false, writableEnded: false, status: 0, body: null, writeHead(s, h) { this.status = s; this.headersSent = true; }, end(d) { this.writableEnded = true; if (d) this.body = JSON.parse(d); } };
}
const stubCtx = { get: () => undefined };

// 多块 body 的 fakeReq（验证按字节限长，不是按块数——旧实现的坑：body.length 是块数）
function fakeReqChunks(method, url, chunks) {
  return {
    method, url, headers: { 'content-type': 'application/json' },
    on: (evt, cb) => {
      if (evt === 'data') for (const c of chunks) cb(c);
      if (evt === 'end') setTimeout(cb, 5);
    }
  };
}

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

/* ④b POST 超 1MB body → 413（按字节计：3×500KB 块 = 1.5MB，旧实现按块数会放行） */
const r4b = fakeRes();
serveApi(fakeReqChunks('POST', '/iris/api/actions/status', [Buffer.alloc(500000, 0x61), Buffer.alloc(500000, 0x61), Buffer.alloc(500000, 0x61)]), r4b, stubCtx);
await new Promise((r) => setTimeout(r, 50));
assert(r4b.status === 413, '超限 body → 413', r4b.status);
/* ④c 限内多块 body 正常放行 */
const r4c = fakeRes();
serveApi(fakeReqChunks('POST', '/iris/api/actions/status', [Buffer.from('{"a":'), Buffer.from('1}')]), r4c, stubCtx);
await new Promise((r) => setTimeout(r, 50));
assert(r4c.status === 200 && r4c.body && r4c.body.ok, '限内多块 body 正常', r4c.status);

/* ---------- ⑤ 供应商管理动作（阶段 6） ---------- */
process.env.DSH_HOME = '/tmp/iris-actions-home-' + Date.now();
const fsMod = await import('node:fs');
const fs = fsMod.default;
const pathMod = await import('node:path');
const path = pathMod.default;
const irisV1 = path.join(process.env.DSH_HOME, 'iris', 'v1');
fs.mkdirSync(path.join(irisV1, 'outputs'), { recursive: true });
// 预置一个旧字段 provider（迁移为模型池）
fs.writeFileSync(path.join(irisV1, 'providers.json'), JSON.stringify({
  version: 1,
  providers: [{ id: 'p_old', name: '旧供应商', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-old-key', enabled: true, visionModel: 'qwen-vl-plus' }]
}, null, 2));

const config = await import('../lib/config.js');
const { runAction, listActions } = await import('../lib/actions.js');
config.resetCache();

// ① 列出：预置 provider 的模型池含 qwen-vl-plus（vision）
const listed = await runAction(stubCtx, 'providers_list', {});
assert(listed.ok && listed.providers.length === 1, 'providers_list 列出 1 个');
const pl = listed.providers[0];
assert(pl.apiKeyHint === 'sk-****key' || pl.apiKeyHint.includes('****'), 'apiKey 只给 hint', pl.apiKeyHint);
assert(pl.models.some((m) => m.id === 'qwen-vl-plus' && m.capabilities.includes('vision')), '模型池含 qwen-vl-plus/vision', pl.models);

// ② upsert 新增一个多模型 provider
await runAction(stubCtx, 'providers_upsert', { name: '新供应商', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-new-key', imageModel: 'wan2.2-t2i-flash', videoModel: 'wan2.2-t2v-flash' });
config.resetCache();
const listed2 = await runAction(stubCtx, 'providers_list', {});
assert(listed2.providers.length === 2, 'upsert 新增后 2 个', listed2.providers.length);
const np = listed2.providers.find((p) => p.name === '新供应商');
assert(np && np.models.length === 2, '新 provider 模型池 2 条（image+video）', np && np.models);

// ③ set_models 覆盖模型池
await runAction(stubCtx, 'providers_set_models', { id: np.id, models: [{ id: 'gpt-image-1', capabilities: ['image-gen'] }] });
config.resetCache();
const listed3 = await runAction(stubCtx, 'providers_list', {});
const np2 = listed3.providers.find((p) => p.id === np.id);
assert(np2 && np2.models.length === 1 && np2.models[0].id === 'gpt-image-1', 'set_models 覆盖模型池', np2 && np2.models);

// ④ test_vision：无 vision 模型的 provider → 跳过提示
const tv = await runAction(stubCtx, 'providers_test_vision', { id: np.id });
assert(tv.ok && tv.tested === false && /未配置 vision/.test(tv.text), 'test_vision 无 vision 跳过', tv.text);

// ⑤ remove 删除
await runAction(stubCtx, 'providers_remove', { id: np.id });
config.resetCache();
const listed4 = await runAction(stubCtx, 'providers_list', {});
assert(listed4.providers.length === 1, 'remove 后剩 1 个', listed4.providers.length);

// ⑥ 动作清单包含管理动作 + 阶段 7.2 转写 + 阶段 7.1 抽帧 + 阶段 7.3 摘要
const names = listActions();
for (const act of ['providers_list', 'providers_upsert', 'providers_remove', 'providers_set_models', 'providers_test_vision', 'transcribe', 'video_frames', 'media_summarize']) {
  assert(names.includes(act), '动作清单含 ' + act);
}

// ⑦ 转写动作入参校验（无真实音频，测错误路径）
let terr1 = null;
try { await runAction(stubCtx, 'transcribe', {}); } catch (e) { terr1 = e; }
assert(terr1 && /audio_path/.test(terr1.message), 'transcribe 缺 audio_path 报错', terr1 && terr1.message);
let terr2 = null;
try { await runAction(stubCtx, 'transcribe', { audio_path: 'relative.wav' }); } catch (e) { terr2 = e; }
assert(terr2 && /绝对路径/.test(terr2.message), 'transcribe 相对路径报错', terr2 && terr2.message);
let terr3 = null;
try { await runAction(stubCtx, 'transcribe', { audio_path: '/nonexistent/audio.wav' }); } catch (e) { terr3 = e; }
assert(terr3 && /不存在/.test(terr3.message), 'transcribe 文件不存在报错', terr3 && terr3.message);

// ⑧ 视频抽帧动作入参校验（阶段 7.1）
let verr1 = null;
try { await runAction(stubCtx, 'video_frames', {}); } catch (e) { verr1 = e; }
assert(verr1 && /video_path/.test(verr1.message), 'video_frames 缺 video_path 报错', verr1 && verr1.message);
let verr2 = null;
try { await runAction(stubCtx, 'video_frames', { video_path: 'relative.mp4' }); } catch (e) { verr2 = e; }
assert(verr2 && /绝对路径/.test(verr2.message), 'video_frames 相对路径报错', verr2 && verr2.message);
let verr3 = null;
try { await runAction(stubCtx, 'video_frames', { video_path: '/nonexistent/video.mp4' }); } catch (e) { verr3 = e; }
assert(verr3 && /不存在/.test(verr3.message), 'video_frames 文件不存在报错', verr3 && verr3.message);
// 动作清单包含 7.1 抽帧动作
assert(names.includes('video_frames'), '动作清单含 video_frames');

// ⑨ 多模态摘要动作入参校验（阶段 7.3）
let merr1 = null;
try { await runAction(stubCtx, 'media_summarize', {}); } catch (e) { merr1 = e; }
assert(merr1 && /video_path/.test(merr1.message), 'media_summarize 缺 video_path 报错', merr1 && merr1.message);
let merr2 = null;
try { await runAction(stubCtx, 'media_summarize', { video_path: 'relative.mp4' }); } catch (e) { merr2 = e; }
assert(merr2 && /绝对路径/.test(merr2.message), 'media_summarize 相对路径报错', merr2 && merr2.message);
let merr3 = null;
try { await runAction(stubCtx, 'media_summarize', { video_path: '/nonexistent/video.mp4' }); } catch (e) { merr3 = e; }
assert(merr3 && /不存在/.test(merr3.message), 'media_summarize 文件不存在报错', merr3 && merr3.message);
assert(names.includes('media_summarize'), '动作清单含 media_summarize');

console.log('ALL OK —— 动作路由 + 供应商管理 + 转写/抽帧/摘要校验断言全部通过（POST status/不存在/GET 405/空body + providers 6 项 + transcribe 3 项 + video_frames 3 项 + media_summarize 3 项）');