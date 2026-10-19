import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
import { FAKE_WAV, createFakeLifecycleProvider } from './fixtures/fake-lifecycle-provider.mjs';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { ProviderContractError } from '../lib/provider-contract.js';

const { root } = useTempDshHome('iris-model-directory-cli');
const file = path.join(root, 'providers.json'), dataRoot = path.join(root, 'core'), log = path.join(root, 'requests.jsonl');
const preload = path.join(root, 'fetch.mjs');
const old = 'qwen3-tts-flash-2025-11-27', current = 'qwen3-tts-flash';
fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'cli', enabled: true, auth: 'none', mediaProtocol: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [old, current].map(id => ({ id, capabilities: ['tts'] })) }],
  assignments: { tts: { mode: 'auto', models: [] } } }), { mode: 0o600 });
fs.writeFileSync(preload, `import fs from 'node:fs';
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input);
 if((options.method||'GET')==='GET'){
  if(url.pathname!=='/api/v1/models')throw Error('unexpected fixture GET');
  fs.appendFileSync(process.env.IRIS_DIRECTORY_TEST_LOG,'directory\\n');
  return Response.json({output:{total:1,models:[{id:${JSON.stringify(current)},capabilities:['TTS']}]}});
 }
 const model=JSON.parse(options.body).model;
 fs.appendFileSync(process.env.IRIS_DIRECTORY_TEST_LOG,model+'\\n');
 if(model===${JSON.stringify(old)}&&process.env.IRIS_DIRECTORY_TEST_RECOVER!=='true')return Response.json({code:'NotFound.Model',message:'Model not exist.'},{status:404});
 return Response.json({output:{audio:{data:${JSON.stringify(FAKE_WAV.toString('base64'))}}}});
};`, { mode: 0o600 });
const cli = (args, recover = false, expectedStatus = 0) => {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'bin/dsh-iris.js', ...args, '--provider-config', file], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, DSH_HOME: path.join(root, 'unused-host'),
      IRIS_DIRECTORY_TEST_LOG: log, IRIS_DIRECTORY_TEST_RECOVER: String(recover) }
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  if (expectedStatus !== 0) return result;
  return JSON.parse(result.stdout);
};
const requests = () => fs.readFileSync(log, 'utf8').trim().split('\n');
const run = () => cli(['run', 'tts', '--data-root', dataRoot, '--input', JSON.stringify({ text: 'CLI directory fixture' })]);
const first = run();
assert.equal(first.task.outcome, 'succeeded');
assert.deepEqual(requests(), ['directory', old, current]);
const second = run();
assert.equal(second.task.outcome, 'succeeded');
assert.deepEqual(requests(), ['directory', old, current, 'directory', current], '新进程沿用持久阻断并核对目录');
const beforeRead = fs.readFileSync(file);
const state = cli(['capabilities', 'list']).capabilities.find(row => row.capability === 'tts');
assert.deepEqual(state.candidates, ['cli::' + current]);
cli(['models', 'list']);
assert.deepEqual(fs.readFileSync(file), beforeRead, '只读命令不改配置或同步目录');
assert.equal(requests().length, 5);
run(); assert.deepEqual(requests(), ['directory', old, current, 'directory', current, current], '重启后有效目录也不重复读取');
assert.equal(fs.readdirSync(root).filter(name => name.startsWith('providers.json.backup')).length, 0, '自动元数据不新增配置备份副本');
const restored = cli(['models', 'test', 'cli::' + old, '--capability', 'tts', '--data-root', dataRoot], true);
assert.equal(restored.passed, true);
assert.deepEqual(cli(['capabilities', 'list']).capabilities.find(row => row.capability === 'tts').candidates, ['cli::' + old, 'cli::' + current]);
assert.equal(requests().at(-1), old, '恢复实测只调用指定模型');
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
const failedProvider = createFakeLifecycleProvider({ id: 'cli', capabilities: ['tts'], submitSteps: [() => {
  throw new ProviderContractError('fixture rejected', { category: 'invalid_request', stage: 'submit', acceptance: 'not_accepted', httpStatus: 400 });
}] });
const { task: failed } = await createProviderTaskRunner(runtime).submit({ capability: 'tts',
  candidates: [{ adapter: failedProvider.adapter, model: 'cli::' + old }], providerInput: { text: 'fixture' } });
await runtime.dispose();
const oldTaskFile = path.join(dataRoot, 'task-store/v0/tasks', failed.id + '.json');
const oldTaskBytes = fs.readFileSync(oldTaskFile);
const stale = JSON.parse(fs.readFileSync(file)); stale.providers[0].modelDirectory.checkedAt = '2000-01-01T00:00:00.000Z';
fs.writeFileSync(file, JSON.stringify(stale));
const beforeRetry = requests().length;
const retryArgs = ['task', 'retry', failed.id, '--data-root', dataRoot, '--input', JSON.stringify({ text: 'retry fixture' })];
const denied = cli(retryArgs, true, 1);
assert.match(denied.stderr, /IRIS_COMMAND_BILLING_CONFIRM_REQUIRED/);
assert.equal(requests().length, beforeRetry, '计费未确认时连目录也不查询');
cli([...retryArgs, '--confirm-billing'], true);
assert.deepEqual(requests().slice(beforeRetry), ['directory', old], '计费确认后为新任务刷新目录，仍按原顺序执行');
assert.deepEqual(fs.readFileSync(oldTaskFile), oldTaskBytes, '重试不修改旧Task');
console.log('PASS 真实CLI新进程：目录/404持久化、后续跳过、只读零请求、缓存、无额外备份和单项恢复');
