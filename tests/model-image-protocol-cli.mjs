import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
const { root } = useTempDshHome('iris-model-image-protocol-cli');
const { executeConfigCommand } = await import('../lib/provider-config-service.js');
const { recordModelRateLimit } = await import('../lib/provider-health.js');
const file = path.join(root, 'providers.json'), stateFile = path.join(root, 'state.json'), dataRoot = path.join(root, 'core');
const read = () => JSON.parse(fs.readFileSync(file));
const state = () => JSON.parse(fs.readFileSync(stateFile));
const write = value => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
write({ other: { preserved: true }, providers: [{ id: 'account', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: 'protocol-cli-fixture-key', mediaProtocol: 'dashscope', models: [
    { id: 'wan2.2-t2i-flash', capabilities: ['image-gen'], source: 'discovered' },
    { id: 'custom-image', capabilities: ['image-gen', 'vision'], source: 'discovered' }
  ] }], assignments: { 'image-gen': ['account::custom-image', 'account::wan2.2-t2i-flash'] } });
fs.writeFileSync(stateFile, JSON.stringify({ submit: 0, poll: 0, download: 0, tasks: {} }));
const cli = (args, status = 0) => {
  const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/model-image-protocol-fetch.mjs', import.meta.url).href,
    'bin/dsh-iris.js', ...args, '--provider-config', file], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, IRIS_ASYNC_FIXTURE_STATE: stateFile } });
  assert.equal(result.status, status, result.stderr);
  assert(!result.stdout.includes('protocol-cli-fixture-key'));
  return status === 0 || result.stdout.trim() ? JSON.parse(result.stdout) : result;
};

const changed = cli(['models', 'protocol', 'account::custom-image', '--input', '{"imageProtocol":"openai-images"}']);
assert.equal(changed.imageRouting.mediaProtocol, 'openai-images');
if (process.platform !== 'win32') assert.equal(fs.statSync(changed.backupPath).mode & 0o077, 0);
assert.equal(JSON.parse(fs.readFileSync(changed.backupPath)).providers[0].models[1].imageProtocol, undefined);
assert.equal(state().requests, undefined, '设置协议不发请求');
let listed = cli(['models', 'list']).models.find(model => model.id === 'custom-image');
assert.equal(listed.imageProtocol, 'openai-images'); assert.equal(listed.imageRouting.protocolInferred, false);
cli(['models', 'discover', 'account', '--apply', 'true']);
assert.equal(read().providers[0].models[1].imageProtocol, 'openai-images', '发现保留手工协议覆盖');
assert.equal(state().requests.length, 1, '发现只请求目录');

const input = JSON.stringify({ prompt: 'fixture', model_ref: 'account::custom-image' });
const generated = cli(['run', 'image', '--data-root', dataRoot, '--input', input]);
assert.equal(generated.task.deliveryState, 'ready'); assert.equal(state().images, 1); assert.equal(state().submit, 0);
assert.equal(state().requests.at(-1).pathname, '/compatible-mode/v1/images/generations');
assert.equal(state().requests.at(-1).correctAuth, true);
assert.equal(cli(['models', 'test', 'account::custom-image', '--capability', 'image-gen', '--data-root', dataRoot]).passed, true);
assert.equal(state().images, 2, '显式实测也走模型级 Images，不误用账号默认 DashScope');

// 原生异步任务经多个 CLI 进程观察/取回，必须遵循模型协议覆盖。
cli(['models', 'protocol', 'account::wan2.2-t2i-flash', '--input', '{"imageProtocol":"dashscope"}']);
cli(['providers', 'set', '--input', '{"id":"account","mediaProtocol":"openai-images"}']);
fs.writeFileSync(stateFile, JSON.stringify({ ...state(), failNextDownload: true }));
const pending = cli(['run', 'image', '--data-root', dataRoot, '--input', '{"prompt":"async fixture","model_ref":"account::wan2.2-t2i-flash"}']);
cli(['task', 'observe', pending.task.id, '--data-root', dataRoot]);
const failed = cli(['task', 'observe', pending.task.id, '--data-root', dataRoot]);
assert.equal(failed.task.outcome, 'succeeded'); assert.equal(failed.task.deliveryState, 'failed');
const beforeRecovery = state().submit;
const recovered = cli(['task', 'redeliver', failed.task.id, '--data-root', dataRoot]);
assert.equal(recovered.task.deliveryState, 'ready'); assert.equal(state().submit, beforeRecovery);
assert.equal(state().images, 2, '原任务观察没有重新调用 Images 或生成新图片');

// 改协议使旧生图验证失效，但明确耗尽不能通过换协议或恢复默认解除。
const bindingConfig = read();
recordModelRateLimit(bindingConfig.providers[0], 'custom-image', { httpStatus: 429, reason: 'budget' }); write(bindingConfig);
const beforeSetting = state().requests.length;
cli(['models', 'protocol', 'account::custom-image', '--input', '{"imageProtocol":"dashscope"}']);
cli(['models', 'protocol', 'account::custom-image', '--input', '{"imageProtocol":"auto"}']);
listed = cli(['models', 'list']).models.find(model => model.id === 'custom-image');
assert.equal(listed.imageProtocol, undefined); assert.equal(listed.imageRouting.mediaProtocol, 'openai-images');
assert.equal(listed.reason, 'budget', '协议修改不解除耗尽');
assert.equal(listed.verified['image-gen'], undefined, '旧生图实测失效');
assert.equal(state().requests.length, beforeSetting);
assert.equal(cli(['config', 'check']).valid, true);
const beforeInvalid = fs.readFileSync(file);
cli(['models', 'protocol', 'account::custom-image', '--input', '{"imageProtocol":"unknown-image-protocol"}'], 1);
assert.deepEqual(fs.readFileSync(file), beforeInvalid);
await assert.rejects(executeConfigCommand(file, 'models.add', { model_ref: 'account::invalid-image', capabilities: ['image-gen'], imageProtocol: 'bad' }), { code: 'IRIS_PROVIDER_IMAGE_PROTOCOL_INVALID' });
assert.deepEqual(fs.readFileSync(file), beforeInvalid);
cli(['models', 'add', 'account::new-image', '--input', '{"capabilities":["image-gen"],"imageProtocol":"dashscope"}']);
assert.equal(read().providers[0].models.find(model => model.id === 'new-image').imageProtocol, 'dashscope');
const invalidCatalog = read(); invalidCatalog.providers[0].models[0].imageProtocol = 'unimplemented-protocol'; write(invalidCatalog);
const invalidBytes = fs.readFileSync(file);
assert(cli(['config', 'check'], 1).issues.includes('invalid_model_image_protocol'));
assert.deepEqual(fs.readFileSync(file), invalidBytes, 'check 不修复或改写用户配置');
assert.deepEqual(read().other, { preserved: true });
console.log('PASS 模型图片协议 CLI：设置/列表/继承、私有备份、发现保留、真实 Images 请求与实测、重启 redeliver 零重提、耗尽与旧验证、非法值零写入');
