import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-bridge'), dataRoot = path.join(root, 'core'), clients = [];
const fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
const key = () => crypto.randomUUID(), readJson = file => JSON.parse(fs.readFileSync(file));
let api;
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(block => block.type === 'text').text); };
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'pair'), origin: 'http://127.0.0.1:1', harnessKind: 'kimi', label: 'MCP fixture', scopes: ['read', 'create', 'execute', 'stop'] });
  api = createLocalReadApi({ dataRoot, allowExecution: true, executionPorts: fixture, connectionsFile: pair.serverFile });
  const started = await api.start(), credentials = readJson(pair.clientFile);
  fs.writeFileSync(pair.clientFile, JSON.stringify({ ...credentials, origin: started.origin }) + '\n', { mode: 0o600 });
  const cli = path.resolve('bin/dsh-iris.js'), client = stdioMcpClient(cli, pair.clientFile, 'read,create,execute,stop'); clients.push(client);
  const hello = await client.initialize(); assert.equal(hello.serverInfo.name, 'iris-core'); assert(hello.capabilities.tools);
  const tools = (await client.request('tools/list')).tools;
  assert.equal(tools.length, 12); assert(tools.find(tool => tool.name === 'iris_core_continue').inputSchema.properties.expectedRevision);
  const invalid = await client.call('iris_core_continue', { arbitraryCommand: 'generate' }); assert(invalid.isError);
  assert.deepEqual(readFlowEvents(dataRoot), []);
  const imported = parse(await client.call('iris_core_import_image', { key: key(), imageBase64: FLOW_SOURCE.toString('base64'), mediaType: 'image/png' }));
  const created = parse(await client.call('iris_core_create_run', { key: key(), sourceArtifactId: imported.artifact.artifactId,
    modelRef: 'flow-fixture::edit', prompt: 'Actual parameterized MCP fixture, preserve the subject' }));
  const run = created.flow, input = { key: key(), runId: run.id, expectedRevision: run.revision };
  assert.deepEqual(readFlowEvents(dataRoot), [], 'create is zero-generation');
  const accepted = parse(await client.call('iris_core_continue', input));
  for (let index = 0; index < 100; index++) {
    const saved = parse(await client.call('iris_core_operation', { operationId: accepted.operation.id }));
    if (!['queued', 'running'].includes(saved.operation.state)) { assert.equal(saved.operation.state, 'succeeded'); break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const finished = parse(await client.call('iris_core_run', { runId: run.id }));
  assert.equal(finished.status, 'awaiting_selection'); assert.equal(finished.task.attemptCount, 1);
  const image = await client.call('iris_core_image', { artifactId: finished.output.artifactId });
  const content = image.content.find(block => block.type === 'image'); assert(content);
  assert.equal(content.mimeType, 'image/png'); assert.deepEqual(Buffer.from(content.data, 'base64'), readCoreArtifactBytes(dataRoot, finished.output.artifactId).bytes);
  const events = readFlowEvents(dataRoot); assert.equal(events.filter(event => event.kind === 'submit').length, 1);
  assert.equal((await client.close()).status, 0, 'EOF must close the actual production CLI process');
  assert(!client.output().stdout.includes(credentials.accessToken)); assert(!client.output().stderr.includes(credentials.accessToken));
  const next = stdioMcpClient(cli, pair.clientFile, 'read,create,execute,stop'); clients.push(next); await next.initialize();
  assert.equal(parse(await next.call('iris_core_lookup', { key: input.key })).operation.id, accepted.operation.id);
  assert.equal(parse(await next.call('iris_core_continue', input)).operation.id, accepted.operation.id);
  assert.deepEqual(readFlowEvents(dataRoot), events);
  assert.equal(fixture.calls.submit.length, 1);
  const reader = stdioMcpClient(cli, pair.clientFile); clients.push(reader); await reader.initialize();
  assert.equal((await reader.request('tools/list')).tools.length, 8);
  await assert.rejects(reader.call('iris_core_continue', input), { rpcCode: -32602 });
  assert.deepEqual(readFlowEvents(dataRoot), events);
  assert.equal((await reader.close()).status, 0);
  assert.equal((await next.close()).status, 0);
  console.log('Official SDK MCP: real production CLI, legacy version negotiation, 12 finite schemas, actual parameters/HTTP/Core, original image bytes, restricted tools, EOF and cross-process durable replay OK');
} finally {
  for (const client of clients.reverse()) await client.kill();
  await api?.dispose(); await app.dispose();
}
