/**
 * D4 retry as new task —— DSH API 层验收：POST /iris/api/core/task/:id/retry。
 * 运行：node tests/retry-api.mjs
 *
 * 覆盖：
 * - 计费确认门：缺/假 confirmBilling → 400，零网络零新 Task；prompt 为空 → 400。
 * - 门真值表：坏 ID 400 / 未知 404 / ready 409（只有终态且未成功交付才允许）。
 * - 计费链与关系：单次调用恰好创建 1 个新 Task（retriedFrom 单向关系、全新
 *   attempts=1）；旧 Task 事实零变化；响应只含五类投影行。
 * - CLI `task retry` 同一命令面：缺 --confirm-billing / 缺 --input 都拒绝。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempDshHome } from './test-env.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { root, cleanup } = useTempDshHome('iris-retry-api');
process.env.IRIS_ASYNC_FIXTURE_STATE = path.join(root, 'fixture-state.json');
await import('./fixtures/headless-async-fetch.mjs');

const { upsert } = await import('../lib/config.js');
const {
  dshCoreDataRoot,
  inspectProviderTaskForDsh,
  submitProviderTaskForDsh
} = await import('../lib/dsh-core-adapter.js');
const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
const { providerTaskBinding } = await import('../lib/provider-catalog.js');
const { createCoreRuntime } = await import('../lib/core-runtime.js');
const { recordCorePollResult } = await import('../lib/core-tasks.js');
const { serveApi } = await import('../lib/api.js');
const fixture = fileURLToPath(new URL('./fixtures/headless-async-fetch.mjs', import.meta.url));

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

/** retry 路由有请求体：用 EventEmitter 风格 req 桩驱动 handleJsonPost。 */
async function postAction(action, taskId, body) {
  const res = response();
  const req = {
    method: 'POST',
    url: '/iris/api/core/task/' + taskId + '/' + action,
    listeners: {},
    on(event, handler) {
      (this.listeners[event] = this.listeners[event] || []).push(handler);
      return this;
    }
  };
  serveApi(req, res);
  if (action === 'retry') {
    const payload = Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8');
    setImmediate(() => {
      for (const handler of req.listeners.data || []) handler(payload);
      for (const handler of req.listeners.end || []) handler();
    });
  }
  for (let i = 0; i < 400 && !res.writableEnded; i++) {
    await new Promise((resolve) => setImmediate(resolve));
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

function cliRetry(taskId, extraArgs) {
  return spawnSync(process.execPath, ['--import', fixture, 'bin/dsh-iris.js',
    'task', 'retry', taskId, '--data-root', dshCoreDataRoot(), '--provider-config', configFile,
    ...extraArgs], {
    cwd: repo, encoding: 'utf8', shell: false,
    env: { ...process.env, DSH_HOME: root, IRIS_ASYNC_FIXTURE_STATE: process.env.IRIS_ASYNC_FIXTURE_STATE }
  });
}

try {
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

  /** 用真实 Core 原语把任务记为远端失败终态（fixture 无失败 poll 分支）。 */
  async function markFailedTerminal(taskId) {
    const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'writer' });
    runtime.start();
    try {
      await runtime.run('execute', ({ dataRoot }) =>
        recordCorePollResult(dataRoot, taskId, { kind: 'failed', error: 'fixture remote failure' }));
    } finally {
      await runtime.dispose();
    }
  }

  const failedTaskId = await submitFixture('retry api failed');
  const readyTaskId = await submitFixture('retry api ready');
  const doneOne = await postAction('reobserve', readyTaskId);
  const doneTwo = await postAction('reobserve', readyTaskId);
  assert(doneOne.status === 200 && doneTwo.json.task.userState === 'succeeded'
      && doneTwo.json.task.retryable === false,
    '前置：ready 任务已成功交付且不可重试', doneTwo.json.task);
  await markFailedTerminal(failedTaskId);
  const failedFact = await inspectProviderTaskForDsh(failedTaskId);
  assert(failedFact.outcome === 'failed' && failedFact.phase === 'terminal',
    '前置：旧任务为远端失败终态', failedFact);

  /* 门真值表与计费确认：全部零网络、零新 Task */
  const frozen = state();
  const badShape = await postAction('retry', 'not-a-task-id', { prompt: 'again', confirmBilling: true });
  assert(badShape.status === 400 && String(badShape.body).includes('IRIS_DSH_TASK_INVALID'),
    '坏 ID 必须 400', badShape);
  const noConfirm = await postAction('retry', failedTaskId, { prompt: 'again' });
  assert(noConfirm.status === 400 && String(noConfirm.body).includes('IRIS_COMMAND_BILLING_CONFIRM_REQUIRED'),
    '缺 confirmBilling 必须 400 拒绝', noConfirm);
  const falseConfirm = await postAction('retry', failedTaskId, { prompt: 'again', confirmBilling: false });
  assert(falseConfirm.status === 400, 'confirmBilling:false 必须 400 拒绝', falseConfirm);
  const emptyPrompt = await postAction('retry', failedTaskId, { prompt: '  ', confirmBilling: true });
  assert(emptyPrompt.status === 400, '空 prompt 必须 400 拒绝', emptyPrompt);
  const missing = await postAction('retry', 'task_' + '0'.repeat(24), { prompt: 'again', confirmBilling: true });
  assert(missing.status === 404, '未知 Task 必须 404', missing);
  const readyReject = await postAction('retry', readyTaskId, { prompt: 'again', confirmBilling: true });
  assert(readyReject.status === 409 && String(readyReject.body).includes('IRIS_TASK_NOT_RETRYABLE'),
    'ready 任务必须 409 拒绝（成功交付不需要重试）', readyReject);
  assertSafeBody(readyReject.body, 'ready 拒绝');
  assert(state().submit === frozen.submit && state().poll === frozen.poll
      && state().download === frozen.download,
    '所有拒绝必须零 Provider 调用', { before: frozen, after: state() });
  const failedUnchanged = await inspectProviderTaskForDsh(failedTaskId);
  assert(failedUnchanged.revision === failedFact.revision, '拒绝不得改写旧 Task');

  /* 成功：单次调用恰好创建 1 个新 Task，旧 Task 零变化 */
  const retried = await postAction('retry', failedTaskId, { prompt: 'retry prompt from caller', confirmBilling: true });
  assert(retried.status === 200 && retried.json?.ok === true
      && retried.json.command === 'task.retry' && retried.json.contractVersion === 0,
    'retry 必须成功并稳定标注命令名', retried);
  const row = retried.json.task;
  assert(retried.json.retriedFrom === failedTaskId && row.id !== failedTaskId
      && row.observable === true && row.retryable === false
      && state().submit === frozen.submit + 1,
    '单次调用恰好创建一个带 retriedFrom 关系的新 Task、恰好一次 submit', {
      retriedFrom: retried.json.retriedFrom, row, state: state()
    });
  assertSafeBody(JSON.stringify(retried.json), 'retry 成功响应');
  const newFact = await inspectProviderTaskForDsh(row.id);
  assert(newFact.retriedFrom === failedTaskId && newFact.attempts.length === 1
      && !fs.readFileSync(path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks', row.id + '.json'), 'utf8')
        .includes('retry prompt from caller'),
    '新 Task 持久化 retriedFrom、独立 attempts=1、记录不含 prompt', newFact);
  const oldAfter = await inspectProviderTaskForDsh(failedTaskId);
  assert(oldAfter.revision === failedFact.revision && oldAfter.attempts.length === failedFact.attempts.length,
    '旧 Task 事实必须零变化（不新增 Attempt）', oldAfter);

  /* CLI `task retry` 同一命令面 */
  const noFlag = cliRetry(failedTaskId, ['--input', JSON.stringify({ prompt: 'cli retry' })]);
  assert(noFlag.status === 1 && noFlag.stderr.includes('IRIS_COMMAND_BILLING_CONFIRM_REQUIRED')
      && state().submit === frozen.submit + 1,
    'CLI 缺 --confirm-billing 必须拒绝且零网络', { stderr: noFlag.stderr, state: state() });
  const noInput = cliRetry(failedTaskId, ['--confirm-billing']);
  assert(noInput.status === 2 && noInput.stderr.includes('--input'),
    'CLI 缺 --input 必须按用法错误拒绝', noInput.stderr);
  const cliOk = cliRetry(failedTaskId, ['--input', JSON.stringify({ prompt: 'cli retry' }), '--confirm-billing']);
  assert(cliOk.status === 0, 'CLI retry 必须成功', { stderr: cliOk.stderr });
  const cliResult = JSON.parse(cliOk.stdout);
  assert(cliResult.command === 'task.retry' && cliResult.retriedFrom === failedTaskId
      && cliResult.taskId !== failedTaskId && cliResult.task.retriedFrom === failedTaskId
      && state().submit === frozen.submit + 2,
    'CLI retry 与 API 同一事实面：关系与计费链一致', { result: cliResult, state: state() });

  console.log('ALL OK —— D4 retry API：计费确认门、门真值表零调用、retriedFrom 关系、CLI 同一命令面');
} finally {
  cleanup();
}
