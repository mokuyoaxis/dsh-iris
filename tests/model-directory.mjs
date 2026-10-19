import assert from 'node:assert/strict';
import { listModels } from '../lib/adapters.js';
import { refreshModelDirectory } from '../lib/model-directory-service.js';
import { currentModelDirectory, modelDirectoryBinding, modelDirectorySummary, MODEL_DIRECTORY_TTL_MS } from '../lib/model-directory.js';

const provider = { id: 'fixture', apiKey: 'directory-fixture-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mediaProtocol: 'dashscope', models: [{ id: 'old', capabilities: ['tts'] }] };
const originalFetch = globalThis.fetch;
const json = value => Response.json(value);
const now = Date.now();
let calls = 0;
const save = directory => { provider.modelDirectory = directory; };
try {
  const rows = [
    { id: 'speech', inference_metadata: { request_modality: ['Text'], response_modality: ['Audio'] } },
    { id: 'video-with-audio', inference_metadata: { request_modality: ['Text'], response_modality: ['Video', 'Audio'] } },
    { id: 'audio-understanding', inference_metadata: { request_modality: ['Text', 'Audio'], response_modality: ['Text'] } },
    { id: 'omni', inference_metadata: { request_modality: ['Text', 'Audio'], response_modality: ['Text', 'Audio'] } },
    { id: 'asr-explicit', capabilities: ['ASR'], inference_metadata: { request_modality: ['Audio'], response_modality: ['Text'] } }
  ];
  globalThis.fetch = async () => { calls++; return json({ output: { total: rows.length, models: rows } }); };
  const first = await refreshModelDirectory(provider, { save, now });
  assert.equal(first.refreshed, true);
  assert.equal(calls, 1);
  assert.deepEqual(provider.modelDirectory.models.find(row => row.id === 'speech').capabilities, ['tts']);
  assert.deepEqual(provider.modelDirectory.models.find(row => row.id === 'video-with-audio').capabilities, ['video-gen']);
  assert.deepEqual(provider.modelDirectory.models.find(row => row.id === 'audio-understanding').capabilities, []);
  assert.deepEqual(provider.modelDirectory.models.find(row => row.id === 'omni').capabilities, []);
  assert.deepEqual(provider.modelDirectory.models.find(row => row.id === 'asr-explicit').capabilities, ['transcribe']);
  assert(!JSON.stringify(first.directory).includes(provider.apiKey));
  assert.deepEqual(modelDirectorySummary(provider).missing, ['old']);
  await refreshModelDirectory(provider, { save, now: now + MODEL_DIRECTORY_TTL_MS - 1 });
  assert.equal(calls, 1, '有效目录不重复访问供应商');
  await refreshModelDirectory(provider, { save, now: now + MODEL_DIRECTORY_TTL_MS });
  assert.equal(calls, 2, '过期目录按需刷新');
  const lastGood = structuredClone(provider.modelDirectory);
  for (const response of [() => new Response('{bad-json'), () => json({ unexpected: [] }),
    () => json({ success: false, output: { total: 0, models: [] } }),
    () => json({ output: { total: 1, models: [{ id: {} }] } }),
    () => json({ output: { total: 'bad', models: [] } }),
    () => json({ output: { total: 2, models: [] } })]) {
    globalThis.fetch = async () => { calls++; return response(); };
    const failed = await refreshModelDirectory(provider, { force: true, save, now });
    assert.equal(failed.refreshed, false);
    assert(failed.error);
    assert.deepEqual(provider.modelDirectory.models, lastGood.models, '坏响应保留完整旧目录');
    assert.equal(provider.modelDirectory.checkedAt, lastGood.checkedAt);
  }
  let pages = 0;
  globalThis.fetch = async () => {
    pages++;
    return json({ output: { total: 101, models: pages === 1
      ? Array.from({ length: 100 }, (_, id) => ({ id: 'page-' + id })) : [] } });
  };
  assert.equal((await refreshModelDirectory(provider, { force: true, save, now })).refreshed, false);
  assert.equal(pages, 2);
  assert.deepEqual(provider.modelDirectory.models, lastGood.models, '部分分页不能发布为完整目录');
  pages = 0;
  globalThis.fetch = async () => { pages++; return json({ output: {
    total: pages === 1 ? 101 : 102,
    models: pages === 1 ? Array.from({ length: 100 }, (_, id) => ({ id: 'page-' + id })) : [{ id: 'last' }]
  } }); };
  await assert.rejects(listModels({ key: 'fixture', baseUrl: provider.baseUrl }), /分页不完整或总数变化/);
  pages = 0;
  globalThis.fetch = async () => { pages++; return json({ output: {
    ...(pages === 1 ? { total: 102 } : {}),
    models: pages === 1 ? Array.from({ length: 100 }, (_, id) => ({ id: 'page-' + id }))
      : pages === 2 ? [{ id: 'last' }] : []
  } }); };
  await assert.rejects(listModels({ key: 'fixture', baseUrl: provider.baseUrl }), /分页不完整或总数变化/, '后页不再提供total也不能截断已声明的目录');
  pages = 0;
  globalThis.fetch = async () => { pages++; return json({ output: { total: 101,
    models: pages === 1 ? Array.from({ length: 100 }, (_, id) => ({ id: 'page-' + id })) : [{ id: 'page-0' }]
  } }); };
  await assert.rejects(listModels({ key: 'fixture', baseUrl: provider.baseUrl }), /分页不完整或总数变化/, '重复分页不能冒充完整目录');
  const beforeRetry = calls;
  await refreshModelDirectory(provider, { save, now: now + 1 });
  assert.equal(calls, beforeRetry, '失败后30秒内不重复读取目录');
  globalThis.fetch = async () => { calls++; throw new Error('read failed ' + provider.apiKey); };
  const failure = await refreshModelDirectory(provider, { force: true, save, now });
  assert(!failure.error.includes(provider.apiKey), '目录错误移除当前完整密钥');
  let release, discoveries = 0;
  const discover = () => { discoveries++; return new Promise(resolve => { release = resolve; }); };
  const a = refreshModelDirectory(provider, { force: true, save, discover, now });
  const b = refreshModelDirectory(provider, { force: true, save, discover, now });
  release([{ id: 'new', capabilities: ['TTS'] }]);
  assert((await a).refreshed); assert((await b).refreshed);
  assert.equal(discoveries, 1, '同一连接的并发目录读取合并');
  assert.deepEqual(provider.models.map(model => model.id), ['old'], '快照不改变模型登记');
  assert.equal(currentModelDirectory({ ...provider, apiKey: 'rotated-key' }), null);
  assert.equal(currentModelDirectory({ ...provider, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }), null);
  assert.notEqual(modelDirectoryBinding(provider), modelDirectoryBinding({ ...provider, id: 'other-account' }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(refreshModelDirectory(provider, { force: true, save, discover, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(discoveries, 1, '预取消不发现或保存');
  const unchanged = JSON.stringify(provider.modelDirectory);
  const changed = await refreshModelDirectory(provider, { force: true, now,
    discover: async () => ['replacement'], save: () => false });
  assert.equal(changed.refreshed, false);
  assert.match(changed.error, /连接.*变化/);
  assert.equal(JSON.stringify(provider.modelDirectory), unchanged);
  const failedChange = await refreshModelDirectory(provider, { force: true, now,
    discover: async () => { throw new Error('failed outdated request'); }, save: () => false });
  assert.match(failedChange.error, /连接.*变化/);
  assert.equal(failedChange.directory, undefined, '失败响应同样不能回传已失效连接的快照');
  const empty = await refreshModelDirectory(provider, { force: true, save, discover: async () => [], now });
  assert.equal(empty.refreshed, true, '明确完整空目录可以保存，但不删除用户模型');
  assert.deepEqual(provider.models.map(model => model.id), ['old']);
  const legacy = { ...provider, ttsModel: 'legacy-only-model', visionModel: 'legacy-only-model' };
  delete legacy.models;
  assert.deepEqual(modelDirectorySummary(legacy).missing, ['legacy-only-model'], '旧字段绑定也显示未列出，同名绑定不重复统计');
  assert.deepEqual(modelDirectorySummary({ ...legacy, models: [] }).missing, [], '明确空模型数组仍优先于旧字段');
} finally { globalThis.fetch = originalFetch; }
console.log('PASS 目录完整性、模态边界、TTL、失败保留/退避、并发合并、连接隔离、取消与空目录');
