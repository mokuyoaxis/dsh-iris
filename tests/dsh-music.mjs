import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { useTempDshHome } from './test-env.js';
import { FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';

const { cleanup } = useTempDshHome('iris-dsh-music');
const config = await import('../lib/config.js');
const { apply } = await import('./fixtures/dsh-runtime-fixture.mjs');
const { runAction } = await import('./fixtures/dsh-runtime-fixture.mjs');
const { serveApi } = await import('./fixtures/dsh-runtime-fixture.mjs');
const { coreSnapshotForDsh, stopProviderTaskWatchesForDsh } = await import('./fixtures/dsh-runtime-fixture.mjs');
const provider = config.upsert({ name: 'fixture music', apiKey: 'fixture-music-key',
  baseUrl: 'https://music.fixture.invalid/v1', mediaProtocol: 'openai-responses-images', models: [
    { id: 'gemini-image', capabilities: ['image-gen'] },
    { id: 'gemini-music', capabilities: ['music-gen'] }
  ] });
await runAction({}, 'providers_set_model_music_protocol', { id: provider.id, model_id: 'gemini-music', musicProtocol: 'gemini-web-music' });
config.setAssignmentOrder('music-gen', [provider.id + '::gemini-music']);
const registered = [], disposers = [];
const services = { tools: { register(definition) { registered.push(definition); return () => {}; } },
  skills: { register() { return () => {}; } }, webServer: { register() { return () => {}; } } };
const ctx = { tools: services.tools, skills: services.skills, get: name => services[name],
  inject(names, callback) { if (names.every(name => services[name])) callback(this); },
  effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; } };
const originalFetch = global.fetch;
let calls = 0;
global.fetch = async (url, init) => {
  assert.equal(String(url), 'https://music.fixture.invalid/v1/chat/completions');
  assert.equal(JSON.parse(init.body).model, 'gemini-music');
  calls++;
  return new Response(JSON.stringify(calls === 1 ? { error: { message: 'fixture upstream error' } }
    : { choices: [{ message: { content: '[audio](data:audio/wav;base64,' + FAKE_WAV.toString('base64') + ')' } }] }),
    { status: calls === 1 ? 502 : 200 });
};
async function request(url, body) {
  const req = new EventEmitter(); req.method = body ? 'POST' : 'GET'; req.url = url;
  const chunks = [];
  const res = new EventEmitter();
  res.headersSent = false; res.writableEnded = false; res.destroyed = false;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
  const done = new Promise(resolve => {
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); res.writableEnded = true; resolve(); };
  });
  serveApi(req, res, {});
  if (body) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
  await done;
  return { status: res.status, headers: res.headers, bytes: Buffer.concat(chunks) };
}
try {
  await apply(ctx);
  const tool = registered.find(item => item.name === 'iris_generate_music');
  assert(tool);
  const rendered = await tool.execute({ prompt: 'fixture music', retry_delay_ms: 0 }, {});
  assert.match(rendered, /重试1次/);
  assert.match(rendered, /\[♪ 音乐播放\]\(\/iris\/api\/core\/artifact\/artifact_[a-f0-9]{24}\/media\)/);
  assert.equal(calls, 2);
  const generated = await request('/iris/api/actions/music', { prompt: 'fixture API music', retry_502: 0 });
  assert.equal(generated.status, 200, generated.bytes.toString());
  const result = JSON.parse(generated.bytes);
  assert.equal(result.storage, 'core');
  const audio = await request(result.audioUrl);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers['Content-Type'], 'audio/wav');
  assert.deepEqual(audio.bytes, FAKE_WAV);
  const snapshot = await coreSnapshotForDsh();
  assert(JSON.stringify(snapshot).includes('music'));
  assert(!JSON.stringify(snapshot).includes('fixture-music-key'));
  const beforeProbe = calls;
  const skipped = await runAction({}, 'providers_test_model', { id: provider.id, model_id: 'gemini-music', capability: 'music-gen' });
  assert.equal(skipped.skipped, true); assert.equal(calls, beforeProbe);
  assert.equal(config.providerById(provider.id).mediaProtocol, 'openai-responses-images');
  config.setAssignmentOrder('music-gen', []);
  await assert.rejects(runAction({}, 'music', { prompt: 'unassigned' }), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' });
  assert.equal(calls, beforeProbe);
  console.log('PASS DSH Music：工具、GUI动作API、502重试、同源播放、Core快照、零小样本探测和图片协议隔离');
} finally {
  global.fetch = originalFetch;
  await stopProviderTaskWatchesForDsh();
  for (const dispose of disposers) dispose();
  cleanup();
}
