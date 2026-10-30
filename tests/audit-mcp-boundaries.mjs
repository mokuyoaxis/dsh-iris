import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { useTempDshHome } from './test-env.js';
import { createDshServiceBridge } from '../lib/dsh-service-bridge.js';
import { bridgeToolsForScopes } from '../lib/core-bridge-tools.js';
import { createMcpServerFactory } from '../lib/mcp-server.js';
import { loadCorePluginRegistry } from '../lib/plugins.js';

const { root } = useTempDshHome('iris-audit-mcp'), checks = [];
async function bridgeCase(label, { capabilities, scopes = ['read'], pluginOperations = [], failAt } = {}) {
  const connection = { schemaVersion: 0, origin: 'http://127.0.0.1:1', rootId: crypto.randomUUID(), connectionId: crypto.randomUUID(),
    adapterId: 'iris.dsh-service', harnessKind: 'dsh', label, accessToken: crypto.randomBytes(32).toString('base64url'), capabilities,
    tools: bridgeToolsForScopes(scopes, capabilities, undefined, pluginOperations).map(item => item.name), ...(pluginOperations.length ? { pluginOperations } : {}) };
  const file = path.join(root, label + '.json'); fs.writeFileSync(file, JSON.stringify(connection), { mode: 0o600 });
  const requests = [], registered = new Set(), removed = [];
  const bridge = createDshServiceBridge({ connectionFile: file, requestedScopes: scopes,
    getHost: () => ({ ports: { tools: { register(tool) {
      if (registered.size === failAt) throw Error('registration fixture failure');
      registered.add(tool.name); return () => { removed.push(tool.name); registered.delete(tool.name); };
    } } } }),
    fetch: async (url, options) => {
      const action = new URL(url).pathname.split('/').at(-1); requests.push(action);
      const input = options.body ? JSON.parse(options.body) : {};
      return new Response(JSON.stringify(action === 'handshake' ? { contractVersion: 0, rootId: connection.rootId, connectionId: connection.connectionId,
        instance: { runtimeInstanceId: input.runtimeInstanceId, scopes: input.requestedScopes, capabilities: input.requestedCapabilities,
          tools: input.requestedTools, pluginOperations: input.requestedPluginOperations || [] } } : { contractVersion: 0 }));
    } });
  return { bridge, requests, registered, removed, connection };
}

const unsupported = await bridgeCase('unsupported-audio', { capabilities: ['tts'] });
await assert.rejects(unsupported.bridge.start(), { code: 'IRIS_DSH_AUDIO_NOT_SUPPORTED' });
assert.equal(unsupported.bridge.snapshot().connection.state, 'closed'); assert.deepEqual(unsupported.requests, ['handshake', 'disconnect']);
await unsupported.bridge.dispose(); assert.equal(unsupported.requests.length, 2);
checks.push('unsupported startup disconnects the already negotiated Core instance exactly once');

const partial = await bridgeCase('partial-registration', { capabilities: ['image-edit'], failAt: 2 });
await assert.rejects(partial.bridge.start(), /registration fixture failure/);
assert.equal(partial.registered.size, 0); assert.equal(partial.removed.length, 2); assert.equal(partial.requests.at(-1), 'disconnect');
await partial.bridge.dispose(); checks.push('a partial tool registration is removed before failed startup finishes');

const registry = await loadCorePluginRegistry({ entries: [path.resolve('plugins/contact-sheet/index.mjs')] });
try {
  const selected = await bridgeCase('selected-business', { capabilities: [], scopes: ['read', 'execute'],
    pluginOperations: [registry.dependency('operations', 'community.contact-sheet.create')] });
  try {
    await selected.bridge.start(); assert(selected.registered.has('iris_core_plugin_catalog')); assert(selected.registered.has('iris_core_plugin_call'));
    assert.deepEqual([...selected.registered], selected.connection.tools);
  } finally { await selected.bridge.dispose(); }
  assert.equal(selected.registered.size, 0); checks.push('DSH registers only the actual selected business tools and releases them on close');
} finally { await registry.dispose(); }

let completeMetadata, actualCommands = 0;
const metadata = new Promise((_resolve, reject) => { completeMetadata = reject; });
const client = { snapshot: () => ({ scopes: ['read'], capabilities: ['image-edit'], tools: ['iris_core_models'] }),
  reportClientInfo: () => metadata, models: async () => { actualCommands++; return { contractVersion: 0, models: [] }; } };
const { factory } = await createMcpServerFactory({ client, version: 'test', transport: 'http' }), server = factory();
const errors = [], originalError = console.error; console.error = value => errors.push(value);
try {
  const receipt = await server._registeredTools.iris_core_models.handler({}, { mcpReq: { envelope: {
    'io.modelcontextprotocol/clientInfo': { name: 'fixture', version: '1' } }, signal: new AbortController().signal } });
  assert.equal(receipt.isError, undefined); assert.equal(actualCommands, 1); assert.deepEqual(receipt.structuredContent.models, []);
  completeMetadata(new Error('PRIVATE_CREDENTIAL_FIXTURE')); await new Promise(setImmediate);
  assert.equal(errors.length, 1); assert(!errors[0].includes('PRIVATE_CREDENTIAL_FIXTURE'));
  checks.push('pending or failed optional metadata neither delays a command nor replaces its receipt and private errors stay redacted');
} finally { console.error = originalError; await server.close(); }
console.log(JSON.stringify({ ok: true, checks }, null, 2));
