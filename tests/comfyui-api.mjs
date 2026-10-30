import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair, readConnectionGrants } from '../lib/core-connections.js';
import { COMFY_WORKFLOW, comfyProtocolFixture } from './fixtures/comfyui-protocol-fixture.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { FLOW_RESULT } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-comfyui-api'), fixture = await comfyProtocolFixture(), children = [], services = [];
const dataRoot = path.join(root, 'core'), configPath = path.join(root, 'providers.json'), scopes = ['read', 'create', 'execute', 'stop'];
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const read = file => JSON.parse(fs.readFileSync(file));
write(configPath, { providers: [{ id: 'comfy', name: 'Comfy', baseUrl: fixture.baseUrl, mediaProtocol: 'comfyui', auth: 'none',
  models: [{ id: 'portrait', capabilities: ['image-gen'], comfyWorkflow: COMFY_WORKFLOW }] }], assignments: { 'image-gen': { mode: 'auto', models: [] } } });
const app = createApplicationRuntime({ dataRoot });
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(block => block.type === 'text').text); };
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true }); await app.dispose();
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'pair'), origin: 'http://127.0.0.1:1', label: 'Comfy caller', scopes, capabilities: ['image-generate'] });
  const api = createLocalReadApi({ dataRoot, providerConfigPath: configPath, allowExecution: true, allowSelection: true, allowMcp: true,
    allowProviderManagement: true, connectionsFile: pair.serverFile }); services.push(api);
  const session = await api.start(); write(pair.clientFile, { ...read(pair.clientFile), origin: session.origin });
  const call = async (route, value, extra = {}) => {
    const response = await fetch(session.origin + route, { method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + session.accessToken, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, text: await response.text() };
  };
  const settings = JSON.parse((await call('/api/v0/provider-management/settings')).text), configBytes = fs.readFileSync(configPath);
  const check = { expectedRevision: settings.revision, modelRef: 'comfy::portrait', workflowParameters: { lora: 'portrait.safetensors', seed: 42 } };
  const checked = await call('/api/v0/provider-management/workflow-check', check);
  assert.equal(checked.status, 200); assert(JSON.parse(checked.text).ok); assert.equal(fixture.graphs.length, 0);
  assert.deepEqual(fs.readFileSync(configPath), configBytes);
  const draft = { expectedRevision: settings.revision, providerId: 'comfy', comfyWorkflow: structuredClone(COMFY_WORKFLOW) };
  const draftCheck = await call('/api/v0/provider-management/workflow-check', draft);
  assert.equal(draftCheck.status, 200); assert(JSON.parse(draftCheck.text).ok);
  assert.deepEqual(fs.readFileSync(configPath), configBytes); assert.equal(fixture.graphs.length, 0);
  for (const invalid of [{ ...draft, modelRef: 'comfy::portrait' }, { ...draft, providerId: 'absent' },
    { ...draft, expectedRevision: 'stale' }, { ...draft, baseUrl: 'https://untrusted.invalid' },
    { ...draft, comfyWorkflow: { ...COMFY_WORKFLOW, graph: {} } }, { ...check, providerId: 'comfy' }]) {
    assert([400, 409].includes((await call('/api/v0/provider-management/workflow-check', invalid)).status));
  }
  assert.equal((await call('/api/v0/provider-management/workflow-check', { ...check, expectedRevision: 'stale' })).status, 409);
  assert.equal((await call('/api/v0/provider-management/workflow-check', { ...check, workflowParameters: { injected: true } })).status, 400);
  const grant = readConnectionGrants(pair.serverFile)[0], beforeDenied = fixture.requests.length;
  assert.equal((await call('/api/v0/provider-management/workflow-check', check, { Authorization: 'Bearer ' + grant.accessToken, 'Iris-Connection-Id': grant.connectionId })).status, 403);
  assert.equal((await call('/api/v0/provider-management/workflow-check', check, { Origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await call('/api/v0/provider-management/workflow-check', draft, { Authorization: 'Bearer ' + grant.accessToken, 'Iris-Connection-Id': grant.connectionId })).status, 403);
  assert.equal((await call('/api/v0/provider-management/workflow-check', draft, { Origin: 'https://outside.invalid' })).status, 403);
  assert.equal(fixture.requests.length, beforeDenied, 'denied checks do not contact the provider');
  fixture.mode = 'unauthorized';
  const unavailable = await call('/api/v0/provider-management/workflow-check', draft);
  assert.equal(unavailable.status, 502); assert.equal(JSON.parse(unavailable.text).error.code, 'IRIS_COMFYUI_CHECK_UNAVAILABLE');
  assert(!unavailable.text.includes('private fixture upstream detail')); fixture.mode = 'normal';
  let started, release;
  const begun = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  fixture.beforeInfo = async () => { fixture.beforeInfo = undefined; started(); await gate; };
  const pendingCheck = call('/api/v0/provider-management/workflow-check', draft);
  await begun;
  try {
    const changed = JSON.parse(configBytes); changed.providers[0].name = 'Changed during inspection'; write(configPath, changed); release();
    const stale = await pendingCheck; assert.equal(stale.status, 409); assert.equal(JSON.parse(stale.text).error.code, 'IRIS_CONFIG_CHANGED');
  } finally { release(); fixture.beforeInfo = undefined; fs.writeFileSync(configPath, configBytes); }
  const createOnly = createLocalReadApi({ dataRoot, providerConfigPath: configPath, allowLocalWrites: true }); services.push(createOnly);
  const co = await createOnly.start();
  const requestsAfterChecks = fixture.requests.length;
  const invalidDraft = await fetch(co.origin + '/api/v0/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + co.accessToken,
    'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ modelRef: 'comfy::portrait', prompt: 'Invalid draft', workflowParameters: { unknown: true } }) });
  assert.equal(invalidDraft.status, 400); await invalidDraft.arrayBuffer();
  assert.equal(fixture.requests.length, requestsAfterChecks, 'draft validation without execution remains local');
  const readonly = createLocalReadApi({ dataRoot, providerConfigPath: configPath }); services.push(readonly);
  const ro = await readonly.start();
  const denied = await fetch(ro.origin + '/api/v0/provider-management/workflow-check', { method: 'POST',
    headers: { Authorization: 'Bearer ' + ro.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(check) });
  assert.equal(denied.status, 405); await denied.arrayBuffer();
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/dsh-iris.js', 'models', 'workflow-check', 'comfy::portrait',
    '--provider-config', configPath, '--input', JSON.stringify({ workflow_parameters: { seed: 99 } })], { timeout: 30000 });
  assert(JSON.parse(stdout).ok); assert.equal(fixture.graphs.length, 0); assert.deepEqual(fs.readFileSync(configPath), configBytes);

  for (const transport of ['stdio', 'http']) {
    const mcp = transport === 'stdio' ? stdioMcpClient(path.resolve('bin/dsh-iris.js'), pair.clientFile, scopes.join(',')) : httpMcpClient(session.origin, read(pair.clientFile).accessToken);
    if (transport === 'stdio') children.push(mcp);
    await mcp.initialize();
    const schema = (await mcp.request('tools/list')).tools.find(tool => tool.name === 'iris_core_create_generation').inputSchema;
    assert.equal(schema.properties.workflowParameters.maxProperties, 32);
    const models = parse(await mcp.call('iris_core_models'));
    assert.equal(models.models[0].comfyWorkflow.parameters.find(parameter => parameter.id === 'seed').type, 'integer');
    assert(!JSON.stringify(models).includes('filename_prefix')); assert(!JSON.stringify(models).includes('class_type'));
    const before = fixture.graphs.length, key = crypto.randomUUID();
    const args = { key, modelRef: 'comfy::portrait', prompt: 'Iris through ' + transport, workflowParameters: { seed: 66, model_weight: 0.6, clip_weight: 0.3 } };
    const created = parse(await mcp.call('iris_core_create_generation', args));
    assert.equal(created.flow.input.workflowParameters.seed, 66); assert.equal(fixture.graphs.length, before);
    assert.equal(parse(await mcp.call('iris_core_create_generation', args)).flow.id, created.flow.id);
    const conflict = await mcp.call('iris_core_create_generation', { ...args, workflowParameters: { seed: 67 } }); assert(conflict.isError);
    const invalid = await mcp.call('iris_core_create_generation', { ...args, key: crypto.randomUUID(), workflowParameters: { seed: { nested: true } } }); assert(invalid.isError);
    const wait = async id => {
      for (let i = 0; i < 100; i++) {
        const value = parse(await mcp.call('iris_core_operation', { operationId: id }));
        if (!['queued', 'running'].includes(value.operation.state)) { assert.equal(value.operation.state, 'succeeded'); return; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('finite ComfyUI operation did not finish');
    };
    fixture.phase = 'queued';
    const submitted = parse(await mcp.call('iris_core_continue', { key: crypto.randomUUID(), runId: created.flow.id, expectedRevision: 1 })); await wait(submitted.operation.id);
    const running = parse(await mcp.call('iris_core_run', { runId: created.flow.id })); assert.equal(running.status, 'running');
    assert.equal(fixture.graphs.length, before + 1); assert.equal(fixture.graphs.at(-1)['3'].inputs.seed, 66);
    assert.equal(fixture.graphs.at(-1)['10'].inputs.strength_model, 0.6); assert.equal(fixture.graphs.at(-1)['10'].inputs.strength_clip, 0.3);
    fixture.phase = 'done';
    const observed = parse(await mcp.call('iris_core_continue', { key: crypto.randomUUID(), runId: created.flow.id, expectedRevision: running.revision })); await wait(observed.operation.id);
    const finished = parse(await mcp.call('iris_core_run', { runId: created.flow.id }));
    assert.equal(finished.status, 'awaiting_selection'); assert.equal(finished.task.id, running.task.id); assert.equal(fixture.graphs.length, before + 1);
    const image = await mcp.call('iris_core_image', { artifactId: finished.output.artifactId });
    assert.deepEqual(Buffer.from(image.content.find(block => block.type === 'image').data, 'base64'), FLOW_RESULT);
    if (transport === 'stdio') assert.equal((await mcp.close()).status, 0);
  }
  assert.deepEqual(read(configPath).providers[0].models[0].comfyWorkflow, COMFY_WORKFLOW);
  console.log('PASS ComfyUI owner-only check API + CLI, revision/origin guards, parameter discovery and production stdio/HTTP MCP snapshot -> submit -> original Task observe -> exact image bytes');
} finally { for (const child of children.reverse()) await child.kill(); await Promise.allSettled(services.map(api => api.dispose())); await app.dispose(); await fixture.close(); }
