import assert from 'node:assert/strict';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-discovery-merge');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const provider = config.upsert({
  name: 'fixture', type: 'openai', enabled: true, auth: 'none',
  baseUrl: 'https://fixture.example/v1', mediaProtocol: 'openai-images',
  models: [
    { id: 'manual-only', capabilities: ['vision'], source: 'manual' },
    { id: 'shared', capabilities: ['video-gen'], source: 'manual' },
    { id: 'retired', capabilities: ['image-gen'], source: 'discovered' },
    { id: 'updated', capabilities: ['image-gen'], source: 'discovered' }
  ]
});
const originalFetch = global.fetch;
let calls = 0;
global.fetch = async () => {
  calls++;
  return new Response(JSON.stringify({ data: [
    { id: 'shared', capabilities: ['IG'] },
    { id: 'updated', capabilities: ['VU'] },
    { id: 'new-image', capabilities: ['IG'] },
    { id: 'new-image', capabilities: ['IG'] }
  ] }), { headers: { 'Content-Type': 'application/json' } });
};
try {
  await runAction({}, 'providers_discover', { id: provider.id });
  const entries = config.providerById(provider.id).models;
  assert.equal(entries.length, 5, 'discovery must retain absent models and deduplicate');
  assert.deepEqual(entries.find((m) => m.id === 'shared').capabilities, ['video-gen']);
  assert.equal(entries.find((m) => m.id === 'shared').source, 'manual');
  assert.deepEqual(entries.find((m) => m.id === 'updated').capabilities, ['vision']);
  assert.equal(entries.find((m) => m.id === 'new-image').source, 'discovered');
  assert.ok(entries.some((m) => m.id === 'manual-only'));
  assert.ok(entries.some((m) => m.id === 'retired'));
  config.addProviderModel(provider.id, 'updated', ['tts']);
  await runAction({}, 'providers_discover', { id: provider.id });
  const edited = config.providerById(provider.id).models.find((m) => m.id === 'updated');
  assert.equal(edited.source, 'manual', 'editing an existing model makes it manual');
  assert.deepEqual(edited.capabilities, ['tts']);
  assert.equal(calls, 2, 'only explicit discovery invokes the provider');
  config.resetCache();
  assert.deepEqual(config.providerById(provider.id).models.find((m) => m.id === 'updated'), edited);
} finally {
  global.fetch = originalFetch;
}
console.log('Discovery merge: manual precedence, retained entries, updates, deduplication and reload passed');
