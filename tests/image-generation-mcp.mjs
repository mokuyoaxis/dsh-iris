import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { createConnectionPair, readConnectionGrants } from '../lib/core-connections.js';
import { connectionSkillResources } from '../lib/connection-skill.js';
import { bridgeToolsForScopes } from '../lib/core-bridge-tools.js';
import { inspectCoreTask } from '../lib/core-tasks.js';
import { FLOW_MODEL, FLOW_SOURCE, FLOW_RESULT, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-image-generation-mcp'), dataRoot = path.join(root, 'core'), children = [], clients = [];
const fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
const scopes = ['read', 'create', 'execute', 'stop'], read = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(block => block.type === 'text').text); };
let api;
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true });
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const edit = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'Existing edit capability' });
  const pairs = ['image-edit', 'image-generate'].map(capability => createConnectionPair({ dataRoot, directory: path.join(root, capability),
    origin: 'http://127.0.0.1:1', label: capability, scopes, capabilities: [capability] }));
  const grantsFile = path.join(root, 'grants.json'); write(grantsFile, { schemaVersion: 0, grants: pairs.flatMap(pair => readConnectionGrants(pair.serverFile)) });
  api = createLocalReadApi({ dataRoot, allowExecution: true, allowSelection: true, allowMcp: true, executionPorts: fixture, connectionsFile: grantsFile });
  const session = await api.start();
  for (const pair of pairs) write(pair.clientFile, { ...read(pair.clientFile), origin: session.origin });
  const oldClient = createCoreServiceClient({ connectionFile: pairs[0].clientFile, requestedScopes: scopes }); clients.push(oldClient); await oldClient.connect();
  const generationClient = createCoreServiceClient({ connectionFile: pairs[1].clientFile, requestedScopes: scopes }); clients.push(generationClient); await generationClient.connect();
  await assert.rejects(oldClient.createGeneration({ key: crypto.randomUUID(), value: { modelRef: FLOW_MODEL, prompt: 'Forbidden generation' } }), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' });
  await assert.rejects(generationClient.continueRun({ key: crypto.randomUUID(), runId: edit.run.id, expectedRevision: 1 }), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' });
  assert.equal((await generationClient.runs()).total, 0);

  let submitCount = 0;
  for (const transport of ['stdio', 'http']) {
    const client = transport === 'http' ? httpMcpClient(session.origin, read(pairs[1].clientFile).accessToken)
      : stdioMcpClient(path.resolve('bin/dsh-iris.js'), pairs[1].clientFile, scopes.join(','));
    if (transport === 'stdio') children.push(client);
    await client.initialize();
    const names = (await client.request('tools/list')).tools.map(tool => tool.name);
    assert(names.includes('iris_core_create_generation')); assert(!names.includes('iris_core_create_run')); assert(!names.includes('iris_core_import_image'));
    assert.equal(names.length, 11);
    const key = crypto.randomUUID(), args = { key, modelRef: FLOW_MODEL, prompt: 'Generation over production ' + transport };
    const created = parse(await client.call('iris_core_create_generation', args));
    assert.equal(created.flow.recipe, 'image-generate/v0'); assert.equal(created.flow.source, null);
    assert.equal(parse(await client.call('iris_core_create_generation', args)).flow.id, created.flow.id, 'a lost create response reuses the original creation identity');
    assert.equal(fixture.calls.submit.length, submitCount);
    await assert.rejects(oldClient.run(created.flow.id), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' });
    await assert.rejects(oldClient.continueRun({ key: crypto.randomUUID(), runId: created.flow.id, expectedRevision: 1 }), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' });
    const continueArgs = { key: crypto.randomUUID(), runId: created.flow.id, expectedRevision: 1 };
    const accepted = parse(await client.call('iris_core_continue', continueArgs));
    for (let index = 0; index < 100; index++) {
      const saved = parse(await client.call('iris_core_operation', { operationId: accepted.operation.id }));
      if (!['queued', 'running'].includes(saved.operation.state)) { assert.equal(saved.operation.state, 'succeeded'); break; }
      await new Promise(resolve => setTimeout(resolve, 10)); assert(index < 99);
    }
    let finished = parse(await client.call('iris_core_run', { runId: created.flow.id }));
    if (finished.status === 'running') {
      // The scripted lifecycle fixture switches to an accepted asynchronous response after its first submit.
      const originalTask = finished.task.id;
      const observed = parse(await client.call('iris_core_continue', { key: crypto.randomUUID(), runId: finished.id, expectedRevision: finished.revision }));
      for (let index = 0; index < 100; index++) {
        const saved = parse(await client.call('iris_core_operation', { operationId: observed.operation.id }));
        if (!['queued', 'running'].includes(saved.operation.state)) { assert.equal(saved.operation.state, 'succeeded'); break; }
        await new Promise(resolve => setTimeout(resolve, 10)); assert(index < 99);
      }
      finished = parse(await client.call('iris_core_run', { runId: created.flow.id })); assert.equal(finished.task.id, originalTask);
    }
    assert.equal(finished.status, 'awaiting_selection'); assert.equal(finished.comparison, null);
    assert.equal(parse(await client.call('iris_core_continue', continueArgs)).operation.id, accepted.operation.id);
    const image = await client.call('iris_core_image', { artifactId: finished.output.artifactId });
    assert.deepEqual(Buffer.from(image.content.find(block => block.type === 'image').data, 'base64'), FLOW_RESULT);
    for (const action of [() => oldClient.operation(accepted.operation.id), () => oldClient.lookup(continueArgs.key),
      () => oldClient.stop(accepted.operation.id), () => oldClient.image(finished.output.artifactId)]) {
      await assert.rejects(action(), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' });
    }
    assert.equal((await oldClient.runs()).total, 1, 'legacy capability sees only its original edit Runs');
    const selected = await fetch(session.origin + '/api/v0/runs/' + finished.id + '/selection', { method: 'POST',
      headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifactId: finished.output.artifactId, expectedRevision: finished.revision }) });
    assert.equal(selected.status, 200); await selected.arrayBuffer();
    const download = await fetch(session.origin + '/api/v0/runs/' + finished.id + '/download', { headers: { Authorization: 'Bearer ' + session.accessToken } });
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), FLOW_RESULT);
    submitCount++; assert.equal(fixture.calls.submit.length, submitCount);
    if (transport === 'stdio') assert.equal((await client.close()).status, 0);
  }
  const interrupted = await app.execute('creation.generate', { key: crypto.randomUUID(), value: { modelRef: FLOW_MODEL, prompt: 'Delivery before Run checkpoint' } });
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to.endsWith(interrupted.flow.run.id + '.json') && JSON.parse(fs.readFileSync(from)).output) {
      throw Object.assign(new Error('controlled output checkpoint failure'), { code: 'EIO' });
    }
    return originalRename(from, to);
  };
  try {
    const initial = await app.execute('flow.continue', { run_id: interrupted.flow.run.id });
    assert.equal(initial.status, 'running');
    await assert.rejects(app.execute('flow.continue', { run_id: interrupted.flow.run.id }), { code: 'EIO' });
  } finally { fs.renameSync = originalRename; }
  const deliveredTask = inspectCoreTask(dataRoot, interrupted.flow.run.generate.taskId);
  assert.equal(deliveredTask.deliveryState, 'ready');
  await assert.rejects(oldClient.image(deliveredTask.artifactIds[0]), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' });
  assert.deepEqual((await generationClient.image(deliveredTask.artifactIds[0])).bytes, FLOW_RESULT);
  const submitBeforeRecovery = fixture.calls.submit.length;
  assert.equal((await app.execute('flow.continue', { run_id: interrupted.flow.run.id })).status, 'awaiting_selection');
  assert.equal(fixture.calls.submit.length, submitBeforeRecovery, 'delivered output before Run checkpoint recovers without another submit');
  const bundle = { schemaVersion: 0, kind: 'iris-mcp-skill', rootId: read(pairs[1].clientFile).rootId,
    connectionId: pairs[1].connectionId, revision: 1, label: 'Generate', scopes, capabilities: ['image-generate'],
    tools: bridgeToolsForScopes(scopes, ['image-generate']).map(tool => tool.name) };
  const skill = connectionSkillResources(bundle, {});
  const text = skill.bytes['SKILL.md'].toString(); assert(text.includes('iris_core_create_generation')); assert(!text.includes('iris_core_create_run'));
  console.log('PASS image generation API/MCP: production stdio + HTTP, explicit new capability, frozen legacy selection, shared-tool Run/Operation/image isolation, original creation/continue Keys, exact bytes and scoped Skill');
} finally { for (const child of children.reverse()) await child.kill(); await Promise.allSettled(clients.map(client => client.dispose())); await api?.dispose(); await app.dispose(); }
