import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-headless-provider-'));
const dataRoot = path.join(base, 'core');
const configFile = path.join(base, 'providers.json');
const requestFile = path.join(base, 'request.json');
let server;

function assert(condition, message, detail) {
  if (!condition) throw new Error(message + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
}

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline >= 0) resolve(text.slice(0, newline));
    });
    stream.on('error', reject);
  });
}

try {
  server = spawn(process.execPath, ['tests/fixtures/openai-image-server.mjs', requestFile], {
    cwd: repo, stdio: ['ignore', 'pipe', 'inherit']
  });
  const port = Number(await firstLine(server.stdout));
  assert(Number.isInteger(port) && port > 0, '本地 Provider fixture 未启动');
  fs.writeFileSync(configFile, JSON.stringify({
    version: 1,
    providers: [{
      id: 'local-provider', name: 'local', type: 'openai', enabled: true,
      baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-secret',
      mediaProtocol: 'openai-images',
      models: [{ id: 'fixture-image', capabilities: ['image-gen'] }]
    }],
    assignments: { 'image-gen': ['local-provider::fixture-image'] }
  }), { mode: 0o600 });
  const run = spawnSync(process.execPath, [
    'bin/dsh-iris.js', 'run', 'image', '--data-root', dataRoot,
    '--provider-config', configFile,
    '--input', JSON.stringify({ prompt: 'headless provider fixture', size: '1024x1024', n: 1 })
  ], { cwd: repo, encoding: 'utf8', shell: false });
  assert(run.status === 0, 'Headless Provider CLI 必须成功', { stderr: run.stderr, stdout: run.stdout });
  const result = JSON.parse(run.stdout);
  assert(result.task?.outcome === 'succeeded' && result.task?.deliveryState === 'ready'
    && result.task?.artifactIds?.length === 1, 'CLI 必须完成 Core Task/Artifact 闭环', result);
  assert(result.task.attempts[0].selectionReason === 'assignment',
    '省略 model_ref 时，assignment 首选必须作为 Attempt 事实输出', result.task.attempts[0]);
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  assert(request.method === 'POST' && request.url === '/v1/images/generations'
    && request.model === 'fixture-image', 'HTTP 只能收到原始模型 ID，不能收到复合引用', request);
  assert(!run.stdout.includes('fixture-secret') && !run.stdout.includes(configFile)
    && !run.stdout.includes(dataRoot), 'CLI 输出不得泄露凭据或本机路径');
  const inspect = spawnSync(process.execPath, [
    'bin/dsh-iris.js', 'artifact', 'inspect', result.task.artifactIds[0], '--data-root', dataRoot
  ], { cwd: repo, encoding: 'utf8', shell: false });
  assert(inspect.status === 0 && JSON.parse(inspect.stdout).artifact.size > 0,
    '后续 CLI 进程必须能检查真实 Provider 产物', inspect.stderr);
  const bare = spawnSync(process.execPath, [
    'bin/dsh-iris.js', 'run', 'image', '--data-root', dataRoot,
    '--provider-config', configFile,
    '--input', JSON.stringify({ prompt: 'bare model fixture', model_ref: 'fixture-image' })
  ], { cwd: repo, encoding: 'utf8', shell: false });
  const bareResult = JSON.parse(bare.stdout);
  assert(bare.status === 0 && bareResult.task.modelRef === 'local-provider::fixture-image'
      && bareResult.task.attempts[0].selectionReason === 'explicit',
    '裸模型名必须走同一 CLI 提交与复合身份落盘路径', bare.stderr);

  const poolConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  poolConfig.assignments = {};
  fs.writeFileSync(configFile, JSON.stringify(poolConfig), { mode: 0o600 });
  const pooled = spawnSync(process.execPath, [
    'bin/dsh-iris.js', 'run', 'image', '--data-root', dataRoot,
    '--provider-config', configFile,
    '--input', JSON.stringify({ prompt: 'pool model fixture' })
  ], { cwd: repo, encoding: 'utf8', shell: false });
  const pooledResult = JSON.parse(pooled.stdout);
  assert(pooled.status === 0 && pooledResult.task.attempts[0].selectionReason === 'pool',
    '无显式模型且无 assignment 时必须持久化 pool 来源', pooled.stderr);

  console.log('ALL OK —— Headless CLI 经 Provider Adapter 完成 Core Task/Attempt/Artifact 图片闭环');
} finally {
  if (server && server.exitCode === null) server.kill('SIGTERM');
  fs.rmSync(base, { recursive: true, force: true });
}
