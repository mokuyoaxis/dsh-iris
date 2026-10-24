import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { projectFlowFacts, presentFlow, canSelect } from '../prototypes/workbench/view-model.js';
import { createDemoTransport, DEMO_MODELS } from '../prototypes/workbench/demo-transport.js';
import { startWorkbenchPreview } from '../scripts/preview-workbench.mjs';
import { DEMO_CONNECTION_TOOLS, previewDraftTools } from '../prototypes/workbench/workspace-panels.js';
import { bridgeToolsForScopes, CORE_BRIDGE_TOOLS } from '../lib/core-bridge-tools.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-web-prototype');
const apps = [];
let preview;
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const file = path.join(item.parentPath, item.name); return [path.relative(directory, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]; }));
}
async function flow(name, options) {
  const dataRoot = path.join(root, name), fixture = imageFlowFixture(dataRoot, options);
  const app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {});
  const imported = await app.execute('artifact.import', { image_bytes: FLOW_SOURCE });
  const facts = await app.execute('flow.create', { source_artifact_id: imported.artifact.id, model_ref: FLOW_MODEL, prompt: 'Green background; keep the subject' });
  return { dataRoot, fixture, app, facts, input: { run_id: facts.run.id } };
}

try {
  const main = await flow('main');
  const initialTree = tree(main.dataRoot), initialEvents = readFlowEvents(main.dataRoot);
  const created = projectFlowFacts(await main.app.execute('flow.inspect', main.input));
  assert.equal(created.status, 'not_started'); assert.equal(created.task, null);
  assert.equal(presentFlow(created).action, 'start'); assert.equal(canSelect(created), false);
  assert.equal(created.input.prompt, main.facts.run.input.prompt);
  assert.deepEqual(tree(main.dataRoot), initialTree, '投影和读取不能写根或创建 Task');
  assert.deepEqual(readFlowEvents(main.dataRoot), initialEvents);
  const completedFacts = await main.app.execute('flow.continue', main.input);
  const completed = projectFlowFacts(completedFacts);
  assert.equal(completed.status, 'awaiting_selection'); assert.equal(canSelect(completed), true);
  assert.equal(completed.task.attemptCount, 1); assert.equal(completed.metrics.ratio, 1);
  assert.equal(completed.output.artifactId, completedFacts.run.output.artifactId);
  assert.equal(completed.comparison.artifactId, completedFacts.run.compare.artifactId);
  const marked = structuredClone(completedFacts);
  marked.run.endpoint = 'private-endpoint-marker'; marked.run.secret = 'private-key-marker';
  marked.task.remoteTaskId = 'private-remote-marker'; marked.task.attempts[0].debug = 'private-attempt-marker';
  const json = JSON.stringify(projectFlowFacts(marked));
  for (const forbidden of ['providerBinding', 'inputDigest', 'sha256', 'remoteTaskId', 'attempts',
    'private-endpoint-marker', 'private-key-marker', 'private-remote-marker', 'private-attempt-marker']) assert(!json.includes(forbidden), forbidden);
  const selected = projectFlowFacts(await main.app.execute('flow.select', { ...main.input, artifact_id: completed.source.artifactId }));
  assert.equal(selected.selection.artifactId, selected.source.artifactId);
  assert.equal(presentFlow(selected).title, '已选择原图'); assert.equal(selected.export, undefined);
  assert.equal(readFlowEvents(main.dataRoot).filter(entry => entry.kind === 'submit').length, 1);
  assert.throws(() => projectFlowFacts({ ...completedFacts, status: 'future_status' }), /不支持/);

  const asynchronous = await flow('async', { mode: 'async', pendingPoll: true });
  const first = projectFlowFacts(await asynchronous.app.execute('flow.continue', asynchronous.input));
  assert.equal(first.status, 'running'); assert.equal(presentFlow(first).action, 'observe');
  const pending = projectFlowFacts(await asynchronous.app.execute('flow.continue', asynchronous.input));
  assert.equal(pending.status, 'running'); assert.equal(pending.task.id, first.task.id);
  const ready = projectFlowFacts(await asynchronous.app.execute('flow.continue', asynchronous.input));
  assert.equal(ready.status, 'awaiting_selection'); assert.equal(ready.task.id, first.task.id);
  assert.equal(readFlowEvents(asynchronous.dataRoot).filter(entry => entry.kind === 'submit').length, 1);

  const unknown = await flow('unknown', { mode: 'unknown' });
  const unknownView = projectFlowFacts(await unknown.app.execute('flow.continue', unknown.input));
  assert.equal(unknownView.status, 'needs_attention'); assert.equal(presentFlow(unknownView).action, null);
  assert.match(presentFlow(unknownView).message, /可能已经计费/);
  const unknownTree = tree(unknown.dataRoot);
  projectFlowFacts(await unknown.app.execute('flow.inspect', unknown.input));
  assert.deepEqual(tree(unknown.dataRoot), unknownTree);
  assert.equal(readFlowEvents(unknown.dataRoot).filter(entry => entry.kind === 'submit').length, 1);
  assert.equal(presentFlow({ ...completed, status: 'delivery_failed' }).action, 'redeliver');
  assert.equal(presentFlow({ ...completed, status: 'needs_comparison' }).action, 'compare');

  const input = { sourceArtifactId: 'artifact_' + '1'.repeat(24), modelRef: DEMO_MODELS[0].modelRef, prompt: 'Keep the subject' };
  for (const scenario of ['success', 'running', 'unknown', 'delivery_failed', 'needs_comparison']) {
    const demo = createDemoTransport({ delayMs: 1 }), run = demo.create(input, { scenario });
    assert.equal(demo.stats().submissions, 0);
    const [a, b] = await Promise.allSettled([demo.continueRun(run.id), demo.continueRun(run.id)]);
    assert.equal(a.status, 'fulfilled'); assert.equal(b.status, 'rejected'); assert.equal(demo.stats().submissions, 1);
    const stats = demo.stats(); demo.inspect(run.id); demo.list(); assert.deepEqual(demo.stats(), stats);
    if (scenario === 'unknown') {
      assert.equal(presentFlow(a.value).action, null);
      await assert.rejects(demo.continueRun(run.id), /不会自动重提/);
    } else {
      const done = scenario === 'success' ? a.value : await demo.continueRun(run.id);
      assert.equal(done.status, 'awaiting_selection'); assert.equal(done.task.id, a.value.task.id);
      assert.equal(demo.stats().submissions, 1);
      const selected = demo.select(run.id, done.source.artifactId);
      assert.equal(demo.select(run.id, done.source.artifactId).revision, selected.revision);
      assert.equal(demo.stats().selections, 1);
      assert.throws(() => demo.select(run.id, done.comparison.artifactId), /只能选择/);
    }
  }
  const canceledDemo = createDemoTransport({ delayMs: 25 }), canceled = canceledDemo.create(input);
  const aborter = new AbortController(), operation = canceledDemo.continueRun(canceled.id, { signal: aborter.signal });
  aborter.abort(new DOMException('stopped', 'AbortError'));
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(canceledDemo.inspect(canceled.id).task.outcome, 'none', '停止等待不是远端取消');
  const resumed = await canceledDemo.continueRun(canceled.id);
  assert.equal(resumed.status, 'awaiting_selection'); assert.equal(canceledDemo.stats().submissions, 1);

  preview = await startWorkbenchPreview();
  const index = await fetch(preview.origin);
  assert.equal(index.status, 200); assert.match(await index.text(), /内置样图/);
  assert.equal(index.headers.get('cache-control'), 'no-store');
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const url of ['/app.js', '/styles.css', '/view-model.js', '/demo-transport.js', '/workspace-panels.js', '/assets/sample.webp', '/assets/iris-mark.svg']) {
    assert.equal((await fetch(preview.origin + url)).status, 200, url);
  }
  for (const url of ['/.internal/PLAN.md', '/package.json', '/lib/core-tasks.js', '/api/v0/runs', '/assets/../../.git/config', '/%2e%2e%2f.internal/PLAN.md']) {
    assert.equal((await fetch(preview.origin + url)).status, 404, url);
  }
  assert.equal((await fetch(preview.origin, { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(preview.origin, { headers: { Origin: 'https://outside.invalid' } })).status, 403);
  assert.equal((await fetch(preview.origin, { headers: { Origin: 'null' } })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.get(preview.origin, { headers: { Host: 'outside.invalid' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject);
  });
  assert.equal(badHost, 421);
  const head = await fetch(preview.origin, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.deepEqual(DEMO_CONNECTION_TOOLS.map(tool => tool.name), CORE_BRIDGE_TOOLS.map(tool => tool.name));
  for (const image of [true, false]) for (const scopes of [['read'], ['read', 'create'], ['read', 'execute', 'stop'], ['read', 'create', 'execute', 'stop']]) {
    assert.deepEqual(previewDraftTools(image, scopes).map(tool => tool.name), bridgeToolsForScopes(scopes, image ? ['image-edit'] : [], undefined).map(tool => tool.name));
  }
  console.log('web prototype: real Core projections, demo gates, cancellation and bounded static preview OK');
} finally {
  await preview?.close();
  for (const app of apps) await app.dispose();
}
