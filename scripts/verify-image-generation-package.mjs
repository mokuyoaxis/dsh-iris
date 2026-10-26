// Extracted package + real CLI/MCP; reuse installed dependencies, with controlled HTTP only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stdioMcpClient } from '../tests/fixtures/mcp-client.mjs';
import { FLOW_RESULT } from '../tests/fixtures/image-flow-fixture.mjs';

const args = process.argv.slice(2);
assert(args.length === 6 && args[0] === '--package' && args[2] === '--baseline-tree' && args[4] === '--output');
assert([args[1], args[3], args[5]].every(value => path.isAbsolute(value)));
const repo = fileURLToPath(new URL('../', import.meta.url)), out = args[5], baseline = args[3];
fs.mkdirSync(out, { mode: 0o700 });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-image-generation-package-'));
const report = { status: 'running', work, checks: [], commands: [], paidCalls: 0, freshDependencyInstall: false,
  packageSha256: crypto.createHash('sha256').update(fs.readFileSync(args[1])).digest('hex') };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const processes = new Set(), children = [];
async function run(command, values, expected = 0) {
  const started = Date.now(), child = spawn(command, values, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', DSH_HOME: path.join(work, 'unused-dsh'), IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  processes.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  clearTimeout(timer); processes.delete(child);
  report.commands.push({ command, args: values, ...result, durationMs: Date.now() - started }); save();
  assert.equal(result.status, expected, stderr || stdout); return result;
}
let api, phase = 'queued', submits = 0;
const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* The tests assert delivery and call count, not server-side fake parameter validation. */ }
  const url = new URL(req.url, 'http://fixture'), send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/prompt') { submits++; phase = 'queued'; return send({ prompt_id: 'pack-task-' + submits, node_errors: {} }); }
  if (url.pathname.startsWith('/history/')) return send(phase === 'queued' ? {} : {
    [url.pathname.slice('/history/'.length)]: { status: { completed: true, status_str: 'success' }, outputs: { '9': { images: [{ filename: 'iris.png', subfolder: '', type: 'output' }] } } }
  });
  if (url.pathname === '/queue') return send({ queue_running: [], queue_pending: [[0, 'pack-task-' + submits]] });
  if (url.pathname === '/view') { res.setHeader('Content-Type', 'image/png'); return res.end(FLOW_RESULT); }
  if (url.pathname === '/system_stats') return send({ system: {} });
  res.writeHead(404); res.end();
});
const tree = directory => Object.fromEntries(fs.readdirSync(directory, { recursive: true }).map(name => {
  const stat = fs.lstatSync(path.join(directory, name));
  return [name, { mode: stat.mode & 0o777, ...(stat.isFile() ? { sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') } : {}) }];
}));
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const unpacked = path.join(work, 'archive'); fs.mkdirSync(unpacked);
  await run('tar', ['-xzf', args[1], '-C', unpacked]);
  const installed = path.join(unpacked, 'package'); fs.symlinkSync(path.join(repo, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
  const cli = path.join(installed, 'bin/dsh-iris.js'), core = path.join(work, 'core'), config = path.join(work, 'providers.json');
  const cliRun = async values => JSON.parse((await run(process.execPath, [cli, ...values])).stdout);
  const flags = ['--data-root', core], configFlags = ['--provider-config', config];
  await cliRun(['flow', 'init', ...flags]);
  assert.equal((await cliRun(['execution', 'init', ...flags, '--image-generation'])).root.schemaVersion, 2);
  await cliRun(['config', 'init', ...configFlags]);
  const workflow = { version: 0, promptNode: '6', outputNode: '9', graph: {
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'Pack workflow prompt' } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'iris' } }
  } };
  await cliRun(['providers', 'add', ...configFlags, '--input', JSON.stringify({ id: 'comfy', name: 'Package ComfyUI',
    baseUrl: 'http://127.0.0.1:' + server.address().port, auth: 'none', mediaProtocol: 'comfyui',
    models: [{ id: 'workflow', capabilities: ['image-gen'], comfyWorkflow: workflow }] })]);
  await cliRun(['assignments', 'set', ...configFlags, '--input', JSON.stringify({ capability: 'image-gen', mode: 'auto' })]);
  const created = await cliRun(['flow', 'create', ...flags, ...configFlags, '--input', JSON.stringify({ model_ref: 'comfy::workflow', prompt: 'A violet iris', n: 1 })]);
  assert.equal(created.run.recipe, 'image-generate/v0'); assert.equal(submits, 0);
  const first = await cliRun(['flow', 'continue', created.run.id, ...flags, ...configFlags]); assert.equal(first.status, 'running');
  phase = 'done'; const completed = await cliRun(['flow', 'continue', created.run.id, ...flags, ...configFlags]);
  assert.equal(completed.status, 'awaiting_selection'); assert.equal(first.task.id, completed.task.id); assert.equal(submits, 1);
  await cliRun(['flow', 'select', created.run.id, ...flags, '--input', JSON.stringify({ artifact_id: completed.run.output.artifactId })]);
  const output = path.join(work, 'output.png'); await cliRun(['flow', 'export', created.run.id, ...flags, '--output', output]);
  assert.deepEqual(fs.readFileSync(output), FLOW_RESULT);
  report.checks.push('extracted package CLI initializes v2, creates, submits once, observes, selects and exports exact bytes through native ComfyUI'); save();

  const old = path.join(work, 'old-checkpoint'); fs.mkdirSync(old);
  for (const name of ['lib', 'bin', 'package.json']) fs.cpSync(path.join(baseline, name), path.join(old, name), { recursive: true });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(old, 'node_modules'), 'dir');
  const before = tree(core), rejected = await run(process.execPath, [path.join(old, 'bin/dsh-iris.js'), 'flow', 'continue', created.run.id, ...flags, ...configFlags], 1);
  assert.match(rejected.stderr, /IRIS_CREATION_STORE_INVALID/); assert.deepEqual(tree(core), before); assert.equal(submits, 1);
  report.checks.push('actual previous checkpoint writer rejects v2 before changing business files or submitting'); save();

  const { createConnectionPair } = await import(pathToFileURL(path.join(installed, 'lib/core-connections.js')));
  const { createLocalReadApi } = await import(pathToFileURL(path.join(installed, 'lib/local-api.js')));
  const pair = createConnectionPair({ dataRoot: core, directory: path.join(work, 'pair'), origin: 'http://127.0.0.1:1', label: 'Outside package',
    scopes: ['read', 'create', 'execute', 'stop'], capabilities: ['image-generate'] });
  api = createLocalReadApi({ dataRoot: core, providerConfigPath: config, allowExecution: true, connectionsFile: pair.serverFile, serveWorkbench: true });
  const session = await api.start(), credentials = JSON.parse(fs.readFileSync(pair.clientFile));
  fs.writeFileSync(pair.clientFile, JSON.stringify({ ...credentials, origin: session.origin }), { mode: 0o600 });
  const client = stdioMcpClient(cli, pair.clientFile, 'read,create,execute,stop'); children.push(client); await client.initialize();
  const tools = (await client.request('tools/list')).tools.map(tool => tool.name);
  assert.equal(tools.length, 11); assert(tools.includes('iris_core_create_generation')); assert(!tools.includes('iris_core_create_run'));
  const createdOverMcp = await client.call('iris_core_create_generation', { key: crypto.randomUUID(), modelRef: 'comfy::workflow', prompt: 'An outside package Run' });
  assert(!createdOverMcp.isError); assert.equal(submits, 1);
  assert.equal((await client.close()).status, 0);
  const html = await (await fetch(session.origin + '/')).text(); assert(html.includes('comfyui-file') && html.includes('data-creation-mode="generate"'));
  assert(!fs.existsSync(path.join(work, 'unused-dsh')));
  report.checks.push('extracted package serves current Panel and official stdio generation tools outside repository with no daily DSH home');
  report.submits = submits; report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; }
finally {
  for (const child of children.reverse()) await child.kill(); for (const process of processes) process.kill('SIGTERM');
  await api?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); save();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, commands: report.commands.length, output: out, ...(report.failure ? { failure: report.failure } : {}) }, null, 2));
}
