/**
 * dsh-iris 客户端形态冒烟（静态检查 lib/client.js）。
 * 运行：node tests/client.mjs
 * 不依赖浏览器 —— 验证三个座位注册与悬浮泡泡的结构性存在，
 * 防止后续重构把「设置页工作台 / 输入框进度条 / 主界面悬浮泡泡」改丢。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
};

/* ① 三个座位注册必须存在 */
assert(src.includes("ctx.slots.inject('settings.section'"), '缺少 settings.section 注册');
assert(src.includes("id: 'iris-workbench'"), '缺少 iris-workbench 座位 id');
assert(src.includes("ctx.slots.inject('conversation.input.dock'"), '缺少 conversation.input.dock 注册');
assert(src.includes("id: 'iris-progress'"), '缺少 iris-progress 座位 id');
assert(src.includes("ctx.slots.inject('shell.overlay'"), '缺少 shell.overlay 注册');
assert(src.includes("id: 'iris-bubble'"), '缺少 iris-bubble 座位 id');

/* ② 三个组件函数必须存在 */
for (const fn of ['WorkbenchPanel', 'ProgressDock', 'FloatingBubble']) {
  assert(new RegExp('function\\s+' + fn + '\\s*\\(').test(src), '缺少组件函数 ' + fn);
}

/* ③ 泡泡关键行为痕迹：拖动状态、配置明暗、点击展开、数字角标 */
assert(src.includes('localStorage.getItem(\'iris-bubble-pos\''), '缺少拖动位置持久化');
assert(src.includes("'iris-bubble' + (configured ? ' lit' : ' dim')"), '缺少配置明暗类');
assert(src.includes('setOpen(!open)'), '缺少点击切换面板');
assert(src.includes("className: 'iris-bubble-badge'"), '缺少运行中数字角标');

/* ④ 阶段 5 操作卡片组：ActionCard/ActionGroups + POST /iris/api/actions */
assert(new RegExp('function\\s+ActionCard\\s*\\(').test(src), '缺少 ActionCard 组件');
assert(new RegExp('function\\s+ActionGroups\\s*\\(').test(src), '缺少 ActionGroups 组件');
assert(src.includes("'/iris/api/actions/' + action"), '缺少 actions POST 调用');
assert(src.includes("method: 'POST'"), '缺少 POST 方法');
assert(src.includes("React.createElement(ActionGroups"), '缺少 ActionGroups 挂载到工作台');
for (const act of ["action: 'image'", "action: 'video'", "action: 'tts'", "action: 'look'", "action: 'crop'", "action: 'diff'", "action: 'locate'", "action: 'html'", "action: 'ocr'", "action: 'relook'", "action: 'status'"]) {
  assert(src.includes(act), '缺少操作卡片 ' + act);
}

console.log('ALL OK —— 客户端形态 3 座位 + 3 组件 + 4 行为痕迹 + 阶段 5 操作卡片组 11 卡片断言全部通过');