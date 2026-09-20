/**
 * D4 retry as new task —— 客户端接线静态断言 + 投影 retryable 门真值表。
 * 运行：node tests/retry-client.mjs
 *
 * 覆盖：「重试为新任务」只在投影标记 retryable 时出现；二次确认文案明确重复
 * 计费；retry 是唯一要求重新输入 prompt 的入口（prompt 来自 window.prompt 的
 * 用户输入，绝不从 Core record 恢复）；成功后提示新 Task ID；URL 仍只有
 * CoreTaskManualButton 一处拼接来源。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  coreTaskRetryable,
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

/* retry 动作组件：只在投影 retryable 时出现 */
assert(/function\s+CoreRetryButton\s*\(/.test(src), '缺少 CoreRetryButton 组件');
const retryBody = src.slice(src.indexOf('function CoreRetryButton'), src.indexOf('/* 只读卡片'));
assert(retryBody.includes("props.row.retryable !== true") && retryBody.includes('return null')
  && retryBody.includes("action: 'retry'")
  && retryBody.includes('重试为新任务') && retryBody.includes('创建中…'),
  'retry 按钮必须只在 retryable 时渲染、指向 retry 动作');
assert(retryBody.includes('confirm:') && retryBody.includes('将创建一个新任务并可能产生重复生成费用'),
  'retry 必须携带明确重复计费的二次确认文案');
assert(retryBody.includes("createdPrefix: '已创建新任务：'"),
  'retry 成功后必须提示新 Task ID（新旧关系对调用方可见）');

/* retry 是唯一要求重新输入 prompt 的入口：来源是 window.prompt 用户输入 */
assert(retryBody.includes('buildBody:') && retryBody.includes('window.prompt(')
  && retryBody.includes('Core 记录不保存生成指令')
  && retryBody.includes('confirmBilling: true'),
  'retry 必须用 window.prompt 重新收集 prompt 并显式带 confirmBilling:true');
const manualBody = src.slice(src.indexOf('function CoreTaskManualButton'), src.indexOf('function CoreReobserveButton'));
assert(manualBody.includes('props.buildBody ? props.buildBody() : {}')
  && manualBody.includes('if (body === null) return'),
  '通用动作按钮必须支持动态 body，且用户取消输入时直接中止（零请求）');
const reobserveBody = src.slice(src.indexOf('function CoreReobserveButton'), src.indexOf('function CoreRedeliverButton'));
const redeliverBody = src.slice(src.indexOf('function CoreRedeliverButton'), src.indexOf('function CoreCancelButton'));
const cancelBody = src.slice(src.indexOf('function CoreCancelButton'), src.indexOf('function CoreRetryButton'));
assert(!reobserveBody.includes('buildBody') && !redeliverBody.includes('buildBody') && !cancelBody.includes('buildBody')
  && !reobserveBody.includes('window.prompt') && !redeliverBody.includes('window.prompt') && !cancelBody.includes('window.prompt'),
  'reobserve/redeliver/cancel 不得收集输入：只有 retry 要求重新提供 prompt');

/* 动作 URL 全 bundle 仍然只有一处拼接来源（D1-D4 共用），且不得新建提交路径 */
const coreTaskUrls = src.match(/\/iris\/api\/core\/task\//g) || [];
assert(coreTaskUrls.length === 1,
  'Core Task 动作 URL 必须由 CoreTaskManualButton 统一拼接', coreTaskUrls.length);
assert(!retryBody.includes('/submit') && !retryBody.includes('run image'),
  'retry 走 task.retry 命令（新建 Task 由服务端候选链承担），客户端不得新建提交路径');

/* 用户任务区卡片与高级诊断都挂同一动作（诊断按终态未成功交付启用） */
const cardBody = src.slice(src.indexOf('function coreTaskCard'), src.indexOf('function coreTaskMini'));
assert(cardBody.includes('React.createElement(CoreRetryButton, { row: row })'),
  'Core 投影卡片必须挂载 retry 动作入口');
assert(!cardBody.includes('fetch('), 'Core 投影卡片本体仍不得直接请求网络');
const panelBody = src.slice(src.indexOf('function CoreRuntimePanel'), src.indexOf('/* ---- 泡泡常用卡片选择器'));
assert(panelBody.includes('React.createElement(CoreRetryButton')
  && panelBody.includes("selectedTask.phase === 'terminal'")
  && panelBody.includes("selectedTask.deliveryState === 'ready'"),
  '高级诊断的 retry 入口必须按终态且未成功交付的门启用');
assert(panelBody.includes("'重试来源'") && panelBody.includes('selectedTask.retriedFrom'),
  '诊断详情必须展示新任务的 retriedFrom 关系');

/* retryable 门真值表：终态且未成功交付才允许重试 */
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
  ['succeeded+ready（唯一关闭）', { outcome: 'succeeded', deliveryState: 'ready', phase: 'terminal', artifactIds: [] }, false],
  ['failed 终态', { outcome: 'failed', phase: 'terminal' }, true],
  ['unknown 终态', { outcome: 'unknown', phase: 'terminal', cancelState: 'unknown' }, true],
  ['canceled 终态', { outcome: 'canceled', phase: 'terminal', cancelState: 'remote_confirmed' }, true],
  ['not_accepted 终态', { acceptance: 'not_accepted', remoteTaskId: '', phase: 'terminal' }, true],
  ['delivery_failed 终态（redeliver 更省，但重试也合法）', { outcome: 'succeeded', deliveryState: 'failed', phase: 'terminal' }, true],
  ['非终态运行中', { outcome: 'none', phase: 'running' }, false]
];
for (const [label, overrides, expected] of truthTable) {
  const row = rowWith(overrides);
  assert(row.retryable === expected, '投影 retryable 真值表不符：' + label, { row, expected });
  assert(coreTaskRetryable({
    outcome: overrides.outcome ?? 'none',
    deliveryState: overrides.deliveryState ?? 'none',
    phase: overrides.phase ?? 'running'
  }) === expected, 'coreTaskRetryable 与行 DTO 必须一致：' + label);
}
assert(coreTaskRetryable(null) === false && coreTaskRetryable([]) === false,
  '畸形输入必须判为不可重试');

console.log('ALL OK —— D4 retry 客户端：计费确认文案、prompt 重新输入、关系展示与门真值表');
