import assert from 'node:assert/strict';
import {
  createConfiguredProviderAdapter, createDashScopeProviderAdapter, createOpenAiImagesProviderAdapter,
  createOpenAiChatImagesProviderAdapter, createOpenAiResponsesImagesProviderAdapter, createGeminiWebMusicProviderAdapter
} from '../lib/provider-adapters.js';
import { invokeProviderOperation, prepareProviderInput } from '../lib/provider-adapter.js';

// Opaque credentials must be removed even when they do not match a vendor's key pattern.
const key = 'irisOpaqueFixtureCredential782341NotARealKey';
const failure = () => Object.assign(new Error('x'.repeat(990) + key + ' upstream rejected'), {
  status: 401, providerCode: 'upstream-' + key
});
const reject = async () => { throw failure(); };
const transport = {
  listModels: reject, submitImage: reject, openAiGenerateImage: reject, openAiChatGenerateImage: reject,
  openAiResponsesGenerateImage: reject, generateMusic: reject, uploadTempFile: reject, downloadTo: reject,
  dashscopeImageMode: () => 'legacy-async'
};
function noKey(value) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes(key.slice(0, 12)), 'redaction must precede truncation, including error codes');
  assert.ok(serialized.includes('[REDACTED]'));
}
for (const [factory, mediaProtocol, capability] of [
  [createDashScopeProviderAdapter, 'dashscope', 'image'],
  [createOpenAiImagesProviderAdapter, 'openai-images', 'image'],
  [createOpenAiChatImagesProviderAdapter, 'openai-chat-images', 'image'],
  [createOpenAiResponsesImagesProviderAdapter, 'openai-responses-images', 'image'],
  [createGeminiWebMusicProviderAdapter, 'gemini-web-music', 'music'],
  [createConfiguredProviderAdapter, 'openai-images', 'image']
]) {
  const adapter = factory({ id: 'redaction-fixture', apiKey: key, mediaProtocol,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, { transport });
  const result = await invokeProviderOperation(adapter, 'submit', { capability, model: 'fixture', input: { prompt: 'fixture' } });
  noKey(result);
  assert.equal(result.acceptance, 'not_accepted');
  assert.equal(result.error.category, 'authentication');
  assert.equal(result.error.httpStatus, 401);
  await assert.rejects(invokeProviderOperation(adapter, 'discover', {}), error => {
    noKey(error); assert.equal(error.stage, 'validate'); return true;
  });
  await assert.rejects(invokeProviderOperation(adapter, 'download', {
    artifact: { kind: 'remote-url', url: 'https://fixture.invalid/result.png' }, targetPath: '/fixture/result.png'
  }), error => {
    // Music has no remote download operation; its inline-only validation is independent of the upstream key.
    if (capability === 'music') return true;
    noKey(error); assert.equal(error.acceptance, 'accepted'); return true;
  });
}

for (const capability of ['image', 'video', 'transcribe']) {
  const failedPoll = async () => ({ done: true, ok: false, status: 'FAILED', message: failure().message });
  const adapter = createDashScopeProviderAdapter({ id: 'redaction-poll', apiKey: key,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, {
    transport: { pollTask: failedPoll, pollTranscriptionTask: failedPoll, uploadTempFile: reject }
  });
  const result = await invokeProviderOperation(adapter, 'poll', { capability, remoteTaskId: 'existing-fixture' });
  noKey(result);
  assert.equal(result.kind, 'failed');
  assert.equal(result.error.acceptance, 'accepted');
  await assert.rejects(prepareProviderInput(adapter, { model: 'fixture', filePath: '/fixture/input.png' }), error => {
    noKey(error); assert.equal(error.acceptance, 'not_accepted'); assert.equal(error.stage, 'upload'); return true;
  });
}

console.log('ALL OK - exact opaque-key redaction before truncation across media protocols, discovery, upload, poll and download');
