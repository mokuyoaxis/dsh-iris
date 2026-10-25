import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { executeConfigCommand } from '../lib/provider-config-service.js';
import { loadProviderCatalog, imageCandidatesFromCatalog, providerTaskBinding } from '../lib/provider-catalog.js';
import { createProviderRegistry } from '../lib/provider-extensions.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createConnectionPair, readConnectionGrants } from '../lib/core-connections.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-provider-settings'), file = path.join(root, 'providers.json'), dataRoot = path.join(root, 'core');
const key = 'fixture-private-key-C3-392103', replacement = 'fixture-new-key-C3-491202';
const registry = await createProviderRegistry(), services = [], app = createApplicationRuntime({ dataRoot });
const checks = [], requests = [];
const provider = http.createServer((request, response) => {
  requests.push({ method: request.method, path: request.url, auth: request.headers.authorization });
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'media-edit' }, { id: 'directory-only' }] }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + provider.address().port + '/v1';
const initial = { schemaVersion: 1, untouched: { evidence: 'preserved' }, providers: [{ id: 'original', name: 'Original', baseUrl,
  mediaProtocol: 'openai-chat-images', apiKey: key, enabled: true, opaque: { privateExtension: 1 },
  models: [{ id: 'media-edit', capabilities: ['image-gen'], verified: { 'image-gen': { ok: true, at: '2026-10-25', category: 'success' } }, unknownField: 3 },
    { id: 'keep-unmentioned', capabilities: [] }] }], assignments: { 'image-gen': { mode: 'manual', models: ['original::media-edit'] } } };
fs.writeFileSync(file, JSON.stringify(initial, null, 2) + '\n', { mode: 0o600 });
const show = () => executeConfigCommand(file, 'settings.show', {}, { registry });
const input = async () => { const value = await show(), item = value.providers[0]; return { expectedRevision: value.revision,
  provider: { id: item.id, name: item.name, baseUrl: item.baseUrl, mediaBaseUrl: item.mediaBaseUrl,
    mediaProtocol: item.mediaProtocol, enabled: item.enabled, auth: item.auth,
    models: item.models.map(({ id, capabilities, imageProtocol, musicProtocol }) => ({ id, capabilities, imageProtocol, musicProtocol })) }, credential: { action: 'keep' } }; };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function call(session, resource, value, extra = {}) {
  const response = await fetch(session.origin + resource, { method: value === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + session.accessToken, ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}
try {
  const original = fs.readFileSync(file), binding = providerTaskBinding(initial.providers[0], registry);
  assert.equal((await show()).revision, hash(original)); assert(!(JSON.stringify(await show())).includes(key)); assert.equal(requests.length, 0);
  const value = await input(); value.provider.name = 'Renamed'; value.provider.models = [{ id: 'media-edit', capabilities: ['image-gen', 'vision'], imageProtocol: 'auto' }];
  value.assignments = { vision: { mode: 'auto', models: [] } };
  const saved = await executeConfigCommand(file, 'settings.save', value, { registry });
  const record = loadProviderCatalog(file), backups = fs.readdirSync(root).filter(name => name.includes('.backup-'));
  assert.equal(backups.length, 1); assert.deepEqual(fs.readFileSync(path.join(root, backups[0])), original);
  assert.equal(record.providers[0].apiKey, key); assert.equal(record.providers[0].models.length, 2);
  assert.equal(record.providers[0].models[0].unknownField, 3); assert.deepEqual(record.providers[0].opaque, initial.providers[0].opaque);
  assert.equal(record.providers[0].models[0].verified['image-gen'].ok, true, 'equivalent legacy defaults must not invalidate an unchanged image verification');
  assert.deepEqual(record.untouched, initial.untouched); assert.equal(record.assignments.vision.mode, 'auto');
  assert.deepEqual(record.assignments['image-gen'], initial.assignments['image-gen']); assert.notEqual(saved.revision, value.expectedRevision);
  assert.equal(providerTaskBinding(record.providers[0], registry), binding); assert.equal(requests.length, 0);
  assert(!JSON.stringify(saved).includes('backup-')); checks.push('one commit/backup saves connection, model uses and global policies while preserving opaque fields and historical Task binding');
  const beforeReject = fs.readFileSync(file);
  await assert.rejects(executeConfigCommand(file, 'settings.save', value, { registry }), { code: 'IRIS_CONFIG_CHANGED' });
  for (const modify of [v => { v.credential = { action: 'keep', value: 'injected' }; }, v => { v.provider.baseUrl = 'https://user:pass@example.com/v1'; },
    v => { v.provider.models[0].capabilities = ['unknown']; }, v => { v.provider.extra = 'injected'; }, v => { v.provider.mediaProtocol = 'not-loaded'; },
    v => { v.assignments = { tts: { mode: 'manual', models: ['missing::missing'] } }; }]) {
    const invalid = await input(); modify(invalid);
    await assert.rejects(executeConfigCommand(file, 'settings.save', invalid, { registry }), { code: 'IRIS_CONFIG_INPUT_INVALID' });
    assert.deepEqual(fs.readFileSync(file), beforeReject);
  }
  fs.writeFileSync(file + '.lock', 'fixture', { mode: 0o600 });
  await assert.rejects(executeConfigCommand(file, 'settings.save', await input(), { registry }), { code: 'IRIS_CONFIG_BUSY' });
  fs.renameSync(file + '.lock', file + '.fixture-lock-evidence');
  assert.deepEqual(fs.readFileSync(file), beforeReject); assert.equal(fs.readdirSync(root).filter(name => name.includes('.backup-')).length, 1);
  checks.push('stale revisions, lock contention and malformed changes leave original config and backup count unchanged');
  const directory = await executeConfigCommand(file, 'settings.discover', { expectedRevision: saved.revision, providerId: 'original' }, { registry });
  assert.equal(directory.persisted, false); assert.equal(directory.models.length, 2); assert.deepEqual(fs.readFileSync(file), beforeReject);
  assert.deepEqual(requests.map(item => [item.method, item.path]), [['GET', '/v1/models']]);
  assert.equal(requests[0].auth, 'Bearer ' + key); assert.equal(imageCandidatesFromCatalog(loadProviderCatalog(file), '', registry).length, 1);
  checks.push('explicit directory GET uses the saved credential, does not write or authorize newly discovered models, and never generates media');
  const replace = await input(); replace.credential = { action: 'replace', value: replacement };
  const replaced = await executeConfigCommand(file, 'settings.save', replace, { registry });
  assert.equal(loadProviderCatalog(file).providers[0].apiKey, replacement); assert(!JSON.stringify(replaced).includes(replacement));
  assert(!replaced.providers[0].models[0].verified['image-gen']);
  const clear = await input(); clear.credential = { action: 'clear' }; clear.provider.auth = 'none';
  await executeConfigCommand(file, 'settings.save', clear, { registry });
  assert.equal(loadProviderCatalog(file).providers[0].apiKey, undefined);
  checks.push('explicit keep/replace/clear semantics, stale verification invalidation and auth:none round-trip');
  const dormantFile = path.join(root, 'dormant-extension.json'), dormant = structuredClone(initial);
  dormant.providers[0].models[0].imageProtocol = 'temporarily-unloaded';
  fs.writeFileSync(dormantFile, JSON.stringify(dormant), { mode: 0o600 });
  const dormantView = await executeConfigCommand(dormantFile, 'settings.show', {}, { registry });
  const dormantInput = await input(); dormantInput.expectedRevision = dormantView.revision;
  dormantInput.provider.models[0].imageProtocol = 'temporarily-unloaded';
  await executeConfigCommand(dormantFile, 'settings.save', dormantInput, { registry });
  assert.equal(loadProviderCatalog(dormantFile).providers[0].models[0].imageProtocol, 'temporarily-unloaded');
  checks.push('an unloaded per-model extension protocol remains editable and preserved without silently falling back');
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const pair = createConnectionPair({ dataRoot, origin: 'http://127.0.0.1:3182', harnessKind: 'generic', label: 'Untrusted harness', directory: path.join(root, 'pair') });
  const grant = readConnectionGrants(pair.serverFile)[0];
  const start = async options => { const api = createLocalReadApi({ dataRoot, providerConfigPath: file, providerRegistry: registry, ...options }); services.push(api); return api.start(); };
  const readonly = await start({}); assert.equal((await call(readonly, '/api/v0/provider-management/settings')).status, 405);
  assert.equal((await call(readonly, '/api/v0/provider-management/save', await input())).status, 405);
  const owner = await start({ allowProviderManagement: true, connectionsFile: pair.serverFile });
  const session = JSON.parse((await call(owner, '/api/v0/session')).text);
  assert.equal(session.providerManagement, true); assert.equal(session.readOnly, true); assert(!session.operations.includes('runs.continue'));
  const editView = await call(owner, '/api/v0/provider-management/settings'); assert.equal(editView.status, 200);
  const foreign = { ...owner, accessToken: grant.accessToken }, head = { 'Iris-Connection-Id': grant.connectionId };
  for (const route of ['settings', 'save', 'discover']) assert.equal((await call(foreign, '/api/v0/provider-management/' + route, route === 'settings' ? undefined : {}, head)).status, 403);
  assert.equal((await call(owner, '/api/v0/provider-management/settings', undefined, { Origin: 'https://outside.invalid' })).status, 403);
  const committed = await call(owner, '/api/v0/provider-management/save', await input()); assert.equal(committed.status, 200);
  const conflict = await call(owner, '/api/v0/provider-management/save', value); assert.equal(conflict.status, 409);
  assert(!conflict.text.includes(file)); assert(!editView.text.includes(replacement)); assert(!committed.text.includes('backup-'));
  const tooLarge = await call(owner, '/api/v0/provider-management/save', { giant: 'x'.repeat(65536) }); assert.equal(tooLarge.status, 413);
  checks.push('HTTP management is explicitly enabled, owner-only across all routes, same-origin protected, size-bounded, conflict-aware and independent of media execution');
  console.log(JSON.stringify({ checks, count: checks.length, actualPaidCalls: 0 }));
} finally {
  for (const api of services) await api.dispose();
  await app.dispose(); await registry.dispose(); await new Promise(resolve => provider.close(resolve));
}
