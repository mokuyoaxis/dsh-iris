/**
 * dsh-iris 真实 lint（阶段 0：把占位脚本换成可执行的检查）。
 * 运行：npm run lint   （= node tests/lint.mjs）
 *
 * 两层检查，零依赖：
 *   ① 语法：对 lib/ 与 tests/ 下所有 .js/.mjs 逐个 node --check；
 *   ② 结构防回归：守卫本阶段刚做的可靠性契约，防止未来改动悄悄退化：
 *      - api.js 不再泄露绝对路径（buildState 无 home: 字段）
 *      - media.js 具备 Accept-Ranges / createReadStream（Range 流式在）
 *      - tasks.js / config.js 具备 .corrupted- 损坏隔离
 *      - client.js 只有一份状态轮询（三个座位共享 pub/sub）
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
  const idxGuards = (index.match(/tasks\.submitGuard\(/g) || []).length;
  const idxTryFailed = (index.match(/status: 'failed', error: String\(err\.message \|\| err\)/g) || []).length;
  if (idxGuards < 2 || idxTryFailed < 3) {
    failures.push(`lib/index.js 提交段守卫退化（submitGuard ${idxGuards} 处 <2 或 try/catch 标 failed ${idxTryFailed} 处 <3）`);
  }
}

/* ---------- 汇总 ---------- */
if (failures.length) {
  console.error(`lint 失败（${failures.length} 项）：`);
  for (const f of failures) console.error(' - ' + f.replace(/\n/g, '\n   '));
  process.exit(1);
}
console.log(`lint OK —— ${files.length} 个文件语法通过 + 结构契约守卫通过`);
