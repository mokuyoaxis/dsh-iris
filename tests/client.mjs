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
for (const act of ["action: 'image'", "action: 'video'", "action: 'tts'", "action: 'transcribe'", "action: 'video_frames'", "action: 'media_summarize'", "action: 'look'", "action: 'crop'", "action: 'diff'", "action: 'locate'", "action: 'html'", "action: 'ocr'", "action: 'relook'", "action: 'status'"]) {
  assert(src.includes(act), '缺少操作卡片 ' + act);
}

/* ⑤ 阶段 6 条目 4：能力分配 UI（有序 failover 列表编辑） */
assert(new RegExp('function\\s+CapabilityAssigner\\s*\\(').test(src), '缺少 CapabilityAssigner 组件');
assert(src.includes("React.createElement(CapabilityAssigner"), '缺少 CapabilityAssigner 挂载到工作台');
assert(src.includes("'能力分配（failover 顺序）'"), '缺少能力分配区标题');
assert(src.includes("capability: cap, model_ids: ids"), '缺少有序列表保存调用（model_ids 数组）');
for (const capRow of ["cap: 'image-gen'", "cap: 'video-gen'", "cap: 'tts'", "cap: 'vision'"]) {
  assert(src.includes(capRow), '缺少能力行 ' + capRow);
}
assert(src.includes("'↑'") && src.includes("'↓'") && src.includes("'恢复自动'"), '缺少排序/清除操作');

/* ⑥ 阶段 4 续：泡泡瘦身（标签页）+ 卡片注册表 + 历史分组 + 常用选择器 + 清理区 */
assert(new RegExp('var\\s+CARD_DEFS\\s*=').test(src), '缺少 CARD_DEFS 卡片注册表');
assert(src.includes('CARD_DEFS.map(renderCard)'), 'ActionGroups 未从注册表渲染');
assert(new RegExp('function\\s+BubblePanel\\s*\\(').test(src), '缺少 BubblePanel 组件');
assert(src.includes("React.createElement(BubblePanel"), 'FloatingBubble 未挂载 BubblePanel');
assert(src.includes("'📋 任务'") && src.includes("'⚡ 常用'"), '泡泡缺少任务/常用标签');
assert(!/React\.createElement\(WorkbenchPanel, \{\}\),\s*\n\s*React\.createElement\('div', \{ className: 'iris-wb-muted' \}, '完整工作台/.test(src), '泡泡不应再塞完整工作台');
assert(new RegExp('function\\s+HistoryBrowser\\s*\\(').test(src), '缺少 HistoryBrowser 历史浏览器');
assert(src.includes("'今天'") && src.includes("'昨天'") && src.includes("'更早'"), '历史缺少日期分组');
assert(new RegExp('function\\s+BubbleCardPicker\\s*\\(').test(src), '缺少 BubbleCardPicker 常用卡片选择器');
assert(src.includes("type: 'checkbox'") && src.includes('iris-pick-item'), '常用卡片选择器缺少多项勾选');
assert(src.includes("'iris-bubble-cards'"), '缺少泡泡常用卡片 localStorage key');
assert(new RegExp('function\\s+CleanupBar\\s*\\(').test(src), '缺少 CleanupBar 清理区');
for (const act of ['tasks_clear', 'tasks_orphans', 'tasks_purge_orphans']) {
  assert(src.includes("'" + act + "'"), '清理区缺少动作调用 ' + act);
}
assert(src.includes('window.confirm'), '破坏性清理缺少二次确认');
assert(new RegExp('function\\s+taskRowMini\\s*\\(').test(src), '缺少紧凑任务行 taskRowMini');

console.log('ALL OK —— 客户端形态 3 座位 + 组件群 + 14 卡片注册表 + 能力分配 UI + 泡泡瘦身（标签/历史/选择器/清理）断言全部通过');