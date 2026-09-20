import assert from 'node:assert/strict';
import {
  defineProviderAdapter, prepareProviderInput, providerAdapterSnapshot, PROVIDER_OPERATIONS
} from '../lib/provider-adapter.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';

const provider = {
  id: 'upload-fixture', mediaProtocol: 'dashscope', apiKey: 'sk-upload-fixture-secret',
  baseUrl: 'https://api.invalid/v1', mediaBaseUrl: 'https://media.invalid/v1'
};
const calls = [];
const signal = new AbortController().signal;
const url = 'oss://temporary/audio.wav?signature=fixture-signature';
const adapter = createConfiguredProviderAdapter(provider, { transport: {
  async uploadTempFile(input) { calls.push(input); return url; }
} });
const prepared = await prepareProviderInput(adapter, {
  model: 'fixture-audio', filePath: '/tmp/fixture.wav', signal, timeoutMs: 1234,
  key: 'caller-key', baseUrl: 'https://caller.invalid'
});
assert.equal(prepared.url, url);
assert.equal(JSON.stringify(prepared), '{}');
assert.deepEqual(calls, [{
  key: provider.apiKey, baseUrl: provider.mediaBaseUrl, model: 'fixture-audio',
  filePath: '/tmp/fixture.wav', signal, timeoutMs: 1234
}]);
const snapshot = providerAdapterSnapshot(adapter);
assert.equal(snapshot.inputPreparation.status, 'supported');
assert.deepEqual(Object.keys(snapshot.operations), PROVIDER_OPERATIONS);
assert.equal(PROVIDER_OPERATIONS.length, 6);
assert(!JSON.stringify(snapshot).includes(provider.apiKey));
assert(!JSON.stringify(snapshot).includes(provider.mediaBaseUrl));

let unsupportedCalls = 0;
const unsupported = createConfiguredProviderAdapter({ ...provider, mediaProtocol: 'openai-images' }, {
  transport: { async uploadTempFile() { unsupportedCalls++; return url; } }
});
assert.equal(providerAdapterSnapshot(unsupported).inputPreparation.status, 'unsupported');
await assert.rejects(prepareProviderInput(unsupported, { filePath: '/tmp/fixture.wav' }), (error) => {
  assert.equal(error.code, 'IRIS_PROVIDER_INPUT_PREPARATION_UNSUPPORTED');
  assert.equal(error.providerCode, error.code);
  assert.equal(error.stage, 'upload');
  assert.equal(error.acceptance, 'not_accepted');
  return true;
});
assert.equal(unsupportedCalls, 0);

// Existing adapters without the optional extension remain valid and explicitly unsupported.
const legacy = defineProviderAdapter({
  id: 'legacy', protocol: 'fixture', capabilities: ['image'],
  operations: { submit() {}, mapError(error) { return error; } },
  unsupported: { discover: 'unused', poll: 'unused', cancel: 'unused', download: 'unused' }
});
assert.equal(providerAdapterSnapshot(legacy).inputPreparation.status, 'unsupported');
await assert.rejects(prepareProviderInput(legacy), { code: 'IRIS_PROVIDER_INPUT_PREPARATION_UNSUPPORTED' });
assert.throws(() => defineProviderAdapter({ ...legacy, prepareInput: async () => ({ url }) }),
  /supported/);
assert.throws(() => defineProviderAdapter({ ...legacy, prepareInput: 'invalid' }), /prepareInput/);

for (const [failure, category] of [
  [Object.assign(new Error('Bearer secret-token /home/private/audio.wav?signature=hidden'), {
    httpStatus: 403, stage: 'submit', acceptance: 'accepted'
  }), 'authentication'],
  [Object.assign(new Error('canceled'), { name: 'AbortError' }), 'aborted'],
  [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'timeout']
]) {
  const failing = createConfiguredProviderAdapter(provider, { transport: {
    async uploadTempFile() { throw failure; }
  } });
  await assert.rejects(prepareProviderInput(failing), (error) => {
    assert.equal(error.stage, 'upload');
    assert.equal(error.acceptance, 'not_accepted');
    assert.equal(error.category, category);
    assert(!JSON.stringify(error).includes('secret-token'));
    assert(!JSON.stringify(error).includes('/home/private'));
    assert(!JSON.stringify(error).includes('hidden'));
    return true;
  });
}
const malformed = createConfiguredProviderAdapter(provider, { transport: {
  async uploadTempFile() { return ''; }
} });
await assert.rejects(prepareProviderInput(malformed), {
  stage: 'upload', acceptance: 'not_accepted', category: 'protocol'
});
console.log('ALL OK - optional input preparation: upload, unsupported, redaction, acceptance boundary');
