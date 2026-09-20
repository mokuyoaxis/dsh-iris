/**
 * D2 redeliver —— DSH API 层验收：POST /iris/api/core/task/:id/redeliver。
 * 运行：node tests/redeliver-api.mjs
 *
 * 覆盖：
 * - succeeded+failed → 200：一次 re-poll + 一次 download、零 submit，响应只含
 *   五类用户投影行（无 providerId/binding/绝对路径/Key）；ready 后门反转。
 * - 坏 ID → 400、未知 ID → 404、非 failed → 409，全部零 Provider 调用。
 * - CLI `task redeliver` 与 API 共用同一条事实：对 ready 任务同样稳定拒绝。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempDshHome } from './test-env.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { root, cleanup } = useTempDshHome('iris-redeliver-api');
process.env.IRIS_ASYNC_FIXTURE_STATE = path.join(root, 'fixture-state.json');
await import('./fixtures/headless-async-fetch.mjs');

const { upsert } = await import('../lib/config.js');
const {
  dshCoreDataRoot,
  submitProviderTaskForDsh
} = await import('../lib/dsh-core-adapter.js');
const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
const { providerTaskBinding } = await import('../lib/provider-catalog.js');
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
function updateState(key, value) {
  const current = state();
  current[key] = value;
  fs.writeFileSync(process.env.IRIS_ASYNC_FIXTURE_STATE, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
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

  const mainTaskId = await submitFixture('redeliver api main');
  const runningTaskId = await submitFixture('redeliver api running');
  assert(state().submit === 2 && state().poll === 0, '两个任务各只能提交一次', state());

  /* 門真值表：坏 ID / 未知 Task / 非 failed → 全部零 Provider 调用 */
  const badShape = await postAction('redeliver', 'not-a-task-id');
  assert(badShape.status === 400 && badShape.json?.error?.code === 'IRIS_DSH_TASK_INVALID'
      && state().poll === 0,
    '坏 ID 必须在 Provider 调用前 400 拒绝', badShape);
  assertSafeBody(badShape.body, '坏 ID');
  const missing = await postAction('redeliver', 'task_' + '0'.repeat(24));
  assert(missing.status === 404 && missing.json?.error?.code === 'IRIS_TASK_NOT_FOUND'
      && state().poll === 0,
    '未知 Task 必须 404 且零调用', missing);
  assertSafeBody(missing.body, '未知 Task');
  const runningReject = await postAction('redeliver', runningTaskId);
  assert(runningReject.status === 409 && runningReject.json?.error?.code === 'IRIS_TASK_NOT_REDELIVERABLE'
      && state().poll === 0,
    '运行中的 Task 必须 409 拒绝且零调用', runningReject);
  assertSafeBody(runningReject.body, '运行中拒绝');

  /* 走向 delivery_failed：reobserve#1 RUNNING；注入下载故障后 reobserve#2 → succeeded+failed */
  const stepOne = await postAction('reobserve', mainTaskId);
  assert(stepOne.status === 200 && stepOne.json.task.redeliverable === false
      && stepOne.json.task.userState === 'observation_paused',
    '第一次观察后是观察暂停而非交付失败，门必须为 false', stepOne.json.task);
  updateState('failNextDownload', true);
  const stepTwo = await postAction('reobserve', mainTaskId);
  assert(stepTwo.status === 200 && stepTwo.json.task.userState === 'delivery_failed'
      && stepTwo.json.task.redeliverable === true
      && state().poll === 2 && state().download === 1 && state().submit === 2,
    '下载失败必须如实投影 delivery_failed 并标记可重新交付', { row: stepTwo.json.task, state: state() });
  assertSafeBody(JSON.stringify(stepTwo.json), '失败投影');

  /* redeliver：一次 re-poll + 一次成功 download，零 submit */
  const redelivered = await postAction('redeliver', mainTaskId);
  assert(redelivered.status === 200 && redelivered.json?.ok === true
      && redelivered.json.command === 'task.redeliver' && redelivered.json.contractVersion === 0,
    'redeliver 必须成功并稳定标注命令名', redelivered);
  const row = redelivered.json.task;
  assert(row.id === mainTaskId && row.userState === 'succeeded'
      && row.mediaReady === true && row.artifactIds.length === 1
      && row.redeliverable === false
      && state().submit === 2 && state().poll === 3 && state().download === 2,
    'redeliver 必须收敛 ready 且零 submit、poll/download 各只 +1', { row, state: state() });
  assertSafeBody(JSON.stringify(redelivered.json), 'redeliver 成功响应');

  /* 幂等：ready 后再次被拒且计数冻结 */
  const redone = await postAction('redeliver', mainTaskId);
  assert(redone.status === 409 && redone.json?.error?.code === 'IRIS_TASK_NOT_REDELIVERABLE'
      && state().poll === 3 && state().download === 2 && state().submit === 2,
    'ready 后再 redeliver 必须 409 拒绝且计数冻结', redone);
  assertSafeBody(redone.body, '重复 redeliver');

  /* CLI `task redeliver` 与 API 共用同一条事实：对 ready 任务同样稳定拒绝且零网络 */
  const cliRedeliver = spawnSync(process.execPath, ['--import', fixture, 'bin/dsh-iris.js',
    'task', 'redeliver', mainTaskId, '--data-root', dshCoreDataRoot(), '--provider-config', configFile], {
    cwd: repo, encoding: 'utf8', shell: false,
    env: { ...process.env, DSH_HOME: root, IRIS_ASYNC_FIXTURE_STATE: process.env.IRIS_ASYNC_FIXTURE_STATE }
  });
  assert(cliRedeliver.status === 1 && cliRedeliver.stderr.includes('IRIS_TASK_NOT_REDELIVERABLE')
      && state().poll === 3 && state().submit === 2,
    'CLI redeliver 对 ready 任务必须稳定拒绝、绝不重新生成', { stderr: cliRedeliver.stderr, state: state() });

  console.log('ALL OK —— D2 redeliver API：门真值表零调用、幂等、CLI 同一拒绝面、响应脱敏');
} finally {
  cleanup();
}
