import assert from 'node:assert/strict';
import { mcpLoadFixture, rpc, until } from './fixtures/mcp-load-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-http-media-budget'), fixture = await mcpLoadFixture(root), held = [];
try {
  for (let i = 0; i < 4; i++) {
    const id = 'media-' + i; fixture.hold(id);
    const item = fixture.pausedMedia(id, { token: fixture.tokens[i % 2], version: i % 2 ? '2026-07-28' : '2025-11-25' }); held.push(item);
    await until(() => fixture.rows.get(id)?.writtenBodyBytes > fixture.image.length, 'MCP response reaches controlled socket backpressure');
    assert.equal(fixture.rows.get(id).response.writableFinished, false);
  }
  const busy = await fixture.post(rpc());
  assert.equal(busy.status, 429, 'response headers are not completion; hold capacity until the response drains');
  assert.equal((await busy.json()).error.data.code, 'IRIS_MCP_HTTP_BUSY');
  fixture.release(held[0].id); held[0].socket.resume();
  await until(() => fixture.rows.get(held[0].id).response.writableFinished, 'one response drains');
  await fixture.client(1, '2026-07-28').request('tools/list');
  held[1].socket.destroy();
  await until(() => fixture.rows.get(held[1].id).response.destroyed, 'client disconnect cancels media response');
  const image = await fixture.client().call('iris_core_image', { artifactId: fixture.artifact.id });
  assert.deepEqual(Buffer.from(image.content.find(item => item.type === 'image').data, 'base64'), fixture.image);
  const invalid = await fixture.client().call('iris_core_image', { artifactId: 'artifact_' + '0'.repeat(24) });
  assert.equal(invalid.isError, true);
  for (const item of held) item.socket.destroy();
  await until(() => held.every(item => fixture.rows.get(item.id).response.destroyed || fixture.rows.get(item.id).response.writableFinished), 'all output slots release');
  const pending = [fixture.partial('shutdown-body-0'), fixture.partial('shutdown-body-1', { token: fixture.tokens[1] })];
  for (const item of pending) await until(() => fixture.rows.get(item.id)?.readBodyBytes === item.prefixBytes, 'shutdown body was admitted');
  const shuttingId = 'shutdown-response'; fixture.hold(shuttingId); const last = fixture.pausedMedia(shuttingId); held.push(last);
  await until(() => fixture.rows.get(shuttingId)?.writtenBodyBytes > fixture.image.length, 'shutdown response is backpressured');
  await fixture.api.dispose();
  assert.equal(fixture.api.snapshot().state, 'closed');
  assert(pending.every(item => fixture.rows.get(item.id).request.destroyed));
  assert.equal(fixture.rows.get(shuttingId).response.destroyed, true);
  assert.equal(fixture.fixture.calls.submit.length, 0);
  console.log('PASS real SDK/HTTP media byte identity, weighted capacity through controlled socket backpressure, normal completion, disconnect, failed tools and shutdown with pending inputs/outputs');
} finally { await fixture.close(); }
