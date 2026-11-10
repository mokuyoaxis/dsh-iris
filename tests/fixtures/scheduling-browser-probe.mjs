import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { readAllOperations } from '../../lib/operation-store.js';
import { listCoreTasks } from '../../lib/core-tasks.js';
import { createFakeLifecycleProvider } from './fake-lifecycle-provider.mjs';
import { FLOW_MODEL, imageFlowFixture } from './image-flow-fixture.mjs';
import { createRootBusyFixture } from './root-busy-fixture.mjs';
import { inspectCoreWriterLease } from '../../lib/core-runtime.js';
import { RECOVERY_STORAGE_KEY } from '../../lib/web/recovery.js';

export async function verifySchedulingBrowser({ out, cdp, evaluate, click, wait, report, save, dimensions, measure, capture, restart }) {
  const result = report.scheduling = { status: 'running', checks: [], actualPaidCalls: 0 };
  const dataRoot = path.join(out, 'scheduling-core'), file = path.join(out, 'scheduling-providers.json');
  const fake = createFakeLifecycleProvider({ id: 'ui' });
  const ports = { resolveImageCandidates: ({ modelRef }) => [{ adapter: fake.adapter, model: modelRef, providerBinding: 'sha256:' + 'a'.repeat(64) }],
    resolveTaskAdapter: () => fake.adapter };
  const app = createApplicationRuntime({ dataRoot, ...ports });
  try {
    await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true });
    const original = await app.execute('flow.create', { model_ref: 'ui::image', prompt: 'original remote fixture' });
    await app.execute('flow.continue', { run_id: original.run.id }); await app.dispose();
    fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'ui', name: '受控模型', mediaProtocol: 'openai-chat-images',
      auth: 'none', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'image', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': ['ui::image'] } }), { mode: 0o600 });
    const session = await restart({ dataRoot, providerConfigPath: file, executionPorts: ports, allowExecution: true,
      scheduling: { schemaVersion: 1, remoteLimit: 1, queueTimeoutMs: 30000 } });
    await cdp('Page.navigate', { url: session.loginUrl });
    await wait(() => evaluate("document.readyState==='complete'&&document.body.classList.contains('connected')&&document.querySelector('#connection')?.hidden===true&&document.querySelector('#workspace')?.hidden===false"), 'scheduler owner login');
    await click('#studio-tab'); await click('#new-run');
    await evaluate("document.querySelector('#model').value='ui::image';document.querySelector('#model').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#edit-prompt').value='排队演示，不调用真实供应商';document.querySelector('#edit-prompt').dispatchEvent(new Event('input',{bubbles:true}))");
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'scheduler draft ready'); await click('#start-edit');
    await wait(() => evaluate("document.querySelector('#status-title').textContent==='等待远端任务名额'"), 'scheduler capacity explanation');
    assert.equal(await evaluate("document.querySelector('#status-message').textContent.includes('还没有提交')&&!document.querySelector('#stop-operation').hidden"), true);
    assert.equal(fake.calls.submit.length, 1); result.checks.push('queued operation explains unsent remote capacity wait and permits independent local stop'); save();
    await dimensions(390); await measure('scheduling-mobile'); await capture('scheduling-mobile-queue');
    await click('#stop-operation');
    await wait(() => readAllOperations(dataRoot).some(operation => operation.state === 'canceled'), 'queued stop saved');
    await wait(() => evaluate("document.querySelector('#stop-operation').hidden"), 'queued stop controls settle');
    assert.equal(fake.calls.submit.length, 1);
    const tasks = listCoreTasks(dataRoot).tasks;
    assert.equal(tasks.filter(task => task.attempts.length).length, 1);
    result.checks.push('stopping the queued operation leaves the original accepted Task and produces no additional submission'); save();
    await cdp('Page.reload');
    await wait(() => evaluate("document.readyState==='complete'&&document.body.classList.contains('connected')&&document.querySelector('#connection')?.hidden===true&&document.querySelector('#workspace')?.hidden===false"), 'queued refresh login retained');
    assert.equal(fake.calls.submit.length, 1); result.checks.push('refresh retains login and does not resume a canceled queue item');
    await verifyRootBusyBrowser({ out, cdp, evaluate, click, wait, result, save, dimensions, measure, capture, restart });
    result.status = 'passed'; save();
  } finally { await app.dispose(); }
}

async function verifyRootBusyBrowser({ out, cdp, evaluate, click, wait, result, save, dimensions, measure, capture, restart }) {
  const dataRoot = path.join(out, 'root-busy-core'), file = path.join(out, 'root-busy-providers.json');
  const fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
  const holders = [];
  const journal = () => evaluate(`JSON.parse(sessionStorage.getItem(${JSON.stringify(RECOVERY_STORAGE_KEY)}))`);
  const loggedIn = () => evaluate("document.readyState==='complete'&&document.body.classList.contains('connected')&&document.querySelector('#workspace')?.hidden===false");
  const blocked = () => evaluate("document.querySelector('#status-title').textContent==='等待数据根写权限'&&!document.querySelector('#retry-operation').hidden");
  async function draft() {
    await click('#studio-tab'); await click('#new-run');
    await evaluate(`document.querySelector('#model').value=${JSON.stringify(FLOW_MODEL)};document.querySelector('#model').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#edit-prompt').value='独立进程占用，测试原操作重试';document.querySelector('#edit-prompt').dispatchEvent(new Event('input',{bubbles:true}))`);
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'root-busy draft ready');
  }
  try {
    await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true }); await app.dispose();
    fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'flow-fixture', name: '受控服务', auth: 'none',
      baseUrl: 'http://127.0.0.1:1', mediaProtocol: 'openai-chat-images', models: [{ id: 'edit', capabilities: ['image-gen'] }] }],
      assignments: { 'image-gen': [FLOW_MODEL] } }), { mode: 0o600 });
    const session = await restart({ dataRoot, providerConfigPath: file, executionPorts: fixture, allowExecution: true,
      scheduling: { schemaVersion: 1, requestsPerSecond: 100, remoteLimit: 4 } });
    await cdp('Page.navigate', { url: session.loginUrl }); await wait(loggedIn, 'root-busy owner login');
    await draft();
    const first = await createRootBusyFixture(dataRoot); holders.push(first); first.arm();
    await click('#start-edit'); await wait(blocked, 'root-busy reason shown');
    await wait(() => evaluate("!document.querySelector('#retry-operation').disabled"), 'original retry enabled');
    const operation = readAllOperations(dataRoot)[0], originalKey = (await journal()).actions.find(action => action.kind === 'continue').key;
    assert.equal(operation.state, 'queued'); assert.equal(inspectCoreWriterLease(dataRoot).pid, first.pid);
    assert.equal(fixture.calls.submit.length, 0);
    await dimensions(390); await measure('root-busy-mobile'); await capture('root-busy-mobile');
    result.checks.push('independent writer contention shows the real root wait and original retry on mobile'); save();
    await cdp('Page.reload'); await wait(loggedIn, 'root-busy reload login'); await wait(blocked, 'root-busy reload status');
    await wait(() => evaluate("!document.querySelector('#retry-operation').disabled"), 'reloaded original retry enabled');
    assert.equal((await journal()).actions.find(action => action.kind === 'continue').key, originalKey);
    assert.equal(fixture.calls.submit.length, 0);
    await click('#retry-operation');
    await wait(() => evaluate("!document.querySelector('#retry-operation').disabled"), 'blocked replay settles');
    assert.equal(readAllOperations(dataRoot).length, 1); assert.equal(fixture.calls.submit.length, 0);
    assert.equal((await journal()).actions.find(action => action.kind === 'continue').key, originalKey);
    result.checks.push('refresh and retry under contention preserve the original Key and Operation without generation'); save();
    await first.release();
    assert.equal(fixture.calls.submit.length, 0);
    await click('#retry-operation');
    await wait(() => readAllOperations(dataRoot).find(item => item.id === operation.id)?.state === 'succeeded', 'original operation finishes');
    await wait(() => evaluate("document.querySelector('#retry-operation').hidden&&document.querySelector('#stop-operation').hidden"), 'finished retry controls hidden');
    assert.equal(fixture.calls.submit.length, 1); assert.equal(readAllOperations(dataRoot).length, 1);
    result.checks.push('explicit retry after lease release completes the same Operation with one Provider submission'); save();

    await draft();
    const second = await createRootBusyFixture(dataRoot); holders.push(second); second.arm();
    await click('#start-edit'); await wait(blocked, 'second root wait');
    const canceling = readAllOperations(dataRoot).find(item => item.state === 'queued');
    await click('#stop-operation');
    await wait(() => evaluate("document.querySelector('#creation-feedback').textContent.includes('停止尚未保存')&&!document.querySelector('#stop-operation').disabled"), 'busy cancel explanation');
    assert.equal(readAllOperations(dataRoot).find(item => item.id === canceling.id).state, 'queued');
    assert.equal(await evaluate("document.querySelector('#retry-operation').disabled"), true);
    const stop = (await journal()).actions.find(action => action.kind === 'stop'); assert(stop);
    await cdp('Page.reload'); await wait(loggedIn, 'pending cancel reload'); await wait(blocked, 'pending cancel root reason');
    assert.equal((await journal()).actions.find(action => action.kind === 'stop').id, stop.id);
    assert.equal(await evaluate("document.querySelector('#retry-operation').disabled"), true);
    assert.equal(fixture.calls.submit.length, 1);
    result.checks.push('busy cancellation is not claimed as saved; refresh retains the stop intent and disables generation retry'); save();
    await second.release(); await click('#stop-operation');
    await wait(() => readAllOperations(dataRoot).find(item => item.id === canceling.id)?.state === 'canceled', 'original stop retried');
    await wait(() => evaluate("document.querySelector('#stop-operation').hidden&&document.querySelector('#retry-operation').hidden"), 'cancel controls hidden');
    assert.equal(fixture.calls.submit.length, 1); assert.equal(fixture.calls.cancel.length, 0);
    assert.equal(readAllOperations(dataRoot).length, 2); assert.equal(await journal(), null);
    result.checks.push('explicit stop retry reuses its saved identity, clears recovery and does not generate or cancel remotely'); save();
  } finally {
    for (const holder of holders.reverse()) await holder.release();
    await app.dispose();
  }
}
