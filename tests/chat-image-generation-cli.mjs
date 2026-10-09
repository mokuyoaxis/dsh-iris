import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
const { root } = useTempDshHome('iris-chat-image-cli');
const file = path.join(root, 'providers.json'), state = path.join(root, 'calls.jsonl'), dataRoot = path.join(root, 'core');
fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'gateway', baseUrl: 'https://gateway.fixture.invalid/v1',
  apiKey: 'chat-cli-fixture-key', mediaProtocol: 'openai-images',
  models: [{ id: 'gemini-image', capabilities: ['image-gen'] }, { id: 'flash', capabilities: ['vision'] }]
}], assignments: {} }), { mode: 0o600 });
const calls = () => fs.existsSync(state) ? fs.readFileSync(state, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
function cli(args, mode = '', status = 0) {
  const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/chat-image-fetch.mjs', import.meta.url).href,
    'bin/dsh-iris.js', ...args, ...(args[0] === 'artifact' ? [] : ['--provider-config', file])], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, IRIS_CHAT_FIXTURE_STATE: state, IRIS_CHAT_FIXTURE_MODE: mode } });
  assert.equal(result.status, status, result.stderr);
  assert(!result.stdout.includes('chat-cli-fixture-key') && !result.stderr.includes('chat-cli-fixture-key'));
  return result.stdout.trim() ? JSON.parse(result.stdout) : result;
}
assert.equal(cli(['models', 'protocol', 'gateway::gemini-image', '--input', '{"imageProtocol":"openai-chat-images"}']).imageRouting.mediaProtocol, 'openai-chat-images');
assert.equal(calls().length, 0, '配置不探测接口');
assert.equal(cli(['config', 'check']).valid, true);
const result = cli(['run', 'image', '--data-root', dataRoot, '--input', '{"prompt":"Draw a red rectangle","model_ref":"gateway::gemini-image"}']);
assert.equal(result.task.deliveryState, 'ready'); assert.equal(result.task.modelRef, 'gateway::gemini-image');
assert.equal(result.task.attempts.length, 1);
const id = result.task.artifactIds[0], output = path.join(root, 'generated.jpg');
assert.equal(cli(['artifact', 'export', id, '--data-root', dataRoot, '--output', output]).artifact.mediaType, 'image/jpeg');
assert.equal((await sharp(output).metadata()).format, 'jpeg');
assert.equal(calls().length, 1, 'Artifact 导出零网络');
const look = cli(['vision', 'look', '--data-root', dataRoot, '--model-ref', 'gateway::flash', '--input', JSON.stringify({ artifact_id: id, question: '描述图片' })]);
assert(look.text.includes('红色')); assert.equal(look.artifactId, id);
assert.deepEqual(calls().map(call => [call.pathname, call.model, call.stream]), [
  ['/v1/chat/completions', 'gemini-image', false], ['/v1/chat/completions', 'flash', true]
]);
assert.equal(calls()[1].inputMediaType, 'image/jpeg'); assert.equal(calls()[1].imageHashMatches, true);
assert(calls().every(call => call.authMatches));
assert.equal(cli(['artifact', 'list', '--data-root', dataRoot]).total, 1, '按 ID 看图不增产物');
const probe = cli(['models', 'test', 'gateway::gemini-image', '--capability', 'image-gen', '--data-root', dataRoot]);
assert.equal(probe.passed, true); assert.equal(calls().at(-1).stream, false);
const beforeText = calls().length;
const text = cli(['run', 'image', '--data-root', dataRoot, '--input', '{"prompt":"fixture","model_ref":"gateway::gemini-image"}'], 'text');
assert.equal(text.task.acceptance, 'unknown'); assert.equal(text.task.artifactIds.length, 0);
assert.equal(calls().length, beforeText + 1);
assert.equal(cli(['models', 'list']).models.find(model => model.id === 'gemini-image').imageProtocol, 'openai-chat-images');
console.log('PASS 聊天生图 CLI：模型协议配置/检查、JPEG Artifact/导出、按 ID 看图的原 MIME 与字节、模型实测、纯文字零重复提交');
