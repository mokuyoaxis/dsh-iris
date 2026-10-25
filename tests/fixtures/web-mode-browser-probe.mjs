import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { readAllOperations, operationId, inspectExecutionRoot } from '../../lib/operation-store.js';
import { listCoreTasks } from '../../lib/core-tasks.js';
import { FLOW_MODEL } from './image-flow-fixture.mjs';

/** Focused W1d combination: unknown write + capability downgrade + explicit original-Key resume. */
export async function verifyWebModeBrowser({ out, dataRoot, chosenRunId, unstartedRunId, fixture,
  cdp, evaluate, click, wait, chooseToken, readyRun, tree, report, save, capture, restart, pausedResponses }) {
  const result = report.modeClosure = { status: 'running', checks: [], actualPaidCalls: 0 };
  const storageKey = 'iris.workbench.recovery.v0', config = path.join(out, 'mode-providers.json');
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'flow-fixture', enabled: true,
    baseUrl: 'https://never-called.fixture.invalid/v1', apiKey: 'fixture-mode-not-a-key', mediaProtocol: 'openai-chat-images',
    models: [{ id: 'edit', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': [FLOW_MODEL] } }), { mode: 0o600 });
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const posts = () => report.requests.filter(item => item.method === 'POST');
  const table = () => evaluate(`JSON.parse(sessionStorage.getItem(${JSON.stringify(storageKey)}))`);
  const counts = () => ({ tasks: listCoreTasks(dataRoot).total, submits: fixture.calls.submit.length, operations: readAllOperations(dataRoot).length });
  let sequence = 0;
  async function login(session, runId) {
    const token = path.join(out, 'mode-token-' + ++sequence);
    writeLocalApiTokenFile(token, session.accessToken, dataRoot);
    await cdp('Page.navigate', { url: session.origin + '/#' + runId });
    await wait(() => evaluate("Boolean(document.documentElement.dataset.theme&&!document.querySelector('#connection').hidden)"), 'mode login');
    const before = posts().length;
    await chooseToken(token); await readyRun(runId);
    await wait(() => evaluate("!document.querySelector('#recovery-check').disabled"), 'mode recovery reads finished');
    assert.equal(posts().length, before, 'authentication/recovery never posts');
  }

  let session = await restart(dataRoot, fixture, config);
  await login(session, unstartedRunId);
  await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'unstarted Run is executable');
  const baseline = counts();
  assert.equal(baseline.operations, 0);
  await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/runs/' + unstartedRunId + '/continue', requestStage: 'Request' }] });
  await click('#start-edit'); await wait(() => pausedResponses.length > 0, 'unsent continue request');
  await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionClosed' }); await cdp('Fetch.disable');
  await wait(() => evaluate("document.querySelector('#recovery-list').textContent.includes('尚未找到原请求')"), 'original unknown action retained');
  const pending = await table();
  assert.equal(pending.actions.length, 1); assert.equal(pending.actions[0].kind, 'continue');
  assert.equal(pending.actions[0].runId, unstartedRunId);
  const expectedOperationId = operationId(inspectExecutionRoot(dataRoot), pending.actions[0].key);
  assert.deepEqual(counts(), baseline);
  result.checks.push('an unsent continuation retains its original Key without a Task, Operation or Provider call'); save();

  session = await restart(dataRoot, undefined, undefined, { allowExecution: false, allowSelection: false });
  const readonlyBytes = tree(dataRoot), readonlyPosts = posts().length;
  await click('#refresh');
  await wait(() => evaluate("!document.querySelector('#connection').hidden&&document.querySelector('#feedback').textContent.includes('失效')"), 'downgrade invalidates old token');
  assert.deepEqual(await table(), pending);
  await login(session, unstartedRunId);
  await wait(() => evaluate("document.querySelector('#recovery-list').textContent.includes('当前服务未开放对应查询')"), 'read-only capability notice');
  await check('downgrade keeps the unknown identity and disables execution instead of silently discarding it',
    "document.querySelector('#start-edit').disabled&&document.querySelector('#draft-fields').disabled&&document.querySelector('#stop-operation').hidden");
  assert.deepEqual(await table(), pending); assert.equal(posts().length, readonlyPosts);
  assert.deepEqual(tree(dataRoot), readonlyBytes); assert.deepEqual(counts(), baseline);
  await capture('mode-readonly-pending');

  session = await restart(dataRoot, undefined, undefined, { allowExecution: false, allowSelection: true });
  await login(session, chosenRunId);
  await check('selection-only service needs no Provider and cannot execute a retained continuation',
    "document.querySelector('#start-edit').disabled&&!document.querySelector('#select-source').disabled&&!document.querySelector('#download').disabled&&document.querySelector('#model-summary').textContent==='未指定配置'");
  assert.deepEqual(await table(), pending);
  const selectionPosts = posts().length;
  await click('#select-source');
  await wait(() => evaluate("document.querySelector('#status-title').textContent==='已选择原图'&&!document.querySelector('#select-source').disabled"), 'selection-only local choice');
  assert.equal(posts().length, selectionPosts + 1); assert.deepEqual(counts(), baseline); assert.deepEqual(await table(), pending);
  result.checks.push('a permitted local selection does not erase or execute an unrelated pending continuation'); save();

  session = await restart(dataRoot, fixture, config);
  const restoredPosts = posts().length;
  await login(session, unstartedRunId);
  await wait(() => evaluate("document.querySelector('#recovery-list').textContent.includes('尚未找到原请求')"), 'execution restored lookup');
  await check('restoring execution still requires explicit original-action preparation', "document.querySelector('#start-edit').disabled");
  assert.deepEqual(await table(), pending); assert.equal(posts().length, restoredPosts); assert.deepEqual(counts(), baseline);
  await click('#recovery-panel>summary');
  const retry = await evaluate("[...document.querySelectorAll('#recovery-list button')].findIndex(n=>n.textContent==='准备按原 Key 接回')");
  assert(retry >= 0);
  await click('#recovery-list button:nth-of-type(' + (retry + 1) + ')');
  await wait(() => evaluate("document.querySelector('#start-edit').textContent==='按原 Key 接回'&&!document.querySelector('#start-edit').disabled"), 'explicit original-Key preparation');
  assert.equal(posts().length, restoredPosts); assert.deepEqual(counts(), baseline);
  await click('#start-edit');
  await wait(() => evaluate("document.querySelector('#status-title').textContent==='图片已就绪'&&document.querySelector('#viewer').getAttribute('aria-busy')==='false'"), 'one resumed execution');
  await wait(() => evaluate(`sessionStorage.getItem(${JSON.stringify(storageKey)})===null`), 'resolved original identity');
  assert.equal(posts().length, restoredPosts + 1);
  assert.deepEqual(counts(), { tasks: baseline.tasks + 1, submits: baseline.submits + 1, operations: 1 });
  const [operation] = readAllOperations(dataRoot);
  assert.equal(operation.runId, unstartedRunId);
  assert.equal(operation.id, expectedOperationId, 'the resumed operation is derived from the original pending Key');
  result.checks.push('two explicit user actions resume exactly one original-Key Operation, Task and Provider submit');
  await capture('mode-explicit-resume');
  result.counts = counts(); result.originalKeyPreserved = true; result.status = 'passed'; save();
}
