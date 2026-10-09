import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
const { root } = useTempDshHome('iris-chat-edit-cli');
const file = path.join(root, 'providers.json'), state = path.join(root, 'calls.jsonl'), dataRoot = path.join(root, 'core');
fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'gateway', baseUrl: 'https://gateway.fixture.invalid/v1',
  apiKey: 'chat-cli-fixture-key', mediaProtocol: 'openai-images', models: [
    { id: 'ordinary', capabilities: ['image-gen'] },
    { id: 'gemini-image', capabilities: ['image-gen'], imageProtocol: 'openai-chat-images' },
    { id: 'flash', capabilities: ['vision'] }
  ] }], assignments: { 'image-gen': ['gateway::ordinary', 'gateway::gemini-image'] } }), { mode: 0o600 });
const calls = () => fs.existsSync(state) ? fs.readFileSync(state, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
function cli(args, mode = '', status = 0) {
  const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/chat-image-fetch.mjs', import.meta.url).href,
    'bin/dsh-iris.js', ...args, ...(args[0] === 'artifact' ? [] : ['--provider-config', file])], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, IRIS_CHAT_FIXTURE_STATE: state, IRIS_CHAT_FIXTURE_MODE: mode } });
  assert.equal(result.status, status, result.stderr);
  assert(!result.stdout.includes('chat-cli-fixture-key') && !result.stderr.includes('chat-cli-fixture-key'));
  return result.stdout.trim() ? JSON.parse(result.stdout) : result;
}
const generate = input => cli(['run', 'image', '--data-root', dataRoot, '--input', JSON.stringify(input)]);
const initial = generate({ prompt: 'Draw a red rectangle', model_ref: 'gateway::gemini-image' });
const sourceId = initial.task.artifactIds[0];
const edited = generate({ prompt: 'Make the rectangle green', source_artifact_id: sourceId });
assert.equal(edited.task.deliveryState, 'ready'); assert.equal(edited.task.sourceArtifactId, sourceId);
assert.equal(edited.task.modelRef, 'gateway::gemini-image'); assert.equal(edited.task.attempts.length, 1);
assert.equal(calls().length, 2, '编辑池跳过普通 Images 模型');
assert.equal(calls()[1].inputText, 'Make the rectangle green');
assert.equal(calls()[1].inputMediaType, 'image/jpeg'); assert.equal(calls()[1].imageHashMatches, true);
assert.equal(calls()[1].stream, false);
const id = edited.task.artifactIds[0];
const artifact = cli(['artifact', 'inspect', id, '--data-root', dataRoot]).artifact;
assert.deepEqual(artifact.relations, [{ type: 'derived-from', artifactId: sourceId }]);
const look = cli(['vision', 'look', '--data-root', dataRoot, '--model-ref', 'gateway::flash', '--input', JSON.stringify({ artifact_id: id })]);
assert.equal(look.artifactId, id); assert.equal(calls().at(-1).imageHashMatches, true);
const before = calls().length;
cli(['run', 'image', '--data-root', dataRoot, '--input', JSON.stringify({ prompt: 'edit', source_artifact_id: sourceId, model_ref: 'gateway::ordinary' })], '', 1);
assert.equal(calls().length, before, '显式不支持改图的协议零 HTTP');
assert.equal(cli(['artifact', 'list', '--data-root', dataRoot]).total, 2, '原图和修改版各有独立 ID');
const unknown = cli(['run', 'image', '--data-root', dataRoot, '--input', JSON.stringify({ prompt: 'edit', source_artifact_id: sourceId })], 'text');
assert.equal(unknown.task.acceptance, 'unknown'); assert.equal(unknown.task.sourceArtifactId, sourceId);
assert.equal(calls().length, before + 1, '纯文字不重新生成');
console.log('PASS 聊天改图 CLI：源 Artifact 原 MIME/字节、独立产物与关系、混合协议过滤、按 ID 看图、未知零重提');
