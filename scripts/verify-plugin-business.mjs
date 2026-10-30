#!/usr/bin/env node
// Real official MCP clients, real Iris server and real business; public Iris interfaces only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createBusinessEnvironment } from '../tests/fixtures/plugin-business-consumer.mjs';

const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Usage: --client-sdk-root <installed-official-client> --output <new-directory>');
assert.equal(args[0], '--client-sdk-root'); assert.equal(args[2], '--output');
const sdkRoot = fs.realpathSync(args[1]), sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
assert.equal(sdk.name, '@modelcontextprotocol/client');
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.mjs')));
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkRoot, 'dist/stdio.mjs')));
const output = path.resolve(args[3]); fs.mkdirSync(output, { mode: 0o700 });
const env = await createBusinessEnvironment(), clients = new Set();
const report = { ok: false, sdkVersion: sdk.version, work: env.work, checks: [], paidCalls: 0 };
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
function parsed(result) { assert(!result.isError, JSON.stringify(result)); const value = JSON.parse(result.content.find(item => item.type === 'text').text); assert.deepEqual(value, result.structuredContent); return value; }
async function connect(record, transportName = 'http', protocol = '2025-11-25') {
  const exported = await env.exported(record, transportName), configuration = exported.configuration;
  const client = new Client({ name: 'Independent contact-sheet consumer', version: '1.0.0' },
    protocol === '2026-07-28' ? { versionNegotiation: { mode: { pin: protocol } } } : {});
  const transport = transportName === 'stdio'
    ? new StdioClientTransport({ ...configuration, stderr: 'pipe', env: { ...process.env, IRIS_CORE_CONNECTION_FILE: '', IRIS_IMPORT_WORKBENCH_CONFIG: '' } })
    : new StreamableHTTPClientTransport(new URL(configuration.url), { requestInit: { headers: configuration.headers } });
  clients.add(client); await client.connect(transport); assert.equal(client.getServerVersion().name, 'iris-core');
  assert.equal(Boolean(client.getDiscoverResult()), protocol === '2026-07-28', 'actual discovery must match the selected protocol era'); return client;
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const toolNames = async client => (await client.listTools()).tools.map(item => item.name);
async function closeClient(client) { await client.close(); clients.delete(client); }
async function poll(client, operationId) {
  for (let i = 0; i < 400; i++) {
    const value = parsed(await call(client, 'iris_core_operation', { operationId })).operation;
    if (!['queued', 'running'].includes(value.state)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('MCP Operation never finished');
}
try {
  await env.start();
  const none = await env.createConnection([]), noClient = await connect(none);
  assert.deepEqual((await toolNames(noClient)).sort(), ['iris_core_connection', 'iris_core_connections']);
  await closeClient(noClient); report.checks.push('installation alone exposes no business tools; unselected connection has only two control tools');
  const mixedResult = await env.http('/api/v0/connection-management/connections', { value: { key: crypto.randomUUID(), label: 'Media read plus plugin execution',
    scopes: ['read', 'execute'], capabilities: ['image-edit'], pluginOperations: [env.pin()] } }, 201);
  const mixed = (await env.http('/api/v0/connection-management/connections')).connections.find(item => item.connectionId === mixedResult.connectionId);
  const mixedClient = await connect(mixed); assert(!(await toolNames(mixedClient)).includes('iris_core_continue')); await closeClient(mixedClient);
  const skill = await env.http('/api/v0/connection-management/connections/' + mixed.connectionId + '/skill', { value: {} });
  assert(!skill.bundle.tools.includes('iris_core_continue')); assert(skill.bundle.tools.includes('iris_core_plugin_call'));
  report.checks.push('plugin execute scope does not expose the disabled media runner in real MCP discovery or generated Skill');
  let record = await env.createConnection(), request = env.request(), operation, originalBytes;
  const stdioConfiguration = (await env.exported(record, 'stdio')).configuration;
  const configArgs = stdioConfiguration.args;
  const readCheck = await env.cliRun('mcp', 'check', '--connection-file', configArgs[configArgs.indexOf('--connection-file') + 1]);
  assert.equal(readCheck.ok, true); assert.equal(readCheck.tools.length, 6); assert(readCheck.tools.includes('iris_core_plugin_catalog'));
  report.checks.push('public mcp check reports the actual selected read-only plugin tools and closes its own handshake without executing business');
  const savedFile = configArgs[configArgs.indexOf('--connection-file') + 1], savedClient = JSON.parse(fs.readFileSync(savedFile));
  const emptyFile = path.join(env.work, 'explicit-no-business.json');
  fs.writeFileSync(emptyFile, JSON.stringify({ ...savedClient, pluginOperations: [] }) + '\n', { mode: 0o600 });
  const noBusiness = await env.cliRun('mcp', 'check', '--connection-file', emptyFile);
  assert.equal(noBusiness.ok, true); assert.equal(noBusiness.tools.length, 2); assert(!noBusiness.connection.pluginOperations?.length);
  const invalidRuntime = crypto.randomUUID();
  await env.http('/api/v0/connections/' + record.connectionId + '/handshake', {
    headers: { Authorization: 'Bearer ' + savedClient.accessToken, 'Iris-Connection-Id': record.connectionId, 'Iris-Runtime-Id': invalidRuntime }, value: {
      contractVersion: 0, adapterId: 'iris.mcp', harnessKind: 'generic', runtimeInstanceId: invalidRuntime, harnessVersion: 'Invalid selection boundary',
      requestedScopes: ['read'], requestedPluginOperations: null
    }
  }, 400);
  report.checks.push('an explicit empty business selection negotiates zero businesses; null is rejected instead of falling back to a wider grant');
  for (const transport of ['stdio', 'http']) for (const protocol of ['2025-11-25', '2026-07-28']) {
    const client = await connect(record, transport, protocol);
    const names = await toolNames(client); assert.equal(names.length, 8); assert(names.includes('iris_core_plugin_call'));
    const catalog = parsed(await call(client, 'iris_core_plugin_catalog', { limit: 30 }));
    assert.equal(catalog.operations[0].available, true); assert.deepEqual(catalog.operations[0].dependency, request.dependency);
    assert.deepEqual(catalog.operations[0].inputSchema.required, ['artifactIds', 'columns', 'cellSize']);
    const bad = await call(client, 'iris_core_plugin_call', { ...request, key: crypto.randomUUID(), input: { ...request.input, cellSize: 0 } }); assert.equal(bad.isError, true);
    const accepted = parsed(await call(client, 'iris_core_plugin_call', request));
    const result = await poll(client, accepted.operation.id); assert.equal(result.state, 'succeeded');
    if (operation) assert.deepEqual(result, operation); operation = result;
    assert.equal(parsed(await call(client, 'iris_core_lookup', { key: request.key })).operation.id, operation.id);
    const image = (await call(client, 'iris_core_image', { artifactId: operation.result.artifactIds[0] })).content.find(item => item.type === 'image');
    assert.equal(image.mimeType, 'image/png'); const bytes = Buffer.from(image.data, 'base64');
    const metadata = await sharp(bytes).metadata(); assert.equal(metadata.width, 292); assert.equal(metadata.height, 152);
    if (originalBytes) assert.deepEqual(bytes, originalBytes); originalBytes = bytes;
    parsed(await call(client, 'iris_core_stop', { operationId: operation.id }));
    parsed(await call(client, 'iris_core_connection')); parsed(await call(client, 'iris_core_connections'));
    await closeClient(client);
    report.checks.push({ transport, protocol, tools: names.length, actualPng: true, originalOperationAndBytes: true }); save();
  }
  assert.equal((await env.http('/api/v0/plugin-operations/catalog')).artifacts.length, 3);
  fs.writeFileSync(path.join(output, 'contact-sheet.png'), originalBytes);
  report.checks.push('four transport/protocol combinations preserve one Operation and one real output; invalid business schema does not write');

  await env.close(); await env.start();
  let client = await connect(record);
  assert.deepEqual(parsed(await call(client, 'iris_core_lookup', { key: request.key })).operation, operation);
  assert.equal(parsed(await call(client, 'iris_core_plugin_call', request)).idempotentReplay, true);
  await closeClient(client); await env.close(); await env.start({ present: false });
  client = await connect(record);
  assert.equal(parsed(await call(client, 'iris_core_plugin_catalog')).operations[0].available, false);
  assert.deepEqual(parsed(await call(client, 'iris_core_operation', { operationId: operation.id })).operation, operation);
  const historicalImage = (await call(client, 'iris_core_image', { artifactId: operation.result.artifactIds[0] })).content.find(item => item.type === 'image');
  assert.deepEqual(Buffer.from(historicalImage.data, 'base64'), originalBytes);
  assert.equal((await call(client, 'iris_core_plugin_call', { ...request, key: crypto.randomUUID() })).isError, true);
  await closeClient(client); report.checks.push('Core restart and missing plugin are visible through real MCP: original operation/image remain readable, new execution fails');

  await env.close(); await env.start({ version: '0.1.1' }); client = await connect(record);
  assert.equal(parsed(await call(client, 'iris_core_plugin_catalog')).operations[0].available, false);
  assert.equal((await call(client, 'iris_core_plugin_call', { ...request, key: crypto.randomUUID() })).isError, true);
  assert.equal(parsed(await call(client, 'iris_core_lookup', { key: request.key })).operation.dependency.pluginVersion, '0.1.0');
  await closeClient(client); report.checks.push('installing a newer plugin does not silently repin a saved MCP grant or substitute its implementation');

  await env.close(); await env.start(); client = await connect(record, 'stdio');
  await env.update(record, { scopes: ['read'] });
  const oldAttempt = await call(client, 'iris_core_plugin_call', { ...request, key: crypto.randomUUID() }); assert.equal(oldAttempt.isError, true);
  await closeClient(client);
  record = (await env.http('/api/v0/connection-management/connections')).connections.find(item => item.connectionId === record.connectionId);
  client = await connect(record); const readOnlyTools = await toolNames(client); assert.equal(readOnlyTools.length, 6); assert(!readOnlyTools.includes('iris_core_plugin_call'));
  assert.equal(parsed(await call(client, 'iris_core_operation', { operationId: operation.id })).operation.id, operation.id);
  await closeClient(client);
  await env.update(record, { pluginOperations: [], tools: ['iris_core_connection', 'iris_core_connections'] });
  record = (await env.http('/api/v0/connection-management/connections')).connections.find(item => item.connectionId === record.connectionId);
  client = await connect(record); assert.equal((await toolNames(client)).length, 2); await closeClient(client);
  assert.deepEqual((await env.http('/api/v0/operations/' + operation.id)).operation, operation);
  assert.equal((await env.http('/api/v0/plugin-operations/catalog')).artifacts.length, 3);
  report.checks.push('permission reduction rejects the already running stdio bridge, new read-only discovery removes writes, removing the exact business selection removes its tools; Core retains original facts');
  report.ok = true; save(); console.log(JSON.stringify({ ok: true, sdk: sdk.version, report: path.join(output, 'report.json'), checks: report.checks.length }));
} catch (error) { report.error = { code: error.code, message: error.message }; save(); throw error; }
finally { for (const client of clients) await client.close(); await env.close(); }
