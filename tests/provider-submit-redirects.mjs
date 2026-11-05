import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import * as transport from '../lib/adapters.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { defineProviderAdapter } from '../lib/provider-adapter.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { createFakeLifecycleProvider, FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-submit-redirects');
const requests = [], targets = [];
let status = 307, crossOrigin = false, origin, otherOrigin, fallbackSubmits = 0;
function reply(response, value, code = 200) {
  response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
}
async function handle(request, response, other = false) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const entry = { method: request.method, path: request.url, body: Buffer.concat(chunks) };
  if (other || request.url === '/target') {
    targets.push(entry);
    if (request.method === 'GET') { response.end(FAKE_PNG); return; }
    reply(response, { error: { message: 'synthetic final-hop authentication failure' } }, 401); return;
  }
  requests.push(entry);
  if (request.url.startsWith('/ok/')) { reply(response, { data: [{ b64_json: FAKE_PNG.toString('base64') }] }); return; }
  response.writeHead(request.method === 'GET' ? 302 : status, { Location: (crossOrigin ? otherOrigin : origin) + '/target' });
  response.end();
}
const server = http.createServer((request, response) => { void handle(request, response); });
const other = http.createServer((request, response) => { void handle(request, response, true); });
server.listen(0, '127.0.0.1'); other.listen(0, '127.0.0.1');
await Promise.all([once(server, 'listening'), once(other, 'listening')]);
origin = `http://127.0.0.1:${server.address().port}`; otherOrigin = `http://127.0.0.1:${other.address().port}`;
const runtime = createCoreRuntime({ dataRoot: path.join(root, 'core') }); runtime.start();
const fake = createFakeLifecycleProvider({ id: 'backup' });
const backup = defineProviderAdapter({ ...fake.adapter, capabilities: ['image', 'music'], operations: {
  ...fake.adapter.operations, submit() { fallbackSubmits++; throw Error('a redirected submission must not switch models'); }
} });
let coreChecks = 0, mappedChecks = 0;
try {
  const runner = createProviderTaskRunner(runtime);
  for (status of [307, 308]) for (crossOrigin of [false, true]) {
    for (const mediaProtocol of ['openai-images', 'openai-chat-images', 'openai-responses-images', 'gemini-web-music']) {
      const before = requests.length, followed = targets.length;
      const adapter = createConfiguredProviderAdapter({ id: 'redirect-source', apiKey: 'synthetic-fixture-key',
        baseUrl: origin + '/v1', mediaProtocol });
      const result = await runner.submit({ capability: mediaProtocol === 'gemini-web-music' ? 'music' : 'image',
        candidates: [{ adapter, model: 'redirect-source::fixture' }, { adapter: backup, model: 'backup::fixture' }],
        providerInput: { prompt: 'local redirect fixture', n: 1 } });
      assert.equal(result.task.acceptance, 'unknown'); assert.equal(result.task.attempts.length, 1);
      assert.equal(result.task.attempts[0].providerId, 'redirect-source');
      assert.equal(requests.length, before + 1); assert.equal(targets.length, followed);
      assert.equal(requests.at(-1).method, 'POST'); assert.equal(fallbackSubmits, 0);
      coreChecks++;
    }

    // Keep DashScope's official HTTPS endpoint restriction intact. The injected
    // fetch port maps only the test's HTTP exchange to the loopback fixture.
    const fetchPort = (url, options) => {
      assert.equal(new URL(url).hostname, 'dashscope.aliyuncs.com');
      assert.equal(options.redirect, 'error');
      return fetch(origin + '/dashscope-submit', options);
    };
    const common = { key: 'synthetic-fixture-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      prompt: 'local fixture', model: 'fixture', timeoutMs: 3000, fetchPort };
    for (const [name, input] of [
      ['submitImage', { model: 'wan2.2-t2i-flash' }], ['generateImageMultimodal', { model: 'qwen-image-2.0' }],
      ['submitVideo', {}], ['synthesizeTts', { text: 'fixture' }],
      ['submitTranscription', { audioUrl: 'https://audio.fixture.invalid/fixture.wav' }],
      ['visionStream', { imageDataUrl: 'data:image/png;base64,' + FAKE_PNG.toString('base64') }]
    ]) {
      const before = requests.length, followed = targets.length;
      await assert.rejects(transport[name]({ ...common, ...input }));
      assert.equal(requests.length, before + 1); assert.equal(targets.length, followed); mappedChecks++;
    }
    let policyReads = 0, uploadRedirect;
    const beforeUpload = requests.length, beforeUploadTarget = targets.length;
    await assert.rejects(transport.uploadTempFile({ ...common, bytes: Buffer.from('synthetic upload'), filename: 'fixture.wav',
      fetchPort(url, options) {
        if ((options.method || 'GET') === 'GET') {
          policyReads++;
          return Promise.resolve(new Response(JSON.stringify({ data: { upload_dir: 'fixture', upload_host: origin + '/upload',
            oss_access_key_id: 'fixture', signature: 'fixture', policy: 'fixture', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } }),
          { headers: { 'Content-Type': 'application/json' } }));
        }
        uploadRedirect = options.redirect; return fetch(url, options);
      } }));
    assert.equal(uploadRedirect, 'error');
    assert.equal(requests.length, beforeUpload + 1); assert.equal(targets.length, beforeUploadTarget);
    assert.equal(policyReads, 1); assert.equal(fallbackSubmits, 0);
  }
  assert.equal(targets.length, 0, 'no submit or upload follows a redirect');

  const healthy = createConfiguredProviderAdapter({ id: 'healthy', apiKey: 'synthetic-fixture-key',
    baseUrl: origin + '/ok/v1', mediaProtocol: 'openai-images' });
  const result = await runner.submit({ capability: 'image', candidates: [{ adapter: healthy, model: 'healthy::fixture' }],
    providerInput: { prompt: 'successful control', n: 1 } });
  assert.equal(result.task.acceptance, 'accepted'); assert.equal(result.task.deliveryState, 'ready');

  crossOrigin = true;
  const file = path.join(root, 'download.png');
  await transport.downloadTo(origin + '/download', file, { timeoutMs: 3000 });
  assert.deepEqual(fs.readFileSync(file), FAKE_PNG); assert.equal(targets.at(-1).method, 'GET');
  assert.equal(fallbackSubmits, 0);
  console.log(`Submission redirects: ${coreChecks} actual Core Task/Attempt checks, ${mappedChecks} DashScope/vision transport checks, upload rejection, zero second-hop/failover POSTs and valid generation/download controls OK`);
} finally {
  await runtime.dispose();
  server.closeAllConnections(); other.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => other.close(resolve))]);
}
