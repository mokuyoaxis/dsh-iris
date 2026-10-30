import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { uploadTempFile } from '../lib/adapters.js';
import { prepareProviderInput } from '../lib/provider-adapter.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { AUDIO_WAV } from './fixtures/audio-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-audio-upload'), fetch = globalThis.fetch, calls = [];
const input = { key: 'fixture-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'fixture-transcribe', signal: new AbortController().signal };
const source = path.join(root, 'source.wav'); fs.writeFileSync(source, AUDIO_WAV, { mode: 0o600 });
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  if (String(url).includes('/uploads?')) return Response.json({ data: { upload_dir: 'fixture', upload_host: 'https://upload.invalid',
    oss_access_key_id: 'id', signature: 'signature', policy: 'policy', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } });
  assert.equal(String(url), 'https://upload.invalid'); assert.equal(options.method, 'POST');
  const body = options.body;
  assert.equal(body.get('file').name, 'source.wav'); assert.deepEqual(Buffer.from(await body.get('file').arrayBuffer()), AUDIO_WAV);
  assert.match(body.get('key'), /^fixture\/\d+-source.wav$/); assert.equal(body.get('success_action_status'), '200');
  assert.equal(options.headers?.Authorization, undefined, 'API key never goes to the object storage upload');
  return new Response('', { status: 200 });
};
try {
  const byBytes = await uploadTempFile({ ...input, bytes: AUDIO_WAV, filename: 'source.wav' }); assert.match(byBytes, /^oss:\/\/fixture\//);
  const byPath = await uploadTempFile({ ...input, filePath: source }); assert.match(byPath, /^oss:\/\/fixture\//);
  assert.equal(calls.length, 4); assert.equal(new URL(calls[0].url).searchParams.get('model'), 'fixture-transcribe');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-key');
  for (const invalid of [{}, { bytes: AUDIO_WAV, filePath: source }, { bytes: AUDIO_WAV, filename: '../source.wav' }, { bytes: Buffer.alloc(0), filename: 'source.wav' }]) {
    await assert.rejects(uploadTempFile({ ...input, ...invalid }), TypeError);
  }
  assert.equal(calls.length, 4, 'malformed upload arguments fail before policy or object-storage requests');
  const forwarded = [];
  const adapter = createConfiguredProviderAdapter({ id: 'fixture', mediaProtocol: 'dashscope', baseUrl: input.baseUrl, apiKey: input.key }, {
    transport: { uploadTempFile: async value => { forwarded.push(value); return 'oss://private-result'; } } });
  const prepared = await prepareProviderInput(adapter, { model: input.model, bytes: AUDIO_WAV, filename: 'source.wav', signal: input.signal });
  assert.equal(prepared.url, 'oss://private-result'); assert.equal(JSON.stringify(prepared), '{}');
  assert.deepEqual(forwarded[0].bytes, AUDIO_WAV); assert.equal(forwarded[0].filename, 'source.wav'); assert.equal(forwarded[0].filePath, undefined);
  console.log('audio upload: original bytes and legacy path create the same finite OSS form, credentials stay on policy request, malformed input does zero network, runtime URL stays nonserializable OK');
} finally { globalThis.fetch = fetch; }
