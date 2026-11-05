import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { configSnapshot, executeConfigCommand } from '../lib/provider-config-service.js';
import { providerCatalogSnapshot } from '../lib/provider-catalog.js';
import { projectProviderSettings } from '../lib/provider-settings.js';
import { refreshModelDirectory } from '../lib/model-directory-service.js';
import { modelDirectoryBinding } from '../lib/model-directory.js';
import { createProviderRegistry } from '../lib/provider-extensions.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-credential-review');
const envName = 'IRIS_REVIEW_TEST_' + crypto.randomUUID().replaceAll('-', '').toUpperCase();
const key = 'review-fixture-' + crypto.randomBytes(900).toString('hex');
const replacement = 'replacement-fixture-' + crypto.randomUUID();
const file = path.join(root, 'providers.json'), checks = [], requests = [];
let mode = 'echo';
const server = http.createServer((request, response) => {
  const usedKey = request.headers.authorization?.slice(7);
  requests.push({ authenticated: usedKey === (mode === 'overlap' ? 'review' : key), path: request.url }); response.setHeader('Content-Type', 'application/json');
  if (mode === 'rotate-error') {
    process.env[envName] = replacement;
    response.writeHead(500).end(JSON.stringify({ error: { message: 'directory error: ' + usedKey } })); return;
  }
  response.end(JSON.stringify({ data: [{ id: 'edit' }, { id: mode === 'echo' ? usedKey : mode === 'suffix' ? 'prefix-' + usedKey + '-suffix' : mode === 'overlap' ? 'review-model' : 'new-model' }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1', registry = await createProviderRegistry();
const write = value => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function clean(value) {
  const text = JSON.stringify(value);
  assert(!text.includes(key), 'projection must not contain the full fixture credential');
  assert(!text.includes(key.slice(0, 48)), 'projection must redact before truncating a long credential');
}
const unsafe = error => error.category === 'protocol' && error.providerCode === 'IRIS_PROVIDER_DIRECTORY_CREDENTIALS';
try {
  process.env[envName] = key;
  for (const source of [{ apiKeyEnv: envName }, { apiKey: key }]) {
    const provider = { id: 'account', name: 'echo:' + key, baseUrl, ...source, mediaProtocol: 'openai-chat-images',
      models: [{ id: 'edit', capabilities: ['image-gen'] }, { id: key, capabilities: ['image-gen'] }] };
    const catalog = { providers: [provider], assignments: { 'image-gen': ['account::' + key] } };
    clean(configSnapshot(catalog)); clean(providerCatalogSnapshot(catalog)); clean(projectProviderSettings(catalog, 'review'));
    write(catalog); const before = fs.readFileSync(file);
    for (const command of ['show', 'models.list', 'assignments.list']) clean(await executeConfigCommand(file, command, {}, { registry }));
    assert.deepEqual(fs.readFileSync(file), before);
  }
  checks.push('inline and environment credentials are redacted before summary truncation in catalog/config/model/assignment projections');
  const provider = { id: 'account', name: 'Account', baseUrl, apiKeyEnv: envName, mediaProtocol: 'openai-chat-images',
    models: [{ id: 'edit', capabilities: ['image-gen'] }] };
  const catalog = { providers: [provider], assignments: { 'image-gen': ['account::edit'] } };
  write(catalog); const before = fs.readFileSync(file), beforeNames = fs.readdirSync(root).sort();
  for (const apply of [false, true]) {
    await assert.rejects(executeConfigCommand(file, 'models.discover', { provider_id: 'account', apply }, { registry }), unsafe);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(root).sort(), beforeNames);
  }
  const revision = (await executeConfigCommand(file, 'settings.show', {}, { registry })).revision;
  await assert.rejects(executeConfigCommand(file, 'settings.discover', { expectedRevision: revision, providerId: 'account' }, { registry }), unsafe);
  assert.deepEqual(fs.readFileSync(file), before);
  checks.push('actual upstream echo is rejected by both CLI discovery modes and owner discovery, with no config/cache/backup write');
  mode = 'suffix';
  for (const apply of [false, true]) {
    await assert.rejects(executeConfigCommand(file, 'models.discover', { provider_id: 'account', apply }, { registry }), unsafe);
    assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readdirSync(root).sort(), beforeNames);
  }
  await assert.rejects(executeConfigCommand(file, 'settings.discover', { expectedRevision: revision, providerId: 'account' }, { registry }), unsafe);
  checks.push('an entire credential embedded inside an ID rejects the response without inventing or persisting a replacement model');
  const previous = { version: 1, binding: modelDirectoryBinding(provider), checkedAt: '2026-10-01T00:00:00.000Z', models: [{ id: 'edit', capabilities: ['image-gen'] }] };
  for (const registered of [false, true]) {
    let saved;
    const result = await refreshModelDirectory({ ...provider, modelDirectory: previous }, { force: true,
      ...(registered ? { registry } : {}), save: value => { saved = value; } });
    assert.equal(result.refreshed, false); assert.match(result.error, /认证/);
    assert.deepEqual(saved.models, previous.models); clean(result); clean(saved);
  }
  checks.push('legacy and registered directory refresh preserve complete previous metadata and save only a sanitized failure');
  mode = 'rotate-error';
  let saved;
  const rotated = await refreshModelDirectory(provider, { force: true, save: value => { saved = value; } });
  clean(rotated); clean(saved); assert.equal(rotated.refreshed, false);
  process.env[envName] = key;
  checks.push('legacy directory failure uses the credential actually sent even if the process environment changes during the request');
  mode = 'clean';
  const discovered = await executeConfigCommand(file, 'models.discover', { provider_id: 'account', apply: true }, { registry });
  assert.deepEqual(discovered.models.map(model => model.id), ['edit', 'new-model']);
  const committed = JSON.parse(fs.readFileSync(file));
  assert.equal(committed.providers[0].models.find(model => model.id === 'new-model').source, 'discovered');
  assert(!fs.readFileSync(file, 'utf8').includes(key));
  checks.push('ordinary directory discovery still saves original model IDs and leaves new entries unconfirmed');
  mode = 'overlap'; process.env[envName] = 'review';
  await assert.rejects(executeConfigCommand(file, 'models.discover', { provider_id: 'account', apply: false }, { registry }), unsafe);
  checks.push('whole-key echo rejection also applies to short test keys; a matching ID is not silently rewritten');
  assert(requests.every(request => request.authenticated));
  await import('./fixtures/provider-credential-directory-consumer.mjs');
  console.log(JSON.stringify({ ok: true, checks, root, requests: requests.length }, null, 2));
} finally { delete process.env[envName]; await registry.dispose(); await new Promise(resolve => server.close(resolve)); }
