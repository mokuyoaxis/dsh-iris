import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
const { root } = useTempDshHome('iris-responses-image-cli');
const file = path.join(root, 'providers.json'), state = path.join(root, 'calls.jsonl'), dataRoot = path.join(root, 'core');
fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'gateway', baseUrl: 'https://gateway.fixture.invalid/v1',
  apiKey: 'responses-cli-fixture-key', mediaProtocol: 'openai-images',
  models: [{ id: 'gemini-image', capabilities: ['image-gen'] }, { id: 'flash', capabilities: ['vision'] }]
}], assignments: {} }), { mode: 0o600 });
const calls = () => fs.existsSync(state) ? fs.readFileSync(state, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
function cli(args, mode = '', status = 0) {
  const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/responses-image-fetch.mjs', import.meta.url).href,
    'bin/dsh-iris.js', ...args, ...(args[0] === 'artifact' ? [] : ['--provider-config', file])], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, IRIS_RESPONSES_FIXTURE_STATE: state, IRIS_RESPONSES_FIXTURE_MODE: mode } });
  assert.equal(result.status, status, result.stderr);
  assert(!result.stdout.includes('responses-cli-fixture-key') && !result.stderr.includes('responses-cli-fixture-key'));
  return result.stdout.trim() ? JSON.parse(result.stdout) : result;
}
assert.equal(cli(['models', 'protocol', 'gateway::gemini-image', '--input', '{"imageProtocol":"openai-responses-images"}']).imageRouting.mediaProtocol, 'openai-responses-images');
assert.equal(calls().length, 0); assert.equal(cli(['config', 'check']).valid, true);
const result = cli(['run', 'image', '--data-root', dataRoot, '--input', '{"prompt":"Draw a red rectangle","model_ref":"gateway::gemini-image"}']);
assert.equal(result.task.deliveryState, 'ready'); assert.equal(result.task.modelRef, 'gateway::gemini-image');
assert.equal(result.task.attempts.length, 1);
const id = result.task.artifactIds[0], output = path.join(root, 'generated.jpg');
assert.equal(cli(['artifact', 'export', id, '--data-root', dataRoot, '--output', output]).artifact.mediaType, 'image/jpeg');
assert.equal((await sharp(output).metadata()).format, 'jpeg'); assert.equal(calls().length, 1);
const look = cli(['vision', 'look', '--data-root', dataRoot, '--model-ref', 'gateway::flash', '--input', JSON.stringify({ artifact_id: id, question: '描述图片' })]);
assert(look.text.includes('红色')); assert.equal(look.artifactId, id);
assert.deepEqual(calls().map(call => [call.pathname, call.model, call.stream]), [
  ['/v1/responses', 'gemini-image', false], ['/v1/chat/completions', 'flash', true]
]);
assert.deepEqual(calls()[0].tool, { type: 'image_generation', action: 'generate' });
assert.deepEqual(calls()[0].toolChoice, { type: 'image_generation' });
assert.equal(calls()[0].store, false); assert.equal(calls()[0].background, false);
assert.equal(calls()[1].inputMediaType, 'image/jpeg'); assert.equal(calls()[1].imageHashMatches, true);
assert(calls().every(call => call.authMatches));
assert.equal(cli(['artifact', 'list', '--data-root', dataRoot]).total, 1);
const probe = cli(['models', 'test', 'gateway::gemini-image', '--capability', 'image-gen', '--data-root', dataRoot], 'tool');
assert.equal(probe.passed, true); assert(!('size' in calls().at(-1).tool), '实测使用默认工具尺寸');
const beforeText = calls().length;
const text = cli(['run', 'image', '--data-root', dataRoot, '--input', '{"prompt":"fixture","model_ref":"gateway::gemini-image"}'], 'text');
assert.equal(text.task.acceptance, 'unknown'); assert.equal(text.task.artifactIds.length, 0);
assert.equal(calls().length, beforeText + 1);
const beforeMultiple = calls().length;
const multiple = cli(['run', 'image', '--data-root', dataRoot, '--input', '{"prompt":"fixture","n":2,"model_ref":"gateway::gemini-image"}']);
assert.equal(multiple.task.acceptance, 'not_accepted'); assert.equal(multiple.task.artifactIds.length, 0);
assert.equal(multiple.task.attempts[0].error.category, 'invalid_request');
assert.equal(calls().length, beforeMultiple, 'CLI 多图请求不会偷偷拆成多次生成');
assert.equal(cli(['models', 'list']).models.find(model => model.id === 'gemini-image').imageProtocol, 'openai-responses-images');
console.log('PASS Responses 生图 CLI：模型协议配置/检查，网关 JPEG Artifact 与 ID 看图，官方工具实测，纯文字零重复提交，原 MIME 与字节');
