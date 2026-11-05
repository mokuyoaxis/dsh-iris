import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair, readConnectionGrants } from '../lib/core-connections.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-env-api'), dataRoot = path.join(root, 'core'), config = path.join(root, 'providers.json');
const envName = 'IRIS_API_CREDENTIAL_TEST_' + crypto.randomUUID().replaceAll('-', '').toUpperCase();
const secret = 'api-key-fixture-' + crypto.randomUUID(), app = createApplicationRuntime({ dataRoot }), checks = [];
let api, session;
const upstream = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: request.headers.authorization.slice(7) }] }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
async function call(route, value, headers = {}) {
  const response = await fetch(session.origin + route, { method: value === undefined ? 'GET' : 'POST', headers: {
    Authorization: 'Bearer ' + session.accessToken, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers
  }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const text = await response.text(); assert(!text.includes(secret)); return { status: response.status, body: JSON.parse(text) };
}
const prefix = '/api/v0/provider-management/';
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', { video: true });
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'media', name: 'Media', baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1', apiKeyEnv: envName,
    mediaProtocol: 'openai-chat-images', models: [{ id: 'edit', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': ['media::edit'] } }), { mode: 0o600 });
  const pair = createConnectionPair({ dataRoot, origin: 'http://127.0.0.1:3182', harnessKind: 'generic', label: 'Untrusted credential caller', directory: path.join(root, 'pair') });
  const grant = readConnectionGrants(pair.serverFile)[0];
  api = createLocalReadApi({ dataRoot, providerConfigPath: config, serveWorkbench: true, allowProviderManagement: true, allowExecution: true,
    connectionsFile: pair.serverFile }); session = await api.start();
  let view = (await call(prefix + 'settings')).body;
  assert.equal(view.providers[0].apiKeyEnv, envName); assert.equal(view.providers[0].credentialStatus, 'missing');
  const models = await call('/api/v0/models'); assert.equal(models.status, 200); assert.equal(models.body.gap, 'credential_unavailable');
  assert.equal((await call('/api/v0/audio-models')).status, 200);
  assert.equal((await call('/api/v0/video-models')).status, 200);
  const check = await call(prefix + 'check', { expectedRevision: view.revision, providerId: 'media' });
  assert.equal(check.status, 409); assert.equal(check.body.error.code, 'IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE');
  const foreign = { Authorization: 'Bearer ' + grant.accessToken, 'Iris-Connection-Id': grant.connectionId };
  assert.equal((await call(prefix + 'settings', undefined, foreign)).status, 403);
  assert.equal((await call(prefix + 'save', { credential: { action: 'env', name: 'HOME' } }, foreign)).status, 403);
  checks.push('missing environment is a readable owner state, an empty media catalog and a locatable connection-check error; a client cannot read/edit credential references');
  process.env[envName] = secret;
  const ready = (await call(prefix + 'settings')).body;
  assert.equal(ready.revision, view.revision); assert.equal(ready.providers[0].credentialStatus, 'ready');
  assert.equal((await call('/api/v0/models')).body.models[0].modelRef, 'media::edit');
  const item = ready.providers[0], provider = { ...Object.fromEntries(['id', 'name', 'baseUrl', 'mediaBaseUrl', 'mediaProtocol', 'enabled', 'auth'].map(key => [key, item[key]])),
    models: item.models.map(({ id, capabilities, imageProtocol, musicProtocol }) => ({ id, capabilities, imageProtocol, musicProtocol })) };
  const before = fs.readFileSync(config);
  const unsafeDirectory = await call(prefix + 'discover', { expectedRevision: ready.revision, providerId: 'media' });
  assert.equal(unsafeDirectory.status, 502); assert.equal(unsafeDirectory.body.error.code, 'IRIS_PROVIDER_DIRECTORY_CREDENTIALS');
  assert.deepEqual(fs.readFileSync(config), before);
  checks.push('upstream credential echo is rejected through the actual HTTP API with a specific safe error and no configuration write');
  assert.equal((await call(prefix + 'save', { expectedRevision: ready.revision, provider, credential: { action: 'env', name: 'BAD-NAME' } })).status, 400);
  assert.deepEqual(fs.readFileSync(config), before);
  const keep = await call(prefix + 'save', { expectedRevision: ready.revision, provider, credential: { action: 'env', name: envName } });
  assert.equal(keep.status, 200); assert.equal(JSON.parse(fs.readFileSync(config)).providers[0].apiKey, undefined);
  view = keep.body;
  const clear = await call(prefix + 'save', { expectedRevision: view.revision, provider, credential: { action: 'clear' } });
  assert.equal(clear.status, 200); assert.equal(clear.body.providers[0].apiKeyEnv, undefined);
  for (const name of fs.readdirSync(root).filter(name => name.includes('providers.json'))) assert(!fs.readFileSync(path.join(root, name), 'utf8').includes(secret));
  checks.push('owner env/keep/clear changes preserve CAS and produce no secret in responses, configuration or backups');
  console.log(JSON.stringify({ ok: true, checks, root }, null, 2));
} finally { delete process.env[envName]; await api?.dispose(); await app.dispose(); await new Promise(resolve => upstream.close(resolve)); }
