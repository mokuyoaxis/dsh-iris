import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-task-wait-'));
const config = path.join(root, 'providers.json'), stateFile = path.join(root, 'state.json'), dataRoot = path.join(root, 'core');
fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'cli', apiKey: 'fixture', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  models: [{ id: 'wan2.6-t2v', capabilities: ['video-gen'] }] }] }), { mode: 0o600 });
const cli = (args, status = 0) => {
  const result = spawnSync(process.execPath, ['--import', path.resolve('tests/fixtures/headless-vision-fetch.mjs'), 'bin/dsh-iris.js', ...args,
    '--data-root', dataRoot], { encoding: 'utf8', timeout: 10000, env: { ...process.env, IRIS_ASYNC_FIXTURE_STATE: stateFile, DSH_HOME: path.join(root, 'unused-dsh') } });
  assert.equal(result.status, status, result.stderr); return result.stdout ? JSON.parse(result.stdout) : null;
};
const providerArgs = ['--provider-config', config];
try {
  fs.writeFileSync(stateFile, JSON.stringify({ submit: 0, poll: 0, download: 0, tasks: {} }));
  const submitted = cli(['run', 'video', ...providerArgs, '--input', '{"prompt":"red"}']);
  let state = JSON.parse(fs.readFileSync(stateFile)); state.asrHang = true; fs.writeFileSync(stateFile, JSON.stringify(state));
  const timed = cli(['task', 'wait', submitted.taskId, ...providerArgs, '--timeout-ms', '200', '--poll-interval-ms', '50'], 3);
  assert.equal(timed.timedOut, true); assert.equal(timed.task.attempts.length, 1); assert.equal(timed.task.remoteTaskId, submitted.task.remoteTaskId);
  assert.equal(fs.existsSync(path.join(dataRoot, '.iris-runtime-writer-v0')), false);
  state = JSON.parse(fs.readFileSync(stateFile)); assert.equal(state.asrAborted, true); state.asrHang = false; fs.writeFileSync(stateFile, JSON.stringify(state));
  const waited = cli(['task', 'wait', submitted.taskId, ...providerArgs, '--timeout-ms', '5000', '--poll-interval-ms', '50']);
  assert.equal(waited.ready, true); assert.equal(waited.task.deliveryState, 'ready'); assert.equal(waited.task.attempts.length, 1);
  const completedState = fs.readFileSync(stateFile);
  assert.equal(cli(['task', 'wait', submitted.taskId]).ready, true);
  assert.deepEqual(fs.readFileSync(stateFile), completedState, '终态等待不能访问 Provider');
  assert.equal(JSON.parse(completedState).submit, 1);
  cli(['task', 'wait', submitted.taskId, '--timeout-ms', '0'], 1);
  assert.equal(fs.existsSync(path.join(root, 'unused-dsh')), false);
  console.log('PASS task wait：同一 Task/Attempt、超时中断在途 poll、继续观察与交付、终态无需配置/HTTP、租约释放、零重提');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
