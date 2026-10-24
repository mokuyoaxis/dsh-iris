// Explicit installed SDK verification. No daily profile, installation or real model access.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { bridgeToolsForScopes } from '../lib/core-bridge-tools.js';
import { createDshHostAdapter } from '../lib/dsh-host-adapter.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { FLOW_SOURCE, imageFlowFixture, readFlowEvents } from '../tests/fixtures/image-flow-fixture.mjs';

const [flag, suppliedRoot] = process.argv.slice(2);
assert.equal(flag, '--dsh-root'); assert(path.isAbsolute(suppliedRoot));
const dshRoot = fs.realpathSync(suppliedRoot), requireDsh = createRequire(path.join(dshRoot, 'package.json'));
const manifest = JSON.parse(fs.readFileSync(path.join(dshRoot, 'package.json')));
assert.equal(manifest.name, '@deepseek-ai/dsh');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-core-service-dsh-'));
const report = { status: 'running', work, dsh: { root: dshRoot, version: manifest.version }, checks: [] };
const save = () => fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const load = name => import(pathToFileURL(requireDsh.resolve(name)));
const originalFetch = globalThis.fetch;
let origin, ctx, api, app, pluginFiber;
process.env.DSH_HOME = path.join(work, 'isolated-dsh'); process.env.IRIS_IMPORT_WORKBENCH_CONFIG = '';
process.argv[1] = path.join(dshRoot, 'lib/bin.js');
globalThis.fetch = (value, options) => {
  assert.equal(new URL(typeof value === 'string' || value instanceof URL ? value : value.url).origin, origin, 'external network forbidden');
  return originalFetch(value, options);
};
async function check(name, fn) { await fn(); report.checks.push(name); save(); }
console.log('验收目录：' + work);
try {
  const [{ Context }, { LocalAttachmentStore }, { ToolRuntime }, { SystemPrompt }, { SkillRegistry }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-attachment-local'), load('@deepseek-ai/dsh-tools'),
    load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-skill')
  ]);
  ctx = new Context();
  for (const [plugin, config] of [[LocalAttachmentStore, { dshHome: process.env.DSH_HOME }], [SystemPrompt, {}], [ToolRuntime, {}], [SkillRegistry, {}]]) await ctx.plugin(plugin, config);
  const dataRoot = path.join(work, 'shared-core'), fixture = imageFlowFixture(dataRoot);
  app = createApplicationRuntime({ dataRoot, ...fixture });
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const pair = createConnectionPair({ dataRoot, directory: path.join(work, 'pair'), origin: 'http://127.0.0.1:1',
    harnessKind: 'dsh', label: 'Isolated DSH', scopes: ['read', 'create', 'execute', 'stop'] });
  api = createLocalReadApi({ dataRoot, allowExecution: true, connectionsFile: pair.serverFile, executionPorts: fixture });
  const started = await api.start(); origin = started.origin;
  const client = JSON.parse(fs.readFileSync(pair.clientFile)); client.origin = origin;
  fs.writeFileSync(pair.clientFile, JSON.stringify(client) + '\n', { mode: 0o600 });
  process.env.IRIS_CORE_CONNECTION_FILE = pair.clientFile; process.env.IRIS_CORE_SCOPES = 'read,create,execute,stop';
  const iris = await import('../lib/index.js');
  pluginFiber = ctx.plugin({ name: iris.name, inject: iris.inject, apply: iris.apply }); await pluginFiber;
  const toolCall = async (name, args) => {
    const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name, arguments: args,
      agent: { ctx, session: { id: 'isolated-core-service' } }, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result)); return result;
  };
  const textCall = async (name, args) => JSON.parse((await toolCall(name, args)).content.find(block => block.type === 'text').text);
  await check('real plugin retains 17 native tools and 3 Skills while adding 12 authorized shared-Flow tools', async () => {
    const names = ctx.get('tools').schemas().map(tool => tool.name);
    assert.equal(names.filter(name => name.startsWith('iris_core_')).length, bridgeToolsForScopes(['read', 'create', 'execute', 'stop']).length);
    assert.equal(names.filter(name => !name.startsWith('iris_core_')).length, 17);
    assert.equal((await ctx.get('skills').list()).length, 3);
    assert.equal(ctx.get('irisCoreService').snapshot().state, 'open');
    assert.deepEqual(readFlowEvents(dataRoot), []);
    assert.equal(createDshHostAdapter(ctx, { version: manifest.version }).id, 'deepseek-harness');
  });
  let artifact, flow, operation;
  await check('actual tool schemas reject extra arguments without Provider calls', async () => {
    const invalid = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_core_runs', arguments: { arbitraryCommand: 'run.image' },
      agent: { ctx, session: { id: 'isolated-core-service' } }, signal: new AbortController().signal });
    assert.equal(invalid.isError, true); assert.deepEqual(readFlowEvents(dataRoot), []);
  });
  await check('native calls use real Core HTTP creation and durable Operation identity', async () => {
    const imported = await textCall('iris_core_import_image', { key: crypto.randomUUID(), imageBase64: FLOW_SOURCE.toString('base64'), mediaType: 'image/png' });
    artifact = imported.artifact.artifactId;
    flow = (await textCall('iris_core_create_run', { key: crypto.randomUUID(), sourceArtifactId: artifact,
      modelRef: 'flow-fixture::edit', prompt: 'native shared Flow fixture' })).flow;
    assert.deepEqual(readFlowEvents(dataRoot), []);
    const call = { key: crypto.randomUUID(), runId: flow.id, expectedRevision: flow.revision };
    operation = (await textCall('iris_core_continue', call)).operation;
    for (let i = 0; i < 100; i++) {
      operation = (await textCall('iris_core_operation', { operationId: operation.id })).operation;
      if (!['queued', 'running'].includes(operation.state)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(operation.state, 'succeeded');
    assert.equal((await textCall('iris_core_continue', call)).operation.id, operation.id);
    assert.equal(readFlowEvents(dataRoot).filter(event => event.kind === 'submit').length, 1);
    assert.equal(fixture.calls.submit.length, 1);
  });
  await check('actual attachment store receives exact original Core image bytes', async () => {
    flow = await textCall('iris_core_run', { runId: flow.id });
    const shown = await toolCall('iris_core_image', { artifactId: flow.output.artifactId });
    const block = shown.content.find(item => item.type === 'image'); assert(block);
    const actual = await ctx.get('attachments').readImage(block.attachment);
    assert.deepEqual(Buffer.from(actual.data), readCoreArtifactBytes(dataRoot, flow.output.artifactId).bytes);
  });
  await check('explicit service failure does not route shared Flow into the native legacy root', async () => {
    await api.dispose();
    const failed = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_core_run', arguments: { runId: flow.id },
      agent: { ctx, session: { id: 'isolated-core-service' } }, signal: new AbortController().signal });
    assert.equal(failed.isError, true);
    assert.equal(readFlowEvents(dataRoot).filter(event => event.kind === 'submit').length, 1);
    // No native media was invoked; its original root is not used for the shared Run.
    assert(!fs.existsSync(path.join(process.env.DSH_HOME, 'iris/v1/core-v0/task-store')));
  });
  // Reopen only the isolated service so the bridge can explicitly unregister its connection on unload.
  api = createLocalReadApi({ dataRoot, allowExecution: true, connectionsFile: pair.serverFile, executionPorts: fixture });
  await api.start({ port: Number(new URL(origin).port) });
  await textCall('iris_core_connection', {});
  await check('actual Fiber unload waits for service disconnect and removes both tool sets', async () => {
    await pluginFiber.dispose(); assert.equal(ctx.get('tools').schemas().length, 0); pluginFiber = null;
  });
  await check('offline Core does not prevent local Fiber unload or claim remote disconnection', async () => {
    pluginFiber = ctx.plugin({ name: iris.name, inject: iris.inject, apply: iris.apply }); await pluginFiber;
    const bridge = ctx.get('irisCoreService'); await api.dispose();
    await pluginFiber.dispose(); pluginFiber = null;
    assert.equal(ctx.get('tools').schemas().length, 0);
    assert.equal(bridge.snapshot().state, 'closed'); assert.equal(bridge.snapshot().remoteDisconnect, 'unconfirmed');
  });
  report.status = 'passed'; save(); console.log('PASS ' + report.checks.length + ' Core service/DSH checks: ' + path.join(work, 'report.json'));
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; save(); throw error;
} finally {
  if (pluginFiber) await pluginFiber.dispose();
  if (ctx) await ctx.fiber.dispose();
  await api?.dispose(); await app?.dispose(); globalThis.fetch = originalFetch;
}
