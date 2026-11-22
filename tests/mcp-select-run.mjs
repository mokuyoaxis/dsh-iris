import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { LEGACY_BRIDGE_TOOLS_V0 } from '../lib/core-bridge-selection.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { readFlowRun } from '../lib/flow-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-select-run');
const dataRoot = path.join(root, 'core'), fixture = imageFlowFixture(dataRoot);
const app = createApplicationRuntime({ dataRoot, ...fixture });
const toolName = 'iris_core_select_run', scopes = ['read', 'create'];
const grantsFile = path.join(root, 'grants.json'), cli = path.resolve('bin/dsh-iris.js');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const clients = [];
let api, stdio;

function pair(label, capabilities, tools, grantScopes = scopes) {
  return createConnectionPair({ dataRoot, directory: path.join(root, label), origin: 'http://127.0.0.1:1',
    label, scopes: grantScopes, capabilities, tools });
}
async function start(options) {
  api = createLocalReadApi({ dataRoot, allowMcp: true, connectionsFile: grantsFile, ...options });
  return api.start();
}
function identity(pair, session) {
  return { ...read(pair.clientFile), origin: session.origin };
}
async function direct(pair, session, requestedScopes = scopes) {
  const client = createCoreServiceClient({ connection: identity(pair, session), requestedScopes });
  clients.push(client);
  const selected = await client.connect();
  return { client, selected };
}
async function http(pair, session) {
  const client = httpMcpClient(session.origin, identity(pair, session).accessToken, { version: '2026-07-28' });
  await client.initialize();
  return client;
}
function result(value) {
  assert(!value.isError, JSON.stringify(value));
  return value.structuredContent;
}

try {
  await app.execute('flow.init', {});
  await app.execute('execution.init', { imageGeneration: true });
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const edited = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'Selection fixture' });
  const ready = (await app.execute('flow.continue', { run_id: edited.run.id })).run;
  const created = await app.execute('creation.generate', { key: crypto.randomUUID(), value: { modelRef: FLOW_MODEL, prompt: 'Generated selection' } });
  let generated = await app.execute('flow.continue', { run_id: created.flow.run.id });
  if (generated.status === 'running') generated = await app.execute('flow.continue', { run_id: created.flow.run.id });
  assert(ready.comparison && generated.run.output);
  const beforeSelect = fixture.calls.submit.length;

  const edit = pair('edit', ['image-edit'], ['iris_core_run', toolName]);
  const generate = pair('generate', ['image-generate'], ['iris_core_run', toolName]);
  const ordinary = pair('ordinary', ['image-edit']);
  const legacy = pair('legacy', ['image-edit']);
  const readOnly = pair('reader', ['image-edit'], ['iris_core_run', toolName], ['read']);
  assert(!ordinary.tools.includes(toolName));
  const legacyGrant = read(legacy.serverFile).grants[0], legacyClient = read(legacy.clientFile);
  for (const value of [legacyGrant, legacyClient]) { delete value.capabilities; delete value.tools; }
  write(legacy.clientFile, legacyClient);
  write(grantsFile, { schemaVersion: 0, grants: [edit, generate, ordinary, readOnly].map(value => read(value.serverFile).grants[0]).concat(legacyGrant) });
  const args = { runId: ready.id, expectedRevision: ready.revision, choice: 'source' };

  let session = await start({ allowLocalWrites: true });
  const disabled = await direct(edit, session);
  assert(!disabled.selected.instance.tools.includes(toolName));
  await assert.rejects(disabled.client.selectRun(args), { code: 'IRIS_API_READ_ONLY', status: 405 });
  await disabled.client.dispose(); await api.dispose();

  session = await start({ allowSelection: true });
  const noWrites = await direct(edit, session, ['read']);
  assert(!noWrites.selected.instance.tools.includes(toolName));
  await assert.rejects(noWrites.client.selectRun(args), { code: 'IRIS_API_READ_ONLY', status: 405 });
  await noWrites.client.dispose(); await api.dispose();

  session = await start({ allowSelection: true, allowLocalWrites: true });
  for (const grant of [ordinary, legacy, readOnly]) {
    const negotiated = await direct(grant, session, grant.scopes);
    if (grant !== readOnly) assert(!negotiated.selected.instance.tools.includes(toolName));
    if (grant === legacy) assert.deepEqual(negotiated.selected.instance.tools, LEGACY_BRIDGE_TOOLS_V0);
    const wire = await http(grant, session);
    assert(!(await wire.request('tools/list')).tools.some(tool => tool.name === toolName));
    await assert.rejects(negotiated.client.selectRun(args), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', status: 403 });
  }
  const incorrectGroup = await direct(generate, session);
  await assert.rejects(incorrectGroup.client.selectRun(args), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', status: 403 });
  const genArgs = { runId: generated.run.id, expectedRevision: generated.run.revision, choice: 'output' };
  await assert.rejects(incorrectGroup.client.selectRun({ ...genArgs, choice: 'source' }), { code: 'IRIS_API_SELECTION_INVALID', status: 409 });
  const pickedGeneration = await incorrectGroup.client.selectRun(genArgs);
  assert.equal(pickedGeneration.selection.artifactId, generated.run.output.artifactId);

  const web = await http(edit, session);
  const definition = (await web.request('tools/list')).tools.find(tool => tool.name === toolName);
  assert(definition);
  assert.equal(definition.annotations.readOnlyHint, false);
  assert.equal(definition.annotations.openWorldHint, false);
  const first = result(await web.call(toolName, args));
  assert.equal(first.selection.artifactId, source.id);
  assert.equal(first.revision, ready.revision + 1);
  write(edit.clientFile, identity(edit, session));
  stdio = stdioMcpClient(cli, edit.clientFile, scopes.join(','));
  await stdio.initialize();
  assert((await stdio.request('tools/list')).tools.some(tool => tool.name === toolName));
  const stale = await stdio.call(toolName, { ...args, choice: 'output' });
  assert.equal(stale.structuredContent.error.code, 'IRIS_API_RUN_CHANGED');
  const second = result(await stdio.call(toolName, { ...args, expectedRevision: first.revision, choice: 'output' }));
  assert.equal(second.selection.artifactId, ready.output.artifactId);
  assert.equal(second.revision, first.revision + 1);
  const same = result(await stdio.call(toolName, { ...args, expectedRevision: second.revision, choice: 'output' }));
  assert.equal(same.revision, second.revision);
  assert.deepEqual(readFlowRun(dataRoot, ready.id).selection, ready.output);
  assert.equal(fixture.calls.submit.length, beforeSelect);
  assert.equal((await stdio.close()).status, 0);
  console.log('PASS MCP image selection over stdio and HTTP, saved grants, service gates, Run groups, revisions and zero model calls');
} finally {
  await stdio?.kill();
  await Promise.allSettled(clients.map(client => client.dispose()));
  await api?.dispose();
  await app.dispose();
}
