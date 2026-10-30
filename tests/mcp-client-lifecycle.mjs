import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { createMcpBridge } from '../lib/mcp-bridge.js';
import { createMcpHttpGateway } from '../lib/mcp-http.js';
import { coreConnectionDiagnostic } from '../lib/core-connection-diagnostics.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-client-lifecycle');
const connection = { schemaVersion: 0, origin: 'http://127.0.0.1:1', rootId: crypto.randomUUID(), connectionId: crypto.randomUUID(),
  adapterId: 'iris.mcp', harnessKind: 'generic', label: 'Lifecycle fixture', accessToken: crypto.randomBytes(32).toString('base64url'), capabilities: [], tools: ['iris_core_connections'] };
const clients = [], bridges = [], gateways = [], checks = [];
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hello = options => {
  const request = JSON.parse(options.body);
  return new Response(JSON.stringify({ contractVersion: 0, rootId: connection.rootId, connectionId: connection.connectionId, connectionFeatures: ['client-info'],
    instance: { runtimeInstanceId: request.runtimeInstanceId, scopes: request.requestedScopes, capabilities: request.requestedCapabilities, tools: request.requestedTools } }));
};
const client = fetch => { const value = createCoreServiceClient({ connection, fetch }); clients.push(value); return value; };
let server;
try {
  const entered = defer();
  const delayed = client((_url, options) => { entered.resolve(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); });
  const starting = delayed.connect(), rejected = assert.rejects(starting, { code: 'IRIS_CORE_SERVICE_ABORTED' }); await entered.promise;
  const closing = delayed.dispose(); assert.equal(delayed.dispose(), closing); await closing; await rejected;
  assert.equal(delayed.snapshot().state, 'closed'); await assert.rejects(delayed.connect(), { code: 'IRIS_CORE_SERVICE_DISCONNECTED' });
  checks.push('shutdown aborts a pending handshake, is idempotent and cannot resurrect the client');

  const late = defer(), lateEntered = defer();
  const nonCooperative = client(async (_url, options) => { lateEntered.resolve(); await late.promise; return hello(options); });
  const slow = nonCooperative.connect(), slowRejected = assert.rejects(slow, { code: 'IRIS_CORE_SERVICE_ABORTED' }); await lateEntered.promise;
  const stopped = nonCooperative.dispose(); late.resolve(); await stopped; await slowRejected;
  assert.equal(nonCooperative.snapshot().state, 'closed');
  checks.push('even a late successful response cannot reopen a closing client');

  const metadataEntered = defer(); let metadataAborted = false, disconnected = 0;
  const reporting = client(async (url, options) => {
    if (url.endsWith('/handshake')) return hello(options);
    if (url.endsWith('/disconnect')) { disconnected++; return new Response(JSON.stringify({ contractVersion: 0 })); }
    metadataEntered.resolve(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { metadataAborted = true; reject(options.signal.reason); }, { once: true }));
  });
  await reporting.connect(); const metadata = reporting.reportClientInfo({ name: 'fixture', version: '1' }, 'stdio');
  const metadataRejected = assert.rejects(metadata, { code: 'IRIS_CORE_SERVICE_ABORTED' }); await metadataEntered.promise;
  assert.equal((await reporting.dispose()).remoteDisconnect, 'confirmed'); await metadataRejected;
  assert(metadataAborted); assert.equal(disconnected, 1); assert.equal((await reporting.dispose()).remoteDisconnect, 'confirmed');
  checks.push('close cancels in-flight metadata before waiting and disconnects the negotiated instance exactly once');

  const requestId = crypto.randomUUID();
  const denied = client(async (url, options) => url.endsWith('/handshake') ? hello(options) : url.endsWith('/disconnect')
    ? new Response(JSON.stringify({ contractVersion: 0 })) : new Response(JSON.stringify({ error: { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', requestId,
      message: 'PRIVATE_KEY_SECRET /private/file https://credential.invalid/?token=secret' } }), { status: 403 }));
  await denied.connect(); let error; try { await denied.models(); } catch (caught) { error = caught; }
  const diagnostic = coreConnectionDiagnostic(error, { references: { key: requestId, runId: 'run_' + 'a'.repeat(24), apiKey: connection.accessToken, arbitrary: '/private/file' } });
  assert.equal(diagnostic.stage, 'authorization'); assert.equal(diagnostic.requestId, requestId);
  assert.equal(diagnostic.recovery.key, requestId); assert(!JSON.stringify(diagnostic).includes('PRIVATE')); assert(!JSON.stringify(diagnostic).includes(connection.accessToken));
  assert.deepEqual(Object.keys(diagnostic.recovery).sort(), ['key', 'runId']);
  const unknown = coreConnectionDiagnostic(Object.assign(new Error(connection.accessToken), { code: 'EFAIL', requestId: connection.accessToken }));
  assert.equal(unknown.code, 'IRIS_MCP_REQUEST_FAILED'); assert.equal(unknown.requestId, undefined);
  checks.push('diagnostics preserve safe request/root identities and concrete actions without private messages or credentials');

  const handshakeEntered = defer();
  server = http.createServer((request, response) => { request.resume(); request.once('end', () => { handshakeEntered.resolve(); response.on('error', () => {}); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const file = path.join(root, 'client.json'); fs.writeFileSync(file, JSON.stringify({ ...connection, origin: 'http://127.0.0.1:' + server.address().port }), { mode: 0o600 });
  const stdin = new PassThrough(), stdout = new PassThrough(); let output = ''; stdout.on('data', value => { output += value; });
  const bridge = createMcpBridge({ connectionFile: file, version: 'fixture', stdin, stdout }); bridges.push(bridge);
  const begin = bridge.start(), bridgeRejected = assert.rejects(begin, { code: 'IRIS_CORE_SERVICE_ABORTED' }); await handshakeEntered.promise;
  const ending = bridge.dispose(); assert.equal(bridge.dispose(), ending); await ending; await bridgeRejected;
  assert.equal((await bridge.closed).state, 'closed'); assert.equal(bridge.snapshot().state, 'closed'); assert.equal(output, '');
  await assert.rejects(bridge.start(), { code: 'IRIS_MCP_CLOSED' });
  checks.push('real loopback startup cancellation closes the stdio bridge without protocol output or a second Core process');

  const gateway = createMcpHttpGateway({ getOrigin: () => connection.origin, authenticate: () => { throw Error('must not be called'); }, availableScopes: ['read'], version: 'fixture' }); gateways.push(gateway);
  const boot = gateway.start(), bootRejected = assert.rejects(boot, { code: 'IRIS_MCP_CLOSED' });
  const end = gateway.dispose(); assert.equal(gateway.dispose(), end); await bootRejected; await end;
  assert.deepEqual(gateway.snapshot(), { state: 'closed', connections: 0 }); await assert.rejects(gateway.start(), { code: 'IRIS_MCP_CLOSED' });
  checks.push('HTTP gateway disposal during SDK initialization stays terminal and releases its entries');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  for (const bridge of bridges) await bridge.dispose();
  for (const gateway of gateways) await gateway.dispose();
  for (const value of clients) await value.dispose();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
