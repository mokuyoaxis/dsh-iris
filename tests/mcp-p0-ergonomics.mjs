import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { LEGACY_BRIDGE_TOOLS_V0 } from '../lib/core-bridge-selection.js';
import { CORE_BRIDGE_TOOLS, callCoreBridgeTool } from '../lib/core-bridge-tools.js';
import { createVisionProviderAdapter } from '../lib/vision-provider-adapter.js';
import { loadCorePluginRegistry } from '../lib/plugins.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-p0'), dataRoot = path.join(root, 'core'), store = path.join(root, 'managed');
const uuid = () => crypto.randomUUID();
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(block => block.type === 'text').text); };

let submitGate = null, submitEntered = null, releaseGate = null;
const setupFixture = imageFlowFixture(dataRoot);
const imageFixture = imageFlowFixture(dataRoot, {
  beforeSubmit: async (_input, context) => {
    submitEntered?.();
    if (submitGate) {
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (context?.signal?.aborted) return onAbort();
        context?.signal?.addEventListener('abort', onAbort, { once: true });
        submitGate.then(() => { context?.signal?.removeEventListener('abort', onAbort); resolve(); });
      });
    }
  }
});
let visionPosts = 0;
const visionAdapter = createVisionProviderAdapter(
  { id: 'vision-fixture', type: 'openai', baseUrl: 'https://vision.invalid/v1', apiKey: 'CONTROLLED_KEY' },
  {
    fetchPort: async () => {
      visionPosts++;
      return new Response(
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })
        + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      );
    }
  }
);
const setupPorts = {
  resolveImageCandidates: setupFixture.resolveImageCandidates,
  resolveVisionCandidates: () => [{ adapter: visionAdapter, model: 'vision-fixture::vision', providerBinding: 'sha256:' + 'a'.repeat(64), selectionReason: 'explicit' }],
  resolveTaskAdapter: task => task.provider === 'vision-fixture' ? visionAdapter : setupFixture.resolveTaskAdapter(task)
};
const ports = {
  resolveImageCandidates: imageFixture.resolveImageCandidates,
  resolveVisionCandidates: () => [{ adapter: visionAdapter, model: 'vision-fixture::vision', providerBinding: 'sha256:' + 'a'.repeat(64), selectionReason: 'explicit' }],
  resolveTaskAdapter: task => task.provider === 'vision-fixture' ? visionAdapter : imageFixture.resolveTaskAdapter(task)
};

const app = createApplicationRuntime({ dataRoot, ...setupPorts });
const children = [], clients = [];
let api, readOnlyApi, registry;

try {
  await app.execute('flow.init', {});
  await app.execute('execution.init', { vision: true });

  const sourcePng = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } }).png().toBuffer();
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const visionSource = (await app.execute('artifact.import', { image_bytes: sourcePng })).artifact;

  // 2 image-edit runs (1 selected, 1 unselected), 1 vision run, 1 ocr run.
  const imgSelected = (await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'Selected edit' })).run;
  const completedSelected = await app.execute('flow.continue', { run_id: imgSelected.id });
  await app.execute('flow.select', { run_id: imgSelected.id, artifact_id: completedSelected.run.output.artifactId });
  const imgUnselected = (await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'Unselected edit' })).run;
  const visionRun = (await app.execute('creation.vision', { key: uuid(), value: { sourceArtifactId: visionSource.id, modelRef: 'vision-fixture::vision', question: 'What is shown?' } })).flow.run;
  const ocrRun = (await app.execute('creation.ocr', { key: uuid(), value: { sourceArtifactId: visionSource.id, modelRef: 'vision-fixture::vision', chunkHeight: 100, overlap: 0, maxInvocations: 1 } })).flow.run;
  assert.equal(setupFixture.calls.submit.length, 1);
  assert.equal(imageFixture.calls.submit.length, 0);

  registry = await loadCorePluginRegistry({ entries: [path.resolve('plugins/contact-sheet/index.mjs')] });
  const pluginPin = registry.dependency('operations', 'community.contact-sheet.create');

  // Legacy frozen static grant without iris_core_run_operations.
  const legacyPair = createConnectionPair({
    dataRoot, directory: path.join(root, 'legacy-pair'), origin: 'http://127.0.0.1:1',
    label: 'Legacy frozen v0', scopes: ['read'], capabilities: ['image-edit'], tools: [...LEGACY_BRIDGE_TOOLS_V0]
  });

  api = createLocalReadApi({
    dataRoot, allowExecution: true, allowMcp: true, executionPorts: ports,
    allowConnectionManagement: true, connectionStore: store, connectionsFile: legacyPair.serverFile,
    pluginRegistry: registry, allowedOperations: ['community.contact-sheet.create']
  });
  const session = await api.start();

  const manage = async (route, value) => {
    const response = await fetch(session.origin + '/api/v0/connection-management' + route, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + session.accessToken, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    assert(response.ok, route + ' HTTP ' + response.status);
    return response.json();
  };

  const fullKey = uuid();
  await manage('/connections', {
    key: fullKey, label: 'Full P0', scopes: ['read', 'create', 'execute', 'stop'],
    capabilities: ['image-edit', 'vision', 'ocr'], pluginOperations: [pluginPin]
  });
  const fullHttpConfig = (await manage('/connections/' + fullKey + '/export', { transport: 'http', format: 'entry' })).configuration;
  const fullStdioConfig = (await manage('/connections/' + fullKey + '/export', { transport: 'stdio', format: 'entry' })).configuration;

  const imageReadKey = uuid();
  await manage('/connections', { key: imageReadKey, label: 'Image read only', scopes: ['read'], capabilities: ['image-edit'] });
  const imageReadToken = (await manage('/connections/' + imageReadKey + '/export', { transport: 'http', format: 'entry' })).configuration.headers.Authorization.slice(7);

  const revokeTargetKey = uuid();
  await manage('/connections', { key: revokeTargetKey, label: 'Revoke mid-wait', scopes: ['read'], capabilities: ['image-edit'] });
  const revokeTargetToken = (await manage('/connections/' + revokeTargetKey + '/export', { transport: 'http', format: 'entry' })).configuration.headers.Authorization.slice(7);

  const revokeStdioKey = uuid();
  await manage('/connections', { key: revokeStdioKey, label: 'Revoke stdio mid-wait', scopes: ['read'], capabilities: ['image-edit'] });
  const revokeStdioConfig = (await manage('/connections/' + revokeStdioKey + '/export', { transport: 'stdio', format: 'entry' })).configuration;

  const fullHttp = httpMcpClient(session.origin, fullHttpConfig.headers.Authorization.slice(7), { version: '2026-07-28', name: 'p0-http' });
  await fullHttp.initialize();
  const fullStdio = stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read,create,execute,stop', { version: '2025-11-25', name: 'p0-stdio', launch: fullStdioConfig });
  children.push(fullStdio);
  await fullStdio.initialize();
  const imageReadHttp = httpMcpClient(session.origin, imageReadToken, { version: '2026-07-28', name: 'p0-image-read' });
  await imageReadHttp.initialize();

  // 1. Tool annotations: openWorldHint is true ONLY for scope === 'execute'.
  const scopeMap = new Map(CORE_BRIDGE_TOOLS.map(tool => [tool.name, tool.scope]));
  for (const listed of [(await fullHttp.request('tools/list')).tools, (await fullStdio.request('tools/list')).tools]) {
    assert(listed.some(tool => tool.name === 'iris_core_run_operations'));
    assert(listed.some(tool => tool.name === 'iris_core_plugin_call'));
    for (const tool of listed) {
      const scope = scopeMap.get(tool.name);
      assert(scope, 'known tool ' + tool.name);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: scope === 'read',
        destructiveHint: scope === 'stop',
        idempotentHint: true,
        openWorldHint: scope === 'execute'
      }, tool.name + ' annotations');
    }
  }

  // 2. iris_core_runs kind/selection filtering + pagination + capability isolation.
  const allRuns = parse(await fullHttp.call('iris_core_runs', { kind: 'all' }));
  assert.equal(allRuns.total, 4);
  assert.deepEqual(allRuns.counts, { all: 4, selected: 1, unselected: 3 });

  const imageRuns = parse(await fullStdio.call('iris_core_runs', { kind: 'image' }));
  assert.equal(imageRuns.total, 2);
  assert.deepEqual(imageRuns.counts, { all: 2, selected: 1, unselected: 1 });
  assert.equal(parse(await fullHttp.call('iris_core_runs', { kind: 'image', selection: 'selected' })).runs.map(r => r.id).join(','), imgSelected.id);
  assert.equal(parse(await fullHttp.call('iris_core_runs', { kind: 'image', selection: 'unselected' })).runs.map(r => r.id).join(','), imgUnselected.id);
  assert.equal(parse(await fullHttp.call('iris_core_runs', { kind: 'vision' })).runs.map(r => r.id).join(','), visionRun.id);
  assert.equal(parse(await fullHttp.call('iris_core_runs', { kind: 'ocr' })).runs.map(r => r.id).join(','), ocrRun.id);

  // Bounded pagination combined with kind filter.
  const page1 = parse(await fullHttp.call('iris_core_runs', { kind: 'image', limit: 1 }));
  assert.equal(page1.runs.length, 1);
  assert(page1.nextCursor);
  const page2 = parse(await fullHttp.call('iris_core_runs', { kind: 'image', limit: 1, cursor: page1.nextCursor }));
  assert.equal(page2.runs.length, 1);
  assert.equal(page2.nextCursor, null);
  assert.notEqual(page1.runs[0].id, page2.runs[0].id);

  // Capability isolation: image-edit connection requesting kind: ocr/vision sees zero runs.
  assert.equal(parse(await imageReadHttp.call('iris_core_runs', { kind: 'ocr' })).total, 0);
  assert.equal(parse(await imageReadHttp.call('iris_core_runs', { kind: 'vision' })).total, 0);
  assert.equal(parse(await imageReadHttp.call('iris_core_runs', { kind: 'image', selection: 'selected' })).runs[0].id, imgSelected.id);

  // Schema rejects invalid kind/selection values.
  assert.equal((await fullHttp.call('iris_core_runs', { kind: 'unknown' })).isError, true);
  assert.equal((await fullHttp.call('iris_core_runs', { selection: 'invalid' })).isError, true);
  assert.equal(imageFixture.calls.submit.length, 0);
  assert.equal(visionPosts, 0);

  // 3. iris_core_operation bounded waitMs + iris_core_run_operations recovery & isolation.
  const gatePromise = () => new Promise(resolve => { releaseGate = resolve; });
  submitGate = gatePromise();
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  submitEntered = () => enteredResolve();

  const firstContinue = parse(await fullHttp.call('iris_core_continue', { key: uuid(), runId: imgUnselected.id, expectedRevision: imgUnselected.revision }));
  const firstOpId = firstContinue.operation.id;
  await entered;

  // Omitted waitMs and waitMs: 0 return immediately while running.
  assert.equal(parse(await imageReadHttp.call('iris_core_operation', { operationId: firstOpId })).operation.state, 'running');
  assert.equal(parse(await imageReadHttp.call('iris_core_operation', { operationId: firstOpId, waitMs: 0 })).operation.state, 'running');

  // Invalid waitMs bounds rejected cleanly before Core.
  for (const bad of [-1, 10001, 1.5, '100']) {
    assert.equal((await imageReadHttp.call('iris_core_operation', { operationId: firstOpId, waitMs: bad })).isError, true);
  }

  // Short waitMs expires cleanly with current running state (not an error, no resubmission).
  const tShort = performance.now();
  const stillRunning = parse(await imageReadHttp.call('iris_core_operation', { operationId: firstOpId, waitMs: 120 }));
  assert.equal(stillRunning.operation.state, 'running');
  assert(performance.now() - tShort >= 90, 'bounded wait should wait up to waitMs');

  // Revocation mid-wait on stdio terminates promptly with IRIS_CONNECTION_AUTH_REQUIRED.
  const revokeStdio = stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read', { version: '2025-11-25', name: 'p0-revoke-stdio', launch: revokeStdioConfig });
  children.push(revokeStdio);
  await revokeStdio.initialize();
  const tStdioRevoke = performance.now();
  const waitingStdioRevoke = revokeStdio.call('iris_core_operation', { operationId: firstOpId, waitMs: 5000 });
  const stdioRevokePromise = new Promise(resolve => setTimeout(resolve, 80))
    .then(() => manage('/connections/' + revokeStdioKey + '/revoke', { expectedRevision: 1 }));
  const [stdioRevokedOutcome] = await Promise.all([waitingStdioRevoke, stdioRevokePromise]);
  assert.equal(stdioRevokedOutcome.isError, true);
  assert.equal(stdioRevokedOutcome.structuredContent.error.code, 'IRIS_CONNECTION_AUTH_REQUIRED');
  assert(performance.now() - tStdioRevoke < 2000, 'stdio mid-wait revocation must exit promptly');
  assert.equal((await revokeStdio.close()).status, 0);

  // Revocation mid-wait on HTTP aborts the waiting entry promptly and rejects subsequent requests with 401.
  const revokeClient = httpMcpClient(session.origin, revokeTargetToken, { version: '2026-07-28', name: 'p0-revoke' });
  await revokeClient.initialize();
  const tRevoke = performance.now();
  const waitingRevoke = revokeClient.call('iris_core_operation', { operationId: firstOpId, waitMs: 5000 }).catch(error => ({ transportError: error }));
  const revokePromise = new Promise(resolve => setTimeout(resolve, 80))
    .then(() => manage('/connections/' + revokeTargetKey + '/revoke', { expectedRevision: 1 }));
  const [revokedOutcome] = await Promise.all([waitingRevoke, revokePromise]);
  assert(revokedOutcome.transportError || revokedOutcome.isError === true, 'HTTP mid-wait revocation must abort or fail');
  assert(performance.now() - tRevoke < 2000, 'HTTP mid-wait revocation must exit promptly');
  await assert.rejects(revokeClient.request('tools/list'), error => error.status === 401);

  // Client disconnect mid-wait aborts cleanly and releases HTTP activeMessages slot.
  const tDisconnect = performance.now();
  const abandoned = http.request(session.origin + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + imageReadToken,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'iris_core_operation'
    }
  }, res => res.resume());
  abandoned.on('error', () => {});
  abandoned.end(JSON.stringify({
    jsonrpc: '2.0', id: 99, method: 'tools/call',
    params: {
      name: 'iris_core_operation', arguments: { operationId: firstOpId, waitMs: 10000 },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'p0-abort', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} }
    }
  }));
  await new Promise(resolve => setTimeout(resolve, 100));
  abandoned.destroy();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert(performance.now() - tDisconnect < 1500);

  // Direct callCoreBridgeTool AbortSignal cancellation during waitMs.
  const directClient = createCoreServiceClient({
    connection: { ...JSON.parse(fs.readFileSync(legacyPair.clientFile, 'utf8')), origin: session.origin },
    requestedScopes: ['read']
  });
  clients.push(directClient);
  await directClient.connect();
  const controller = new AbortController();
  const tAbort = performance.now();
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(
    callCoreBridgeTool(directClient, 'iris_core_operation', { operationId: firstOpId, waitMs: 10000 }, { signal: controller.signal }),
    { code: 'IRIS_CORE_SERVICE_ABORTED', name: 'AbortError' }
  );
  assert(performance.now() - tAbort < 1000, 'AbortSignal must stop waitDelay promptly');

  // Mid-wait completion: while waiting (5000 ms), concurrent Core reads remain unblocked, and releasing gate completes immediately.
  const tWait = performance.now();
  const waitPromise = fullStdio.call('iris_core_operation', { operationId: firstOpId, waitMs: 5000 });
  await new Promise(resolve => setTimeout(resolve, 80));
  const concurrentRuns = await fetch(session.origin + '/api/v0/runs?limit=5', { headers: { Authorization: 'Bearer ' + session.accessToken } });
  assert.equal(concurrentRuns.status, 200, 'bounded MCP wait must not block Core activeReads');
  await concurrentRuns.arrayBuffer();
  releaseGate();
  submitGate = null;
  submitEntered = null;
  const waitedResult = parse(await waitPromise);
  assert.equal(waitedResult.operation.state, 'succeeded');
  assert(performance.now() - tWait < 2000, 'completed operation must return promptly without waiting full waitMs');
  assert.equal(imageFixture.calls.submit.length, 1);

  // Create a second Operation on the same Run so iris_core_run_operations pagination is exercised.
  const afterFirst = parse(await fullHttp.call('iris_core_run', { runId: imgUnselected.id }));
  // Re-continue (already awaiting_selection -> operation will finish quickly or fail cleanly, creating a 2nd Operation record).
  const secondContinue = parse(await fullHttp.call('iris_core_continue', { key: uuid(), runId: imgUnselected.id, expectedRevision: afterFirst.revision }));
  const secondOpId = secondContinue.operation.id;
  const secondDone = parse(await fullHttp.call('iris_core_operation', { operationId: secondOpId, waitMs: 5000 }));
  assert(!['queued', 'running'].includes(secondDone.operation.state));

  // Read-only connection lists Run Operations with pagination (recovering IDs purely from runId).
  const opPage1 = parse(await imageReadHttp.call('iris_core_run_operations', { runId: imgUnselected.id, limit: 1 }));
  assert.equal(opPage1.total, 2);
  assert.equal(opPage1.operations.length, 1);
  assert(opPage1.nextCursor);
  const opPage2 = parse(await imageReadHttp.call('iris_core_run_operations', { runId: imgUnselected.id, limit: 1, cursor: opPage1.nextCursor }));
  assert.equal(opPage2.operations.length, 1);
  assert.equal(opPage2.nextCursor, null);
  assert.deepEqual(new Set([opPage1.operations[0].id, opPage2.operations[0].id]), new Set([firstOpId, secondOpId]));

  // Capability isolation: image-edit connection cannot list operations of an OCR Run.
  assert.equal((await imageReadHttp.call('iris_core_run_operations', { runId: ocrRun.id })).isError, true);

  // Legacy frozen connection: does not receive iris_core_run_operations AND direct HTTP route is denied with 403.
  const legacyConfig = JSON.parse(fs.readFileSync(legacyPair.clientFile, 'utf8'));
  const legacyHttp = httpMcpClient(session.origin, legacyConfig.accessToken, { version: '2026-07-28', name: 'p0-legacy' });
  await legacyHttp.initialize();
  const legacyTools = (await legacyHttp.request('tools/list')).tools.map(t => t.name);
  assert(!legacyTools.includes('iris_core_run_operations'));
  assert.equal(legacyTools.length, 8);
  await assert.rejects(legacyHttp.call('iris_core_run_operations', { runId: imgUnselected.id }), { rpcCode: -32602 });
  const directForbidden = await fetch(session.origin + '/api/v0/runs/' + imgUnselected.id + '/operations', {
    headers: {
      Authorization: 'Bearer ' + legacyConfig.accessToken,
      'Iris-Connection-Id': legacyConfig.connectionId,
      'Iris-Runtime-Id': directClient.snapshot().runtimeInstanceId
    }
  });
  assert.equal(directForbidden.status, 403);
  await directForbidden.arrayBuffer();

  // Read-only Core (execution disabled): iris_core_run_operations fails cleanly (404 / tool error), no execution started.
  await fullStdio.close();
  await directClient.dispose();
  await api.dispose();
  api = null;

  readOnlyApi = createLocalReadApi({
    dataRoot, allowExecution: false, allowMcp: true, allowConnectionManagement: true, connectionStore: store
  });
  const readOnlySession = await readOnlyApi.start();
  const readOnlyMcp = httpMcpClient(readOnlySession.origin, imageReadToken, { version: '2026-07-28', name: 'p0-no-exec' });
  await readOnlyMcp.initialize();
  const noExecRes = await readOnlyMcp.call('iris_core_run_operations', { runId: imgUnselected.id });
  assert.equal(noExecRes.isError, true);
  assert.equal(imageFixture.calls.submit.length, 1, 'no extra submission across all P0 tests');

  console.log('PASS MCP P0 ergonomics (runs kind/selection filter, run_operations pagination & legacy/capability isolation, openWorldHint, bounded operation waitMs & abort/revoke)');
} finally {
  releaseGate?.();
  submitGate = null;
  for (const child of children.reverse()) await child.kill();
  for (const client of clients.reverse()) await client.dispose();
  await api?.dispose();
  await readOnlyApi?.dispose();
  await registry?.dispose();
  await app.dispose();
}
