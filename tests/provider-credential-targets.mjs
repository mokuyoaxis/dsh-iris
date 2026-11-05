import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { withDshProviderConfig } from '../lib/dsh-provider-config.js';
import { createDshRuntime } from '../lib/dsh-core-adapter.js';
import { runAction } from '../lib/actions.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const { root } = useTempDshHome('iris-credential-targets');
const store = await import('../lib/config.js');
const reference = { provider: 'fixture-host', settingsNs: 'fixture-settings' };
const saved = store.upsert({ name: 'Host reference', dshProvider: reference, mediaProtocol: 'openai-images',
  models: [{ id: 'portrait', capabilities: ['image-gen'] }] });
const file = path.join(store.irisHome(), 'providers.json'), before = fs.readFileSync(file);
const inventory = fs.readdirSync(store.irisHome()).sort();
const core = createDshRuntime({ dataRoot: path.join(root, 'core') });
try {
  for (const field of ['baseUrl', 'mediaBaseUrl', 'apiKey']) {
    for (const value of [null, 42, {}]) {
      assert.throws(() => store.upsert({ name: 'Invalid manual', [field]: value }), { code: 'IRIS_CONFIG_INPUT_INVALID' });
      await assert.rejects(runAction(undefined, 'providers_upsert', { name: 'Invalid action', [field]: value }, { core }),
        { code: 'IRIS_CONFIG_INPUT_INVALID' });
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(store.allProviders().length, 1, 'rejected edits cannot leave an invalid cached provider');
    }
  }
  await assert.rejects(runAction(undefined, 'providers_upsert', { id: saved.id, mediaBaseUrl: 'https://override.invalid/v1' }, { core }),
    { code: 'IRIS_CONFIG_INPUT_INVALID' });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(store.irisHome()).sort(), inventory);

  const invalid = JSON.parse(before); invalid.providers[0].mediaBaseUrl = 'https://override.invalid/v1';
  fs.writeFileSync(file, JSON.stringify(invalid)); const raw = fs.readFileSync(file);
  store.resetCache();
  assert.throws(() => store.load(), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  assert.deepEqual(fs.readFileSync(file), raw, 'a newly disallowed source combination must not quarantine or migrate user configuration');
  assert.deepEqual(fs.readdirSync(store.irisHome()).sort(), inventory);
  fs.writeFileSync(file, before); store.resetCache();
  const provider = store.upsert({ id: saved.id, mediaBaseUrl: '' });
  const emptyOverride = fs.readFileSync(file), key = 'fixture-host-key-not-a-model', calls = [];
  // Model an already-cached old record without publishing the forbidden field.
  provider.mediaBaseUrl = 'https://override.invalid/v1';
  await withDshProviderConfig({ ports: { providerConnections: { async resolve() {
    return { baseUrl: 'https://host.invalid/v1', apiKey: key };
  } } } }, async () => {
    const runtimeProvider = store.runtimeProviders().find(value => value.id === saved.id);
    const adapter = createConfiguredProviderAdapter(runtimeProvider, { transport: {
      async listModels(input) { calls.push(input); return ['portrait']; },
      async openAiGenerateImage(input) { calls.push(input); return [{ b64: FAKE_PNG.toString('base64') }]; }
    } });
    await adapter.operations.discover({});
    await adapter.operations.submit({ capability: 'image', model: 'portrait', input: { prompt: 'offline' } });
  });
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.baseUrl === 'https://host.invalid/v1' && call.key === key));
  assert.deepEqual(fs.readFileSync(file), emptyOverride, 'resolved Host values and discarded old overrides stay in memory');
  assert(!fs.readFileSync(file, 'utf8').includes(key));
  store.resetCache(); assert.equal(store.allProviders().length, 1);
  console.log('PASS provider targets: rejected null/type edits preserve disk and cache, forbidden DSH targets preserve old files, empty override and Host-only discover/submit work');
} finally { await core.dispose(); }
