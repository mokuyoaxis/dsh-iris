import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { buildVisionBackendsFromHost, askWithBackends } from '../lib/vision.js';
import { createDshHostAdapter } from '../lib/dsh-host-adapter.js';
import { providerTaskBinding } from '../lib/provider-catalog.js';

const { root } = useTempDshHome('iris-protocol-selection');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const official = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const compatible = 'https://compatible.example/v1';
const source = path.join(root, 'import.json');
fs.writeFileSync(source, JSON.stringify({ providers: [{
  type: 'future-vision', mediaProtocol: 'future-media', baseUrl: compatible,
  apiKey: 'fixture-secret', enabled: true
}] }));
assert.equal(config.importFromWorkbench(source).imported, 1);
assert.equal(config.allProviders()[0].type, 'future-vision', 'import must preserve explicit vision type');
assert.equal(config.allProviders()[0].mediaProtocol, 'future-media');

const inferred = config.upsert({ baseUrl: compatible, apiKey: 'fixture-secret', enabled: true });
assert.equal(inferred.mediaProtocol, 'openai-images');
assert.equal(inferred.protocolInferred, true);
config.resetCache();
assert.equal(config.providerById(inferred.id).protocolInferred, true, 'provenance survives reload');
assert.equal(config.upsert({ id: inferred.id, name: 'renamed' }).protocolInferred, true);
assert.equal(config.upsert({ id: inferred.id, mediaProtocol: 'openai-images' }).protocolInferred, false);
assert.equal(config.upsert({ id: inferred.id, mediaProtocol: 'auto' }).protocolInferred, true);
const dash = config.upsert({ id: inferred.id, mediaBaseUrl: official, mediaProtocol: 'auto' });
assert.equal(dash.mediaProtocol, 'dashscope');
assert.equal(dash.protocolInferred, false);
const custom = config.upsert({ id: inferred.id, mediaProtocol: 'future-media' });
assert.equal(custom.mediaProtocol, 'future-media');
config.resetCache();
assert.equal(config.providerById(custom.id).mediaProtocol, 'future-media', 'reload must not rewrite unknown protocol');

const auto = { id: 'auto', baseUrl: compatible, mediaProtocol: 'auto', apiKey: 'fixture-secret' };
assert.equal(createConfiguredProviderAdapter(auto).protocol, 'openai-images');
assert.equal(providerTaskBinding(auto), providerTaskBinding({ ...auto, mediaProtocol: 'openai-images' }));
assert.equal(createConfiguredProviderAdapter({ ...auto, mediaBaseUrl: official }).protocol, 'dashscope');
assert.throws(() => createConfiguredProviderAdapter({
  ...auto, mediaProtocol: 'future-media', protocolInferred: true
}), { code: 'IRIS_PROVIDER_PROTOCOL_UNSUPPORTED' }, 'a stale marker cannot override a newly written explicit protocol');

let calls = 0;
const originalFetch = global.fetch;
global.fetch = async () => { calls++; throw new Error('unexpected network'); };
try {
  for (const protocol of ['future-media', 'constructor', 'https://private.example/?key=fixture-secret']) {
    assert.throws(() => createConfiguredProviderAdapter({ ...auto, mediaProtocol: protocol }), (error) => {
      assert.equal(error.code, 'IRIS_PROVIDER_PROTOCOL_UNSUPPORTED');
      assert.ok(!error.message.includes('fixture-secret') && !error.message.includes('private.example'));
      return true;
    });
  }
  assert.equal(config.upsert({ baseUrl: official, mediaProtocol: 'constructor' }).mediaProtocol, 'constructor');
  await assert.rejects(askWithBackends(buildVisionBackendsFromHost({}, { providers: [{ type: 'future-vision' }] }), {}),
    { code: 'IRIS_VISION_PROTOCOL_UNSUPPORTED' });
  const host = createDshHostAdapter({ get: (name) => name === 'llm' ? {
    stream: async function* () { yield { delta: 'host fixture' }; }
  } : undefined });
  const fallback = await askWithBackends(buildVisionBackendsFromHost(host, {
    providers: [{ type: 'future-vision' }]
  }), { question: 'fixture' });
  assert.equal(fallback.answer, 'host fixture');
  assert.equal(fallback.errors[0].code, 'IRIS_VISION_PROTOCOL_UNSUPPORTED');
  const future = config.upsert({
    enabled: true, auth: 'none', baseUrl: compatible, mediaProtocol: 'future-media',
    models: [{ id: 'future-video', capabilities: ['video-gen'] }, { id: 'future-tts', capabilities: ['tts'] }]
  });
  await assert.rejects(runAction({}, 'video', { prompt: 'fixture', model: future.id + '::future-video' }),
    { code: 'IRIS_PROVIDER_PROTOCOL_UNSUPPORTED' });
  await assert.rejects(runAction({}, 'tts', { text: 'fixture', model: future.id + '::future-tts' }),
    { code: 'IRIS_PROVIDER_PROTOCOL_UNSUPPORTED' });
  assert.equal(calls, 0);
} finally {
  global.fetch = originalFetch;
}

const pending = config.upsert({ baseUrl: compatible, enabled: true, auth: 'none' });
const view = await runAction({}, 'providers_list', {});
assert.equal(view.providers.find((p) => p.id === pending.id).protocolInferred, true);
assert.ok(!JSON.stringify(view).includes('fixture-secret'));
console.log('Protocol selection: explicit preservation, auto provenance, import, binding and zero-network rejection passed');
