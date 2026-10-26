import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair, readConnectionGrants } from '../lib/core-connections.js';
import { LEGACY_BRIDGE_TOOLS_V0 as BRIDGE_TOOL_NAMES } from '../lib/core-bridge-selection.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-http');
const dataRoot = path.join(root, 'core'), fixture = imageFlowFixture(dataRoot);
const app = createApplicationRuntime({ dataRoot, ...fixture }), children = [];
const key = () => crypto.randomUUID(), read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(block => block.type === 'text').text); };
let api;
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const roles = [
    { label: 'full', scopes: ['read', 'create', 'execute', 'stop'] },
    { label: 'read' }, { label: 'control', capabilities: [] }, { label: 'empty', capabilities: [], tools: [] },
    { label: 'native', harnessKind: 'dsh' }
  ];
  const pairs = roles.map(role => createConnectionPair({ dataRoot, directory: path.join(root, role.label), origin: 'http://127.0.0.1:1', ...role }));
  const grantsFile = path.join(root, 'grants.json');
  write(grantsFile, { schemaVersion: 0, grants: pairs.flatMap(pair => readConnectionGrants(pair.serverFile)) });
  api = createLocalReadApi({ dataRoot, allowExecution: true, allowMcp: true, executionPorts: fixture, connectionsFile: grantsFile });
  const started = await api.start(); assert.equal(started.mcpEndpoint, started.origin + '/mcp');
  for (const pair of pairs) write(pair.clientFile, { ...read(pair.clientFile), origin: started.origin });
  const full = read(pairs[0].clientFile);
  let submitted = 0;
  for (const transport of ['stdio', 'http']) for (const version of ['2025-11-25', '2026-07-28']) {
    const client = transport === 'http' ? httpMcpClient(started.origin, full.accessToken, { version, name: 'arbitrary-http-product' })
      : stdioMcpClient(path.resolve('bin/dsh-iris.js'), pairs[0].clientFile, 'read,create,execute,stop', { version, name: 'unregistered-stdio-product' });
    if (transport === 'stdio') children.push(client);
    const hello = await client.initialize();
    const serverInfo = version === '2026-07-28' ? hello._meta?.['io.modelcontextprotocol/serverInfo'] : hello.serverInfo;
    assert.equal(serverInfo?.name, 'iris-core');
    if (version === '2026-07-28') assert(hello.supportedVersions.includes(version));
    const listed = (await client.request('tools/list')).tools;
    assert.deepEqual(listed.map(tool => tool.name).sort(), [...BRIDGE_TOOL_NAMES].sort());
    assert(listed.every(tool => tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false));
    const called = new Set();
    const call = async (name, args = {}) => { called.add(name); return client.call(name, args); };
    assert.equal(parse(await call('iris_core_connection')).adapterId, 'iris.mcp');
    assert.equal(parse(await call('iris_core_connections')).connections.length, 1);
    assert(Array.isArray(parse(await call('iris_core_models')).models));
    assert.equal(typeof parse(await call('iris_core_runs')).total, 'number');
    const invalid = await call('iris_core_continue', { arbitraryCommand: 'generate' }); assert(invalid.isError);
    assert.equal(fixture.calls.submit.length, submitted);
    const imported = parse(await call('iris_core_import_image', { key: key(), imageBase64: FLOW_SOURCE.toString('base64'), mediaType: 'image/png' }));
    const created = parse(await call('iris_core_create_run', { key: key(), sourceArtifactId: imported.artifact.artifactId,
      modelRef: FLOW_MODEL, prompt: 'Transport parity ' + transport + ' ' + version }));
    assert.equal(fixture.calls.submit.length, submitted, 'upload/create never generates');
    const input = { key: key(), runId: created.flow.id, expectedRevision: created.flow.revision };
    const accepted = parse(await call('iris_core_continue', input));
    let terminal;
    for (let index = 0; index < 200; index++) {
      terminal = parse(await call('iris_core_operation', { operationId: accepted.operation.id })).operation;
      if (!['queued', 'running'].includes(terminal.state)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(terminal.state, 'succeeded');
    assert.equal(parse(await call('iris_core_lookup', { key: input.key })).operation.id, accepted.operation.id);
    let run = parse(await call('iris_core_run', { runId: created.flow.id }));
    if (run.status === 'running') {
      const originalTask = run.task.id;
      const observed = parse(await call('iris_core_continue', { key: key(), runId: run.id, expectedRevision: run.revision }));
      for (let index = 0; index < 200; index++) {
        const saved = parse(await call('iris_core_operation', { operationId: observed.operation.id })).operation;
        if (!['queued', 'running'].includes(saved.state)) { assert.equal(saved.state, 'succeeded'); break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      run = parse(await call('iris_core_run', { runId: run.id })); assert.equal(run.task.id, originalTask);
    }
    assert.equal(run.status, 'awaiting_selection'); assert.equal(run.task.attemptCount, 1);
    const image = await call('iris_core_image', { artifactId: run.output.artifactId });
    const content = image.content.find(block => block.type === 'image'); assert.equal(content.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(content.data, 'base64'), readCoreArtifactBytes(dataRoot, run.output.artifactId).bytes);
    assert.equal(parse(await call('iris_core_stop', { operationId: accepted.operation.id })).localStopped, false);
    assert.equal(parse(await call('iris_core_continue', input)).operation.id, accepted.operation.id);
    submitted++; assert.equal(fixture.calls.submit.length, submitted);
    assert.deepEqual([...called].sort(), [...BRIDGE_TOOL_NAMES].sort(), 'every registered tool must be exercised');
    if (transport === 'stdio') assert.equal((await client.close()).status, 0);
    console.log('PASS', transport, version, 'all 12 tools, actual parameters, durable Core, image bytes and original Key');
  }
  for (let index = 1; index < 4; index++) {
    const client = httpMcpClient(started.origin, read(pairs[index].clientFile).accessToken, { version: '2026-07-28' });
    await client.initialize(); const names = (await client.request('tools/list')).tools.map(tool => tool.name);
    assert.equal(names.length, [0, 8, 2, 0][index]);
    await assert.rejects(client.call('iris_core_continue', { key: key(), runId: 'run_' + 'a'.repeat(24), expectedRevision: 1 }), { rpcCode: -32602 });
  }
  for (const headers of [{}, { Authorization: 'Bearer ' + 'a'.repeat(43) }, { Authorization: 'Bearer ' + started.accessToken },
    { Authorization: 'Bearer ' + read(pairs[4].clientFile).accessToken },
    { Authorization: 'Bearer ' + full.accessToken, Origin: 'https://foreign.invalid' }]) {
    const response = await fetch(started.mcpEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    assert([401, 403].includes(response.status)); await response.arrayBuffer();
  }
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.request(started.mcpEndpoint, { method: 'POST', headers: { Host: 'foreign.invalid',
      Authorization: 'Bearer ' + full.accessToken, 'Content-Type': 'application/json' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(foreignHost, 403);
  const mismatched = await fetch(started.mcpEndpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + full.accessToken,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'mismatch-test', version: '1' } } } }) });
  assert.equal(mismatched.status, 400); assert.equal((await mismatched.json()).error.code, -32020);
  const unsupported = await fetch(started.mcpEndpoint, { method: 'GET', headers: { Authorization: 'Bearer ' + full.accessToken } });
  assert.equal(unsupported.status, 405); await unsupported.arrayBuffer();
  const oversized = await fetch(started.mcpEndpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + full.accessToken,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: ' '.repeat(9 * 1024 * 1024 + 1) });
  assert.equal(oversized.status, 413); await oversized.arrayBuffer();
  assert.equal(fixture.calls.submit.length, submitted, 'denied and oversized requests make no new submission');
  console.log('PASS HTTP standard Bearer, role/selection isolation, empty tools, Origin/Host, methods and body bound');
} finally {
  for (const child of children.reverse()) await child.kill();
  await api?.dispose(); await app.dispose();
}
