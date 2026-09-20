/**
 * D1 reobserve —— DSH API 层验收：POST /iris/api/core/task/:id/reobserve。
 * 运行：node tests/reobserve-api.mjs
 *
 * 覆盖：
 * - 成功路径只 poll 一次且绝不 submit；响应只含五类用户投影行（无 providerId/
 *   binding/绝对路径/Key）。
 * - 坏 ID → 400、未知 ID → 404、终态 → 409、binding 漂移 → 409，全部零 Provider 调用。
 * - 与 Headless CLI 同一份事实：同一数据根先 CLI observe 再 API reobserve，
 *   revision 在同一条 Task 上连续推进，不暗示第二套存储。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempDshHome } from './test-env.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { root, cleanup } = useTempDshHome('iris-reobserve-api');
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
const { serveApi } = await import('../lib/api.js');
const fixture = new URL('./fixtures/headless-async-fetch.mjs', import.meta.url).href;

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const provider = (overrides = {}) => ({
  id: 'dash-main',
  enabled: true,
  apiKey: 'fixture-key-api',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope',
  models: [{ id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] }],
  ...overrides
});

const configFile = path.join(root, 'providers.json');
function writeProviderConfig(value) {
  fs.writeFileSync(configFile, JSON.stringify({ providers: [value] }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
}

function state() {
  return JSON.parse(fs.readFileSync(process.env.IRIS_ASYNC_FIXTURE_STATE, 'utf8'));
}

/** serveApi 的 req/res 纯对象桩：POST 路由经 Aborted 通道，无需真实 socket。 */
function response() {
  return {
    headersSent: false, destroyed: false, writableEnded: false, status: 0, body: '',
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = body === undefined ? '' : String(body); this.writableEnded = true; }
  };
}

async function postReobserve(taskId) {
  const res = response();
  serveApi({
    method: 'POST',
    url: '/iris/api/core/task/' + taskId + '/reobserve',
    on() { return this; }
  }, res);
  const deadline = Date.now() + 10_000;
  while (!res.writableEnded && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(res.writableEnded, 'reobserve 路由必须结束响应', res.status);
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
  // upsert 新建 Provider 会生成持久 id；后续 binding/恢复解析都以落库后的记录为准。
  const saved = upsert(provider());
  writeProviderConfig(saved);

  const submitted = await submitProviderTaskForDsh({
    capability: 'image',
    candidates: [{
      adapter: createConfiguredProviderAdapter(saved),
      model: saved.id + '::wan2.2-t2i-flash',
      providerBinding: providerTaskBinding(saved)
    }],
    providerInput: { prompt: 'reobserve api fixture' }
  });
  const taskId = submitted.taskId;
  assert(submitted.task.acceptance === 'accepted' && state().submit === 1 && state().poll === 0,
    '提交必须经 DSH 配置边界绑定原 Provider', { task: submitted.task, state: state() });

  const badShape = await postReobserve('not-a-task-id');
  assert(badShape.status === 400 && badShape.json?.error?.code === 'IRIS_DSH_TASK_INVALID'
      && state().poll === 0 && state().submit === 1,
    '坏 ID 必须在 Provider 调用前 400 拒绝', badShape);
  assertSafeBody(badShape.body, '坏 ID');

  const missing = await postReobserve('task_' + '0'.repeat(24));
  assert(missing.status === 404 && missing.json?.error?.code === 'IRIS_TASK_NOT_FOUND'
      && state().poll === 0 && state().submit === 1,
    '未知 Task 必须 404 且零 Provider 调用', missing);
  assertSafeBody(missing.body, '未知 Task');

  /* 与 CLI 同一份事实：先 CLI observe（带 binding 校验的跨进程单步），再 API reobserve。 */
  const cli = spawnSync(process.execPath, ['--import', fixture, 'bin/dsh-iris.js',
    'task', 'observe', taskId, '--data-root', dshCoreDataRoot(), '--provider-config', configFile], {
    cwd: repo, encoding: 'utf8', shell: false,
    env: { ...process.env, DSH_HOME: root, IRIS_ASYNC_FIXTURE_STATE: process.env.IRIS_ASYNC_FIXTURE_STATE }
  });
  assert(cli.status === 0, 'CLI observe 必须跨进程成功', { stderr: cli.stderr });
  const cliResult = JSON.parse(cli.stdout);
  assert(cliResult.task.watchState === 'suspended' && state().poll === 1 && state().submit === 1,
    'CLI 观察只能 poll 一次', { task: cliResult.task, state: state() });

  const first = await postReobserve(taskId);
  assert(first.status === 200 && first.json?.ok === true
      && first.json.command === 'task.reobserve' && first.json.contractVersion === 0,
    'API reobserve 必须成功并稳定标注命令名', first);
  const row = first.json.task;
  // fixture poll 序列 RUNNING → SUCCEEDED：CLI 已消耗第一次，API 这次显式单步即收尾。
  assert(row && row.id === taskId && row.userState === 'succeeded'
      && row.mediaReady === true && row.artifactIds.length === 1 && row.observable === false
      && Number.isSafeInteger(row.revision) && row.revision > cliResult.task.revision
      && state().poll === 2 && state().submit === 1 && state().download === 1,
    'API 观察必须与 CLI 观察推进同一条 Task 的连续 revision，单次 poll 完成闭环', {
      row, cliRevision: cliResult.task.revision, state: state()
    });
  assertSafeBody(JSON.stringify(first.json), '成功响应');

  const terminal = await postReobserve(taskId);
  assert(terminal.status === 409 && terminal.json?.error?.code === 'IRIS_TASK_NOT_OBSERVABLE'
      && state().poll === 2 && state().submit === 1 && state().download === 1,
    '终态 Task 再观察必须 409 拒绝且零网络零提交', terminal);
  assertSafeBody(terminal.body, '终态拒绝');
  const terminalFact = await inspectProviderTaskForDsh(taskId);
  assert(terminalFact.revision === row.revision && terminalFact.phase === 'terminal',
    '拒绝不得改写这条 Task 事实', terminalFact);

  /* binding 漂移：同一数据根的新 Task 在端点变更后必须拒绝且零网络。 */
  const drifted = await submitProviderTaskForDsh({
    capability: 'image',
    candidates: [{
      adapter: createConfiguredProviderAdapter(saved),
      model: saved.id + '::wan2.2-t2i-flash',
      providerBinding: providerTaskBinding(saved)
    }],
    providerInput: { prompt: 'drift fixture' }
  });
  upsert({ id: saved.id, baseUrl: 'https://dashscope-us-east-1.aliyuncs.com/compatible-mode/v1' });
  const drift = await postReobserve(drifted.taskId);
  assert(drift.status === 409 && drift.json?.error?.code === 'IRIS_PROVIDER_TASK_BINDING_MISMATCH'
      && state().submit === 2 && state().poll === 2,
    '端点/协议漂移必须 409 拒绝且不把旧远端 ID 送往新端点', drift);
  assertSafeBody(drift.body, 'binding 漂移拒绝');

  console.log('ALL OK —— D1 reobserve API：单步 poll、CLI 同一事实、拒绝矩阵零调用、响应脱敏');
} finally {
  cleanup();
}
