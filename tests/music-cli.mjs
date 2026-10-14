import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-music-cli-'));
const file = path.join(base, 'providers.json'), stateFile = path.join(base, 'fixture.json'), root = path.join(base, 'core');
const home = path.join(base, 'unused-home');
fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'gateway', baseUrl: 'https://music.fixture.invalid/v1',
  apiKey: 'fixture-music-key', mediaProtocol: 'openai-responses-images', models: [
    { id: 'gemini-image', capabilities: ['image-gen'] },
    { id: 'gemini-music', capabilities: ['music-gen'] },
    { id: 'unassigned', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' }
  ] }], assignments: { 'image-gen': ['gateway::gemini-image'] }, other: { keep: true } }), { mode: 0o600 });
fs.chmodSync(file, 0o600);
fs.writeFileSync(stateFile, JSON.stringify({ calls: 0, statuses: [] }));
const read = () => JSON.parse(fs.readFileSync(file));
const state = () => JSON.parse(fs.readFileSync(stateFile));
function cli(args, expected = 0) {
  const child = spawnSync(process.execPath, ['--import', new URL('./fixtures/music-fetch.mjs', import.meta.url).href,
    'bin/dsh-iris.js', ...args], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DSH_HOME: home, IRIS_MUSIC_FIXTURE_STATE: stateFile } });
  assert.equal(child.status, expected, child.stderr + child.stdout);
  assert(!child.stdout.includes('fixture-music-key'));
  return child.stdout.trim() ? JSON.parse(child.stdout) : child;
}
const runArgs = input => ['run', 'music', '--data-root', root, '--provider-config', file, '--input', JSON.stringify(input)];
try {
  cli(['models', 'music-protocol', 'gateway::gemini-music', '--provider-config', file,
    '--input', '{"musicProtocol":"gemini-web-music"}']);
  assert.equal(read().providers[0].mediaProtocol, 'openai-responses-images');
  assert.equal(read().providers[0].models[1].musicProtocol, 'gemini-web-music');
  cli(runArgs({ prompt: 'fixture' }), 1);
  assert.equal(state().calls, 0, '未分配模型时零请求');
  cli(['assignments', 'set', '--provider-config', file, '--input',
    '{"capability":"music-gen","model_refs":["gateway::gemini-music"]}']);
  cli(runArgs({ prompt: 'fixture', model_ref: 'gateway::unassigned' }), 1);
  assert.equal(state().calls, 0);
  const listed = cli(['models', 'list', '--provider-config', file]);
  assert.equal(listed.models.find(model => model.id === 'gemini-music').musicProtocol, 'gemini-web-music');
  assert.equal(cli(['config', 'check', '--provider-config', file]).valid, true);
  fs.writeFileSync(stateFile, JSON.stringify({ calls: 0, statuses: [502, 200] }));
  const result = cli(runArgs({ prompt: 'fixture music', retry_delay_ms: 0 }));
  assert.equal(result.task.capability, 'music');
  assert.equal(result.task.deliveryState, 'ready');
  assert.equal(result.retries, 1);
  assert.equal(result.taskIds.length, 2);
  assert.equal(state().calls, 2);
  const id = result.task.artifactIds[0];
  const inspected = cli(['artifact', 'inspect', id, '--data-root', root]);
  assert.equal(inspected.artifact.mediaType, 'audio/wav');
  assert.equal(inspected.artifact.metadata.capability, 'music');
  const output = path.join(base, 'music.wav');
  cli(['artifact', 'export', id, '--data-root', root, '--output', output]);
  assert.deepEqual(fs.readFileSync(output), FAKE_WAV);
  const old = cli(['task', 'inspect', result.taskIds[0], '--data-root', root]);
  assert.equal(old.task.lastError.httpStatus, 502);
  const retried = cli(['task', 'retry', old.task.id, '--data-root', root, '--provider-config', file,
    '--input', '{"prompt":"fixture retry"}', '--confirm-billing']);
  assert.equal(retried.task.deliveryState, 'ready');
  assert.equal(retried.task.retriedFrom, old.task.id);
  const beforeProbe = state().calls;
  assert.equal(cli(['models', 'test', 'gateway::gemini-music', '--provider-config', file, '--capability', 'music-gen']).skipped, true);
  assert.equal(state().calls, beforeProbe);
  fs.writeFileSync(stateFile, JSON.stringify({ calls: beforeProbe, statuses: [502, 502] }));
  const failed = cli(runArgs({ prompt: 'fixture failure', retry_502: 1, retry_delay_ms: 0 }), 1);
  assert.equal(failed.task.lastError.httpStatus, 502);
  assert.equal(failed.retries, 1);
  assert.deepEqual(read().other, { keep: true });
  assert.deepEqual(read().assignments['image-gen'], ['gateway::gemini-image']);
  assert.equal(fs.existsSync(home), false, 'headless 不初始化个人DSH配置');
  console.log('PASS Music CLI：协议配置、严格分配、502重试、跨进程读取/导出/知情重试、失败退出码和零探测');
} finally { fs.rmSync(base, { recursive: true, force: true }); }
