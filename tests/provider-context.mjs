import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { definePlugin, defineProviderAdapter, createCorePluginRegistry, ProviderContractError, PROVIDER_FACTORY_CONTEXT_VERSION,
  normalizeMediaEndpoint } from '@mokuyoaxis/dsh-iris/plugins';
import { ProviderContractError as LegacyError } from '@mokuyoaxis/dsh-iris/provider-extensions';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { createProviderNetworkClient } from '../lib/provider-network.js';
import { CATALOG_NETWORK } from '../lib/network-policy.js';
import crypto from 'node:crypto';

const registries = [], clients = [], contexts = [], connections = [], events = [], requests = [];
let release, entered, failedCleanupRegistry;
const body = new Promise(resolve => { release = resolve; }), headers = new Promise(resolve => { entered = resolve; });
const server = http.createServer(async (req, res) => {
  requests.push(req.url);
  if (req.url === '/slow') { res.setHeader('Content-Type', 'application/json'); res.write('{"models":'); entered(); await body; res.end('["remote"]}'); }
  else { res.setHeader('Content-Type', 'application/json'); res.end('{"models":["next"]}'); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
function definition({ cleanup = () => events.push('disposed'), streaming = false } = {}) {
  return definePlugin({ manifest: { contractVersion: 0, id: 'example.context', version: '1.0.0',
    compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
    contributions: { providers: [{ id: 'images', version: '1.0.0', title: 'Context fixture', capabilities: ['image-gen'] }] } },
  activate({ onDispose }) {
    onDispose(cleanup);
    return { providers: { images: { normalizeEndpoint: normalizeMediaEndpoint,
      createAdapter(provider, context) {
        contexts.push(context); connections.push(provider);
        return defineProviderAdapter({ id: provider.id, protocol: 'example.context.images', capabilities: ['image'],
          operations: {
            async discover({ signal } = {}) {
              const response = await context.network.fetch(origin + (streaming ? '/slow' : '/models'), { signal });
              const value = await response.json(); events.push('body');
              if (streaming) await (await context.network.fetch(origin + '/next', { signal })).text();
              return value;
            },
            submit: async () => ({ kind: 'accepted', remoteTaskId: 'original' }), mapError: error => error
          }, unsupported: { poll: 'fixture', cancel: 'fixture', download: 'fixture' } });
      }
    } } };
  } });
}
async function registry(options) { const r = await createCorePluginRegistry({ plugins: [definition(options)] }); registries.push(r); return r; }
const name = 'IRIS_B4_CONTEXT_FIXTURE_KEY', previous = process.env[name], originalFetch = globalThis.fetch;
try {
  assert.equal(PROVIDER_FACTORY_CONTEXT_VERSION, 1); assert.equal(ProviderContractError, LegacyError);
  const r = await registry(), initial = requests.length;
  delete process.env[name];
  assert.throws(() => r.providers.createAdapter('example.context.images', { id: 'p', baseUrl: origin, apiKeyEnv: name }), { code: 'IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE' });
  assert.equal(contexts.length, 0); assert.equal(requests.length, initial);
  const marked = { id: 'p', auth: 'none', baseUrl: origin };
  Object.defineProperty(marked, CATALOG_NETWORK, { value: { schemaVersion: 1, configId: crypto.randomUUID(), catalogId: crypto.randomUUID() } });
  assert.throws(() => r.providers.createAdapter('example.context.images', marked), { code: 'IRIS_NETWORK_CONTEXT_REQUIRED' });
  assert.throws(() => r.providers.createAdapter('example.context.images', { id: 'p', auth: 'none' }, { network: null }), TypeError);
  assert.throws(() => r.providers.createAdapter('example.context.images', { id: 'p', auth: 'none' }, { modelId: 42 }), TypeError);
  process.env[name] = 'synthetic-b4-context-key';
  const adapter = r.providers.createAdapter('example.context.images', { id: 'p', baseUrl: origin, apiKeyEnv: name }, { modelId: 'raw-image', registry: 'must-not-leak' });
  const context = contexts.at(-1), connection = connections.at(-1);
  assert.deepEqual(Object.keys(context).sort(), ['contractVersion', 'modelId', 'network']);
  assert.deepEqual(Object.keys(context.network), ['fetch']);
  assert(Object.isFrozen(context)); assert(Object.isFrozen(context.network)); assert(Object.isFrozen(connection));
  assert.equal(connection.apiKey, process.env[name]); assert.equal(connection.apiKeyEnv, undefined);
  assert.throws(() => context.network.fetch(origin + '/outside'), { code: 'IRIS_PROVIDER_CONTEXT_OPERATION_REQUIRED' });
  assert.equal(requests.length, initial);
  assert.deepEqual((await adapter.operations.discover({})).models, ['next']);
  assert.throws(() => context.network.fetch(origin + '/late'), { code: 'IRIS_PROVIDER_CONTEXT_OPERATION_REQUIRED' });
  const none = r.providers.createAdapter('example.context.images', { id: 'none', baseUrl: origin, auth: 'none', apiKey: 'retained-unused-key' });
  assert.equal(connections.at(-1).apiKey, ''); assert.equal(none.pluginDependency.pluginVersion, '1.0.0');

  const streaming = await registry({ streaming: true }), other = await registry();
  const streamAdapter = streaming.providers.createAdapter('example.context.images', { id: 'stream', baseUrl: origin, auth: 'none' });
  const promise = streamAdapter.operations.discover({}); await headers;
  const before = events.filter(event => event === 'disposed').length;
  const draining = streaming.dispose(); assert.equal(streaming.dispose(), draining);
  await assert.rejects(streamAdapter.operations.discover({}), { code: 'IRIS_PROVIDER_EXTENSION_CLOSED' });
  assert.equal(events.filter(event => event === 'disposed').length, before);
  release(); assert.deepEqual((await promise).models, ['remote']); await draining;
  assert.equal(events.filter(event => event === 'disposed').length, before + 1);
  assert(requests.includes('/next'), 'admitted method may finish a second request while registry closes');
  const unaffected = other.providers.createAdapter('example.context.images', { id: 'other', auth: 'none', baseUrl: origin });
  assert.deepEqual((await unaffected.operations.discover({})).models, ['next']);

  let closeCount = 0;
  const network = createProviderNetworkClient({ fetchPort: async () => {
    assert.equal(network.snapshot().activeOperations, 1, 'configured unified adapter must not double-wrap its network operation');
    return Response.json({ models: ['explicit'] });
  }, close: () => { closeCount++; } }); clients.push(network);
  let captured;
  const encoded = other.providers.createAdapter('example.context.images', { id: 'encoded', auth: 'none' }, { network: {
    fetch: network.fetch, run(action, context) { captured = context; return network.run(action); }
  } });
  await encoded.operations.submit({ capability: 'image', model: 'raw:model/a::b space', input: {} });
  assert.equal(captured.modelRef, 'encoded::raw%3Amodel%2Fa%3A%3Ab%20space', 'raw model IDs use the existing canonical model reference encoding');
  const configured = createConfiguredProviderAdapter({ id: 'explicit', mediaProtocol: 'example.context.images', baseUrl: origin, auth: 'none' }, { registry: other.providers, network });
  assert.deepEqual((await configured.operations.discover({})).models, ['explicit']);
  await other.dispose(); assert.equal(closeCount, 0, 'registry borrows an explicit Core client');
  await network.dispose(); assert.equal(closeCount, 1);
  const broken = await registry({ cleanup() { throw new Error('controlled cleanup failure'); } });
  failedCleanupRegistry = broken;
  const disposal = broken.dispose();
  await assert.rejects(disposal, /释放失败/);
  assert.equal(broken.dispose(), disposal, 'a failed close stays failed and never runs cleanup twice');
  assert.equal(globalThis.fetch, originalFetch);
  console.log('Provider context: version/opaque readonly port, environment credential snapshot, explicit-policy guard, operation-only fetch, streamed/second-hop drain, isolated registry shutdown and one network scope OK');
} finally {
  release();
  for (const r of registries.reverse()) {
    if (r === failedCleanupRegistry) await assert.rejects(r.dispose(), /释放失败/);
    else await r.dispose();
  }
  for (const client of clients) await client.dispose();
  if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
