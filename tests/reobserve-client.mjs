/**
 * D1 reobserve —— 客户端接线静态断言 + 投影可观察门真值表。
 * 运行：node tests/reobserve-client.mjs
 *
 * 覆盖：「重新观察」只在投影标记 observable 时出现、按钮禁用条件与防重复提交、
 * 动作 URL 指向 /iris/api/core/task/…/reobserve、成功后复用刷新节拍，且不新增
 * 任何未经确认的 submit 路径；五类用户状态下投影 observable 布尔真值表。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  coreTaskObservable,
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

/* reobserve 动作组件：只在投影 observable 时出现；URL 统一经单步动作组件拼接 */
assert(/function\s+CoreReobserveButton\s*\(/.test(src), '缺少 CoreReobserveButton 组件');
const buttonBody = src.slice(src.indexOf('function CoreTaskManualButton'), src.indexOf('/* 只读卡片'));
const reobserveBody = src.slice(src.indexOf('function CoreReobserveButton'), src.indexOf('function CoreRedeliverButton'));
assert(reobserveBody.includes("props.row.observable !== true") && reobserveBody.includes('return null')
  && reobserveBody.includes("action: 'reobserve'"),
  'reobserve 按钮必须在投影未标记可观察时完全不渲染，并指向 reobserve 动作');
assert(buttonBody.includes("'/iris/api/core/task/' + encodeURIComponent(props.id) + '/' + props.action"),
  '动作 URL 必须统一指向 /iris/api/core/task/:id/<action>');
assert(buttonBody.includes("method: 'POST'"), '动作必须是显式 POST');
assert(buttonBody.includes('if (busy) return') && buttonBody.includes('disabled: busy'),
  '点击期间必须禁用按钮并在前端防重复提交');
assert(buttonBody.includes("dispatchEvent(new CustomEvent('iris-core-refresh-tick'))"),
  '成功后必须复用刷新节拍重拉任务区快照');
assert(buttonBody.includes("'重新观察'") && buttonBody.includes("'观察中…'")
  && buttonBody.includes('绝不重新提交'),
  '按钮文案必须说明单步观察语义');
assert(!buttonBody.includes('/submit') && !buttonBody.includes('run image'),
  'reobserve 动作不得新建任何提交路径');

/* /iris/api/core/task/ 全 bundle 只允许 reobserve/redeliver 这两个动作出口（不新增未确认写路径） */
const coreTaskUrls = src.match(/\/iris\/api\/core\/task\//g) || [];
assert(coreTaskUrls.length === 1,
  'Core Task 动作 URL 必须由单步动作组件统一拼接', coreTaskUrls.length);

/* 用户任务区卡片挂同一动作；卡片本体保持无 fetch（网络隔离在动作子组件） */
const cardBody = src.slice(src.indexOf('function coreTaskCard'), src.indexOf('function coreTaskMini'));
assert(cardBody.includes('React.createElement(CoreReobserveButton, { row: row })'),
  'Core 投影卡片必须挂载 reobserve 动作入口');
assert(!cardBody.includes('fetch('), 'Core 投影卡片本体仍不得直接请求网络');

/* 高级诊断卡挂同一动作，且仅对已受理、有远端 ID、结果未定论、非终态的事实启用 */
const detailButton = src.slice(src.indexOf('function CoreRuntimePanel'), src.indexOf('/* ---- 泡泡常用卡片选择器'));
assert(detailButton.includes('React.createElement(CoreReobserveButton')
  && detailButton.includes("selectedTask.acceptance === 'accepted'")
  && detailButton.includes('selectedTask.remoteTaskId')
  && detailButton.includes("['none', 'unknown'].indexOf(selectedTask.outcome) >= 0")
  && detailButton.includes("selectedTask.phase !== 'terminal'"),
  '高级诊断的 reobserve 入口必须按受理事实门启用');

/* 五类用户状态下投影 observable 真值表（服务端行 DTO 与服务端门同源事实） */
function rowWith(overrides) {
  return projectCoreTaskUserRow({
    id: 'task_' + 'a'.repeat(24), capability: 'image', phase: 'running',
    acceptance: 'accepted', remoteTaskId: 'remote-1', outcome: 'none',
    deliveryState: 'none', watchState: 'idle', artifactIds: [], revision: 3,
    ...overrides
  });
}
const truthTable = [
  ['running', {}, true],
  ['observation_paused', { watchState: 'suspended' }, true],
  ['succeeded', { outcome: 'succeeded', deliveryState: 'ready', artifactIds: [], phase: 'terminal' }, false],
  ['delivery_failed', { outcome: 'succeeded', deliveryState: 'failed', phase: 'running' }, false],
  ['attention（失败）', { outcome: 'failed', phase: 'terminal' }, false],
  ['attention（受理未知）', { acceptance: 'unknown', remoteTaskId: '', outcome: 'unknown' }, false],
  ['没有远端 ID', { remoteTaskId: '' }, false]
];
for (const [label, overrides, expected] of truthTable) {
  const row = rowWith(overrides);
  assert(row.observable === expected,
    '投影 observable 真值表不符：' + label, { row, expected });
  assert(coreTaskObservable({ ...overrides,
    acceptance: overrides.acceptance ?? 'accepted',
    remoteTaskId: 'remoteTaskId' in overrides ? overrides.remoteTaskId : 'remote-1',
    outcome: overrides.outcome ?? 'none',
    phase: overrides.phase ?? 'running'
  }) === expected,
  'coreTaskObservable 与行 DTO 必须一致：' + label);
}
assert(coreTaskObservable(null) === false && coreTaskObservable('task_x') === false,
  '畸形输入必须判为不可观察');

console.log('ALL OK —— D1 reobserve 客户端：可观察门、防重复提交、唯一动作出口与五类真值表');
