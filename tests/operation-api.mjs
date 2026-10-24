import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair, readConnectionGrants, createConnectionRegistry } from '../lib/core-connections.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { readFlowRun } from '../lib/flow-store.js';
import { readOperation } from '../lib/operation-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-operation-api'), dataRoot = path.join(root, 'core');
const fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
const key = () => crypto.randomUUID(), apis = [], clients = [];
const jsonFile = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
async function terminal(client, id) {
  for (let index = 0; index < 200; index++) {
    const result = await client.operation(id);
    if (!['queued', 'running'].includes(result.operation.state)) return result.operation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('operation did not finish');
}
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'editor'), origin: 'http://127.0.0.1:1',
    harnessKind: 'kimi', label: 'Fixture editor', scopes: ['read', 'create', 'execute', 'stop'] });
  const readerPair = createConnectionPair({ dataRoot, directory: path.join(root, 'reader'), origin: 'http://127.0.0.1:1', harnessKind: 'generic', label: 'Fixture reader' });
  const grantsFile = path.join(root, 'grants.json');
  write(grantsFile, { schemaVersion: 0, grants: [...readConnectionGrants(pair.serverFile), ...readConnectionGrants(readerPair.serverFile)] });
  const grants = readConnectionGrants(grantsFile), registry = createConnectionRegistry(grants, ['read', 'create', 'execute', 'stop']);
  assert.throws(() => registry.identify(grants[0].connectionId, 'x'.repeat(43)), { code: 'IRIS_CONNECTION_AUTH_REQUIRED' });
  const hello = { contractVersion: 0, adapterId: 'iris.mcp', harnessKind: 'generic', runtimeInstanceId: key(), harnessVersion: 'fixture', requestedScopes: ['read'] };
  assert.throws(() => registry.handshake(grants[1].connectionId, { ...hello, contractVersion: 9 }), { code: 'IRIS_CONNECTION_VERSION_UNSUPPORTED' });
  assert.throws(() => registry.handshake(grants[1].connectionId, { ...hello, requestedScopes: ['read', 'execute'] }), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' });
  registry.handshake(grants[1].connectionId, hello);
  assert.throws(() => registry.authorize(grants[0].connectionId, hello.runtimeInstanceId, 'read'), { code: 'IRIS_CONNECTION_HANDSHAKE_REQUIRED' });
  assert(!JSON.stringify(registry.list()).includes(grants[0].accessToken)); registry.dispose();

  const api = createLocalReadApi({ dataRoot, allowExecution: true, connectionsFile: grantsFile, executionPorts: fixture }); apis.push(api);
  const started = await api.start();
  for (const item of [pair, readerPair]) write(item.clientFile, { ...jsonFile(item.clientFile), origin: started.origin });
  const client = createCoreServiceClient({ connectionFile: pair.clientFile, requestedScopes: ['read', 'create', 'execute', 'stop'] }); clients.push(client);
  const reader = createCoreServiceClient({ connectionFile: readerPair.clientFile }); clients.push(reader);
  const connected = await client.connect(); await reader.connect();
  assert.equal(connected.remoteHostPorts.length, 0, 'MCP handshake does not invent reverse browser/vision ports');
  assert.equal((await client.connections()).connections.length, 1);
  const owners = await fetch(started.origin + '/api/v0/connections', { headers: { Authorization: 'Bearer ' + started.accessToken } });
  assert.equal((await owners.json()).connections.length, 2);
  const second = createLocalReadApi({ dataRoot, allowExecution: true, executionPorts: fixture });
  await assert.rejects(second.start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' });
  const imported = await client.createImage({ key: key(), bytes: FLOW_SOURCE, mediaType: 'image/png' });
  const created = await client.createRun({ key: key(), value: { sourceArtifactId: imported.artifact.artifactId,
    modelRef: FLOW_MODEL, prompt: 'explicit API fixture' } });
  const runId = created.flow.id, revision = readFlowRun(dataRoot, runId).revision;
  const call = { key: key(), runId, expectedRevision: revision };
  await assert.rejects(reader.continueRun(call), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', status: 403 });
  assert.deepEqual(readFlowEvents(dataRoot), [], 'read and denied requests do not contact Provider');
  const accepted = await client.continueRun(call), id = accepted.operation.id;
  assert.equal(accepted.idempotentReplay, false);
  assert.equal((await terminal(client, id)).state, 'succeeded');
  assert.equal((await client.lookup(call.key)).operation.id, id);
  assert.equal((await client.continueRun(call)).idempotentReplay, true);
  assert.equal((await reader.operation(id)).operation.id, id, 'authorized readers share the same explicit data space');
  assert.equal((await client.operations(runId, { limit: 1 })).operations.length, 1);
  const view = await client.run(runId), image = await client.image(view.output.artifactId);
  assert.equal(image.mediaType, 'image/png'); assert(image.bytes.length > 0);
  assert.equal((await client.stop(id)).localStopped, false);
  const events = readFlowEvents(dataRoot); assert.equal(events.filter(event => event.kind === 'submit').length, 1);
  const snapshot = JSON.stringify(await client.connections());
  for (const grant of grants) assert(!snapshot.includes(grant.accessToken));
  await api.dispose();
  const restarted = createLocalReadApi({ dataRoot, allowExecution: true, executionPorts: fixture, connectionsFile: grantsFile }); apis.push(restarted);
  await restarted.start({ port: Number(new URL(started.origin).port) });
  await assert.rejects(client.operation(id), { code: 'IRIS_CONNECTION_HANDSHAKE_REQUIRED' });
  await client.connect();
  assert.equal((await client.continueRun(call)).operation.id, id);
  assert.deepEqual(readFlowEvents(dataRoot), events, 'restart/reconnect/replay does not resubmit');
  assert.equal(fixture.calls.submit.length, 1);
  assert.equal(readOperation(dataRoot, id).state, 'succeeded');
  await client.dispose();
  assert.equal((await fetch(started.origin + '/api/v0/runs', { headers: { Authorization: 'Bearer ' + grants[0].accessToken,
    'Iris-Connection-Id': grants[0].connectionId, 'Iris-Runtime-Id': connected.instance.runtimeInstanceId } })).status, 409);
  // The old reader's connection belongs to the previous service generation; it must handshake again before disconnecting.
  await reader.connect(); await reader.dispose();
  console.log('Operation API/connections: explicit execution, bounded identity/grants, real client, original-key replay, image bytes, two-connection isolation and restart handshake OK');
} finally {
  for (const client of clients.reverse()) if (client.snapshot().state === 'open') await client.dispose();
  for (const api of apis.reverse()) await api.dispose();
  await app.dispose();
}
