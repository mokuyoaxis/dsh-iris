/**
 * D2 redeliver —— 客户端接线静态断言 + 投影 redeliverable 门真值表。
 * 运行：node tests/redeliver-client.mjs
 *
 * 覆盖：「重新取回作品」只在投影标记 redeliverable（唯一对应 delivery_failed）
 * 时出现；按钮禁用与防重复同 D1；URL 统一经 CoreTaskManualButton 拼接指向
 * /iris/api/core/task/:id/redeliver；文案明确"不再次生成/不增加生成费用"。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  coreTaskRedeliverable,
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

/* redeliver 动作组件：只在投影 redeliverable 时出现 */
assert(/function\s+CoreRedeliverButton\s*\(/.test(src), '缺少 CoreRedeliverButton 组件');
const redeliverBody = src.slice(src.indexOf('function CoreRedeliverButton'), src.indexOf('/* 只读卡片'));
assert(redeliverBody.includes("props.row.redeliverable !== true") && redeliverBody.includes('return null')
  && redeliverBody.includes("action: 'redeliver'")
  && redeliverBody.includes('重新取回作品') && redeliverBody.includes('取回中…'),
  'redeliver 按钮必须只在 redeliverable 时渲染、指向 redeliver 动作并使用取回文案');
assert(redeliverBody.includes('不会再次生成') && redeliverBody.includes('不会增加生成费用'),
  'redeliver 文案必须明确不再次生成、不增加生成费用');

/* 动作 URL 全 bundle 仍然只有一处拼接来源（D1/D2 共用） */
const coreTaskUrls = src.match(/\/iris\/api\/core\/task\//g) || [];
assert(coreTaskUrls.length === 1,
  'Core Task 动作 URL 必须由 CoreTaskManualButton 统一拼接', coreTaskUrls.length);
assert(!redeliverBody.includes('/submit') && !redeliverBody.includes('run image'),
  'redeliver 动作不得新建任何提交或重新生成路径');

/* 用户任务区卡片与高级诊断都挂同一动作 */
const cardBody = src.slice(src.indexOf('function coreTaskCard'), src.indexOf('function coreTaskMini'));
assert(cardBody.includes('React.createElement(CoreRedeliverButton, { row: row })'),
  'Core 投影卡片必须挂载 redeliver 动作入口');
assert(!cardBody.includes('fetch('), 'Core 投影卡片本体仍不得直接请求网络');
const panelBody = src.slice(src.indexOf('function CoreRuntimePanel'), src.indexOf('/* ---- 泡泡常用卡片选择器'));
assert(panelBody.includes('React.createElement(CoreRedeliverButton')
  && panelBody.includes("selectedTask.outcome === 'succeeded'")
  && panelBody.includes("selectedTask.deliveryState === 'failed'")
  && panelBody.includes('selectedTask.remoteTaskId'),
  '高级诊断的 redeliver 入口必须按交付事实门启用');

/* redeliverable 门真值表：唯一可交付状态是 succeeded+failed（五类中的 delivery_failed） */
function rowWith(overrides) {
  return projectCoreTaskUserRow({
    id: 'task_' + 'a'.repeat(24), capability: 'image', phase: 'running',
    acceptance: 'accepted', remoteTaskId: 'remote-1', outcome: 'none',
    deliveryState: 'none', watchState: 'idle', artifactIds: [], revision: 3,
    ...overrides
  });
}
const truthTable = [
  ['delivery_failed（唯一开放）', { outcome: 'succeeded', deliveryState: 'failed' }, true],
  ['running', { outcome: 'succeeded', deliveryState: 'downloading' }, false],
  ['succeeded', { outcome: 'succeeded', deliveryState: 'ready', phase: 'terminal', artifactIds: [] }, false],
  ['attention（失败）', { outcome: 'failed', phase: 'terminal' }, false],
  ['attention（受理未知）', { acceptance: 'unknown', remoteTaskId: '', outcome: 'unknown' }, false],
  ['成功但远端 ID 丢失', { outcome: 'succeeded', deliveryState: 'failed', remoteTaskId: '' }, false]
];
for (const [label, overrides, expected] of truthTable) {
  const row = rowWith(overrides);
  assert(row.redeliverable === expected, '投影 redeliverable 真值表不符：' + label, { row, expected });
  assert(coreTaskRedeliverable({
    acceptance: overrides.acceptance ?? 'accepted',
    remoteTaskId: 'remoteTaskId' in overrides ? overrides.remoteTaskId : 'remote-1',
    outcome: overrides.outcome ?? 'none',
    deliveryState: overrides.deliveryState ?? 'none',
    phase: overrides.phase ?? 'running'
  }) === expected, 'coreTaskRedeliverable 与行 DTO 必须一致：' + label);
}
assert(coreTaskRedeliverable(null) === false && coreTaskRedeliverable([]) === false,
  '畸形输入必须判为不可重新交付');
const failedRow = rowWith({ outcome: 'succeeded', deliveryState: 'failed' });
assert(failedRow.userState === 'delivery_failed' && failedRow.redeliverable === true
    && failedRow.observable === false,
  'delivery_failed 是唯一 redeliverable 的五类状态，且它不可 reobserve', failedRow);

console.log('ALL OK —— D2 redeliver 客户端：交付事实门、防重复、文案边界与真值表');
