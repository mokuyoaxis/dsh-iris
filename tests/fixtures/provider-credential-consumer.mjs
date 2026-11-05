import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createCorePluginWorkbench } from '@mokuyoaxis/dsh-iris/plugins';

// Runs unchanged outside the repository: public package metadata, SDK, CLI and HTTP only.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-env-consumer-')); fs.chmodSync(root, 0o700);
const dataRoot = path.join(root, 'core'), config = path.join(root, 'providers.json');
const packageFile = fileURLToPath(import.meta.resolve('@mokuyoaxis/dsh-iris/package.json'));
const metadata = JSON.parse(fs.readFileSync(packageFile));
const cli = path.resolve(path.dirname(packageFile), metadata.bin['dsh-iris']);
const preload = new URL('./provider-env-fetch.mjs', import.meta.url).href;
const envName = 'IRIS_RECOVERY_TEST_' + crypto.randomUUID().replaceAll('-', '').toUpperCase();
const first = 'first-credential-fixture-' + crypto.randomUUID(), second = 'second-credential-fixture-' + crypto.randomUUID();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const requests = [], pids = [], checks = []; let origin;
const upstream = http.createServer(async (request, response) => {
  for await (const _chunk of request) { /* Drain this fixture's private prompt. */ }
  requests.push({ method: request.method, path: request.url, auth: request.headers.authorization });
  if (request.url === '/image.png') { response.setHeader('Content-Type', 'image/png'); response.end(png); return; }
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'POST' && request.url.includes('/services/aigc/')) response.end(JSON.stringify({ output: { task_id: 'original-env-task', task_status: 'PENDING' } }));
  else if (request.method === 'GET' && request.url === '/api/v1/tasks/original-env-task') response.end(JSON.stringify({ output: { task_id: 'original-env-task', task_status: 'SUCCEEDED', results: [{ url: origin + '/image.png' }] } }));
  else response.writeHead(404).end('{}');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + upstream.address().port;
const catalog = { providers: [{ id: 'media', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: envName,
  mediaProtocol: 'dashscope', models: [{ id: 'wan2.2-t2i-plus', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': ['media::wan2.2-t2i-plus'] } };
const save = value => fs.writeFileSync(config, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); save(catalog);
async function run(args, credential, expected = 0) {
  const env = { ...process.env, DSH_HOME: root, IRIS_TEST_ENV_UPSTREAM: origin, IRIS_IMPORT_WORKBENCH_CONFIG: '',
    IRIS_CORE_CONNECTION_FILE: '', IRIS_CORE_SCOPES: '', NODE_OPTIONS: '' };
  if (credential === undefined) delete env[envName]; else env[envName] = credential;
  const configArgs = args[0] === 'flow' && ['create', 'continue'].includes(args[1]) ? ['--provider-config', config] : [];
  const child = spawn(process.execPath, ['--import', preload, cli, ...args, '--data-root', dataRoot, ...configArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  pids.push(child.pid); let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const closed = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolve({ status, signal })); });
  clearTimeout(timer); assert.equal(closed.signal, null); assert.equal(closed.status, expected, stderr);
  assert(!stdout.includes(first) && !stdout.includes(second) && !stderr.includes(first) && !stderr.includes(second));
  if (expected) {
    const code = /^(IRIS_[A-Z_]+):/m.exec(stderr)?.[1]; assert(code, 'CLI must retain a locatable failure code');
    return { code };
  }
  return JSON.parse(stdout);
}
try {
  await run(['flow', 'init']); await run(['execution', 'init', '--image-generation']);
  const input = JSON.stringify({ model_ref: 'media::wan2.2-t2i-plus', prompt: 'A plain iris-coloured square', n: 1, size: '1024*1024' });
  const missing = await run(['flow', 'create', '--input', input], undefined, 1);
  assert.equal(missing.code, 'IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE');
  assert.equal((await run(['flow', 'list'])).total, 0); assert.equal(requests.length, 0);
  const created = await run(['flow', 'create', '--input', input], first), runId = created.run.id;
  const noSubmit = await run(['flow', 'continue', runId], undefined, 1);
  assert.equal(noSubmit.code, 'IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE'); assert.equal(requests.length, 0);
  checks.push('missing environment before create/continue rejects without creating a Run or sending an upstream request');
  const accepted = await run(['flow', 'continue', runId], first);
  assert.equal(accepted.task.remoteTaskId, 'original-env-task'); assert.equal(accepted.task.attempts.length, 1);
  assert.equal(requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(requests[0].auth, 'Bearer ' + first);
  const taskId = accepted.task.id, taskBefore = JSON.stringify(accepted.task);
  const unavailable = await run(['flow', 'continue', runId], undefined, 1);
  assert.equal(unavailable.code, 'IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE'); assert.equal(requests.length, 1);
  assert.equal(JSON.stringify((await run(['flow', 'inspect', runId])).task), taskBefore);
  checks.push('a real accepted Task keeps its exact record across a process restart with a missing variable, with zero extra submit/poll');
  const changed = structuredClone(catalog); changed.providers[0].baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'; save(changed);
  const drift = await run(['flow', 'continue', runId], second, 1);
  assert.equal(drift.code, 'IRIS_PROVIDER_TASK_BINDING_MISMATCH'); assert.equal(requests.length, 1);
  save({ ...catalog, assignments: { 'image-gen': { mode: 'disabled', models: [] } } });
  const completed = await run(['flow', 'continue', runId], second);
  assert.equal(completed.task.id, taskId); assert.equal(completed.task.attempts.length, 1);
  assert.equal(completed.task.deliveryState, 'ready');
  assert.equal(requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(requests.find(item => item.path === '/api/v1/tasks/original-env-task').auth, 'Bearer ' + second);
  const recovered = await run(['flow', 'continue', runId]); assert.equal(recovered.task.id, taskId); assert.equal(recovered.run.output.artifactId, completed.run.output.artifactId);
  checks.push('a new process uses the rotated key for the original remote Task; endpoint drift is blocked and disabled new-generation policy does not rebind recovery');
  for (const name of fs.readdirSync(dataRoot, { recursive: true })) {
    const target = path.join(dataRoot, name); if (!fs.statSync(target).isFile()) continue;
    const bytes = fs.readFileSync(target);
    assert(!bytes.includes(Buffer.from(first)) && !bytes.includes(Buffer.from(second)), name);
  }
  assert.equal(JSON.parse(fs.readFileSync(config)).providers[0].apiKey, undefined);
  assert(new Set(pids).size > 8);
  checks.push('independent CLI processes, stdout/stderr, original Task and all Core data contain no resolved key');
  const workbench = createCorePluginWorkbench({ dataRoot, providerConfigPath: config, allowProviderManagement: true });
  try {
    const session = await workbench.start();
    const read = async () => {
      const response = await fetch(session.origin + '/api/v0/provider-management/settings', { headers: { Authorization: 'Bearer ' + session.accessToken } });
      assert.equal(response.status, 200); const text = await response.text(); assert(!text.includes(first) && !text.includes(second)); return JSON.parse(text);
    };
    assert.equal((await read()).providers[0].credentialStatus, 'missing');
    process.env[envName] = second; assert.equal((await read()).providers[0].credentialStatus, 'ready');
    assert.equal(JSON.parse(fs.readFileSync(config)).providers[0].apiKey, undefined);
    checks.push('the public Workbench SDK projects environment readiness without returning or persisting the value');
  } finally { delete process.env[envName]; await workbench.dispose(); }
  console.log(JSON.stringify({ ok: true, checks, taskId, runId, artifactId: completed.run.output.artifactId,
    cliProcesses: pids.length, submitCount: requests.filter(item => item.method === 'POST').length,
    pollCount: requests.filter(item => item.path === '/api/v1/tasks/original-env-task').length, root }, null, 2));
} finally { await new Promise(resolve => upstream.close(resolve)); }
