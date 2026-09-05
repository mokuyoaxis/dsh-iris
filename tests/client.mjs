/**
 * dsh-iris 客户端形态冒烟（静态检查 lib/client.js）。
 * 运行：node tests/client.mjs
 * 不依赖浏览器 —— 验证三个座位注册与悬浮泡泡的结构性存在，
 * 防止后续重构把「设置页工作台 / 输入框进度条 / 主界面悬浮泡泡」改丢。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
};

/* ⓪ DSH 0.1.2+ 按完整 npm 包名核对 bundle 注册身份。 */
assert(src.includes("window.__ModuleLoader__.load({ id: '@mokuyoaxis/dsh-iris'"),
  'client bundle 必须以完整 scoped npm 包名注册');
assert(!src.includes("window.__ModuleLoader__.load({ id: 'dsh-iris'"),
  'client bundle 不得继续使用旧短名注册');

/* 不只匹配文本：执行 bundle，确认 loader 身份、导出及 apply 座位注册均成立。 */
const registrations = [];
const appendedStyles = [];
const sandbox = {
  console: { log() {}, error() {} },
  document: {
    getElementById() { return null; },
    createElement() { return { dataset: {} }; },
    head: { appendChild(node) { appendedStyles.push(node); } }
  },
  window: { __ModuleLoader__: { load(entry) { registrations.push(entry); } } }
};
sandbox.globalThis = sandbox.window;
vm.runInNewContext(src, sandbox, { filename: 'lib/client.js', timeout: 5000 });
assert(registrations.length === 1, 'client bundle 必须且只能注册一个 loader entry');
assert(registrations[0].id === '@mokuyoaxis/dsh-iris', 'loader entry id 与 npm 包名不一致');
const clientModule = registrations[0].factory((request) => {
  if (request === 'react') return { createElement() {} };
  throw new Error('意外的客户端依赖：' + request);
});
assert(JSON.stringify(clientModule.inject) === JSON.stringify(['slots']), 'client 导出的 Cordis inject 必须为 slots');
const slotRegistrations = [];
clientModule.apply({ slots: {
  inject(name, callback) { return callback(); },
  register(meta, component) {
    slotRegistrations.push({ name: meta.name, id: meta.id, component });
    return () => {};
  }
} });
assert(appendedStyles.length === 1, 'client apply 应注入一份 Iris 样式');
assert(slotRegistrations.length === 3, 'client apply 必须注册三个座位');
assert(slotRegistrations.every((item) => typeof item.component === 'function'), '三个座位必须注册 React 组件');

/* ① 三个座位注册必须存在 */
assert(src.includes("ctx.slots.inject('settings.section'"), '缺少 settings.section 注册');
assert(src.includes("id: 'iris-workbench'"), '缺少 iris-workbench 座位 id');
assert(src.includes("ctx.slots.inject('conversation.input.dock'"), '缺少 conversation.input.dock 注册');
assert(src.includes("id: 'iris-progress'"), '缺少 iris-progress 座位 id');
assert(src.includes("ctx.slots.inject('shell.overlay'"), '缺少 shell.overlay 注册');
assert(src.includes("id: 'iris-bubble'"), '缺少 iris-bubble 座位 id');
assert(src.includes("label: function () { return 'Iris 工作台'; }"), '设置页正式名称应为 Iris 工作台');
assert(!src.includes('Iris 泡泡工作台'), '正式名称不应继续使用 Iris 泡泡工作台');
assert(src.includes("label: function () { return 'Iris 泡泡'; }"), '悬浮入口应保留 Iris 泡泡名称');

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
assert(src.includes("capability: cap, model_refs: refs"), '缺少复合引用有序列表保存调用（model_refs 数组）');
for (const capRow of ["cap: 'image-gen'", "cap: 'video-gen'", "cap: 'tts'", "cap: 'transcribe'", "cap: 'vision'"]) {
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

/* ⑦ P1：分配唯一入口——ActionCard 不再写 assignments（消除互相覆盖） */
assert(!/capability:\s*capability,\s*model_id:/.test(src), 'ActionCard 仍在写单值 model_id 分配（应移除，唯一入口是 CapabilityAssigner）');
assert(!/function\s+assignModel/.test(src), '残留 assignModel（旧下拉写入口）');
assert(src.includes('改分配 → 上方「能力分配'), '卡片缺少只读模型提示（引导去唯一入口）');
// 唯一写入口：CapabilityAssigner 用 provider+model 复合引用数组
assert((src.match(/model_refs:/g) || []).length >= 1, 'CapabilityAssigner 应通过 model_refs 复合引用数组写分配');

/* ⑧ 阶段 9 P4：模型池 UI（发现/手动 + verified 标记 + 逐模型测试/移除 + 手动添加） */
assert(new RegExp('function\\s+ModelPool\\s*\\(').test(src), '缺少 ModelPool 组件');
assert(src.includes('iris-pm-mrow'), '模型池缺少行渲染');
assert(src.includes('providers_test_model'), '缺少逐模型实测调用');
assert(src.includes('providers_remove_model'), '缺少逐模型移除调用');
assert(src.includes('providers_add_model'), '缺少手动添加模型调用');
assert(src.includes('providers_discover'), '缺少发现模型调用');
assert(/verBadge|verified/.test(src), '模型池缺少 verified 状态标记');
assert(src.includes('confirm_paid') && src.includes('可能产生费用'), '真实模型实测缺少费用确认');
assert(src.includes("capability === 'video-gen' || capability === 'transcribe'"), '视频/转写应走不提交空样本的跳过路径');
assert(src.includes("mediaProtocol: 'auto'") && src.includes('自动（按 Base URL 安全判断）'), '供应商表单缺少媒体协议安全自动判断');

/* ⑨ 阶段 10：文件选择器 FileField（看见并选文件，不手填路径） */
assert(new RegExp('function\\s+FileField\\s*\\(').test(src), '缺少 FileField 组件');
assert(src.includes('/iris/api/upload'), 'FileField 缺少上传端点调用');
assert(src.includes('attachments_list'), 'FileField 缺少附件枚举调用');
assert(src.includes('attachment_export'), 'FileField 缺少附件导出调用');
assert(src.includes('ctx.sessions') || src.includes('sessions.list'), '客户端缺少当前会话 id 读取（ctx.sessions）');
assert(src.includes("'💻 上传文件'") && src.includes("'📎 会话附件'") && src.includes("'⌨️ 高级 · 宿主路径'"), 'FileField 三来源按钮标签不符（上传文件/会话附件/高级·宿主路径）');
/* 上传优先：💻 排在 📎 与 ⌨️ 之前，且带 primary 强调；宿主路径降为 ghost 虚线 */
var iUp = src.indexOf("'💻 上传文件'"), iAtt = src.indexOf("'📎 会话附件'"), iPath = src.indexOf("'⌨️ 高级 · 宿主路径'");
assert(iUp > 0 && iUp < iAtt && iAtt < iPath, 'FileField 来源顺序应为 上传 → 会话附件 → 宿主路径');
assert(/\.iris-ff-btn\.primary/.test(src) && src.includes("className: 'iris-ff-btn primary'"), '上传按钮缺少 primary 强调样式');
assert(/\.iris-ff-btn\.ghost/.test(src) && src.includes("className: 'iris-ff-btn ghost'"), '宿主路径按钮缺少 ghost 弱化样式');
assert(/className: 'iris-ff-hint'[\s\S]{0,240}WSL/.test(src), 'FileField 缺少"跨设备/WSL/安卓建议用上传"提示语');
assert(/value \? null : React\.createElement\('div', \{ className: 'iris-ff-hint'/.test(src), 'FileField 提示语应仅在未选文件时出现（选后不占位）');
assert(/placeholder: '高级：粘贴 DSH 宿主上的绝对路径/.test(src), '手输框未标注为宿主路径语义');
/* 活体走查发现：旧 useState(!value) 让空字段默认摊出高级路径框，与"上传优先"相反 */
var ffBody = src.slice(src.indexOf('function FileField'), src.indexOf('function ActionCard'));
assert(/useState\(!value/.test(ffBody) === false, 'FileField 高级路径框不应默认展开（上传优先）');
assert(/var manualPair = React\.useState\(false\)/.test(ffBody), 'FileField manual 初值应为 false');
assert((src.match(/type: 'file'/g) || []).length >= 8, '卡片路径字段未转 FileField（应 ≥8 处 type:file）');

console.log('ALL OK —— 客户端形态 3 座位 + 组件群 + 14 卡片注册表 + 能力分配 UI + 泡泡瘦身 + 分配唯一入口 + 模型池 UI + 文件选择器 断言全部通过');
