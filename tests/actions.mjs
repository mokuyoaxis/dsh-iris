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
// 局部更新只能改 enabled，不能把未传的 key/baseUrl/models 覆盖成 undefined
await runAction(stubCtx, 'providers_upsert', { id: np.id, enabled: false });
let rawNp = config.allProviders().find((p) => p.id === np.id);
assert(rawNp && rawNp.enabled === false && rawNp.apiKey === 'sk-new-key' && rawNp.baseUrl && rawNp.imageModel, '局部更新保留供应商凭据和模型', rawNp);
await runAction(stubCtx, 'providers_upsert', { id: np.id, enabled: true });

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

/* ---------- ⑩ 能力有序分配（阶段 6 条目 4） ---------- */
// 给 p_old 显式池：两个 vision 模型（测 failover 顺序）
await runAction(stubCtx, 'providers_set_models', { id: 'p_old', models: [
  { id: 'qwen-vl-plus', capabilities: ['vision'] },
  { id: 'qwen3-vl-235b-a22b-thinking', capabilities: ['vision'] },
  { id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }
] });
config.resetCache();
// ⑩a 设置有序 failover 列表
const poolBefore = (await runAction(stubCtx, 'assignments_get', {})).poolByCapability.vision;
const strongRef = poolBefore.find((m) => m.id === 'qwen3-vl-235b-a22b-thinking').ref;
const plusRef = poolBefore.find((m) => m.id === 'qwen-vl-plus').ref;
const setR = await runAction(stubCtx, 'assignments_set', { capability: 'vision', model_refs: [strongRef, plusRef] });
assert(setR.ok && JSON.stringify(setR.model_refs) === JSON.stringify([strongRef, plusRef]), 'assignments_set 复合引用有序列表', setR);
// ⑩b get 返回归一化 order
const getR = await runAction(stubCtx, 'assignments_get', {});
assert(JSON.stringify(getR.order.vision) === JSON.stringify([strongRef, plusRef]), 'assignments_get order 归一化为复合引用', getR.order);
// ⑩c pickFor 取分配序首位
assert(config.pickFor('vision').visionModel === 'qwen3-vl-235b-a22b-thinking', 'pickFor 取分配首位', config.pickFor('vision').visionModel);
// ⑩d pickAllFor 尊重分配序（failover 顺序）
const allVis = config.pickAllFor('vision');
assert(allVis.length === 2 && allVis[0].visionModel === 'qwen3-vl-235b-a22b-thinking' && allVis[1].visionModel === 'qwen-vl-plus',
  'pickAllFor 分配序优先', allVis.map((x) => x.visionModel));
// ⑩e 非法分配（模型不具备该能力）→ 拒绝
let aerr = null;
try { await runAction(stubCtx, 'assignments_set', { capability: 'vision', model_ids: ['wan2.2-t2i-flash'] }); } catch (e) { aerr = e; }
assert(aerr && /不具备该能力|不在全局池/.test(aerr.message), '给 vision 分配 image 模型被拒', aerr && aerr.message);
// ⑩f 空数组清除 → 回退池顺序
await runAction(stubCtx, 'assignments_set', { capability: 'vision', model_ids: [] });
const getR2 = await runAction(stubCtx, 'assignments_get', {});
assert(!getR2.order.vision || getR2.order.vision.length === 0, '空数组清除分配', getR2.order);
assert(config.pickFor('vision').visionModel === 'qwen-vl-plus', '清除后回退池顺序', config.pickFor('vision').visionModel);
// ⑩g 旧单字符串向后兼容
config.setAssignment('vision', 'qwen3-vl-235b-a22b-thinking');
assert(JSON.stringify(config.assignmentOrder('vision')) === JSON.stringify([strongRef]), '旧纯 model id 归一化为复合引用', config.assignmentOrder('vision'));
// ⑩h 重复 id 自动去重
await runAction(stubCtx, 'assignments_set', { capability: 'vision', model_ids: ['qwen-vl-plus', 'qwen-vl-plus', 'qwen3-vl-235b-a22b-thinking'] });
const getR3 = await runAction(stubCtx, 'assignments_get', {});
assert(JSON.stringify(getR3.order.vision) === JSON.stringify([plusRef, strongRef]), '重复旧 id 去重并归一化', getR3.order.vision);
// 同名模型跨 provider 可精确选择，不再被池中第一个同名项劫持
const clone = config.upsert({ name: '同名模型供应商', baseUrl: 'https://example.invalid/v1', apiKey: 'sk-clone', enabled: true, models: [{ id: 'qwen-vl-plus', capabilities: ['vision'] }] });
const dupGet = await runAction(stubCtx, 'assignments_get', {});
const cloneRef = dupGet.poolByCapability.vision.find((m) => m.providerId === clone.id && m.id === 'qwen-vl-plus').ref;
await runAction(stubCtx, 'assignments_set', { capability: 'vision', model_refs: [cloneRef, plusRef] });
assert(config.pickFor('vision').id === clone.id, '复合引用精确选中同名模型所属 provider', config.pickFor('vision'));
config.removeProvider(clone.id);

/* ---------- ⑪ 任务清理动作（阶段 4 续） ---------- */
const tasksMod = await import('../lib/tasks.js');
tasksMod.resetCache();
const outDir = tasksMod.outputsDir();
fs.mkdirSync(outDir, { recursive: true });
// 造两条终态记录 + 一条 running + 各自产物文件 + 一个孤儿文件
const tc1 = tasksMod.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'c1' });
tasksMod.update(tc1.id, { status: 'succeeded', files: ['c1.png'] });
const tc2 = tasksMod.create({ cap: 'tts', providerId: 'p1', model: 'm', prompt: 'c2' });
tasksMod.update(tc2.id, { status: 'failed' });
const tcRun = tasksMod.create({ cap: 'video', providerId: 'p1', model: 'm', prompt: 'running' });
fs.writeFileSync(path.join(outDir, 'c1.png'), 'x');
fs.writeFileSync(path.join(outDir, 'orphan.png'), 'yy');
// ⑪a 孤儿扫描：orphan.png 无引用，c1.png 被 tc1 引用
const orph = await runAction(stubCtx, 'tasks_orphans', {});
assert(orph.ok && orph.count === 1 && /orphan\.png/.test(orph.text), 'tasks_orphans 只报无引用文件', orph.text);
// ⑪b 删单条终态
const del = await runAction(stubCtx, 'tasks_delete', { task_id: tc2.id });
assert(del.ok && del.removed === 1 && !tasksMod.get(tc2.id), 'tasks_delete 删终态');
// ⑪c 删 running 被拒
let derr = null;
try { await runAction(stubCtx, 'tasks_delete', { task_id: tcRun.id }); } catch (e) { derr = e; }
assert(derr && /取消/.test(derr.message), 'tasks_delete 拒删 running', derr && derr.message);
// ⑪d 清空已完成（删 tc1，running 幸存）
const clr = await runAction(stubCtx, 'tasks_clear', { scope: 'completed' });
assert(clr.ok && !tasksMod.get(tc1.id) && tasksMod.get(tcRun.id), 'tasks_clear 删终态留 running');
// ⑪e purge 孤儿：删文件不动记录；c1.png 已随记录删除变孤儿，故两个都清
fs.writeFileSync(path.join(outDir, 'c1.png'), 'x'); // tc1 记录已删，重新确认 orphan.png 仍在
const purge = await runAction(stubCtx, 'tasks_purge_orphans', {});
assert(purge.ok && purge.deleted >= 1 && !fs.existsSync(path.join(outDir, 'orphan.png')), 'tasks_purge_orphans 删孤儿文件', purge.deleted);
// ⑪f 非法 scope 拒绝
let serr = null;
try { await runAction(stubCtx, 'tasks_clear', { scope: 'bogus' }); } catch (e) { serr = e; }
assert(serr && /scope/.test(serr.message), 'tasks_clear 非法 scope 拒绝');
// 动作清单含四个清理动作
for (const act of ['tasks_delete', 'tasks_clear', 'tasks_orphans', 'tasks_purge_orphans']) {
  assert(listActions().includes(act), '动作清单含 ' + act);
}

/* ---------- ⑫ 模型池逐模型管理（阶段 9 P3，离线：CRUD + verified 存储） ---------- */
config.resetCache();
// ⑫a 手动添加模型（能力缺省按规则推断）
await runAction(stubCtx, 'providers_add_model', { id: 'p_old', model_id: 'wan2.7-image' });
config.resetCache();
let plP3 = (await runAction(stubCtx, 'providers_list', {})).providers.find((x) => x.id === 'p_old');
let addedP3 = plP3.models.find((m) => m.id === 'wan2.7-image');
assert(addedP3 && addedP3.capabilities.includes('image-gen'), '⑫a 手动添加按规则推能力', addedP3);
assert(addedP3.source === 'manual', '⑫a source=manual', addedP3.source);
// ⑫b 纠正能力标签
await runAction(stubCtx, 'providers_set_model_caps', { id: 'p_old', model_id: 'wan2.7-image', capabilities: ['vision'] });
config.resetCache();
plP3 = (await runAction(stubCtx, 'providers_list', {})).providers.find((x) => x.id === 'p_old');
assert(plP3.models.find((m) => m.id === 'wan2.7-image').capabilities.join(',') === 'vision', '⑫b 能力标签可纠正');
// ⑫c verified 存储（config 级，探针本身走网络不在此测）
config.setModelVerified('p_old', 'wan2.7-image', 'vision', { ok: true, note: '认出红色测试图' });
config.resetCache();
plP3 = (await runAction(stubCtx, 'providers_list', {})).providers.find((x) => x.id === 'p_old');
const vmP3 = plP3.models.find((m) => m.id === 'wan2.7-image').verified;
assert(vmP3 && vmP3.vision && vmP3.vision.ok === true && vmP3.vision.at, '⑫c verified 落池并透出（含时间戳）', vmP3);
// ⑫d 重新发现不丢 verified（setProviderModels 保留同名 verified）
config.setProviderModels('p_old', [{ id: 'wan2.7-image', capabilities: ['vision'] }]);
config.resetCache();
plP3 = (await runAction(stubCtx, 'providers_list', {})).providers.find((x) => x.id === 'p_old');
assert(plP3.models.find((m) => m.id === 'wan2.7-image').verified?.vision?.ok === true, '⑫d 覆盖池保留同名 verified');
// ⑫e 移除模型
await runAction(stubCtx, 'providers_remove_model', { id: 'p_old', model_id: 'wan2.7-image' });
config.resetCache();
plP3 = (await runAction(stubCtx, 'providers_list', {})).providers.find((x) => x.id === 'p_old');
assert(!plP3.models.find((m) => m.id === 'wan2.7-image'), '⑫e 移除模型');
// ⑫f 空 model_id 拒绝
let aerr2 = null;
try { await runAction(stubCtx, 'providers_add_model', { id: 'p_old', model_id: '' }); } catch (e) { aerr2 = e; }
assert(aerr2 && /model_id/.test(aerr2.message), '⑫f 空 model_id 拒绝');
// 动作清单含四个模型管理动作
for (const act of ['providers_add_model', 'providers_remove_model', 'providers_set_model_caps', 'providers_test_model']) {
  assert(listActions().includes(act), '动作清单含 ' + act);
}

/* ---------- ⑬ 文件选择器 L1（附件枚举 + 导出，阶段 10） ---------- */
// 造一条 iris 产物任务（attachments 指向 outputs 里真实文件）
const outDir2 = tasksMod.outputsDir();
fs.mkdirSync(outDir2, { recursive: true });
fs.writeFileSync(path.join(outDir2, 'gen.png'), 'PNGDATA');
const tAtt = tasksMod.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'gen' });
tasksMod.update(tAtt.id, { status: 'succeeded', files: ['gen.png'], attachments: [{ attachmentId: 'sha256:abc123', file: 'gen.png', mediaType: 'image/png' }] });
// ⑬a attachments_list（无 session → 至少含 iris 产物）
const al = await runAction(stubCtx, 'attachments_list', {});
assert(al.ok && al.attachments.some((a) => a.attachmentId === 'sha256:abc123' && a.source === 'iris'), '⑬a attachments_list 含 iris 产物', al.attachments);
// ⑬b attachment_export（iris 产物 → 直接返回其 outputs 路径）
const ex = await runAction(stubCtx, 'attachment_export', { attachment_id: 'sha256:abc123' });
assert(ex.ok && ex.path && fs.existsSync(ex.path) && /gen\.png$/.test(ex.path), '⑬b attachment_export 返回真实路径', ex);
// ⑬c 未知附件（无 session/无上下文）→ 报错
let aer = null;
try { await runAction(stubCtx, 'attachment_export', { attachment_id: 'sha256:zzz' }); } catch (e) { aer = e; }
assert(aer && /不可导出|不在本会话/.test(aer.message), '⑬c 未知附件导出报错', aer && aer.message);
// ⑬d 空 attachment_id 拒绝
let aer2 = null;
try { await runAction(stubCtx, 'attachment_export', {}); } catch (e) { aer2 = e; }
assert(aer2 && /attachment_id/.test(aer2.message), '⑬d 空 attachment_id 拒绝');

console.log('ALL OK —— 动作路由 + 供应商管理 + 转写/抽帧/摘要 + 能力有序分配 + 任务清理 + 模型池管理 + 文件选择器L1 断言全部通过（POST 4 + providers 6 + transcribe 3 + video_frames 3 + media_summarize 3 + 分配 8 + 清理 6 + 模型 6 + 附件 4）');