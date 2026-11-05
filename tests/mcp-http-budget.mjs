import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { mcpLoadFixture, mcpHeaders, rpc, until } from './fixtures/mcp-load-fixture.mjs';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-http-budget'), fixture = await mcpLoadFixture(root);
const responseMessages = async response => {
  const text = await response.text();
  return response.headers.get('content-type')?.startsWith('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))) : [JSON.parse(text)];
};
const holders = [];
try {
  for (let i = 0; i < 4; i++) {
    const item = fixture.partial('partial-' + i, { token: fixture.tokens[i % 2] }); holders.push(item);
    await until(() => fixture.rows.get(item.id)?.readBodyBytes === item.prefixBytes, 'admitted prefix is read');
  }
  const busy = await fixture.post(rpc(), { token: fixture.tokens[1] });
  assert.equal(busy.status, 429, 'the instance budget must cover different connection credentials');
  assert.equal(busy.headers.get('retry-after'), '1');
  assert.equal((await busy.json()).error.data.code, 'IRIS_MCP_HTTP_BUSY');
  const denied = await fixture.post(rpc(), { token: 'a'.repeat(43) });
  assert.equal(denied.status, 401); await denied.arrayBuffer();
  const owner = await fetch(fixture.started.origin + '/api/v0/session', { headers: { Authorization: 'Bearer ' + fixture.started.accessToken } });
  assert.equal(owner.status, 200); await owner.arrayBuffer();
  const rejected = fixture.partial('rejected-chunked', { chunked: true });
  assert.equal((await rejected.response).status, 429);
  assert.equal(fixture.rows.get(rejected.id).readBodyBytes, 0, 'a rejected upload is not decoded or handed to the SDK');
  rejected.request.destroy();
  holders[0].request.destroy();
  await until(() => fixture.rows.get(holders[0].id).request.destroyed, 'disconnect releases a partial request');
  await fixture.client(1, '2026-07-28').request('tools/list');
  for (const item of holders) item.request.destroy();
  await until(() => holders.every(item => fixture.rows.get(item.id).request.destroyed), 'all partial bodies close');

  for (const version of ['2025-11-25', '2026-07-28']) {
    const valid = await fixture.post(rpc('tools/list', {}, version), { version });
    assert.equal(valid.status, 200); assert((await responseMessages(valid))[0].result.tools.length > 0);
  }
  const tooMany = Array.from({ length: 8 }, (_, i) => rpc('tools/call', { name: 'iris_core_image', arguments: { artifactId: fixture.artifact.id } }, '2025-11-25', i));
  const batch = await fixture.post(tooMany);
  assert.equal(batch.status, 400); assert.equal((await batch.json()).error.data.code, 'IRIS_MCP_HTTP_BATCH_TOO_LARGE');

  const occupied = Array.from({ length: 3 }, (_, i) => fixture.partial('upgrade-side-' + i));
  for (const item of occupied) await until(() => fixture.rows.get(item.id)?.readBodyBytes === item.prefixBytes, 'three body slots admitted');
  const upgrade = await fixture.post(tooMany.slice(0, 2), { token: fixture.tokens[1] });
  assert.equal(upgrade.status, 429, 'a batch cannot upgrade its reservation beyond remaining instance capacity');
  assert.equal((await upgrade.json()).error.data.code, 'IRIS_MCP_HTTP_BUSY');
  for (const item of occupied) item.request.destroy();
  await until(() => occupied.every(item => fixture.rows.get(item.id).request.destroyed), 'failed batch reservation releases');

  // A two-message batch reserves two slots until its one HTTP response drains.
  const two = tooMany.slice(0, 2); fixture.hold('batch-two');
  const held = fixture.pausedMedia('batch-two', { message: two });
  await until(() => fixture.rows.get(held.id)?.writtenBodyBytes > fixture.image.length, 'batch media response');
  const extras = [fixture.partial('batch-side-1'), fixture.partial('batch-side-2', { token: fixture.tokens[1] })];
  for (const item of extras) await until(() => fixture.rows.get(item.id)?.readBodyBytes === item.prefixBytes, 'remaining batch slot admitted');
  const batchBusy = await fixture.post(rpc()); assert.equal(batchBusy.status, 429); await batchBusy.arrayBuffer();
  held.socket.destroy(); for (const item of extras) item.request.destroy();
  await until(() => fixture.rows.get(held.id).response.destroyed && extras.every(item => fixture.rows.get(item.id).request.destroyed), 'batch slots released');

  // Keep the existing 9 MiB body envelope: a real 6 MiB PNG import remains valid.
  const large = Buffer.concat([FLOW_SOURCE, Buffer.alloc(6 * 1024 * 1024 - FLOW_SOURCE.length)]), key = crypto.randomUUID();
  const imported = await fixture.client(0, '2026-07-28').call('iris_core_import_image', { key, imageBase64: large.toString('base64'), mediaType: 'image/png' });
  assert.equal(imported.isError, undefined, JSON.stringify(imported.structuredContent));
  assert.equal(imported.structuredContent.artifact.size, large.length);
  const duplicate = await fixture.client(0, '2026-07-28').call('iris_core_import_image', { key, imageBase64: large.toString('base64'), mediaType: 'image/png' });
  assert.equal(duplicate.structuredContent.artifact.artifactId, imported.structuredContent.artifact.artifactId);
  assert.equal(fixture.fixture.calls.submit.length, 0);

  const invalid = await fetch(fixture.started.origin + '/mcp', { method: 'POST', headers: mcpHeaders(fixture.tokens[0], '2025-11-25', rpc()), body: '{bad' });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, -32700);
  const oversized = await fetch(fixture.started.origin + '/mcp', { method: 'POST', headers: mcpHeaders(fixture.tokens[0], '2025-11-25', rpc()), body: ' '.repeat(9 * 1024 * 1024 + 1) });
  assert.equal(oversized.status, 413); await oversized.arrayBuffer();
  const chunked = await new Promise((resolve, reject) => {
    const request = http.request(fixture.started.origin + '/mcp', { method: 'POST', headers: {
      ...mcpHeaders(fixture.tokens[0], '2025-11-25', rpc()), 'x-iris-load-id': 'oversized-chunked' } }, response => {
      request.end(' ');
      const chunks = []; response.on('data', value => chunks.push(value)); response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() })); response.once('error', reject);
    });
    request.once('error', reject); request.write(' '.repeat(10 * 1024 * 1024));
  });
  assert.equal(chunked.status, 413); assert.equal(JSON.parse(chunked.body).error.code, -32000);
  assert.equal(fixture.rows.get('oversized-chunked').request.headers['transfer-encoding'], 'chunked');
  try { await until(() => fixture.rows.get('oversized-chunked').response.writableFinished, 'rejected chunked upload drains after the client ends its body'); }
  catch (error) {
    const { request, response, readBodyBytes } = fixture.rows.get('oversized-chunked');
    console.log(JSON.stringify({ chunkedDrain: { readBodyBytes, requestComplete: request.complete, requestDestroyed: request.destroyed,
      readableFlowing: request.readableFlowing, readableLength: request.readableLength, responseDestroyed: response.destroyed, responseFinished: response.writableFinished } }));
    throw error;
  }
  await fixture.client().request('tools/list');
  assert.equal(fs.readdirSync(path.join(fixture.dataRoot, 'artifact-store/v0/records')).length, 2, 'same-Key import does not duplicate an artifact');
  console.log('PASS HTTP MCP global weighted budget, no-read overload, auth/control isolation, cancellation, batch bounds, real 6 MiB import and 9 MiB/chunked limits');
} finally { await fixture.close(); }
