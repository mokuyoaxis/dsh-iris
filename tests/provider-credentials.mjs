import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { executeConfigCommand } from '../lib/provider-config-service.js';
import { loadProviderCatalog, imageCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding } from '../lib/provider-catalog.js';
import { providerApiKey, isConfiguredProvider } from '../lib/provider-protocol.js';
import { validateProviderCredential, providerCredentialStatus, assertProviderCredential, resolveProviderCredential, scrubProviderSecrets } from '../lib/provider-credentials.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';
import { createProviderRegistry, defineProviderAdapter, normalizeMediaEndpoint } from '../lib/provider-extensions.js';
import { modelDirectoryBinding } from '../lib/model-directory.js';
import { projectProviderDiagnostics } from '../lib/provider-diagnostics.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-provider-env');
const envName = 'IRIS_CREDENTIAL_TEST_' + crypto.randomUUID().replaceAll('-', '').toUpperCase();
const key = 'env-only-fixture-' + crypto.randomUUID(), rotated = 'rotated-fixture-' + crypto.randomUUID();
const file = path.join(root, 'providers.json'), requests = [], checks = [];
let echoCredential = false;
const server = http.createServer((request, response) => {
  requests.push(request.headers.authorization); response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ data: [{ id: 'edit' }, { id: echoCredential ? request.headers.authorization.slice(7) : 'other-model' }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const provider = { id: 'account', name: 'Account', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
  apiKeyEnv: envName, mediaProtocol: 'openai-chat-images', models: [{ id: 'edit', capabilities: ['image-gen'] }] };
const raw = { opaque: { preserved: true }, providers: [provider], assignments: { 'image-gen': ['account::edit'] } };
const save = value => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const show = () => executeConfigCommand(file, 'settings.show');
async function draft(credential) {
  const settings = await show(), p = settings.providers[0];
  return { expectedRevision: settings.revision, provider: { ...Object.fromEntries(['id', 'name', 'baseUrl', 'mediaBaseUrl', 'mediaProtocol', 'enabled', 'auth'].map(name => [name, p[name]])),
    models: p.models.map(({ id, capabilities, imageProtocol, musicProtocol }) => ({ id, capabilities, imageProtocol, musicProtocol })) }, credential };
}
try {
  for (const apiKeyEnv of ['', 'A-B', '$TOKEN', '${TOKEN}', 'A\nB', '1KEY', 'A'.repeat(129), null, 7]) {
    assert.throws(() => validateProviderCredential({ apiKeyEnv }), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  }
  for (const extra of [{ apiKey: 'inline' }, { dshProvider: { provider: 'host', settingsNs: 'scope' } }]) {
    assert.throws(() => validateProviderCredential({ apiKeyEnv: envName, ...extra }), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  }
  validateProviderCredential({ apiKeyEnv: envName }); save(raw);
  assert.equal(providerCredentialStatus(provider), 'missing'); assert.equal(isConfiguredProvider(provider), false);
  assert.equal((await show()).providers[0].credentialStatus, 'missing');
  assert.throws(() => imageCandidatesFromCatalog(loadProviderCatalog(file), 'account::edit'), { code: 'IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE' });
  assert.throws(() => createConfiguredProviderAdapter(provider), { code: 'IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE' });
  assert.equal(projectProviderDiagnostics(raw).capabilities[0].models[0].reason, 'credential_unavailable');
  assert.equal(requests.length, 0);
  checks.push('invalid/mixed sources rejected; absent variable remains editable but cannot reach a provider');
  for (const value of ['bad\r\nheader', 'x'.repeat(8193), 'invalid-🔑']) {
    process.env[envName] = value; assert.equal(providerCredentialStatus(provider), 'invalid');
    assert.throws(() => assertProviderCredential(provider), { code: 'IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE' });
  }
  process.env[envName] = key;
  const before = fs.readFileSync(file), beforeRevision = (await show()).revision;
  assert.equal(providerApiKey(provider), key); assert.equal(isConfiguredProvider(provider), true);
  const resolved = resolveProviderCredential(provider); assert.equal(resolved.apiKey, key); assert.equal(resolved.apiKeyEnv, undefined);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(provider.apiKey, undefined);
  const settings = await show(); assert.equal(settings.providers[0].apiKeyEnv, envName);
  assert.equal(settings.providers[0].hasCredential, true); assert(!JSON.stringify(settings).includes(key));
  assert.equal(providerApiKey({ ...provider, auth: 'none' }), '');
  delete process.env[envName]; assert.equal(isConfiguredProvider({ ...provider, auth: 'none' }), true);
  assert.doesNotThrow(() => assertProviderCredential({ ...provider, auth: 'none' }));
  process.env[envName] = key;
  checks.push('runtime-only resolution, finite header-safe values, owner status and auth:none preserve secret boundaries');
  const discovered = await executeConfigCommand(file, 'settings.discover', { expectedRevision: beforeRevision, providerId: 'account' });
  assert.equal(requests[0], 'Bearer ' + key); assert(!JSON.stringify(discovered).includes(key));
  const captured = createConfiguredProviderAdapter(provider), binding = providerTaskBinding(provider), directoryBinding = modelDirectoryBinding(provider);
  process.env[envName] = rotated;
  await invokeProviderOperation(captured, 'discover', {}); assert.equal(requests.at(-1), 'Bearer ' + key);
  await invokeProviderOperation(createConfiguredProviderAdapter(provider), 'discover', {}); assert.equal(requests.at(-1), 'Bearer ' + rotated);
  assert.equal(providerTaskBinding(provider), binding); assert.notEqual(modelDirectoryBinding(provider), directoryBinding);
  assert.equal((await show()).revision, beforeRevision);
  assert(!JSON.stringify(captured.operations.mapError(new Error('echo ' + key), { stage: 'submit' })).includes(key));
  checks.push('each adapter captures one key; rotation changes cache binding, preserves Task binding and does not create an edit conflict');
  const longKey = 'long-fixture-' + 'Z'.repeat(300) + crypto.randomUUID(); process.env[envName] = longKey;
  echoCredential = true;
  await assert.rejects(executeConfigCommand(file, 'settings.discover', { expectedRevision: beforeRevision, providerId: 'account' }),
    error => error.category === 'protocol' && error.providerCode === 'IRIS_PROVIDER_DIRECTORY_CREDENTIALS');
  echoCredential = false;
  process.env[envName] = rotated;
  const registry = await createProviderRegistry({ extensions: [() => ({ id: 'fixture.env', version: '1.0.0', contractVersion: 0,
    protocols: [{ id: 'env-images', label: 'Env images', capabilities: ['image-gen'], normalizeEndpoint: normalizeMediaEndpoint,
      createAdapter: runtime => {
        assert.equal(runtime.apiKey, rotated); assert.equal(runtime.apiKeyEnv, undefined);
        return defineProviderAdapter({ id: runtime.id, protocol: 'env-images', capabilities: ['image'],
          operations: { submit: async () => { throw new Error('This test only discovers models'); }, discover: async () => ({ models: ['edit'] }), mapError: error => error },
          unsupported: { poll: 'test only', cancel: 'test only', download: 'test only' } });
      } }] })] });
  try {
    await invokeProviderOperation(createConfiguredProviderAdapter({ ...provider, mediaProtocol: 'env-images' }, { registry }), 'discover', {});
    assert(!JSON.stringify(registry.snapshot()).includes(rotated));
  } finally { await registry.dispose(); }
  checks.push('existing third-party Provider factories receive their ordinary runtime apiKey without new credential storage or metadata leakage');
  const contaminated = structuredClone(raw); contaminated.providers[0].name = 'echo:' + rotated;
  save(contaminated);
  assert(!JSON.stringify(await show()).includes(rotated));
  assert(!JSON.stringify(await executeConfigCommand(file, 'show')).includes(rotated));
  assert(!JSON.stringify(projectProviderDiagnostics(contaminated)).includes(rotated));
  assert.equal(scrubProviderSecrets('echo:' + rotated, [{ ...provider, auth: 'none' }]), 'echo:[redacted]');
  save(raw);
  await executeConfigCommand(file, 'settings.save', await draft({ action: 'keep' }));
  assert.equal(loadProviderCatalog(file).providers[0].apiKeyEnv, envName);
  await executeConfigCommand(file, 'settings.save', await draft({ action: 'replace', value: 'explicit-inline-fixture' }));
  assert.equal(loadProviderCatalog(file).providers[0].apiKeyEnv, undefined);
  await executeConfigCommand(file, 'settings.save', await draft({ action: 'env', name: envName }));
  assert.equal(loadProviderCatalog(file).providers[0].apiKey, undefined);
  assert.deepEqual(loadProviderCatalog(file).opaque, raw.opaque);
  const prior = fs.readFileSync(file);
  for (const credential of [{ action: 'env', value: key, name: envName }, { action: 'keep', name: envName }, { action: 'env', name: 'BAD-NAME' }]) {
    await assert.rejects(executeConfigCommand(file, 'settings.save', await draft(credential)), { code: 'IRIS_CONFIG_INPUT_INVALID' });
    assert.deepEqual(fs.readFileSync(file), prior);
  }
  await executeConfigCommand(file, 'settings.save', await draft({ action: 'clear' }));
  assert.equal(loadProviderCatalog(file).providers[0].apiKeyEnv, undefined); assert.equal(loadProviderCatalog(file).providers[0].apiKey, undefined);
  await executeConfigCommand(file, 'providers.set', { provider: { id: 'account', apiKeyEnv: envName } });
  assert.equal(loadProviderCatalog(file).providers[0].apiKey, undefined);
  await executeConfigCommand(file, 'providers.set', { provider: { id: 'account', apiKey: 'inline-cli-fixture' } });
  assert.equal(loadProviderCatalog(file).providers[0].apiKeyEnv, undefined);
  for (const name of fs.readdirSync(root).filter(name => name.includes('providers.json'))) {
    const bytes = fs.readFileSync(path.join(root, name), 'utf8'); assert(!bytes.includes(key) && !bytes.includes(rotated), name);
  }
  checks.push('Web/CLI source switches are explicit and atomic; keep/clear/validation preserve configuration and no resolved key enters backups');
  const { apiKeyEnv: _reference, ...inline } = provider;
  const multi = { providers: [provider, { ...inline, id: 'spare', apiKey: 'inline-spare-fixture' }], assignments: { 'image-gen': { mode: 'auto', models: [] } } };
  delete process.env[envName];
  assert.equal(imageCandidatesFromCatalog(multi)[0].provider.id, 'spare');
  assert.throws(() => providerForTaskFromCatalog(multi, { capability: 'image', providerId: 'account', modelRef: 'account::edit', providerBinding: binding }),
    { code: 'IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE' });
  process.env[envName] = rotated;
  checks.push('new automatic requests can use another eligible provider, but original Task recovery cannot borrow that provider');
  const legacy = await import('../lib/config.js');
  const saved = legacy.upsert({ ...inline, id: undefined, apiKey: 'legacy-inline-fixture' });
  legacy.upsert({ id: saved.id, apiKeyEnv: envName });
  assert.equal(legacy.allProviders().find(item => item.id === saved.id).apiKey, undefined);
  assert.equal(legacy.providers().find(item => item.id === saved.id).apiKeyEnv, envName);
  const legacyFile = path.join(legacy.irisHome(), 'providers.json');
  assert(!fs.readFileSync(legacyFile, 'utf8').includes(rotated));
  delete process.env[envName]; assert(!legacy.providers().some(item => item.id === saved.id));
  process.env[envName] = rotated;
  legacy.upsert({ id: saved.id, apiKey: 'legacy-replacement-fixture' });
  assert.equal(legacy.allProviders().find(item => item.id === saved.id).apiKeyEnv, undefined);
  checks.push('the shared legacy store retains raw references, filters missing values and switches sources without persisting an environment value');
  console.log(JSON.stringify({ ok: true, checks, root }, null, 2));
} finally { delete process.env[envName]; await new Promise(resolve => server.close(resolve)); }
