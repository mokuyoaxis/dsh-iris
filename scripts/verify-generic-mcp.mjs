#!/usr/bin/env node
// Independent installed official client SDK; no production dependency or daily harness setup is added.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { exportMcpConfiguration } from '../lib/mcp-config.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from '../tests/fixtures/image-flow-fixture.mjs';

const args = process.argv.slice(2);
assert.equal(args[0], '--client-sdk-root'); assert.equal(args.length, 2);
const sdkRoot = fs.realpathSync(args[1]), manifest = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
assert.equal(manifest.name, '@modelcontextprotocol/client');
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.mjs')));
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkRoot, 'dist/stdio.mjs')));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-generic-mcp-sdk-'));
const report = { status: 'running', work, clientSdk: { root: sdkRoot, version: manifest.version }, checks: [], realModelCalls: 0 };
const save = () => fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const dataRoot = path.join(work, 'core'), fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
const key = () => crypto.randomUUID(), read = file => JSON.parse(fs.readFileSync(file));
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(item => item.type === 'text').text); };
let api, current;
save();
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const pair = createConnectionPair({ dataRoot, directory: path.join(work, 'pair'), origin: 'http://127.0.0.1:1',
    label: 'Independent SDK', scopes: ['read', 'create', 'execute', 'stop'] });
  api = createLocalReadApi({ dataRoot, allowExecution: true, allowMcp: true, executionPorts: fixture, connectionsFile: pair.serverFile });
  const started = await api.start();
  fs.writeFileSync(pair.clientFile, JSON.stringify({ ...read(pair.clientFile), origin: started.origin }) + '\n', { mode: 0o600 });
  const stdio = exportMcpConfiguration({ connectionFile: pair.clientFile, scopes: ['read', 'create', 'execute', 'stop'], format: 'entry' });
  const exported = path.join(path.dirname(pair.clientFile), 'http.json');
  exportMcpConfiguration({ connectionFile: pair.clientFile, transport: 'http', format: 'entry', output: exported });
  const http = read(exported), importKey = key(), runKey = key();
  let input, operationId, artifactId;
  for (const transportName of ['stdio', 'http']) for (const version of ['2025-11-25', '2026-07-28']) {
    current = new Client({ name: 'unregistered-independent-client', version: manifest.version },
      version === '2026-07-28' ? { versionNegotiation: { mode: { pin: version } } } : {});
    const transport = transportName === 'stdio'
      ? new StdioClientTransport({ ...stdio, stderr: 'pipe', env: { ...process.env, IRIS_CORE_CONNECTION_FILE: '', IRIS_IMPORT_WORKBENCH_CONFIG: '' } })
      : new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: http.headers } });
    await current.connect(transport); assert.equal(current.getServerVersion().name, 'iris-core');
    assert.equal(Boolean(current.getDiscoverResult()), version === '2026-07-28');
    const listed = (await current.listTools()).tools; assert.equal(listed.length, 12);
    const called = new Set();
    const call = async (name, value = {}) => { called.add(name); return current.callTool({ name, arguments: value }); };
    parse(await call('iris_core_connection')); parse(await call('iris_core_connections'));
    parse(await call('iris_core_models')); parse(await call('iris_core_runs'));
    const imported = parse(await call('iris_core_import_image', { key: importKey, imageBase64: FLOW_SOURCE.toString('base64'), mediaType: 'image/png' }));
    const created = parse(await call('iris_core_create_run', { key: runKey, sourceArtifactId: imported.artifact.artifactId,
      modelRef: FLOW_MODEL, prompt: 'Independent SDK cross-transport original-key replay' }));
    input ||= { key: key(), runId: created.flow.id, expectedRevision: created.flow.revision };
    const accepted = parse(await call('iris_core_continue', input));
    if (operationId) assert.equal(accepted.operation.id, operationId);
    operationId = accepted.operation.id;
    let operation;
    for (let i = 0; i < 200; i++) {
      operation = parse(await call('iris_core_operation', { operationId })).operation;
      if (!['queued', 'running'].includes(operation.state)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(operation.state, 'succeeded');
    assert.equal(parse(await call('iris_core_lookup', { key: input.key })).operation.id, operationId);
    const run = parse(await call('iris_core_run', { runId: input.runId })); assert.equal(run.status, 'awaiting_selection');
    if (artifactId) assert.equal(run.output.artifactId, artifactId); artifactId = run.output.artifactId;
    const image = (await call('iris_core_image', { artifactId })).content.find(item => item.type === 'image');
    assert.deepEqual(Buffer.from(image.data, 'base64'), readCoreArtifactBytes(dataRoot, artifactId).bytes);
    parse(await call('iris_core_stop', { operationId }));
    assert.equal(called.size, 12); assert.equal(fixture.calls.submit.length, 1);
    await current.close(); current = null;
    report.checks.push({ transport: transportName, protocol: version, toolsDiscoveredAndCalled: 12,
      actualProviderSubmissions: 1, sameOperationAndArtifact: true, imageBytesMatch: true }); save();
  }
  await api.dispose(); api = null;
  report.status = 'passed'; save(); console.log(JSON.stringify({ status: report.status, report: path.join(work, 'report.json'), clientSdk: manifest.version, checks: report.checks }));
} catch (error) {
  report.status = 'failed'; report.error = { code: error.code, name: error.name, message: error.message }; save(); throw error;
} finally { await current?.close(); await api?.dispose(); await app.dispose(); }
