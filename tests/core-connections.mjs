import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { checkedCoreOrigin, createConnectionPair, readConnectionGrants, readPrivateConnectionJson, createConnectionRegistry } from '../lib/core-connections.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { bridgeToolsForScopes, validateBridgeArguments } from '../lib/core-bridge-tools.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-core-connections'), dataRoot = path.join(root, 'core');
const app = createApplicationRuntime({ dataRoot });
const key = () => crypto.randomUUID();
try {
  for (const origin of ['http://127.0.0.1:80', 'http://127.0.0.1:3182']) assert.equal(checkedCoreOrigin(origin), origin);
  for (const origin of ['https://127.0.0.1:3182', 'http://localhost:3182', 'http://127.0.0.1:3182/', 'http://127.0.0.1:3182/path',
    'http://127.0.0.1:3182?token=x', 'http://secret@127.0.0.1:3182', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:03182']) {
    assert.throws(() => checkedCoreOrigin(origin), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  }
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const options = { dataRoot, origin: 'http://127.0.0.1:3182', harnessKind: 'generic', label: 'Reader' };
  assert.throws(() => createConnectionPair({ ...options, directory: path.join(dataRoot, 'forbidden') }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  assert(!fs.existsSync(path.join(dataRoot, 'forbidden')));
  assert.throws(() => createConnectionPair({ ...options, dataRoot: fs.realpathSync.native(dataRoot), directory: path.join(dataRoot, 'native-forbidden') }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  assert(!fs.existsSync(path.join(dataRoot, 'native-forbidden')));
  const pair = createConnectionPair({ ...options, directory: path.join(root, 'pair') });
  const before = fs.readFileSync(pair.clientFile);
  assert.throws(() => createConnectionPair({ ...options, directory: path.join(root, 'pair') }), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(pair.clientFile), before);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(pair.clientFile).mode & 0o777, 0o600);
    fs.chmodSync(pair.clientFile, 0o644);
    assert.throws(() => readPrivateConnectionJson(pair.clientFile), { code: 'IRIS_CONNECTION_CONFIG_INVALID' }); fs.chmodSync(pair.clientFile, 0o600);
    fs.symlinkSync(pair.clientFile, path.join(root, 'symlink-client'));
    assert.throws(() => readPrivateConnectionJson(path.join(root, 'symlink-client')), { code: 'IRIS_CONNECTION_CONFIG_INVALID' });
  }
  const grants = readConnectionGrants(pair.serverFile), registry = createConnectionRegistry(grants, ['read']);
  const grant = grants[0], hello = { contractVersion: 0, adapterId: grant.adapterId, harnessKind: grant.harnessKind, harnessVersion: 'fixture', requestedScopes: ['read'] };
  const ids = Array.from({ length: 9 }, key);
  for (const id of ids.slice(0, 8)) registry.handshake(grant.connectionId, { ...hello, runtimeInstanceId: id });
  assert.throws(() => registry.handshake(grant.connectionId, { ...hello, runtimeInstanceId: ids[8] }), { code: 'IRIS_CONNECTION_BUSY' });
  registry.disconnect(grant.connectionId, ids[0]); registry.handshake(grant.connectionId, { ...hello, runtimeInstanceId: ids[8] });
  const listed = registry.list(); assert.equal(listed.connections[0].instances.length, 8);
  assert(listed.connections[0].instances.every(instance => instance.liveness === 'not_probed'));
  assert(!JSON.stringify(listed).includes(grant.accessToken)); registry.dispose();
  const bad = path.join(root, 'bad-grants.json');
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 0, grants: [grant, grant] }), { mode: 0o600 });
  assert.throws(() => readConnectionGrants(bad), { code: 'IRIS_CONNECTION_CONFIG_INVALID' });
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 0, grants: [{ ...grant, rootId: key() }] }));
  const foreign = createLocalReadApi({ dataRoot, connectionsFile: bad });
  await assert.rejects(foreign.start(), { code: 'IRIS_API_CONFIG_INVALID' }); await foreign.dispose();
  for (const tool of bridgeToolsForScopes(['read'])) assert.equal(tool.scope, 'read');
  const runs = bridgeToolsForScopes(['read']).find(tool => tool.name === 'iris_core_runs');
  for (const args of [{ limit: 31 }, { limit: 1.5 }, { cursor: '../x' }, { arbitraryCommand: 'generate' }, []]) {
    assert.throws(() => validateBridgeArguments(runs, args), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  }
  console.log('Core connection boundary: loopback/root/credential protection, no overwrite, bounded isolated instances, unknown liveness, duplicate grants and finite tools OK');
} finally { await app.dispose(); }
