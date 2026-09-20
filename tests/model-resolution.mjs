import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import * as models from '../lib/models.js';
import { imageCandidatesFromCatalog } from '../lib/provider-catalog.js';

useTempDshHome('iris-model-resolution');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const provider = config.upsert({
  enabled: true, auth: 'none', baseUrl: 'https://fixture.example/v1',
  models: [{ id: 'custom-image', capabilities: ['image-gen'] }]
});
assert.equal(models.resolveModelRef(provider, 'image-gen', 'custom-image'), models.modelRef(provider.id, 'custom-image'));
assert.equal(models.resolveModelRef(provider, 'image-gen', models.modelRef(provider.id, 'custom-image')), models.modelRef(provider.id, 'custom-image'));
assert.equal(models.resolveModelRef(provider, 'image-gen', 'absent'), null);
assert.equal(models.resolveModelRef(provider, 'tts'), null);
assert.equal(models.resolveModelRef({ ...provider, models: [], imageModel: 'custom-image' }, 'image-gen'), null);
assert.equal(models.resolveModelRef({ ...provider, models: undefined, imageModel: 'legacy' }, 'image-gen'), models.modelRef(provider.id, 'legacy'));
assert.equal(models.providerModels({ id: 'bare', baseUrl: 'https://dashscope.aliyuncs.com/v1' }).length, 0,
  'runtime selection must not inject vendor models');
const legacy = config.upsert({ enabled: true, apiKey: 'fixture', baseUrl: 'https://dashscope.aliyuncs.com/v1' });
assert.ok(legacy.models.length > 0, 'legacy bare account migration is materialized in configuration');
const stored = JSON.parse(fs.readFileSync(path.join(config.irisHome(), 'providers.json'), 'utf8'));
assert.deepEqual(stored.providers.find((p) => p.id === legacy.id).models, legacy.models);
config.removeProvider(legacy.id);
const catalog = { providers: config.allProviders(), assignments: config.assignments() };
assert.equal(imageCandidatesFromCatalog(catalog, 'custom-image')[0].modelRef, models.modelRef(provider.id, 'custom-image'));
assert.deepEqual(imageCandidatesFromCatalog(catalog).map((r) => r.modelRef),
  config.pickAllFor('image-gen').map((p) => models.resolveModelRef(p, 'image-gen')));
const second = config.upsert({
  auth: 'none', baseUrl: 'https://second.example/v1',
  models: [{ id: 'custom-image', capabilities: ['image-gen'] }, { id: 'second-image', capabilities: ['image-gen'] }]
});
config.setAssignmentOrder('image-gen', [models.modelRef(second.id, 'second-image'), models.modelRef(provider.id, 'custom-image')]);
const ordered = { providers: config.allProviders(), assignments: config.assignments() };
assert.deepEqual(imageCandidatesFromCatalog(ordered).map((r) => r.modelRef),
  config.pickAllFor('image-gen').map((p) => models.resolveModelRef(p, 'image-gen')),
  'multiple providers and models must have the same assignment/fallback order');
assert.equal(imageCandidatesFromCatalog(ordered, 'custom-image')[0].provider.id, provider.id,
  'a bare duplicate name uses provider configuration order');
config.load().assignments['image-gen'] = [{ providerId: second.id, id: 'second-image' }];
assert.deepEqual(imageCandidatesFromCatalog({ providers: config.allProviders(), assignments: config.assignments() }).map((r) => r.modelRef),
  config.pickAllFor('image-gen').map((p) => models.resolveModelRef(p, 'image-gen')),
  'legacy assignment objects and implicit enabled must resolve identically');
let calls = 0;
const originalFetch = global.fetch;
global.fetch = async () => { calls++; throw new Error('unexpected network'); };
try {
  await assert.rejects(runAction({}, 'image', { prompt: 'fixture', model: 'absent' }), /模型/);
  assert.equal(calls, 0, 'an undeclared bare model must be rejected before submitting');
} finally { global.fetch = originalFetch; }
console.log('Model resolution: explicit authority, reference parity, persisted migration and zero-network rejection passed');
