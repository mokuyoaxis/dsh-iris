import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createReadClient } from '../lib/web/transport.js';
import { createMediaClient } from '../lib/web/media-client.js';
import { presentReadOnlyFlow, presentFlow } from '../lib/web/flow-view.js';
import { schemaFieldSpecs, collectSchemaFormInput } from '../lib/web/plugin-op-form.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { AUDIO_WAV } from './fixtures/audio-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-web-plugin-op-form');
const dataRoot = path.join(root, 'core');
const outboxDir = path.join(root, 'outbox');
fs.mkdirSync(outboxDir, { mode: 0o700 });
const uuid = () => crypto.randomUUID();

// 1. Unit tests for Host-Owned Schema Auto Form projection & validation!
{
  const specs = schemaFieldSpecs({
    artifactInputs: ['primaryId', 'items'],
    artifactInputTypes: { primaryId: ['audio', 'text'], items: ['image'] },
    inputSchema: {
      type: 'object',
      properties: {
        primaryId: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$', title: 'Primary Media' },
        items: { type: 'array', items: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' }, minItems: 1, maxItems: 4, uniqueItems: true },
        mode: { type: 'string', enum: ['fast', 'accurate'], default: 'fast' },
        columns: { type: 'integer', minimum: 1, maximum: 8 },
        ratio: { type: 'number', minimum: 0.1, maximum: 10 },
        enabled: { type: 'boolean' },
        note: { type: 'string', minLength: 2, maxLength: 100 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 3 }
      },
      required: ['primaryId', 'items', 'columns'],
      additionalProperties: false
    }
  });
  assert.equal(specs.length, 8);
  assert.equal(specs[0].isArtifact, true);
  assert.deepEqual(specs[0].allowedMediaKinds, ['audio', 'text']);
  assert.equal(specs[1].isArtifactArray, true);
  assert.deepEqual(specs[1].allowedMediaKinds, ['image']);

  const art1 = 'artifact_' + 'a'.repeat(24), art2 = 'artifact_' + 'b'.repeat(24);
  const collected = collectSchemaFormInput(specs, {
    primaryId: art1, items: [art1, art2], mode: 'accurate', columns: '3', ratio: '1.5',
    enabled: true, note: '', tags: '["alpha", "beta"]'
  });
  assert.deepEqual(collected, {
    primaryId: art1, items: [art1, art2], mode: 'accurate', columns: 3, ratio: 1.5,
    enabled: true, tags: ['alpha', 'beta']
  });
  assert(!('note' in collected), 'optional empty string omitted cleanly');

  // Legacy operation without artifactInputTypes defaults to ['image']!
  const legacySpecs = schemaFieldSpecs({
    artifactInputs: ['artifactIds'],
    inputSchema: { type: 'object', properties: { artifactIds: { type: 'array', items: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' } } }, required: ['artifactIds'], additionalProperties: false }
  });
  assert.deepEqual(legacySpecs[0].allowedMediaKinds, ['image']);

  // Validation failures!
  assert.throws(() => collectSchemaFormInput(specs, { primaryId: '', items: [art1], columns: '2' }), /不能为空/);
  assert.throws(() => collectSchemaFormInput(specs, { primaryId: 'bad-id', items: [art1], columns: '2' }), /作品 ID/);
  assert.throws(() => collectSchemaFormInput(specs, { primaryId: art1, items: [art1, art1], columns: '2' }), /重复/);
  assert.throws(() => collectSchemaFormInput(specs, { primaryId: art1, items: [art1], columns: '99' }), /不能大于 8/);
  assert.throws(() => collectSchemaFormInput(specs, { primaryId: art1, items: [art1], columns: '2.5' }), /整数/);
  assert.throws(() => collectSchemaFormInput(specs, { primaryId: art1, items: [art1], columns: '2', enabled: 'false' }), /布尔值/);

  // Blocker #3 regression: typed enum (boolean/number), const, nested object, anyOf, array of object!
  const typedSpecs = schemaFieldSpecs({
    inputSchema: {
      type: 'object',
      properties: {
        strict: { type: 'boolean', enum: [false, true], title: '严格模式' },
        level: { type: 'integer', enum: [1, 2, 4], title: '档位' },
        fixedOff: { const: false, title: '固定关' },
        nested: { type: 'object', properties: { tag: { type: 'string' }, weight: { type: 'integer' } }, additionalProperties: false, title: '嵌套选项' },
        records: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }, minItems: 1, title: '对象数组' },
        flexible: { anyOf: [{ type: 'string' }, { type: 'integer' }], title: '多态字段' }
      },
      required: ['strict', 'level', 'fixedOff', 'nested'],
      additionalProperties: false
    }
  });
  assert.equal(typedSpecs.find(s => s.name === 'nested').isStructured, true);
  assert.equal(typedSpecs.find(s => s.name === 'records').isStructured, true);
  assert.equal(typedSpecs.find(s => s.name === 'flexible').isStructured, true);
  const typedCollected = collectSchemaFormInput(typedSpecs, {
    strict: false, level: 2, fixedOff: false,
    nested: '{"tag":"iris","weight":3}',
    records: '[{"id":"r1"}]',
    flexible: '42'
  });
  assert.strictEqual(typedCollected.strict, false, 'boolean enum false must NEVER coerce to true');
  assert.strictEqual(typedCollected.level, 2);
  assert.strictEqual(typedCollected.fixedOff, false);
  assert.deepEqual(typedCollected.nested, { tag: 'iris', weight: 3 });
  assert.deepEqual(typedCollected.records, [{ id: 'r1' }]);
  assert.strictEqual(typedCollected.flexible, 42);
  assert.throws(() => collectSchemaFormInput(typedSpecs, { strict: 'false', level: 2, fixedOff: false, nested: '{}' }), /允许的选项/);
  assert.throws(() => collectSchemaFormInput(typedSpecs, { strict: false, level: 2, fixedOff: false, nested: '{bad json' }), /有效的 JSON/);
  assert.throws(() => collectSchemaFormInput(typedSpecs, { strict: false, level: 2, fixedOff: false, nested: '[1,2]' }), /JSON 对象/);

  // Lossless JSON arrays: required empty array [] accepted, leading/trailing spaces & empty strings preserved verbatim!
  const arrSpecs = schemaFieldSpecs({
    inputSchema: {
      type: 'object',
      properties: {
        labels: { type: 'array', items: { type: 'string' }, title: '标签' },
        nums: { type: 'array', items: { type: 'integer' }, uniqueItems: true, minItems: 1, title: '编号' }
      },
      required: ['labels'],
      additionalProperties: false
    }
  });
  assert.equal(arrSpecs[0].isStructured, true);
  assert.deepEqual(collectSchemaFormInput(arrSpecs, { labels: '[]' }), { labels: [] });
  assert.deepEqual(
    collectSchemaFormInput(arrSpecs, { labels: '["  leading", "trailing  ", "", "a\\nb"]', nums: '[1, 2]' }),
    { labels: ['  leading', 'trailing  ', '', 'a\nb'], nums: [1, 2] }
  );
  assert.throws(() => collectSchemaFormInput(arrSpecs, { labels: '' }), /不能为空/);
  assert.throws(() => collectSchemaFormInput(arrSpecs, { labels: '[123]' }), /类型必须是 string/);
  assert.throws(() => collectSchemaFormInput(arrSpecs, { labels: '[]', nums: '[]' }), /至少需要 1 项/);
  assert.throws(() => collectSchemaFormInput(arrSpecs, { labels: '[]', nums: '[1, 1]' }), /重复/);
  assert.throws(() => collectSchemaFormInput(arrSpecs, { labels: '[]', nums: '[1, "2"]' }), /类型必须是 integer/);

  // Artifact ID array empty-value semantics follow minItems (0 or omitted allows [], >=1 requires selection)!
  const artArrSpecs = schemaFieldSpecs({
    artifactInputs: ['zeroAllowed', 'defaultZero', 'atLeastOne', 'optZero'],
    inputSchema: {
      type: 'object',
      properties: {
        zeroAllowed: { type: 'array', items: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' }, minItems: 0, title: '允许空作品集' },
        defaultZero: { type: 'array', items: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' }, title: '默认可空作品集' },
        atLeastOne: { type: 'array', items: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' }, minItems: 1, title: '至少选一作品' },
        optZero: { type: 'array', items: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' }, minItems: 0, title: '可选作品集' }
      },
      required: ['zeroAllowed', 'defaultZero', 'atLeastOne'],
      additionalProperties: false
    }
  });
  assert.deepEqual(
    collectSchemaFormInput(artArrSpecs, { zeroAllowed: [], defaultZero: [], atLeastOne: [art1], optZero: [] }),
    { zeroAllowed: [], defaultZero: [], atLeastOne: [art1] }
  );
  assert.throws(
    () => collectSchemaFormInput(artArrSpecs, { zeroAllowed: [], defaultZero: [], atLeastOne: [] }),
    /至少需要 1 项/
  );
}

// 2. FlowView projection for new 0.3.3 recipes!
{
  for (const [recipe, readyTitle] of [['video-i2v/v0', '视频已就绪'], ['video-s2v/v0', '视频已就绪'], ['music/v0', '音乐已就绪']]) {
    const view = { contractVersion: 0, recipe, status: 'ready', source: null, selection: null };
    assert.equal(presentReadOnlyFlow(view).title, readyTitle);
    assert.match(presentFlow({ ...view, status: 'delivery_failed' }, ['runs.continue']).message, /不重复提交/);
  }
}

// 3. Browser transport + media-client integration against real HTTP service (video-i2v, video-s2v, music + retriedFromRunId, outbox/files)!
const config = path.join(root, 'providers.json');
fs.writeFileSync(config, JSON.stringify({
  providers: [
    {
      id: 'dash', enabled: true, apiKey: 'FAKE_KEY',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
      models: [
        { id: 'wan2.2-t2v-plus', capabilities: ['video-gen'] },
        { id: 'wan2.6-i2v', capabilities: ['video-gen'] },
        { id: 'wan2.2-s2v', capabilities: ['video-gen'] }
      ]
    },
    {
      id: 'music-p', enabled: true, apiKey: 'FAKE_KEY',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [{ id: 'song-1', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' }]
    }
  ],
  assignments: {
    'video-gen': ['dash::wan2.2-t2v-plus', 'dash::wan2.6-i2v', 'dash::wan2.2-s2v'],
    'music-gen': ['music-p::song-1']
  }
}), { mode: 0o600 });

const app = createApplicationRuntime({ dataRoot });
const nativeFetch = globalThis.fetch;
let api;
try {
  await app.execute('flow.init', {});
  await app.execute('execution.init', { video: true });
  const imgArt = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const audioArt = (await app.execute('creation.audio', { key: uuid(), bytes: AUDIO_WAV, mediaType: 'audio/wav' })).artifact;

  api = createLocalReadApi({ dataRoot, providerConfigPath: config, serveWorkbench: true, allowLocalWrites: true, outboxDir });
  const started = await api.start();
  fs.writeFileSync(path.join(outboxDir, 'exported.png'), FLOW_SOURCE);

  globalThis.fetch = (resource, options) => nativeFetch(started.origin + resource, options);
  const client = createReadClient(started.accessToken);
  const session = await client.get('/api/v0/session');
  assert.equal(session.music, true);
  assert.equal(session.outbox, true);

  // Verify transport methods
  const i2vModels = await client.getVideoModels({ mode: 'i2v' });
  assert.deepEqual(i2vModels.models.map(m => m.modelRef), ['dash::wan2.6-i2v']);
  const musicModels = await client.getMusicModels();
  assert.deepEqual(musicModels.models.map(m => m.modelRef), ['music-p::song-1']);
  const outboxFiles = await client.listOutboxFiles({ limit: 10 });
  assert.deepEqual(outboxFiles.files.map(f => f.name), ['exported.png']);

  // Verify createMediaClient for video-i2v, video-s2v, music (plus retriedFromRunId)!
  const media = createMediaClient({ client, session, origin: started.origin });
  const i2v = await media.createVideoI2v({ modelRef: 'dash::wan2.6-i2v', sourceArtifactId: imgArt.id, resolution: '720P', duration: 5 });
  assert.equal(i2v.flow.recipe, 'video-i2v/v0');
  const s2v = await media.createVideoS2v({ modelRef: 'dash::wan2.2-s2v', sourceArtifactId: imgArt.id, audioArtifactId: audioArt.id, resolution: '480P' });
  assert.equal(s2v.flow.recipe, 'video-s2v/v0');
  const m1 = await media.createMusic({ modelRef: 'music-p::song-1', prompt: 'calm rain piano', timeoutMs: 60000 });
  assert.equal(m1.flow.recipe, 'music/v0');
  // Retrying an unstarted music run must be rejected (400), never creating a dangling taskId!
  await assert.rejects(media.createMusic({ modelRef: 'music-p::song-1', prompt: 'calm rain piano', retriedFromRunId: m1.flow.id }), error => error.status === 400);

  // Reject bad inputs in media-client
  assert.throws(() => media.createVideoS2v({ modelRef: 'dash::wan2.2-s2v', sourceArtifactId: imgArt.id, audioArtifactId: audioArt.id, prompt: 'no' }), TypeError);
  assert.throws(() => media.createMusic({ modelRef: 'music-p::song-1', prompt: 'ok', retriedFromRunId: 'not-a-run' }), TypeError);

  media.close();
  client.close();
  console.log('web plugin-op-form schema + flow-view + transport + media-client for i2v/s2v/music/outbox OK');
} finally {
  globalThis.fetch = nativeFetch;
  await api?.dispose();
  await app.dispose();
}
