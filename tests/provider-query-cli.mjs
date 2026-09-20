import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
import { CAPABILITIES } from '../lib/capability.js';
import { CAP_FIELD, modelRef } from '../lib/models.js';
import { loadProviderCatalog, catalogCapabilitySnapshot, providerCatalogSnapshot, imageCandidatesFromCatalog } from '../lib/provider-catalog.js';

const { root } = useTempDshHome('iris-provider-query');
const config = await import('../lib/config.js');
const first = config.upsert({
  name: 'First https://secret.invalid/path?signature=hidden', auth: 'none',
  baseUrl: 'http://local.invalid/v1', apiKey: 'secret-never-print',
  models: [{ id: 'shared', capabilities: ['image-gen', 'vision'] }, { id: 'other', capabilities: ['image-gen'] }]
});
const second = config.upsert({
  name: 'Second', apiKey: 'second-private-key', mediaProtocol: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  models: [{ id: 'shared', capabilities: ['image-gen', 'vision'] }, { id: 'voice', capabilities: ['tts'] }]
});
config.upsert({ name: 'Disabled', enabled: false, auth: 'none', baseUrl: 'https://disabled.invalid', models: [{ id: 'disabled', capabilities: ['image-gen'] }] });
const file = path.join(config.irisHome(), 'providers.json');
const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
stored.assignments = {
  'image-gen': [{ providerId: second.id, id: 'shared' }, modelRef(second.id, 'shared'), 'missing', 'shared'],
  vision: [modelRef(second.id, 'shared')]
};
fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
config.resetCache();
const before = fs.readFileSync(file, 'utf8');
const catalog = loadProviderCatalog(file);
const snapshot = catalogCapabilitySnapshot(catalog);
for (const capability of Object.values(CAPABILITIES)) {
  const hostRefs = config.pickAllFor(capability).map((provider) => modelRef(provider.id, provider[CAP_FIELD[capability]]));
  assert.deepEqual(snapshot.capabilities.find((row) => row.capability === capability).candidates, hostRefs);
}
assert.deepEqual(snapshot.capabilities[0].candidates, [
  modelRef(second.id, 'shared'), modelRef(first.id, 'shared'), modelRef(first.id, 'other')
]);
assert.deepEqual(imageCandidatesFromCatalog(catalog).map((route) => route.modelRef), snapshot.capabilities[0].candidates);
assert.equal(snapshot.capabilities.find((row) => row.capability === 'transcribe').gap, 'no_configured_model');

for (const [command, expected] of [['providers', providerCatalogSnapshot(catalog)], ['capabilities', snapshot]]) {
  const result = spawnSync(process.execPath, ['bin/dsh-iris.js', command, 'list', '--provider-config', file], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: path.join(root, 'unused-home') }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  for (const secret of ['secret-never-print', 'second-private-key', 'https://', 'http://', root, 'signature=hidden']) {
    assert(!result.stdout.includes(secret), secret);
  }
}
const providers = providerCatalogSnapshot(catalog).providers;
assert.equal(providers.find((row) => row.id === first.id).auth, 'none');
assert.equal(providers.find((row) => row.id === first.id).protocolInferred, true);
assert.equal(providers.find((row) => row.name === 'Disabled').enabled, false);
assert.equal(fs.readFileSync(file, 'utf8'), before);
assert(!fs.existsSync(path.join(root, 'unused-home')));
const missing = spawnSync(process.execPath, ['bin/dsh-iris.js', 'providers', 'list'], { encoding: 'utf8' });
assert.equal(missing.status, 2);
assert(missing.stderr.includes('IRIS_CLI_USAGE'));
console.log('ALL OK - provider/capability queries: redaction, DSH ordering parity, read-only CLI');
