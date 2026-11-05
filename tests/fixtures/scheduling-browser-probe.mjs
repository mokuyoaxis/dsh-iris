import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { readAllOperations } from '../../lib/operation-store.js';
import { listCoreTasks } from '../../lib/core-tasks.js';
import { createFakeLifecycleProvider } from './fake-lifecycle-provider.mjs';

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
    await wait(() => evaluate("document.querySelector('#connection').hidden&&!document.querySelector('#workspace').hidden"), 'scheduler owner login');
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
    await wait(() => evaluate("document.querySelector('#connection').hidden&&!document.querySelector('#workspace').hidden"), 'queued refresh login retained');
    assert.equal(fake.calls.submit.length, 1); result.checks.push('refresh retains login and does not resume a canceled queue item');
    result.status = 'passed'; save();
  } finally { await app.dispose(); }
}
