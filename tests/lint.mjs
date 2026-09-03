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
  failures.push(`lib/client.js 状态轮询应为 1 份共享，实际 setInterval(load) 出现 ${pollCount} 次`);
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

/* ---------- 汇总 ---------- */
if (failures.length) {
  console.error(`lint 失败（${failures.length} 项）：`);
  for (const f of failures) console.error(' - ' + f.replace(/\n/g, '\n   '));
  process.exit(1);
}
console.log(`lint OK —— ${files.length} 个文件语法通过 + 结构契约 8 项守卫通过`);
