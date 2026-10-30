import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { inspectExecutionLease } from '../lib/operation-runner.js';
import { imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-cleanup-failure'), dataRoot = path.join(root, 'core'), directory = path.join(root, 'connections');
const app = createApplicationRuntime({ dataRoot }), originalFetch = globalThis.fetch;
let api, replacement, failedOnce = false;
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const options = { dataRoot, allowExecution: true, executionPorts: imageFlowFixture(dataRoot), allowMcp: true,
    allowConnectionManagement: true, connectionStore: directory };
  api = createLocalReadApi(options); const session = await api.start();
  const request = async (route, value) => {
    const response = await originalFetch(session.origin + '/api/v0/connection-management/' + route, { method: 'POST',
      headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert(response.ok); return response.json();
  };
  const created = await request('connections', { key: crypto.randomUUID(), label: 'Cleanup fault fixture', scopes: ['read'], capabilities: [] });
  const config = await request('connections/' + created.connectionId + '/export', { presetId: 'generic-http' });
  // The gateway captures this scoped test fetch; only its own disconnect returns an unexpected 409.
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === session.origin && url.pathname.endsWith('/disconnect') && !failedOnce) {
      failedOnce = true;
      return Promise.resolve(new Response(JSON.stringify({ contractVersion: 0, error: { code: 'IRIS_CONNECTION_CONFIG_CHANGED', requestId: crypto.randomUUID() } }), { status: 409 }));
    }
    return originalFetch(input, options);
  };
  const remote = httpMcpClient(session.origin, config.configuration.mcpServers.iris.headers.Authorization.slice(7));
  await remote.initialize(); globalThis.fetch = originalFetch;
  assert.equal(inspectExecutionLease(dataRoot).status, 'present');
  let failure;
  try { await api.dispose(); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'IRIS_API_CLEANUP_FAILED'); assert.deepEqual(failure.stages, ['mcp']); assert(failedOnce);
  assert.equal(api.snapshot().state, 'closed'); assert.equal(api.snapshot().cleanupFailed, true);
  assert.equal((await api.closed).cleanupFailed, true);
  assert.equal(inspectExecutionLease(dataRoot).status, 'absent');
  assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  assert.equal(inspectCoreWriterLease(path.join(directory, 'ownership')).status, 'absent');
  replacement = createLocalReadApi(options); await replacement.start(); await replacement.dispose();
  console.log('PASS unexpected MCP disconnect failure is reported, while runner/application/connection leases still close and the same root restarts explicitly');
} finally {
  globalThis.fetch = originalFetch;
  await Promise.allSettled([api?.dispose(), replacement?.dispose(), app.dispose()]);
}
