import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { useTempDshHome } from './test-env.js';
const { root } = useTempDshHome('iris-vision-input-management');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { modelRateLimit, recordModelRateLimit } = await import('../lib/provider-health.js');
const provider = config.upsert({ id: 'account', type: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'input-fixture-key',
  visionInput: { maxBytes: 100000, maxDimension: 400 }, models: [
    { id: 'same', capabilities: ['vision'], source: 'discovered' }, { id: 'other', capabilities: ['vision'] }
  ] });
await runAction({}, 'providers_set_model_vision_input', { id: provider.id, model_id: 'same', visionInput: { maxBytes: 50000 } });
config.mergeDiscoveredModels(provider.id, [{ id: 'same', capabilities: ['vision'] }]);
let snapshot = await runAction({}, 'providers_list', {});
let model = snapshot.providers[0].models.find(model => model.id === 'same');
assert.deepEqual(model.visionInputEffective, { maxBytes: 50000, maxDimension: 400 });
assert.deepEqual(snapshot.providers[0].models.find(model => model.id === 'other').visionInputEffective, { maxBytes: 100000, maxDimension: 400 });
const configFile = path.join(root, 'iris/v1/providers.json');
const beforeInvalid = fs.readFileSync(configFile);
await assert.rejects(runAction({}, 'providers_set_model_vision_input', { id: provider.id, model_id: 'same', visionInput: { maxBytes: -1 } }), { code: 'IRIS_CONFIG_INPUT_INVALID' });
assert.deepEqual(fs.readFileSync(configFile), beforeInvalid);
recordModelRateLimit(config.providerById(provider.id), 'same', { httpStatus: 429, reason: 'budget' });
await runAction({}, 'providers_set_model_vision_input', { id: provider.id, model_id: 'same', visionInput: null });
assert(modelRateLimit(config.providerById(provider.id), 'same'), '改预算不解除额度停用');
snapshot = await runAction({}, 'providers_list', {});
model = snapshot.providers[0].models.find(model => model.id === 'same');
assert.equal(model.visionInput, undefined); assert.equal(model.visionInputEffective.maxBytes, 100000);

const file = path.join(root, 'cli.json'), stateFile = path.join(root, 'state.json'), imagePath = path.join(root, 'input.png');
fs.writeFileSync(file, JSON.stringify({ preserved: true, providers: [
  { id: 'a', auth: 'none', baseUrl: 'https://a.invalid/v1', visionInput: { maxBytes: 100000, maxDimension: 300 },
    models: [{ id: 'same', capabilities: ['vision'] }] },
  { id: 'b', auth: 'none', baseUrl: 'https://b.invalid/v1', models: [{ id: 'same', capabilities: ['vision'] }] }
] }), { mode: 0o600 });
const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#e35' } }).png().toBuffer();
fs.writeFileSync(imagePath, png); fs.writeFileSync(stateFile, '{}');
const digest = createHash('sha256').update(png).digest('hex');
const cli = (args, expected = 0) => {
  const run = spawnSync(process.execPath, ['--import', new URL('./fixtures/headless-vision-fetch.mjs', import.meta.url).href,
    'bin/dsh-iris.js', ...args, '--provider-config', file], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, IRIS_ASYNC_FIXTURE_STATE: stateFile } });
  assert.equal(run.status, expected, run.stderr); return expected ? run : JSON.parse(run.stdout);
};
const saved = cli(['models', 'vision-input', 'a::same', '--input', '{"visionInput":{"maxDimension":200}}']);
assert.deepEqual(saved.visionInputEffective, { maxBytes: 100000, maxDimension: 200 });
assert(fs.existsSync(saved.backupPath));
assert.equal(cli(['models', 'list']).models.find(model => model.ref === 'a::same').visionInput.maxDimension, 200);
const lookInput = ['--input', JSON.stringify({ image_path: imagePath })];
cli(['vision', 'look', ...lookInput, '--model-ref', 'a::same']);
cli(['vision', 'look', ...lookInput, '--model-ref', 'b::same']);
let sent = JSON.parse(fs.readFileSync(stateFile)).vision;
assert.deepEqual(sent.map(item => item.provider), ['a.invalid', 'b.invalid']);
assert.notEqual(sent[0].imageSha256, digest); assert.equal(sent[1].imageSha256, digest, '同名跨账号不能混预算');
const location = cli(['vision', 'locate', '--input', JSON.stringify({ image_path: imagePath, target: 'red' }), '--model-ref', 'a::same']);
sent = JSON.parse(fs.readFileSync(stateFile)).vision;
assert.equal(sent.at(-1).imageSha256, sent[0].imageSha256, '定位使用同一模型预算');
assert.deepEqual(location.bbox, { found: true, x1: 4, y1: 8, x2: 80, y2: 100 });
assert.equal(location.input.sent.width, 200);
const ocr = cli(['vision', 'ocr', '--input', JSON.stringify({ image_path: imagePath, chunk_height: 300, overlap: 0 }), '--model-ref', 'a::same']);
assert.equal(ocr.status, 'complete');
assert.deepEqual(ocr.chunks.map(chunk => [chunk.input.source.height, chunk.input.sent.width, chunk.input.sent.height]), [[300, 200, 75], [200, 200, 50]]);
const beforeBad = fs.readFileSync(file);
cli(['models', 'vision-input', 'a::same', '--input', '{"visionInput":{"maxDimension":0}}'], 1);
assert.deepEqual(fs.readFileSync(file), beforeBad);
const { executeConfigCommand } = await import('../lib/provider-config-service.js');
const oldFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => Response.json({ data: [{ id: 'same', input_modalities: ['image', 'text'] }] });
  await executeConfigCommand(file, 'models.discover', { provider_id: 'a', apply: true });
} finally { globalThis.fetch = oldFetch; }
assert.equal(JSON.parse(fs.readFileSync(file)).providers[0].models[0].visionInput.maxDimension, 200);
cli(['models', 'vision-input', 'a::same', '--input', '{"visionInput":null}']);
assert.deepEqual(cli(['models', 'list']).models.find(model => model.ref === 'a::same').visionInputEffective, { maxBytes: 100000, maxDimension: 300 });
cli(['providers', 'set', '--input', '{"id":"a","visionInput":{"maxBytes":200000}}']);
assert.deepEqual(cli(['models', 'list']).models.find(model => model.ref === 'a::same').visionInputEffective, { maxBytes: 200000 });
assert.equal(cli(['config', 'check']).valid, true);
assert.equal(JSON.parse(fs.readFileSync(file)).preserved, true);
assert.equal(createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex'), digest);
console.log('PASS 视觉预算管理：DSH 保存/发现/恢复继承/耗尽隔离、CLI 私有备份/列表/跨账号请求/定位原图映射/非法值零写入');
