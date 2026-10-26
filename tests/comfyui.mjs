import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createProviderRegistry } from '../lib/provider-extensions.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';
import { checkedComfyWorkflow, comfyWorkflowDigest } from '../lib/comfyui-workflow.js';
import { executeConfigCommand } from '../lib/provider-config-service.js';
import { loadProviderCatalog, imageCandidatesFromCatalog, providerTaskBinding, providerForTaskFromCatalog } from '../lib/provider-catalog.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { configuredImagePorts } from '../lib/configured-image-runtime.js';
import { FLOW_RESULT } from './fixtures/image-flow-fixture.mjs';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-comfyui'), requests = [], graphs = [], apps = [];
const workflow = { version: 0, promptNode: '6', outputNode: '9', sizeNode: '5', graph: {
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'Original positive prompt', clip: ['4', 1] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'Iris' } }
} };
let mode = 'queued', currentId = 'comfy-task-1', phase = 'queued';
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url, 'http://fixture'); requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization });
  const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/system_stats') return send({ system: { os: 'fixture' } });
  if (url.pathname === '/prompt') {
    graphs.push(JSON.parse(Buffer.concat(chunks)).prompt);
    if (mode === 'rejected') return send({ error: 'validation error' }, 400);
    if (mode === 'lost') { req.socket.destroy(); return; }
    if (mode === 'malformed') return send({ number: 2 });
    return send({ prompt_id: currentId, number: 0, node_errors: {} });
  }
  if (url.pathname === '/queue') return send({ queue_running: [], queue_pending: phase === 'queued' ? [[0, currentId]] : [] });
  if (url.pathname.startsWith('/history/')) {
    if (phase === 'queued' || phase === 'missing') return send({});
    return send({ [currentId]: { status: { completed: true, status_str: phase === 'failed' ? 'error' : 'success' }, outputs: { '9': { images: [
      { filename: phase === 'unsafe' ? '../escape.png' : 'iris result.png', subfolder: 'Iris/test', type: 'output' }
    ] } } } });
  }
  if (url.pathname === '/view') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(FLOW_RESULT); return; }
  send({ error: 'not found' }, 404);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port, registry = await createProviderRegistry();
const configPath = path.join(root, 'providers.json'), model = { id: 'my-workflow', capabilities: ['image-gen'], comfyWorkflow: workflow };
const provider = { id: 'comfy', name: 'Local ComfyUI', baseUrl, mediaProtocol: 'comfyui', auth: 'none', apiKey: 'retained-private-fixture', models: [model] };
fs.writeFileSync(configPath, JSON.stringify({ providers: [provider], assignments: { 'image-gen': { mode: 'auto', models: [] } } }), { mode: 0o600 });
try {
  assert.equal(registry.snapshot().protocols.find(protocol => protocol.id === 'comfyui').capabilities.join(','), 'image-gen');
  assert.deepEqual(checkedComfyWorkflow(workflow), workflow);
  assert.equal(comfyWorkflowDigest(workflow), comfyWorkflowDigest({ ...workflow, graph: Object.fromEntries(Object.entries(workflow.graph).reverse()) }));
  for (const invalid of [{ nodes: [] }, { ...workflow, promptNode: 'missing' }, { ...workflow, sizeNode: '6' }, { ...workflow, version: 1 }]) assert.throws(() => checkedComfyWorkflow(invalid));
  const route = imageCandidatesFromCatalog(loadProviderCatalog(configPath), 'comfy::my-workflow', registry)[0];
  const binding = providerTaskBinding(route.provider, registry);
  const adapter = createConfiguredProviderAdapter(route.provider, { registry });
  const discovered = await invokeProviderOperation(adapter, 'discover', {}); assert.deepEqual(discovered.models.map(item => item.id), ['my-workflow']);
  const settings = await executeConfigCommand(configPath, 'settings.show', {}, { registry });
  assert.equal(settings.providers[0].models[0].comfyWorkflow.configured, true);
  assert(!JSON.stringify(settings).includes('Original positive prompt')); assert(!JSON.stringify(settings).includes(provider.apiKey));
  const savedProvider = settings.providers[0];
  const save = { expectedRevision: settings.revision, credential: { action: 'keep' }, provider: {
    id: savedProvider.id, name: savedProvider.name, baseUrl, mediaBaseUrl: '', mediaProtocol: 'comfyui', auth: 'none', enabled: true,
    models: [{ id: model.id, capabilities: ['image-gen'], imageProtocol: 'auto' }]
  } };
  await executeConfigCommand(configPath, 'settings.save', save, { registry });
  assert.deepEqual(loadProviderCatalog(configPath).providers[0].models[0].comfyWorkflow, workflow, 'omitted graph is preserved on ordinary settings saves');

  const dataRoot = path.join(root, 'core'), app = createApplicationRuntime({ dataRoot, ...configuredImagePorts(configPath, registry) }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true });
  const created = await app.execute('creation.generate', { key: crypto.randomUUID(), value: { modelRef: 'comfy::my-workflow', prompt: 'A violet iris', size: '768x512' } });
  assert.equal(graphs.length, 0, 'catalog, import and creation never enqueue');
  const run_id = created.flow.run.id, first = await app.execute('flow.continue', { run_id });
  assert.equal(first.status, 'running'); assert.equal(first.task.remoteTaskId, currentId); assert.equal(graphs.length, 1);
  assert.equal(graphs[0]['6'].inputs.text, 'A violet iris'); assert.equal(graphs[0]['5'].inputs.width, 768);
  assert.equal(workflow.graph['5'].inputs.width, 512, 'input graph remains immutable');
  assert.equal((await app.execute('flow.continue', { run_id })).status, 'running');
  phase = 'done'; const completed = await app.execute('flow.continue', { run_id });
  assert.equal(completed.status, 'awaiting_selection'); assert.equal(graphs.length, 1);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, completed.run.output.artifactId).bytes, FLOW_RESULT);
  assert.equal(requests.filter(item => item.method === 'POST').length, 1); assert(requests.every(item => item.authorization === undefined));
  assert.equal(completed.task.providerBinding, binding);
  const changed = loadProviderCatalog(configPath); changed.providers[0].models[0].comfyWorkflow.graph['5'].inputs.width = 1024;
  assert.throws(() => providerForTaskFromCatalog(changed, completed.task, registry), { code: 'IRIS_PROVIDER_TASK_BINDING_MISMATCH' });
  for (const state of ['missing', 'failed', 'unsafe']) {
    phase = state;
    if (state === 'unsafe') await assert.rejects(invokeProviderOperation(adapter, 'poll', { remoteTaskId: currentId }), /图片位置/);
    else assert.equal((await invokeProviderOperation(adapter, 'poll', { remoteTaskId: currentId })).kind, state === 'missing' ? 'unknown' : 'failed');
  }
  for (const next of ['rejected', 'lost', 'malformed']) {
    mode = next;
    const result = await invokeProviderOperation(adapter, 'submit', { capability: 'image', model: model.id, input: { prompt: 'test', n: 1 } });
    assert.equal(result.kind, next === 'rejected' ? 'not_accepted' : 'acceptance_unknown');
  }
  const beforeUnsafe = requests.length;
  await assert.rejects(invokeProviderOperation(adapter, 'download', { artifact: { kind: 'remote-url', url: 'http://127.0.0.1:1/view?filename=x&subfolder=&type=output' }, targetPath: path.join(root, 'bad') }));
  assert.equal(requests.length, beforeUnsafe, 'credentials and download cannot be redirected to arbitrary URLs');
  assert.equal(adapter.operations.cancel, undefined); assert(!requests.some(item => /interrupt|upload|delete/.test(item.path)));
  console.log('PASS native ComfyUI HTTP: API workflow validation/projection, zero-call setup, prompt mapping, queue/history/view, durable Task delivery, workflow binding, unknown/rejection, auth:none and no global interrupt');
} finally { await Promise.allSettled(apps.map(app => app.dispose())); await registry.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
