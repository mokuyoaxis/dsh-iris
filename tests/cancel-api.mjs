/**
 * D3 cancel —— DSH API 层验收：POST /iris/api/core/task/:id/cancel。
 * 运行：node tests/cancel-api.mjs
 *
 * 覆盖：
 * - 门真值表：坏 ID 400 / 未知 404 / 终态 409，全部零 Provider 调用。
 * - 真实 DashScope/openai-images adapter 均不支持远端取消（conformance 锁定）；
 *   API cancel 端到端走 not_supported：outcome 绝不伪造 canceled，响应无"已取消"。
 * - 幂等：重复 cancel 是零网络的安全重放；CLI `task cancel` 同一事实面。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempDshHome } from './test-env.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { root, cleanup } = useTempDshHome('iris-cancel-api');
process.env.IRIS_ASYNC_FIXTURE_STATE = path.join(root, 'fixture-state.json');
await import('./fixtures/headless-async-fetch.mjs');

const { upsert } = await import('../lib/config.js');
const {
  dshCoreDataRoot,
  submitProviderTaskForDsh
} = await import('../lib/dsh-core-adapter.js');
const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
const { hasProviderOperation } = await import('../lib/provider-adapter.js');
const { providerTaskBinding } = await import('../lib/provider-catalog.js');
const { serveApi } = await import('../lib/api.js');
const fixture = new URL('./fixtures/headless-async-fetch.mjs', import.meta.url).href;

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const provider = () => ({
  id: 'dash-main',
  enabled: true,
  apiKey: 'fixture-key-api',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope',
  models: [{ id: 'wan2.2-flash', capabilities: ['image-gen'] }]
});

const configFile = path.join(root, 'providers.json');
function state() {
  return JSON.parse(fs.readFileSync(process.env.IRIS_ASYNC_FIXTURE_STATE, 'utf8'));
}

function response() {
  return {
    headersSent: false, destroyed: false, writableEnded: false, status: 0, body: '',
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = body === undefined ? '' : String(body); this.writableEnded = true; }
  };
}

async function postAction(action, taskId) {
  const res = response();
  serveApi({
    method: 'POST',
    url: '/iris/api/core/task/' + taskId + '/' + action,
    on() { return this; }
  }, res);
  for (let i = 0; i < 400 && !res.writableEnded; i++) {
    await new Promise((resolve) => setImmediate(resolve)); // 路由异步消化后再断言
  }
  assert(res.writableEnded, action + ' 路由必须结束响应', res.status);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch (_) { /* 下面统一断言 */ }
  return { status: res.status, body: res.body, json: parsed };
}

function assertSafeBody(body, label) {
  assert(!String(body).includes(root) && !String(body).includes('fixture-key-api')
      && !String(body).includes('providerId') && !String(body).includes('providerBinding')
      && !String(body).includes('lastError'),
    label + ' 响应不得携带绝对路径、Key、供应商身份、binding 或错误原文', body);
}

try {
  /* conformance 锁定：真实媒体协议当前都不支持远端取消 */
  const dashAdapter = createConfiguredProviderAdapter(provider());
  const openaiAdapter = createConfiguredProviderAdapter({
    id: 'openai-main', apiKey: 'fixture-key-openai',
    baseUrl: 'https://api.openai.com/v1', mediaProtocol: 'openai-images'
  });
  assert(hasProviderOperation(dashAdapter, 'cancel') === false
      && hasProviderOperation(openaiAdapter, 'cancel') === false,
    'DashScope/openai-images adapter 当前不得暴露 cancel 操作');
  assert(JSON.stringify(dashAdapter.unsupported?.cancel?.reason || '').includes('未提供经过验证的远端取消')
      && JSON.stringify(openaiAdapter.unsupported?.cancel?.reason || '').includes('没有可验证的远端取消'),
    '真实 adapter 的“不支持取消”原因文案必须保留', {
      dash: dashAdapter.unsupported?.cancel, openai: openaiAdapter.unsupported?.cancel
    });

  const saved = upsert(provider());
  fs.writeFileSync(configFile, JSON.stringify({ providers: [saved] }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);

  async function submitFixture(prompt) {
    const submitted = await submitProviderTaskForDsh({
      capability: 'image',
      candidates: [{
        adapter: createConfiguredProviderAdapter(saved),
        model: saved.id + '::wan2.2-flash',
        providerBinding: providerTaskBinding(saved)
      }],
      providerInput: { prompt }
    });
    assert(submitted.task.acceptance === 'accepted', prompt + ' 必须被受理', submitted.task);
    return submitted.taskId;
  }

  const mainTaskId = await submitFixture('cancel api main');
  const doneTaskId = await submitFixture('cancel api done');

  /* 门真值表：坏 ID / 未知 / 终态 → 零调用拒绝 */
  const badShape = await postAction('cancel', 'not-a-task-id');
  assert(badShape.status === 400 && badShape.json?.error?.code === 'IRIS_DSH_TASK_INVALID'
      && state().poll === 0,
    '坏 ID 必须在 Provider 调用前 400 拒绝', badShape);
  assertSafeBody(badShape.body, '坏 ID');
  const missing = await postAction('cancel', 'task_' + '0'.repeat(24));
  assert(missing.status === 404 && missing.json?.error?.code === 'IRIS_TASK_NOT_FOUND'
      && state().poll === 0,
    '未知 Task 必须 404 且零调用', missing);
  assertSafeBody(missing.body, '未知 Task');

  /* 终态任务（驱动 doneTaskId 到 ready）：cancel → 409 零调用 */
  await postAction('reobserve', doneTaskId);
  const doneReady = await postAction('reobserve', doneTaskId);
  assert(doneReady.json.task.userState === 'succeeded', '前置：终态任务已完成', doneReady.json.task);
  const terminalReject = await postAction('cancel', doneTaskId);
  assert(terminalReject.status === 409 && terminalReject.json?.error?.code === 'IRIS_TASK_NOT_CANCELABLE'
      && state().poll === 2 && state().submit === 2,
    '终态 Task 取消必须 409 拒绝且零调用', terminalReject);
  assertSafeBody(terminalReject.body, '终态拒绝');

  /* 主任务：先观察一次（RUNNING），再 cancel → not_supported 端到端 */
  const observed = await postAction('reobserve', mainTaskId);
  assert(observed.json.task.cancelable === true && observed.json.task.userState === 'observation_paused',
    '可观察且未请求过取消的任务必须标记 cancelable', observed.json.task);
  const canceled = await postAction('cancel', mainTaskId);
  assert(canceled.status === 200 && canceled.json?.ok === true
      && canceled.json.command === 'task.cancel' && canceled.json.contractVersion === 0,
    'cancel 必须成功执行一次（not_supported 语义）', canceled);
  const row = canceled.json.task;
  assert(row.id === mainTaskId && row.userState === 'observation_paused'
      && row.observable === true
      && state().submit === 2 && state().poll === 3 && state().download === 1,
    '不支持远端取消时任务保持真实状态：绝不伪造已取消、计数零增长', { row, state: state() });
  assert(!JSON.stringify(canceled.json).includes('已取消'),
    'not_supported 响应必须不含“已取消”伪造字样', canceled.json);
  assertSafeBody(JSON.stringify(canceled.json), 'cancel 响应');

  /* 幂等：重复 cancel 是零网络的安全重放，行状态稳定 */
  const repeated = await postAction('cancel', mainTaskId);
  assert(repeated.status === 200 && repeated.json.task.userState === row.userState
      && state().poll === 3 && state().submit === 2,
    '重复 cancel 必须是零网络的稳定重放', { row: repeated.json.task, state: state() });

  /* CLI `task cancel` 同一事实面：同样 not_supported，零远端调用 */
  const cliCancel = spawnSync(process.execPath, ['--import', fixture, 'bin/dsh-iris.js',
    'task', 'cancel', mainTaskId, '--data-root', dshCoreDataRoot(), '--provider-config', configFile], {
    cwd: repo, encoding: 'utf8', shell: false,
    env: { ...process.env, DSH_HOME: root, IRIS_ASYNC_FIXTURE_STATE: process.env.IRIS_ASYNC_FIXTURE_STATE }
  });
  assert(cliCancel.status === 0, 'CLI task cancel 必须成功（not_supported 是如实结果）', { stderr: cliCancel.stderr });
  const cliResult = JSON.parse(cliCancel.stdout);
  assert(cliResult.command === 'task.cancel' && cliResult.task.id === mainTaskId
      && cliResult.task.outcome === 'none' && cliResult.task.cancelState === 'none'
      && state().submit === 2 && state().poll === 3,
    'CLI cancel 必须与 API 共用同一事实：不支持时 outcome 保持真实', {
      result: cliResult, state: state()
    });

  console.log('ALL OK —— D3 cancel API：门真值表零调用、not_supported 不伪造已取消、幂等、CLI 同一事实面');
} finally {
  cleanup();
}
