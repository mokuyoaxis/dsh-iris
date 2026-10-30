import assert from 'node:assert/strict';
import { createBusinessEnvironment, barrier } from './fixtures/plugin-business-consumer.mjs';

const env = await createBusinessEnvironment(), checks = [];
try {
  const hold = barrier(); let calls = 0;
  await env.start({ transform: operation => async (input, context) => { calls++; await hold.wait(context.signal); return operation(input, context); } });
  const request = env.request(), accepted = await env.submit(request); await hold.entered;
  await env.close();
  await env.start({ present: false });
  const stopped = await env.terminal(accepted.operation.id); assert.equal(stopped.state, 'interrupted');
  assert.deepEqual(stopped.result.artifactIds, []); assert.equal(calls, 1);
  assert.equal((await env.http('/api/v0/operations?key=' + request.key)).operation.id, stopped.id);
  await env.close(); await env.start();
  const replay = await env.submit(request); assert.equal(replay.idempotentReplay, true); assert.equal(replay.operation.state, 'interrupted');
  assert.equal((await env.http('/api/v0/plugin-operations/catalog')).artifacts.length, 2);
  checks.push('in-flight shutdown and plugin absence preserve interrupted identity; restoring the exact plugin does not replay the write');
  await env.close(); await env.start({ version: '0.1.1' });
  await env.submit({ ...request, key: crypto.randomUUID() }, {}, 409);
  assert.equal((await env.http('/api/v0/operations/' + stopped.id)).operation.dependency.pluginVersion, '0.1.0');
  checks.push('a different installed plugin version cannot substitute for the saved exact dependency');

  await env.close(); const partial = barrier();
  await env.start({ transform: operation => async (input, context) => operation(input, { ...context, core: { execute: async (name, args) => {
    const value = await context.core.execute(name, args); if (name === 'artifact.import') await partial.wait(context.signal); return value;
  } } }) });
  const partialRequest = env.request(), acceptedPartial = await env.submit(partialRequest); await partial.entered;
  await env.close(); await env.start({ present: false });
  const partialResult = await env.terminal(acceptedPartial.operation.id);
  assert.equal(partialResult.state, 'interrupted'); assert.equal(partialResult.result.value, null); assert.equal(partialResult.result.artifactIds.length, 1);
  assert.equal((await env.raw('/api/v0/artifacts/' + partialResult.result.artifactIds[0] + '/content')).status, 200);
  checks.push('Core retains a committed output even if interruption happens before the plugin returns; it does not claim success or delete partial facts');

  await env.close(); const stop = barrier();
  await env.start({ transform: operation => async (input, context) => { await stop.wait(context.signal); return operation(input, context); } });
  const cancel = await env.submit(env.request()); await stop.entered;
  const canceled = await env.http('/api/v0/operations/' + cancel.operation.id + '/cancel', { value: {} });
  assert.equal(canceled.operation.state, 'canceled'); assert.deepEqual(canceled.operation.result.artifactIds, []);
  assert.equal((await env.terminal(cancel.operation.id)).revision, canceled.operation.revision);
  checks.push('explicit stop aborts the running real-business context and saves a stable canceled record without a remote cancellation claim');

  await env.close(); const revoke = barrier();
  await env.start({ transform: operation => async (input, context) => { await revoke.wait(context.signal); return operation(input, context); } });
  const record = await env.createConnection(), exported = await env.exported(record), config = exported.configuration;
  // This is the public HTTP handshake, not a fabricated MCP tool server.
  const headers = { ...config.headers, 'Iris-Connection-Id': record.connectionId, 'Iris-Runtime-Id': crypto.randomUUID() };
  const runtimeInstanceId = headers['Iris-Runtime-Id'];
  await env.http('/api/v0/connections/' + record.connectionId + '/handshake', { headers, value: { contractVersion: 0, adapterId: 'iris.mcp', harnessKind: 'generic',
    runtimeInstanceId, harnessVersion: 'Public consumer lifecycle', requestedScopes: ['read', 'execute', 'stop'], requestedCapabilities: [], requestedTools: record.tools, requestedPluginOperations: record.pluginOperations } });
  const pending = await env.submit(env.request(), { headers }); await revoke.entered;
  await env.update(record, { scopes: ['read'] }); revoke.release();
  const denied = await env.terminal(pending.operation.id); assert.equal(denied.state, 'failed'); assert.equal(denied.failureCode, 'permission_denied'); assert.deepEqual(denied.result.artifactIds, []);
  checks.push('reducing the saved grant after acceptance is checked again inside each Core command and prevents the business write');
  console.log(JSON.stringify({ ok: true, checks, work: env.work }, null, 2));
} finally { await env.close(); }
