/**
 * dsh-iris 真实 lint（阶段 0：把占位脚本换成可执行的检查）。
 * 运行：npm run lint   （= node tests/lint.mjs）
 *
 * 三层检查，零依赖：
 *   ① 语法：对 lib/ 与 tests/ 下所有 .js/.mjs 逐个 node --check；
 *   ② 结构防回归：守卫本阶段刚做的可靠性契约，防止未来改动悄悄退化：
 *      - api.js 不再泄露绝对路径（buildState 无 home: 字段）
 *      - media.js 具备 Accept-Ranges / createReadStream（Range 流式在）
 *      - tasks.js / config.js 具备 .corrupted- 损坏隔离
 *      - client.js 只有一份状态轮询（三个座位共享 pub/sub）
 *   ③ 文档守卫：README/CHANGELOG/docs 的相对链接不得指向仓库外（发布后必死链，
 *      曾漏掉 ../ai-paint）、仓库内目标必须真实存在；且折叠进 CHANGELOG 的里程碑明细
 *      不得回流 README。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failures = [];

function walk(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs)$/.test(f)) out.push(p);
  }
  return out;
}

/* ---------- ① 语法检查 ---------- */
const files = [...walk(path.join(root, 'lib')), ...walk(path.join(root, 'tests'))];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failures.push(`语法错误 ${path.relative(root, file)}:\n${(r.stderr || r.stdout || '').trim()}`);
  }
}
if (files.length === 0) failures.push('未找到任何 .js/.mjs 文件');

/* ---------- ② 结构防回归 ---------- */
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const api = read('lib/api.js');
if (/iris\.home\b/.test(api)) {
  failures.push('lib/api.js buildState 仍泄露 iris.home 绝对路径');
}
if (!/serveTaskDetail/.test(api) || !/\/iris\/api\/task\//.test(api)) {
  failures.push('lib/api.js 缺少 /iris/api/task/:id 详情端点（阶段 4 抽屉）');
}
if (!/state\/events/.test(api) || !/serveSse/.test(api) || !/closeAllSse/.test(api)) {
  failures.push('lib/api.js 缺少 SSE 状态推送端点（阶段 4：/iris/api/state/events + serveSse + closeAllSse）');
}

const media = read('lib/media.js');
if (!/'Accept-Ranges'/.test(media) || !/createReadStream/.test(media) || !/parseRange/.test(media)) {
  failures.push('lib/media.js 缺少 Range 流式契约（Accept-Ranges / createReadStream / parseRange）');
}

const tasks = read('lib/tasks.js');
const config = read('lib/config.js');
if (!/\.corrupted-/.test(tasks) || !/\.corrupted-/.test(config)) {
  failures.push('tasks.js / config.js 必须包含 .corrupted- 损坏隔离');
}

const client = read('lib/client.js');
const pollCount = (client.match(/setInterval\(load/g) || []).length;
if (pollCount !== 1) {
  failures.push(`lib/client.js 状态轮询应为 1 份兜底（SSE 为主通道），实际 setInterval(load) 出现 ${pollCount} 次`);
}
if (!/new EventSource\(['"]\/iris\/api\/state\/events['"]\)/.test(client)) {
  failures.push('lib/client.js 缺少 SSE 主通道（EventSource /iris/api/state/events）');
}
if (!/sharedSource\.close\(\)/.test(client)) {
  failures.push('lib/client.js 缺少 SSE 连接清理（sharedSource.close()）');
}
if (!/sharedSource\.onmessage/.test(client)) {
  failures.push('lib/client.js 缺少 SSE onmessage 处理');
}
if (!/setInterval\(load, 30000\)/.test(client)) {
  failures.push('lib/client.js 缺少兜底轮询（setInterval(load, 30000)）');
}
if (!/closest\(['\"]\.iris-bubble-btn['\"]\)/.test(client)) {
  failures.push('lib/client.js 缺少面板交互隔离（.iris-bubble-btn closest 守卫）');
}
if (!/addEventListener\(['\"]resize['\"]/.test(client)) {
  failures.push('lib/client.js 缺少窗口 resize 重约束监听');
}

const index = read('lib/index.js');
if (/required:\s*true/.test(index)) {
  failures.push('lib/index.js 工具参数属性内不得出现 required: true（JSON Schema 属性级 required 必须是字符串数组）');
}
if (!/name: 'iris_crop'/.test(index) || !/name: 'iris_pixel_diff'/.test(index)) {
  failures.push('lib/index.js 缺少阶段 2 工具注册（iris_crop / iris_pixel_diff）');
}
if (!/name: 'iris_locate'/.test(index)) {
  failures.push('lib/index.js 缺少阶段 3A 工具注册（iris_locate）');
}
if (!/name: 'iris_html_screenshot'/.test(index)) {
  failures.push('lib/index.js 缺少阶段 3C 工具注册（iris_html_screenshot）');
}
if (!/name: 'iris_long_ocr'/.test(index)) {
  failures.push('lib/index.js 缺少阶段 3B 工具注册（iris_long_ocr）');
}
if (!/serveAction/.test(api) && !/handleAction/.test(api) && !/runAction/.test(index)) {
  failures.push('lib/index.js / api.js 缺少阶段 5 actions 路由（runAction / handleAction）');
}
if (!/name: 'iris_transcribe_audio'/.test(index)) {
  failures.push('lib/index.js 缺少阶段 7.2 工具注册（iris_transcribe_audio）');
}
if (!/name: 'iris_video_frames'/.test(index)) {
  failures.push('lib/index.js 缺少阶段 7.1 工具注册（iris_video_frames）');
}

// 阶段 7.1：视频抽帧后端必须存在且可离线测试
let mediaProbe = '';
try {
  mediaProbe = read('lib/media-probe.js');
} catch (_) {
  failures.push('缺少 lib/media-probe.js（阶段 7.1 视频抽帧后端）');
}
if (mediaProbe) {
  if (!/export function ffmpegAvailable/.test(mediaProbe) || !/export function probeVideo/.test(mediaProbe) || !/export async function extractFrames/.test(mediaProbe)) {
    failures.push('lib/media-probe.js 必须导出 ffmpegAvailable / probeVideo / extractFrames');
  }
  if (!/MAX_FRAMES\s*=\s*20/.test(mediaProbe)) {
    failures.push('lib/media-probe.js 必须有帧数上限（MAX_FRAMES=20，对齐 RESEARCH §9.2）');
  }
  if (!/normalizeFramesOptions/.test(mediaProbe)) {
    failures.push('lib/media-probe.js 必须有参数校验/clamp（normalizeFramesOptions）');
  }
  if (!/scaledDimensions/.test(mediaProbe)) {
    failures.push('lib/media-probe.js 必须有缩放尺寸计算（scaledDimensions）');
  }
}
if (!/register\('video_frames'/.test(read('lib/actions.js'))) {
  failures.push('lib/actions.js 缺少阶段 7.1 动作（video_frames）');
}

// 阶段 7.3：多模态摘要后端 + 工具 + 动作 + 卡片
let summarize = '';
try {
  summarize = read('lib/summarize.js');
} catch (_) {
  failures.push('缺少 lib/summarize.js（阶段 7.3 多模态摘要后端）');
}
if (summarize) {
  if (!/export async function buildContactSheet/.test(summarize) || !/export async function summarizeMedia/.test(summarize)) {
    failures.push('lib/summarize.js 必须导出 buildContactSheet / summarizeMedia');
  }
  if (!/export function buildSummaryPrompt/.test(summarize)) {
    failures.push('lib/summarize.js 必须导出 buildSummaryPrompt');
  }
}
if (!/name: 'iris_media_summarize'/.test(index)) {
  failures.push('lib/index.js 缺少阶段 7.3 工具注册（iris_media_summarize）');
}
if (!/register\('media_summarize'/.test(read('lib/actions.js'))) {
  failures.push('lib/actions.js 缺少阶段 7.3 动作（media_summarize）');
}

// 阶段 3B：OCR 后端必须存在且复用视觉后端链
let ocr = '';
try {
  ocr = read('lib/ocr.js');
} catch (_) {
  failures.push('缺少 lib/ocr.js（阶段 3B OCR 后端）');
}
if (ocr && !/export async function longOcr/.test(ocr)) {
  failures.push('lib/ocr.js 必须导出 longOcr');
}
if (ocr && !/askWithBackends/.test(ocr)) {
  failures.push('lib/ocr.js 必须复用视觉后端链（askWithBackends），不直连供应商');
}

// 阶段 2：像素后端必须存在且不引入 TypeScript/打包器特性
let pixels = '';
try {
  pixels = read('lib/pixels.js');
} catch (_) {
  failures.push('缺少 lib/pixels.js（阶段 2 像素后端）');
}
if (pixels) {
  if (!/export async function cropImage/.test(pixels) || !/export async function pixelDiff/.test(pixels)) {
    failures.push('lib/pixels.js 必须导出 cropImage 与 pixelDiff');
  }
  if (/PixelError/.test(pixels) === false) {
    failures.push('lib/pixels.js 缺少 PixelError（边界错误要有类型）');
  }
}

// 阶段 3A：定位模块必须存在且契约完整
let locate = '';
try {
  locate = read('lib/locate.js');
} catch (_) {
  failures.push('缺少 lib/locate.js（阶段 3A 定位后端）');
}
if (locate) {
  if (!/export async function locateObject/.test(locate) || !/export function extractBboxJson/.test(locate)) {
    failures.push('lib/locate.js 必须导出 locateObject 与 extractBboxJson');
  }
  if (/x1<x2/.test(locate) === false) {
    failures.push('lib/locate.js 必须校验 x1<x2 且 y1<y2（原像素 bbox 契约）');
  }
}

// 阶段 6：模型发现模块必须存在且被 config 使用
let models = '';
try {
  models = read('lib/models.js');
} catch (_) {
  failures.push('缺少 lib/models.js（阶段 6 模型发现）');
}
if (models) {
  if (!/export function capabilitiesOfModel/.test(models) || !/export function providerModels/.test(models) || !/export function modelPool/.test(models)) {
    failures.push('lib/models.js 必须导出 capabilitiesOfModel / providerModels / modelPool');
  }
  if (!/export function pickModel/.test(models)) {
    failures.push('lib/models.js 必须导出 pickModel（从池按能力选模型）');
  }
}
if (!/from '\.\/models\.js'/.test(read('lib/config.js'))) {
  failures.push('lib/config.js 必须使用 lib/models.js（阶段 6 模型池调度）');
}

// 孤儿任务防线（2026-09-03 修复）：提交段守卫 + 启动兜底清理 + progress 收尾
let tasksLib = '';
try {
  tasksLib = read('lib/tasks.js');
} catch (_) {
  failures.push('缺少 lib/tasks.js');
}
if (tasksLib) {
  if (!/export async function submitGuard/.test(tasksLib)) {
    failures.push('lib/tasks.js 必须导出 submitGuard（提交失败即标 failed，不留 running 孤儿）');
  }
  if (!/无远程任务 id/.test(tasksLib)) {
    failures.push('lib/tasks.js resumePending 必须有孤儿记录兜底清理（running 且无 remoteTaskId → failed）');
  }
  if (!/status: 'succeeded', files, progress: '100%'/.test(tasksLib)) {
    failures.push('lib/tasks.js 盯守成功必须把 progress 收尾为 100%（不残留轮询期 RUNNING 文本）');
  }
}
{
  const actionsSrc = read('lib/actions.js');
  const creates = (actionsSrc.match(/tasks\.create\(/g) || []).length;
  const guards = (actionsSrc.match(/tasks\.submitGuard\(/g) || []).length;
  if (guards < creates) {
    failures.push(`lib/actions.js 每个 tasks.create 站点必须套 submitGuard（create ${creates} 处，守卫仅 ${guards} 处）`);
  }
  for (const action of ['image', 'video', 'tts', 'transcribe']) {
    if (!index.includes("runAction(ctx, '" + action + "'")) {
      failures.push('lib/index.js Agent ' + action + ' 必须复用 lib/actions.js 共享动作（避免双实现漂移）');
    }
  }
}

// 网络与路由健壮性（2026-09-03 健康检查）
{
  const adaptersSrc = read('lib/adapters.js');
  const fetches = (adaptersSrc.match(/await fetch\(/g) || []).length;
  const signals = (adaptersSrc.match(/signal:/g) || []).length;
  if (fetches === 0 || signals < fetches) {
    failures.push(`lib/adapters.js 每个 fetch 必须带超时 signal（fetch ${fetches} 处，signal ${signals} 处）——挂死连接会冻住盯守 tick`);
  }
  if (!/AbortSignal\.timeout/.test(adaptersSrc) || !/T_POLL = 15000/.test(adaptersSrc)) {
    failures.push('lib/adapters.js 必须有分层超时档位常量（T_SUBMIT/T_POLL/T_DOWNLOAD…）');
  }
  if (!/renameSync/.test(adaptersSrc)) {
    failures.push('lib/adapters.js downloadTo 必须原子落盘（.tmp + rename，失败不留半截产物）');
  }
  const idxSrc = index;
  if (!/function pollDeps[\s\S]{0,400}cap === 'transcribe'/.test(idxSrc)) {
    failures.push('lib/index.js pollDeps 必须有 transcribe 分支（重启接管走 pollTranscriptionTask，否则转写文本静默丢失）');
  }
  const apiSrc = read('lib/api.js');
  if (!/MAX_BODY_BYTES/.test(apiSrc) || !/totalBytes/.test(apiSrc)) {
    failures.push('lib/api.js POST body 限长必须按字节计（MAX_BODY_BYTES/totalBytes）——body.length 是块数不是字节数');
  }
  if (!/writableEnded \|\| res\.destroyed/.test(apiSrc)) {
    failures.push('lib/api.js sendJson 必须有 writableEnded/destroyed 守卫（防 end 后二次写）');
  }
  if (!/closeAllSse[\s\S]{0,500}unbindChangeBus\(\)/.test(apiSrc)) {
    failures.push('lib/api.js closeAllSse 必须退订状态变化总线（副作用可逆纪律：不留悬挂监听）');
  }
  if (!/new AbortController\(\)/.test(apiSrc) || !/signal: controller\.signal/.test(apiSrc)) {
    failures.push('lib/api.js GUI action 必须把客户端断开传播为 AbortSignal');
  }
  if (!/UPLOAD_TTL_MS/.test(apiSrc) || !/purgeStaleUploads/.test(apiSrc) || !/\.part/.test(apiSrc)) {
    failures.push('lib/api.js 上传必须具备 TTL 清理和 .part 原子生命周期');
  }
  const renderSrc = read('lib/render.js');
  if (!/Content-Security-Policy/.test(renderSrc) || !/sandbox; default-src \u0027none\u0027/.test(renderSrc)) {
    failures.push('lib/render.js HTML 截图页必须用 CSP sandbox 隔离同源脚本权限');
  }
  const mediaSrc = read('lib/media.js');
  if ((mediaSrc.match(/res\.on\('close', \(\) => \{ if \(!res\.writableEnded\) stream\.destroy\(\)/g) || []).length < 2) {
    failures.push('lib/media.js 两个流式分支都必须断开即毁流（客户端中途断开不留 fd 到 EOF）');
  }
  if (!/writableEnded \|\| res\.destroyed/.test(mediaSrc)) {
    failures.push('lib/media.js sendText 必须有 writableEnded/destroyed 守卫');
  }
}

// 阶段 6 条目 4：能力有序分配（数据层 + 动作 + UI）
{
  const configSrc = read('lib/config.js');
  if (!/export function assignmentOrder/.test(configSrc) || !/export function setAssignmentOrder/.test(configSrc)) {
    failures.push('lib/config.js 必须导出 assignmentOrder / setAssignmentOrder（有序 failover 分配）');
  }
  if (!/for \(const ref of assignmentOrder\(capability\)\)/.test(configSrc)) {
    failures.push('lib/config.js pickFor 必须按分配顺序取首个可用（不再只认单值）');
  }
  if (!/assignmentOrder\(capability\)[\s\S]{0,200}for \(const m of pool\) if \(m\.capabilities\.includes/.test(configSrc)) {
    failures.push('lib/config.js pickAllFor 必须分配序优先、池序补齐（failover 顺序生效）');
  }
  const actionsSrc = read('lib/actions.js');
  if (!/Array\.isArray\(args\.model_refs\)/.test(actionsSrc) || !/store\.setAssignmentOrder/.test(actionsSrc)) {
    failures.push('lib/actions.js assignments_set 必须优先支持 model_refs 复合引用数组（兼容 model_ids/model_id 旧写法）');
  }
  if (!/order\[c\] = store\.assignmentOrder\(c\)/.test(actionsSrc)) {
    failures.push('lib/actions.js assignments_get 必须返回归一化 order');
  }
  const modelsSrc = read('lib/models.js');
  if (!/qwen\\d\?-vl/.test(modelsSrc) || !/qwen3-vl-235b-a22b-thinking/.test(modelsSrc)) {
    failures.push('lib/models.js 必须含 qwen?-vl 规则且收录 qwen3-vl 强视觉模型（VERIFY 2026-09-03 实证）');
  }
}

// O2 授权边界：三条 /iris 路由必须全部包守卫
{
  if (!/from '\.\/guard\.js'/.test(index) || (index.match(/guarded\(/g) || []).length < 3) {
    failures.push('lib/index.js 三条 /iris 前缀路由必须全部包 guarded()（Host/Origin 授权边界）');
  }
  let guardSrc = '';
  try {
    guardSrc = read('lib/guard.js');
  } catch (_) {
    failures.push('缺少 lib/guard.js（O2 请求守卫）');
  }
  if (guardSrc && (!/export function checkRequest/.test(guardSrc) || !/cross-site/.test(guardSrc) || !/method !== 'POST'/.test(guardSrc))) {
    failures.push('lib/guard.js 必须是发布安全版：checkRequest + 读接口放开(非 POST 放行) + POST 挡 cross-site/跨源');
  }
}

// 阶段 4 续：任务清理 + 泡泡瘦身
{
  const tasksSrc = read('lib/tasks.js');
  if (!/const MAX_TASKS = 500/.test(tasksSrc)) {
    failures.push('lib/tasks.js MAX_TASKS 应为 500（后台保存更多历史）');
  }
  if (!/export function remove/.test(tasksSrc) || !/export function prune/.test(tasksSrc) || !/export function all/.test(tasksSrc)) {
    failures.push('lib/tasks.js 必须导出 remove/prune/all（清理原语，running 强制保护）');
  }
  if (!/t\.status !== 'running' && pred\(t\)/.test(tasksSrc)) {
    failures.push('lib/tasks.js prune 必须强制跳过 running（永不批量删除运行中任务）');
  }
  const actionsSrc = read('lib/actions.js');
  for (const act of ['tasks_delete', 'tasks_clear', 'tasks_orphans', 'tasks_purge_orphans']) {
    if (!actionsSrc.includes("register('" + act + "'")) failures.push('lib/actions.js 缺少清理动作 ' + act);
  }
  const apiSrc = read('lib/api.js');
  if (!/recentTotal: terminal\.length/.test(apiSrc)) {
    failures.push('lib/api.js buildState 必须返回 recentTotal（泡泡查看全部计数不受截断）');
  }
  const clientSrc = read('lib/client.js');
  if (!/var\s+CARD_DEFS\s*=/.test(clientSrc) || !/CARD_DEFS\.map\(renderCard\)/.test(clientSrc)) {
    failures.push('lib/client.js 操作卡片必须走 CARD_DEFS 注册表（单一来源：设置全量/泡泡子集/选择器）');
  }
  if (!/function\s+BubblePanel/.test(clientSrc) || !/iris-bubble-cards/.test(clientSrc)) {
    failures.push('lib/client.js 泡泡必须是标签页 BubblePanel + 常用卡片 localStorage');
  }
}

// P2 模型发现：listModels 适配器 + providers_discover 动作 + 扩规则 + UI 按钮
{
  const adaptersSrc = read('lib/adapters.js');
  if (!/export async function listModels/.test(adaptersSrc) || !/\/models`/.test(adaptersSrc)) {
    failures.push('lib/adapters.js 必须有 listModels（GET /models 模型发现）');
  }
  const actionsSrc = read('lib/actions.js');
  if (!/register\('providers_discover'/.test(actionsSrc)) {
    failures.push('lib/actions.js 缺少 providers_discover 动作');
  }
  const modelsSrc = read('lib/models.js');
  if (!/qwen-image|cosyvoice|z-image/.test(modelsSrc)) {
    failures.push('lib/models.js MODEL_CAP_RULES 未覆盖真实命名族（qwen-image/cosyvoice/z-image…）');
  }
  const clientSrc = read('lib/client.js');
  if (!/providers_discover/.test(clientSrc) || !/发现模型/.test(clientSrc)) {
    failures.push('lib/client.js ProviderManager 缺少「发现模型」按钮');
  }
}

// P3 模型池逐模型管理：config CRUD + verified + 动作注册
{
  const configSrc = read('lib/config.js');
  for (const fn of ['addProviderModel', 'removeProviderModel', 'setModelCapabilities', 'setModelVerified']) {
    if (!configSrc.includes('export function ' + fn)) failures.push('lib/config.js 缺少 ' + fn);
  }
  if (!/entry\.verified\[capability\]/.test(configSrc)) {
    failures.push('lib/config.js setModelVerified 必须按能力存 verified');
  }
  const actionsSrc = read('lib/actions.js');
  for (const act of ['providers_add_model', 'providers_remove_model', 'providers_set_model_caps', 'providers_test_model']) {
    if (!actionsSrc.includes("register('" + act + "'")) failures.push('lib/actions.js 缺少模型管理动作 ' + act);
  }
  if (!/async function probeModel/.test(actionsSrc)) {
    failures.push('lib/actions.js 缺少 probeModel（按能力逐模型实测探针）');
  }
  const clientSrc = read('lib/client.js');
  if (!/function\s+ModelPool/.test(clientSrc) || !/providers_test_model/.test(clientSrc) || !/providers_add_model/.test(clientSrc)) {
    failures.push('lib/client.js 模型池 UI 缺 ModelPool/逐模型测试/手动添加');
  }
}

// 阶段 10：文件选择器（L1 附件枚举/导出 + L2 上传 + FileField）
{
  const actionsSrc = read('lib/actions.js');
  if (!/register\('attachments_list'/.test(actionsSrc) || !/register\('attachment_export'/.test(actionsSrc)) {
    failures.push('lib/actions.js 缺少文件选择器动作 attachments_list/attachment_export');
  }
  const apiSrc = read('lib/api.js');
  if (!/\/iris\/api\/upload/.test(apiSrc) || !/function handleUpload/.test(apiSrc) || !/MAX_UPLOAD_BYTES/.test(apiSrc)) {
    failures.push('lib/api.js 缺少上传路由 handleUpload（独立大 body 上限）');
  }
  const clientSrc = read('lib/client.js');
  if (!/function\s+FileField/.test(clientSrc) || !/\/iris\/api\/upload/.test(clientSrc) || !/ctx\.sessions|sessions\.list/.test(clientSrc)) {
    failures.push('lib/client.js 缺 FileField/上传调用/当前会话读取');
  }
}

/* ---------- ③ 文档守卫：相对链接必须存在 + 折叠不回流 ---------- */
{
  const docFiles = ['README.md', 'user_guide.md', 'CHANGELOG.md']
    .concat(fs.readdirSync(path.join(root, 'docs')).filter((f) => /\.md$/.test(f)).map((f) => path.join('docs', f)));
  for (const rel of docFiles) {
    const raw = fs.readFileSync(path.join(root, rel), 'utf8');
    // 先剥掉围栏代码块与行内代码：文档里用反引号举例"已删除的死链"不是真链接
    //（否则守卫会对示例误报，而误报的守卫早晚被人绕过去废掉）
    const src = raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    // [text](target) —— 跳过 http(s)/mailto/纯锚点
    const links = [...src.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])
      .filter((t) => !/^(https?:|mailto:|#)/.test(t));
    for (const link of links) {
      const target = link.split('#')[0];
      if (!target) continue;
      const abs = path.resolve(path.dirname(path.join(root, rel)), target);
      // 规则一：不得指向仓库外。发布物里没有兄弟目录，`../ai-paint` 在本机存在却是对外死链
      //（负向实测：只查 existsSync 会放过它，因为开发机上那个目录真的在）。
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        failures.push(`${rel} 链接指向仓库外：(${link}) —— 发布后必为死链，改为纯文本说明`);
        continue;
      }
      // 规则二：仓库内的目标必须真实存在
      if (!fs.existsSync(abs)) {
        failures.push(`${rel} 相对链接失效：(${link}) → ${path.relative(root, abs)} 不存在`);
      }
    }
  }
  // 公开文档保持可导航，并保留面向使用者的稳定结构。
  const readme = read('README.md');
  if (/^- \[x\] \*\*M1\*\*/m.test(readme)) {
    failures.push('README.md 不应包含内部里程碑清单');
  }
  if (!readme.includes('user_guide.md') || !readme.includes('CHANGELOG.md') || !readme.includes('ROADMAP.md')) {
    failures.push('README.md 缺少指向用户指南、CHANGELOG 或 ROADMAP 的文档链接');
  }
  const badgeCount = (readme.match(/https:\/\/img\.shields\.io\//g) || []).length;
  if (badgeCount < 3) {
    failures.push('README.md 至少应包含版本、运行时和许可证等基础徽章');
  }
  for (const contract of ['dsh plugin --profile web add @mokuyoaxis/dsh-iris', 'dsh web', '最小指令']) {
    if (!readme.includes(contract)) failures.push(`README.md 缺少快速开始契约：${contract}`);
  }
  const userGuide = read('user_guide.md');
  for (const section of ['安装', '最快配置：DashScope', '供应商与协议', '模型池', '能力分配和故障转移', '高级配置文件', '文件输入', '最小指令', '常见问题']) {
    if (!userGuide.includes(`## ${section}`)) failures.push(`user_guide.md 缺少「${section}」节`);
  }
  for (const contract of ['mediaProtocol', 'providerId::modelId', '64 MB', 'iris_task_status']) {
    if (!userGuide.includes(contract)) failures.push(`user_guide.md 缺少配置契约：${contract}`);
  }
  const changelog = read('CHANGELOG.md');
  if (!/^## \[Unreleased\]/m.test(changelog)) {
    failures.push('CHANGELOG.md 缺少 [Unreleased] 节');
  }
  for (const sec of ['Added', 'Changed', 'Fixed', 'Security']) {
    if (!new RegExp(`^### ${sec}$`, 'm').test(changelog)) {
      failures.push(`CHANGELOG.md 缺少「${sec}」节`);
    }
  }
  const roadmap = read('docs/ROADMAP.md');
  for (const sec of ['当前状态', '下一步', '兼容性与限制', '质量要求', '暂不计划']) {
    if (!roadmap.includes(sec)) failures.push(`docs/ROADMAP.md 缺少「${sec}」节`);
  }
  const pkg = JSON.parse(read('package.json'));
  if (pkg.name !== '@mokuyoaxis/dsh-iris') {
    failures.push('package.json name 必须使用未被占用的 @mokuyoaxis/dsh-iris');
  }
  const lock = JSON.parse(read('package-lock.json'));
  if (lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name) {
    failures.push('package-lock.json 根包名必须与 package.json 保持一致');
  }
  if (!read('cordis.patch.yml').includes("name: '@mokuyoaxis/dsh-iris'")) {
    failures.push('cordis.patch.yml 必须使用 scoped npm 包名');
  }
  const packed = Array.isArray(pkg.files) ? pkg.files : [];
  if (!packed.includes('user_guide.md') || !packed.includes('CHANGELOG.md') || !packed.includes('docs')) {
    failures.push('package.json files 必须包含 user_guide.md、CHANGELOG.md 与 docs（README 发布链接不可失效）');
  }
  for (const skill of ['iris-verify-ui', 'iris-compose-media']) {
    if (!packed.includes('.dsh/skills/' + skill)) {
      failures.push('package.json files 必须包含仓库级 ' + skill + ' Skill');
    }
    if (!readme.includes('.dsh/skills/' + skill + '/SKILL.md')) {
      failures.push('README.md 必须链接仓库级 ' + skill + ' Skill');
    }
  }
  if (!pkg.engines || pkg.engines.node !== '>=20.9.0') {
    failures.push('package.json 必须声明 sharp 0.35.4 所需 Node >=20.9.0');
  }
}

/* ---------- 汇总 ---------- */
if (failures.length) {
  console.error(`lint 失败（${failures.length} 项）：`);
  for (const f of failures) console.error(' - ' + f.replace(/\n/g, '\n   '));
  process.exit(1);
}
console.log(`lint OK —— ${files.length} 个文件语法通过 + 结构契约守卫通过`);
