/**
 * D3 cancel —— 客户端接线静态断言 + 投影 cancelable 门真值表。
 * 运行：node tests/cancel-client.mjs
 *
 * 覆盖：「取消任务」只在投影标记 cancelable 时出现；改变远端事实必须二次确认；
 * 三种结果态文案区分（已确认取消 / 已请求未确认 / 不支持远端取消）且不含
 * "已取消"伪造字样；URL 仍只有 CoreTaskManualButton 一处拼接来源。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  coreTaskCancelable,
  projectCoreTaskUserRow
} from '../lib/core-user-projection.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

/* bundle 仍完整执行并注册四个座位（防止接线引入运行时错误） */
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

/* cancel 动作组件：只在投影 cancelable 时出现，且必须二次确认 */
assert(/function\s+CoreCancelButton\s*\(/.test(src), '缺少 CoreCancelButton 组件');
const cancelBody = src.slice(src.indexOf('function CoreCancelButton'), src.indexOf('/* 只读卡片'));
assert(cancelBody.includes("props.row.cancelable !== true") && cancelBody.includes('return null')
  && cancelBody.includes("action: 'cancel'")
  && cancelBody.includes('取消任务') && cancelBody.includes('取消中…'),
  '取消按钮必须只在 cancelable 时渲染、指向 cancel 动作');
assert(cancelBody.includes('confirm:') && cancelBody.includes('绝不伪造已取消')
  && cancelBody.includes('只有供应商明确确认'),
  '取消必须携带二次确认文案，且明示 unsupported/unknown 不伪造已取消');

/* 确认交互只在 cancel 入口；reobserve/redeliver 不得要求确认 */
const manualBody = src.slice(src.indexOf('function CoreTaskManualButton'), src.indexOf('/* 只读卡片'));
assert(manualBody.includes('props.confirm && !window.confirm(props.confirm)'),
  '通用动作按钮必须在携带 confirm 时执行浏览器二次确认');
const reobserveBody = src.slice(src.indexOf('function CoreReobserveButton'), src.indexOf('function CoreRedeliverButton'));
const redeliverBody = src.slice(src.indexOf('function CoreRedeliverButton'), src.indexOf('function CoreCancelButton'));
assert(!reobserveBody.includes('confirm:') && !redeliverBody.includes('confirm:'),
  'reobserve/redeliver 只读/取回类动作不得增加确认弹窗');

/* 动作 URL 全 bundle 仍然只有一处拼接来源（D1/D2/D3 共用） */
const coreTaskUrls = src.match(/\/iris\/api\/core\/task\//g) || [];
assert(coreTaskUrls.length === 1,
  'Core Task 动作 URL 必须由 CoreTaskManualButton 统一拼接', coreTaskUrls.length);
assert(!cancelBody.includes('/submit') && !cancelBody.includes('run image'),
  'cancel 动作不得新建任何提交或重新生成路径');

/* 用户任务区卡片与高级诊断都挂同一动作（诊断按完整事实轴启用） */
const cardBody = src.slice(src.indexOf('function coreTaskCard'), src.indexOf('function coreTaskMini'));
assert(cardBody.includes('React.createElement(CoreCancelButton, { row: row })'),
  'Core 投影卡片必须挂载取消动作入口');
assert(!cardBody.includes('fetch('), 'Core 投影卡片本体仍不得直接请求网络');
const panelBody = src.slice(src.indexOf('function CoreRuntimePanel'), src.indexOf('/* ---- 泡泡常用卡片选择器'));
assert(panelBody.includes('React.createElement(CoreCancelButton')
  && panelBody.includes("selectedTask.cancelState === 'none'")
  && panelBody.includes("['none', 'unknown'].indexOf(selectedTask.outcome) >= 0"),
  '高级诊断的取消入口必须按受理事实门启用（含未请求过取消）');

/* 诊断层三态文案区分：已确认 / 已请求未确认 / 本地确认，不把未确认显示成已取消 */
for (const label of ['供应商已明确确认取消', '已请求取消，远端结果未确认；可显式重新观察', '取消请求进行中', '无取消请求']) {
  assert(src.includes(label), '诊断层缺少取消状态文案：' + label);
}
assert(src.includes('coreCancelLabel(selectedTask.cancelState)'), '诊断详情必须展示 cancelState 事实');
const unsupportedPanelCopy = src.includes('事实面板：「重新观察」只查询远端最新状态')
  && src.includes('「取消任务」只有供应商明确确认才记为已取消');
assert(unsupportedPanelCopy, '诊断面板说明必须如实区分取消三种结果');

/* cancelable 门真值表：可观察超集 + 从未请求过取消 */
function rowWith(overrides) {
  return projectCoreTaskUserRow({
    id: 'task_' + 'a'.repeat(24), capability: 'image', phase: 'running',
    acceptance: 'accepted', remoteTaskId: 'remote-1', outcome: 'none',
    deliveryState: 'none', watchState: 'idle', cancelState: 'none',
    artifactIds: [], revision: 3,
    ...overrides
  });
}
const truthTable = [
  ['已受理未定论', {}, true],
  ['观察已暂停', { watchState: 'suspended' }, true],
  ['取消已请求未确认', { cancelState: 'unknown', outcome: 'unknown' }, false],
  ['取消请求进行中', { cancelState: 'requested' }, false],
  ['已取消', { outcome: 'canceled', phase: 'terminal', cancelState: 'remote_confirmed' }, false],
  ['succeeded ready', { outcome: 'succeeded', deliveryState: 'ready', phase: 'terminal', artifactIds: [] }, false],
  ['受理未知无远端 ID', { acceptance: 'unknown', remoteTaskId: '', outcome: 'unknown' }, false]
];
for (const [label, overrides, expected] of truthTable) {
  const row = rowWith(overrides);
  assert(row.cancelable === expected, '投影 cancelable 真值表不符：' + label, { row, expected });
  assert(coreTaskCancelable({
    acceptance: overrides.acceptance ?? 'accepted',
    remoteTaskId: 'remoteTaskId' in overrides ? overrides.remoteTaskId : 'remote-1',
    outcome: overrides.outcome ?? 'none',
    phase: overrides.phase ?? 'running',
    cancelState: overrides.cancelState ?? 'none'
  }) === expected, 'coreTaskCancelable 与行 DTO 必须一致：' + label);
}
assert(coreTaskCancelable(null) === false, '畸形输入必须判为不可取消');
const unknownRow = rowWith({ cancelState: 'unknown', outcome: 'unknown' });
assert(unknownRow.userState === 'attention' && unknownRow.observable === true
    && unknownRow.cancelable === false,
  '取消未确认仍是 attention（不伪造已取消）且可显式重新观察、不可重复取消', unknownRow);

console.log('ALL OK —— D3 cancel 客户端：二次确认、三分支文案、投影门与唯一动作出口');
