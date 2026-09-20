/**
 * Core 用户侧只读投影的客户端形态验收（静态断言 + bundle 执行）。
 * 运行：node tests/client-core-user-tasks.mjs
 *
 * 覆盖：五类状态文案、legacy+Core 合并进同一任务区/作品区、完成提示去重、
 * 窄屏布局、只读边界（卡片无 fetch/写动作）、敏感的供应商事实不进普通任务区。
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

/* bundle 必须仍能完整执行并注册（防止投影接线引入语法/运行时错误） */
const registrations = [];
const reactStub = {
  createElement(type, props, ...children) { return { type, props: { ...(props || {}), children } }; },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
  useEffect() {},
  useMemo(factory) { return factory(); },
  useRef(initial) { return { current: initial }; },
  useCallback(callback) { return callback; }
};
const localStorageStub = { getItem() { return null; }, setItem() {}, removeItem() {} };
const sandbox = {
  console: { log() {}, error() {} },
  localStorage: localStorageStub,
  document: {
    getElementById() { return null; },
    createElement() { return { dataset: {} }; },
    head: { appendChild() {} }
  },
  window: {
    innerWidth: 412, innerHeight: 915, localStorage: localStorageStub,
    addEventListener() {}, removeEventListener() {}, confirm() { return false; },
    fetch() { return Promise.resolve({ ok: true }); },
    __ModuleLoader__: { load(entry) { registrations.push(entry); } }
  }
};
sandbox.globalThis = sandbox.window;
vm.runInNewContext(src, sandbox, { filename: 'lib/client.js', timeout: 5000 });
assert(registrations.length === 1, 'client bundle 必须仍注册一个 loader entry');
const seats = [];
registrations[0].factory((request) => {
  if (request === 'react') return reactStub;
  throw new Error('意外的客户端依赖：' + request);
}).apply({ slots: { inject(name, callback) { return callback(); }, register(meta, component) { seats.push(component); return () => {}; } } });
assert(seats.length === 4, '四个座位必须仍然全部注册');

/* 工作台/泡泡任务区读取 snapshot 的 userTasks 安全 DTO（消费既有只读端点，不新增 Core API） */
assert(/function\s+useCoreUserTasks\s*\(/.test(src), '缺少 useCoreUserTasks 任务投影 hook');
const hookBody = src.slice(src.indexOf('function useCoreUserTasks'), src.indexOf('/* 五类用户状态'));
assert(hookBody.includes("fetch('/iris/api/core/snapshot?limit=200')")
  && hookBody.includes('data.userTasks') && hookBody.includes('data.degraded'),
  '任务投影 hook 必须读取 snapshot 的 userTasks/degraded 字段');

/* 五类状态文案：远端未定论与明确失败必须区分（服务端 projection 与诊断面板 client 副本同文案） */
for (const label of ['运行中', '观察已暂停，远端可能仍在运行', '已生成，正在保存作品',
  '提交结果未知，请检查后处理', '任务结果未知，需要检查', '已失败', '已取消',
  '已生成，作品取回失败', '已完成，作品可用']) {
  assert(src.includes(label), '客户端缺少五类投影文案：' + label);
}
assert(/function\s+coreTaskState\s*\(task\)[\s\S]*?observation_paused/.test(src)
  && src.includes('state: \'succeeded\'') && src.includes('state: \'delivery_failed\''),
  '高级诊断 coreTaskState 必须收敛为五类用户状态投影');

/* legacy 与 Core 同时存在时：只有一个用户任务区（运行中/需要处理/历史同一组件树），也只有一个作品区 */
assert((src.match(/React\.createElement\(ArtifactGallery, \{/g) || []).length === 1,
  '必须只有一个统一作品区（legacy 与 Core 作品仍在同一 ArtifactGallery）');
const workbenchBody = src.slice(src.indexOf('function WorkbenchPanel'), src.indexOf('/* ---- 泡泡浮层'));
assert(workbenchBody.includes('var coreUser = useCoreUserTasks()')
  && workbenchBody.includes('var coreGroups = splitCoreUserRows(coreUser.rows || [])'),
  '工作台必须消费 Core 用户投影');
assert(workbenchBody.includes('running.length || coreGroups.live.length')
  && workbenchBody.includes('coreGroups.live.map(coreTaskCard)'),
  '运行中区必须合并 legacy 与 Core 投影行（同一分区，不是新面板）');
assert(workbenchBody.includes('attention.length || coreGroups.attention.length')
  && workbenchBody.includes('coreGroups.attention.map(coreTaskCard)'),
  '需要处理区必须合并 legacy 与 Core 投影行');
assert(workbenchBody.includes('coreHistory: [].concat(coreGroups.done, coreGroups.acknowledged)'),
  '历史区必须追加 Core 完成项与已受理（不再提醒）的异常行');
const historyBody = src.slice(src.indexOf('function HistoryBrowser'), src.indexOf('function fmtBytes'));
assert(historyBody.includes('coreHistory') && historyBody.includes('coreTaskCard(entry.core)')
  && historyBody.includes('taskRow(entry.legacy'),
  '历史浏览器必须把 Core 完成项与 legacy 记录渲染进同一历史分区');
const bubbleBody = src.slice(src.indexOf('function BubblePanel'), src.indexOf('function PromptOptimizerControl'));
assert(bubbleBody.includes('useCoreUserTasks()') && bubbleBody.includes('coreGroups.live')
  && bubbleBody.includes('coreGroups.attention'), '泡泡任务区必须合并 Core 投影行');
assert(bubbleBody.includes('noteCoreCompletions(coreUser.rows || [])'),
  '泡泡必须从 Core 事实计算新完成提示');

/* 同一 snapshot 重复渲染不重复提示：会话内 Map + core:id@revision 键 + 首屏基线 */
assert(/function\s+noteCoreCompletions\s*\(rows\)/.test(src)
  && src.includes('coreCompletionSeen === null')
  && src.includes("'core:' + row.id + '@' + Number(row.revision || 0)"),
  '完成提示缺少会话内去重（基线 + core:id@revision 键）');

/* 只读边界：投影卡片不 fetch、不调写动作、没有展开/删除入口；窄屏布局断点存在 */
function bodyOf(fnName, endMarker) {
  return src.slice(src.indexOf('function ' + fnName), src.indexOf(endMarker));
}
for (const scope of ['coreTaskCard', 'coreTaskMini']) {
  const end = scope === 'coreTaskCard' ? 'function coreTaskMini' : 'function splitCoreUserRows';
  const body = bodyOf(scope, end);
  assert(!body.includes('fetch(') && !body.includes('postAction') && !body.includes('useTaskDetail'),
    scope + ' 必须纯渲染：不得请求网络或写动作');
  for (const leak of ['providerId', 'providerBinding', 'lastError', 'safeMessage']) {
    assert(!body.includes(leak), scope + ' 不得渲染供应商身份/binding/错误原文：' + leak);
  }
}
assert(src.includes('只读投影：更多事实见下方「高级诊断 · Core 任务事实」'),
  'Core 投影卡片必须标注只读并指向高级诊断');
assert(bodyOf('coreTaskCard', 'function coreTaskMini').includes("'▶ 作品 ' + (index + 1)"),
  'Core 投影卡片必须提供关联作品链接');
assert(src.includes('作品文件暂时不可用'), '缺少媒体不可用的卡片降级文案');
assert(src.includes('部分 Core 记录损坏或媒体缺失，已跳过 '), '缺少 degraded 局部降级提示');
assert(src.includes('@media (max-width: 420px) { .iris-core-user-head')
  && src.includes('.iris-core-user-row .iris-core-id { grid-column: 1 / -1; }'),
  '窄屏下 Core 投影行必须有把 Task ID/时间/模型拆行的断点，避免重叠');
assert(src.includes('onError: function (event)') && src.includes("note.textContent = '作品文件暂时不可用'"),
  '作品区图片缺少媒体丢失的局部降级（onError 占位）');

/* 泡泡亮度仍由 Provider 能力健康决定，单任务失败不得影响整灯 */
assert(src.includes("'iris-bubble health-' + overallHealth")
  && !/overallHealth[^;]*coreGroups/.test(src) && !/overallHealth[^;]*userTasks/.test(src),
  '泡泡亮度不得混入单个 Core 任务状态');
assert(src.includes("var badgeCount = running.length + attention.length"),
  '泡泡角标与亮度归属不得因 Core 投影改动既有健康口径');

/* CoreRuntimePanel 仍是唯一展示 Attempt 细节的高级诊断入口，且保持只读 */
assert(src.includes('不会重新提交、删除或修改既有任务'), '高级诊断面板缺少只读边界说明');

console.log('ALL OK —— 客户端 Core 用户投影：合并任务区、五类文案、去重、窄屏与只读边界断言全部通过');
