import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateProviderCredential, applyCredentialPatch, resolveProviderCredential } from '../lib/provider-credentials.js';
import { executeConfigCommand, settingsRevision } from '../lib/provider-config-service.js';
import { loadProviderCatalog } from '../lib/provider-catalog.js';
import { applyProviderSettings } from '../lib/provider-settings.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-credential-sources');
const reference = { provider: 'fixture-host', settingsNs: 'fixture-settings' };
const host = { id: 'host', name: 'Host fixture', dshProvider: reference, mediaProtocol: 'openai-images', models: [] };
const manual = { id: 'manual', name: 'Manual fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-inline',
  mediaProtocol: 'openai-images', models: [] };
const file = path.join(root, 'providers.json');
const save = providers => fs.writeFileSync(file, JSON.stringify({ providers, assignments: {} }), { mode: 0o600 });
const inputFor = (catalog, credential) => ({ expectedRevision: settingsRevision(catalog), provider: {
  id: 'host', name: 'Manual replacement', baseUrl: manual.baseUrl, mediaBaseUrl: '', mediaProtocol: 'openai-images',
  enabled: true, auth: 'bearer', models: [] }, credential });
for (const extra of [{ apiKey: 'fixture-inline' }, { apiKey: '' }, { apiKey: null }, { baseUrl: manual.baseUrl },
  { apiKeyEnv: 'IRIS_SOURCE_FIXTURE' }, { auth: 'none', apiKey: 'fixture-retained' }, { mediaBaseUrl: 'https://override.invalid/v1' }]) {
  const value = { ...host, ...extra };
  assert.throws(() => validateProviderCredential(value), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  const previous = structuredClone(host), patch = structuredClone(extra);
  assert.throws(() => applyCredentialPatch(previous, patch), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  assert.deepEqual(previous, host); assert.deepEqual(patch, extra);
  save([value]); const before = fs.readFileSync(file), inventory = fs.readdirSync(root);
  assert.throws(() => loadProviderCatalog(file), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readdirSync(root), inventory, 'reader rejection never quarantines or rewrites a Headless config');
}
validateProviderCredential(host); validateProviderCredential(manual);
const env = applyCredentialPatch(manual, { apiKeyEnv: 'IRIS_SOURCE_FIXTURE' });
assert.equal(env.apiKey, undefined); assert.equal(env.apiKeyEnv, 'IRIS_SOURCE_FIXTURE');
const inline = applyCredentialPatch(env, { apiKey: 'fixture-new' });
assert.equal(inline.apiKeyEnv, undefined); assert.equal(inline.apiKey, 'fixture-new');
assert.throws(() => applyCredentialPatch(manual, { dshProvider: reference }), { code: 'IRIS_CONFIG_INPUT_INVALID' });
const runtimeCopy = { ...host, baseUrl: manual.baseUrl, apiKey: 'fixture-resolved-host' };
assert.equal(resolveProviderCredential(runtimeCopy).apiKey, 'fixture-resolved-host', 'Host-resolved copies are runtime inputs, not stored source edits');

save([host]);
for (const credential of [{ action: 'keep' }, { action: 'replace', value: 'fixture-new' }, { action: 'clear' },
  { action: 'env', name: 'IRIS_SOURCE_FIXTURE' }]) {
  const catalog = loadProviderCatalog(file), before = structuredClone(catalog), bytes = fs.readFileSync(file), files = fs.readdirSync(root);
  const input = inputFor(catalog, credential);
  assert.throws(() => applyProviderSettings(catalog, input), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  assert.deepEqual(catalog, before);
  await assert.rejects(executeConfigCommand(file, 'settings.save', input), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual(fs.readdirSync(root), files, 'invalid settings do not publish a config or backup');
}
await assert.rejects(executeConfigCommand(file, 'providers.set', { provider: { id: 'host', apiKey: 'fixture-new' } }), { code: 'IRIS_CONFIG_INPUT_INVALID' });
const dataRoot = path.join(root, 'core'), app = createApplicationRuntime({ dataRoot });
let api;
try {
  await app.execute('flow.init', {}); await app.dispose();
  api = createLocalReadApi({ dataRoot, providerConfigPath: file, allowProviderManagement: true });
  const session = await api.start(), before = fs.readFileSync(file);
  const response = await fetch(session.origin + '/api/v0/provider-management/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + session.accessToken, 'content-type': 'application/json' },
    body: JSON.stringify(inputFor(loadProviderCatalog(file), { action: 'replace', value: 'fixture-http-secret' })) });
  assert.equal(response.status, 400); const result = await response.json();
  assert.equal(result.error.code, 'IRIS_CONFIG_INPUT_INVALID'); assert(!JSON.stringify(result).includes('fixture-http-secret'));
  assert.deepEqual(fs.readFileSync(file), before);
  console.log('PASS credential source boundaries: stored inline/env/DSH exclusivity, source switches, unchanged rejected files/catalogs, owner HTTP rejection and valid Host runtime copies');
} finally { await api?.dispose(); await app.dispose(); }
