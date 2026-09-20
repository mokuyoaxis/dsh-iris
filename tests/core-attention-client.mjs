/**
 * 注意力处置与自动静默的客户端接线断言。
 * 运行：node tests/core-attention-client.mjs
 *
 * 覆盖：attention 行的「不再提醒」「移除」入口、已受理行的「恢复提醒」、隐藏行的
 * 「恢复显示」、hidden/suppressed 从任务区与泡泡过滤、acknowledged 移入历史、
 * 诊断层可见处置状态、文案不含"删除任务"且 URL 出口仍只有一处。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

/* bundle 仍完整执行并注册四个座位 */
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
    prompt() { return null; },
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

/* 处置按钮组合：attention 行两个入口，已受理行恢复提醒，隐藏行恢复显示 */
assert(/function\s+CoreDispositionButtons\s*\(/.test(src), '缺少 CoreDispositionButtons 组合');
const disposeBody = src.slice(src.indexOf('function CoreDispositionButtons'), src.indexOf('/* 只读卡片'));
for (const [label, snippet] of [
  ['不再提醒', "action: 'acknowledge'"],
  ['移除', "action: 'hide'"],
  ['恢复提醒', "action: 'restore'"],
  ['恢复显示', "action: 'unhide'"]
]) {
  assert(disposeBody.includes(snippet) && disposeBody.includes(label),
    '处置组合缺少入口：' + label, snippet);
}
assert(disposeBody.includes("row.suppressed === true") && disposeBody.includes('return null'),
  '自动静默的行不得再显示处置入口');
assert(disposeBody.includes("row.historical === true"),
  'canceled 历史行不得继续显示注意力处置入口');
assert(disposeBody.includes("row.disposition === 'hidden'"),
  '隐藏行必须改为只提供恢复显示');
assert(disposeBody.includes("row.userState === 'attention' || row.userState === 'delivery_failed'"),
  '处置入口必须限定在 attention/delivery_failed 行');
assert(disposeBody.includes('仅在本机隐藏') && disposeBody.includes('记录保留'),
  '移除文案必须说明仅本机隐藏且记录保留');
assert(!disposeBody.includes('删除任务'), '处置文案不得出现"删除任务"字样');

/* 分区过滤：hidden/suppressed 消失，canceled/acknowledged 进历史 */
const splitBody = src.slice(src.indexOf('function splitCoreUserRows'), src.indexOf('function CoreRuntimePanel'));
assert(splitBody.includes("row.suppressed === true || row.disposition === 'hidden'") && splitBody.includes('continue'),
  'hidden/suppressed 行必须从用户任务区过滤');
assert(splitBody.includes("row.historical === true") && splitBody.includes('done.push(row)'),
  'canceled historical 行必须进入历史而不是 attention');
assert(splitBody.includes('acknowledged.push(row)') && splitBody.includes('acknowledged: acknowledged'),
  'acknowledged 行必须改入历史分区');
assert(src.includes('coreHistory: [].concat(coreGroups.done, coreGroups.acknowledged)'),
  '历史区必须合并完成项与已受理项');

/* 卡片与诊断挂载 */
const cardBody = src.slice(src.indexOf('function coreTaskCard'), src.indexOf('function coreTaskMini'));
assert(cardBody.includes('React.createElement(CoreDispositionButtons, { row: row })'),
  'Core 任务行必须挂载处置入口');
const panelBody = src.slice(src.indexOf('function CoreRuntimePanel'), src.indexOf('/* ---- 泡泡常用卡片选择器'));
assert(panelBody.includes('dispositionMap') && panelBody.includes("disposition === 'hidden'")
  && panelBody.includes('React.createElement(CoreDispositionButtons'),
  '高级诊断必须保留隐藏行、标注并允许恢复显示');
for (const label of ['已在本机隐藏（记录保留，可恢复显示）', '已设「不再提醒」（本机偏好，记录保留）',
  '已由新任务成功交付自动静默']) {
  assert(src.includes(label), '诊断层缺少处置状态文案：' + label);
}

/* 泡泡跟随同一分区（亮度仍只由 Provider 健康决定） */
const bubbleBody = src.slice(src.indexOf('function BubblePanel'), src.indexOf('function PromptOptimizerControl'));
assert(bubbleBody.includes('splitCoreUserRows(coreUser.rows || [])'),
  '泡泡必须共用同一分区过滤');
assert(!/overallHealth[^;]*(coreGroups|userTasks|suppressed|disposition)/.test(src),
  '泡泡亮度不得混入注意力处置状态');

/* URL 出口仍只有 CoreTaskManualButton 一处；Core 处置路径不得出现"删除任务" */
const coreTaskUrls = src.match(/\/iris\/api\/core\/task\//g) || [];
assert(coreTaskUrls.length === 1, 'Core Task 动作 URL 必须仍由单步动作组件统一拼接', coreTaskUrls.length);
const coreScope = src.slice(src.indexOf('function CoreReobserveButton'), src.indexOf('function coreTaskMini'));
assert(!coreScope.includes('删除任务'), 'Core 处置路径不得出现"删除任务"文案');

console.log('ALL OK —— 注意力处置客户端：四入口、过滤、历史归位、诊断可见与文案边界');
