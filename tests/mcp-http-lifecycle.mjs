import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-http-lifecycle'), apis = [], apps = [];
const key = () => crypto.randomUUID();
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(item => item.type === 'text').text); };
async function setup(name) {
  const dataRoot = path.join(root, name);
  let entered;
  const sent = new Promise(resolve => { entered = resolve; });
  const fixture = imageFlowFixture(dataRoot, { afterSend: ({ signal }) => new Promise((_resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(Object.assign(new Error('fixture locally stopped'), { name: 'AbortError' })), { once: true });
  }) });
  const app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, name + '-pair'), origin: 'http://127.0.0.1:1',
    label: name, scopes: ['read', 'create', 'execute', 'stop'] });
  const api = createLocalReadApi({ dataRoot, allowExecution: true, allowMcp: true, executionPorts: fixture, connectionsFile: pair.serverFile }); apis.push(api);
  const started = await api.start(), config = JSON.parse(fs.readFileSync(pair.clientFile));
  const client = httpMcpClient(started.origin, config.accessToken, { version: '2026-07-28' });
  await client.initialize();
  const imported = parse(await client.call('iris_core_import_image', { key: key(), imageBase64: FLOW_SOURCE.toString('base64'), mediaType: 'image/png' }));
  const run = parse(await client.call('iris_core_create_run', { key: key(), sourceArtifactId: imported.artifact.artifactId,
    modelRef: FLOW_MODEL, prompt: 'HTTP lifecycle ' + name })).flow;
  return { dataRoot, fixture, pair, api, started, config, client, run, sent };
}
function discardContinue(origin, token, input) {
  const request = http.request(origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'tools/call', 'Mcp-Name': 'iris_core_continue' } }, response => response.resume());
  request.on('error', () => {}); // This test deliberately abandons its own response socket.
  request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'iris_core_continue', arguments: input,
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'abandoning-client', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {} } } }));
  return request;
}
try {
  const first = await setup('disconnect-stop');
  const input = { key: key(), runId: first.run.id, expectedRevision: first.run.revision };
  const socket = discardContinue(first.started.origin, first.config.accessToken, input);
  await first.sent; socket.destroy();
  const reconnect = httpMcpClient(first.started.origin, first.config.accessToken, { version: '2025-11-25' });
  await reconnect.initialize();
  const accepted = parse(await reconnect.call('iris_core_lookup', { key: input.key })).operation;
  assert.equal(accepted.state, 'running', 'disconnect does not stop the accepted Core operation');
  assert.equal(parse(await reconnect.call('iris_core_continue', input)).operation.id, accepted.id);
  const stopped = parse(await reconnect.call('iris_core_stop', { operationId: accepted.id }));
  assert.equal(stopped.operation.state, 'canceled'); assert.equal(stopped.localStopped, true);
  assert.equal(stopped.remoteCancellation, 'not_requested');
  const original = parse(await reconnect.call('iris_core_run', { runId: input.runId }));
  assert.equal(original.task.acceptance, 'unknown'); assert.equal(original.task.attemptCount, 1);
  assert.equal(first.fixture.calls.submit.length, 1); assert.equal(first.fixture.calls.cancel.length, 0);
  await first.api.dispose();

  const second = await setup('shutdown');
  const secondInput = { key: key(), runId: second.run.id, expectedRevision: second.run.revision };
  const pending = parse(await second.client.call('iris_core_continue', secondInput)); await second.sent;
  await second.api.dispose();
  const replacementPorts = imageFlowFixture(second.dataRoot);
  const replacement = createLocalReadApi({ dataRoot: second.dataRoot, allowExecution: true, allowMcp: true,
    executionPorts: replacementPorts, connectionsFile: second.pair.serverFile }); apis.push(replacement);
  const started = await replacement.start();
  const next = httpMcpClient(started.origin, second.config.accessToken, { version: '2026-07-28' }); await next.initialize();
  const recovered = parse(await next.call('iris_core_lookup', { key: secondInput.key })).operation;
  assert.equal(recovered.id, pending.operation.id); assert.equal(recovered.state, 'interrupted');
  assert.equal(parse(await next.call('iris_core_continue', secondInput)).operation.id, recovered.id);
  let current = parse(await next.call('iris_core_run', { runId: second.run.id }));
  assert.equal(current.task.acceptance, 'unknown'); const taskId = current.task.id;
  const explicit = parse(await next.call('iris_core_continue', { key: key(), runId: current.id, expectedRevision: current.revision }));
  let terminal;
  for (let i = 0; i < 200; i++) {
    terminal = parse(await next.call('iris_core_operation', { operationId: explicit.operation.id })).operation;
    if (!['queued', 'running'].includes(terminal.state)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(terminal.state, 'succeeded');
  current = parse(await next.call('iris_core_run', { runId: current.id })); assert.equal(current.task.id, taskId);
  assert.equal(second.fixture.calls.submit.length, 1); assert.equal(replacementPorts.calls.submit.length, 0);
  console.log('PASS HTTP abandoned response, cross-protocol reconnect/original Key, local stop/unknown Task, graceful shutdown/restart interruption and explicit resume without resubmission');
} finally {
  for (const api of apis.reverse()) await api.dispose();
  for (const app of apps.reverse()) await app.dispose();
}
