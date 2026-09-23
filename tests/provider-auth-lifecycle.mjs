// RECONSTRUCTED 2026-09-23 from the T-01 authentication contract and recovered implementation.
// The original test bytes were not found after the home-directory deletion.
import assert from 'node:assert/strict';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { providerAdapterSnapshot } from '../lib/provider-adapter.js';

for (const [auth, apiKey, expectedKey] of [
  ['none', undefined, ''],
  ['none', 'stale-fixture-secret', ''],
  ['bearer', 'bearer-fixture-secret', 'bearer-fixture-secret']
]) {
  const seen = [];
  const provider = {
    id: 'auth-fixture', auth, apiKey,
    baseUrl: 'http://127.0.0.1:8188/v1', mediaProtocol: 'openai-images'
  };
  const adapter = createConfiguredProviderAdapter(provider, { transport: {
    async listModels(input) {
      seen.push(['discover', input.key]);
      return ['fixture-image'];
    },
    async openAiGenerateImage(input) {
      seen.push(['submit', input.key]);
      return [{ b64: 'YWJj' }];
    }
  } });
  const discovered = await adapter.operations.discover();
  assert.deepEqual(discovered.models, ['fixture-image']);
  const submitted = await adapter.operations.submit({
    capability: 'image', model: 'fixture-image', input: { prompt: 'fixture' }
  });
  assert.equal(submitted.kind, 'completed');
  assert.deepEqual(seen, [['discover', expectedKey], ['submit', expectedKey]],
    '认证方式必须在发现和提交两个生命周期入口保持一致');
  const snapshot = JSON.stringify(providerAdapterSnapshot(adapter));
  assert.ok(!snapshot.includes('fixture-secret') && !snapshot.includes(provider.baseUrl),
    'Adapter 描述不得输出旧凭据或端点');
}

console.log('Provider auth lifecycle: none suppresses stale keys, bearer remains compatible');
