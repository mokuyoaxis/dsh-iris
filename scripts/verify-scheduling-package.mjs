// Actual candidate CLI/MCP with a local HTTP provider. Does not install dependencies or call paid services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { stdioMcpClient } from '../tests/fixtures/mcp-client.mjs';
import { FAKE_PNG } from '../tests/fixtures/fake-lifecycle-provider.mjs';

const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === '--package-root' && args[2] === '--output' && path.isAbsolute(args[1]) && path.isAbsolute(args[3]),
  'Usage: --package-root <absolute-unpacked-package> --output <new-absolute-directory>');
const sourceRoot = args[1], out = args[3], execute = promisify(execFile), key = () => crypto.randomUUID();
fs.mkdirSync(out, { mode: 0o700 });
const cli = path.join(sourceRoot, 'bin/dsh-iris.js'), dataRoot = path.join(out, 'core'), config = path.join(out, 'providers.json'), policy = path.join(out, 'scheduler.json');
const { inspectCoreWriterLease } = await import(pathToFileURL(path.join(sourceRoot, 'lib/core-runtime.js')));
const { inspectExecutionLease } = await import(pathToFileURL(path.join(sourceRoot, 'lib/operation-runner.js')));
const report = { status: 'running', sourceRoot, paidCalls: 0, freshDependencyInstall: false, checks: [], cliProcesses: 0, submits: 0, peakProviderHttp: 0 };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const parse = value => { assert(!value.isError, JSON.stringify(value)); return value.structuredContent || JSON.parse(value.content.find(item => item.type === 'text').text); };
let service, serviceExit, serviceClosed = false, client, started, active = 0;
const provider = http.createServer(async (req, res) => {
  for await (const unused of req) { /* Consume the synthetic request. */ }
  report.submits++; active++; report.peakProviderHttp = Math.max(report.peakProviderHttp, active);
  await delay(200);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: '![fixture](data:image/png;base64,' + FAKE_PNG.toString('base64') + ')' } }] })); active--;
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
async function command(values, label) {
  report.cliProcesses++;
  const result = await execute(process.execPath, [cli, ...values], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '' } });
  fs.writeFileSync(path.join(out, label + '.log'), result.stdout + result.stderr, { mode: 0o600 });
  return JSON.parse(result.stdout);
}
async function start(pair) {
  const tokenFile = path.join(out, 'owner-' + key()); let output = '', stderr = ''; serviceClosed = false;
  service = spawn(process.execPath, [cli, 'api', 'serve', '--data-root', dataRoot, '--provider-config', config, '--allow-execution',
    '--scheduler-config', policy, '--token-file', tokenFile, '--connections-file', pair.serverFile], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '' }
  }); report.cliProcesses++;
  service.stdout.on('data', bytes => { output += bytes; }); service.stderr.on('data', bytes => { stderr += bytes; });
  serviceExit = new Promise(resolve => service.once('close', (code, signal) => { serviceClosed = true; resolve({ code, signal }); }));
  const deadline = performance.now() + 15000;
  while (!output.includes('\n') && !serviceClosed && performance.now() < deadline) await delay(10);
  assert(output.includes('\n'), 'candidate CLI startup failed: ' + stderr);
  started = { ...JSON.parse(output.split('\n')[0]), accessToken: fs.readFileSync(tokenFile, 'utf8').trim() };
  const connection = JSON.parse(fs.readFileSync(pair.clientFile));
  fs.writeFileSync(pair.clientFile, JSON.stringify({ ...connection, origin: started.origin }), { mode: 0o600 });
  client = stdioMcpClient(cli, pair.clientFile, 'read,create,execute,stop'); report.cliProcesses++;
  await client.initialize();
  service.once('close', () => fs.writeFileSync(path.join(out, 'service-' + report.cliProcesses + '.stderr.log'), stderr, { mode: 0o600 }));
}
async function stop() {
  if (client) { assert.equal((await client.close()).status, 0); client = null; }
  if (service && !serviceClosed) {
    service.kill('SIGTERM'); const stopped = await serviceExit;
    if (process.platform === 'win32') assert.equal(stopped.signal, 'SIGTERM'); else assert.equal(stopped.code, 143);
    assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent'); assert.equal(inspectExecutionLease(dataRoot).status, 'absent');
  }
}
async function session() {
  const response = await fetch(started.origin + '/api/v0/session', { headers: { Authorization: 'Bearer ' + started.accessToken } });
  assert.equal(response.status, 200); return response.json();
}
try {
  save();
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'p', auth: 'none', mediaProtocol: 'openai-chat-images',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: ['a', 'b'].map(id => ({ id, capabilities: ['image-gen'] })) }],
    assignments: { 'image-gen': ['p::a', 'p::b'] } }), { mode: 0o600 });
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, httpConcurrency: 2, requestsPerSecond: 100, remoteLimit: 4 }), { mode: 0o600 });
  const originalPolicy = fs.readFileSync(policy);
  await command(['flow', 'init', '--data-root', dataRoot], 'flow-init');
  await command(['execution', 'init', '--data-root', dataRoot, '--image-generation'], 'execution-init');
  const pair = await command(['connection', 'create', '--data-root', dataRoot, '--directory', path.join(out, 'connection'), '--origin', 'http://127.0.0.1:1',
    '--label', 'Candidate scheduling MCP', '--scopes', 'read,create,execute,stop', '--capabilities', 'image-generate'], 'connection-init');
  await start(pair); assert.equal((await session()).scheduling.limits.httpConcurrency, 2);
  const flows = [];
  for (const model of ['a', 'b']) flows.push(parse(await client.call('iris_core_create_generation', { key: key(), modelRef: `p::${model}`, prompt: 'candidate scheduler fixture' })).flow);
  const calls = flows.map(flow => ({ key: key(), runId: flow.id, expectedRevision: flow.revision }));
  const operations = await Promise.all(calls.map(call => client.call('iris_core_continue', call).then(parse)));
  for (const result of operations) {
    let operation;
    for (let i = 0; i < 150; i++) {
      operation = parse(await client.call('iris_core_operation', { operationId: result.operation.id })).operation;
      if (!['queued', 'running'].includes(operation.state)) break;
      await delay(10);
    }
    assert.equal(operation.state, 'succeeded');
  }
  assert.equal(report.submits, 2); assert.equal(report.peakProviderHttp, 2);
  const { readCoreArtifactBytes } = await import(pathToFileURL(path.join(sourceRoot, 'lib/core-artifacts.js')));
  for (const flow of flows) {
    const view = parse(await client.call('iris_core_run', { runId: flow.id }));
    assert.equal(view.task.attemptCount, 1);
    const image = (await client.call('iris_core_image', { artifactId: view.output.artifactId })).content.find(item => item.type === 'image');
    assert.deepEqual(Buffer.from(image.data, 'base64'), FAKE_PNG);
    assert.deepEqual(readCoreArtifactBytes(dataRoot, view.output.artifactId).bytes, FAKE_PNG);
  }
  assert.equal((await session()).scheduling.httpActive, 0);
  report.checks.push('actual candidate CLI policy and real stdio MCP submit two concurrent HTTP generations and return exact saved images'); save();
  await stop(); await start(pair);
  for (let i = 0; i < calls.length; i++) assert.equal(parse(await client.call('iris_core_continue', calls[i])).operation.id, operations[i].operation.id);
  assert.equal(report.submits, 2); assert.deepEqual(fs.readFileSync(policy), originalPolicy);
  report.checks.push('actual candidate service/bridge restart and original UUID replay issue no new POST or policy rewrite');
  await stop(); report.status = 'passed'; save(); console.log(JSON.stringify(report));
} catch (error) { report.status = 'failed'; report.failure = error.stack; save(); throw error; }
finally { if (client) await client.kill(); if (service && !serviceClosed) { service.kill('SIGTERM'); await serviceExit; } provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
