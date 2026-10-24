// Copied outside the repository. Actual installed API CLI, Provider factory and official-SDK MCP.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stdioMcpClient } from './mcp-client.mjs';
import { httpMcpClient } from './mcp-http-client.mjs';

const [cli, dataRoot, providerConfig, imageFile, work, flowFixture] = process.argv.slice(2);
const key = () => crypto.randomUUID(), digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const configHash = digest(fs.readFileSync(providerConfig)), clients = [];
let commands = 0, api, output = '', stderr = '', exited = false, exit;
const stage = name => console.error('[installed-execution] ' + name);
function run(args) {
  commands++;
  stage('cli-start ' + args.slice(0, 2).join('/'));
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '' } });
  assert(!result.error, result.error?.message); assert.equal(result.status, 0, result.stderr);
  stage('cli-closed ' + args.slice(0, 2).join('/')); return JSON.parse(result.stdout);
}
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(item => item.type === 'text').text); };
try {
  run(['flow', 'init', '--data-root', dataRoot]); run(['execution', 'init', '--data-root', dataRoot]);
  const pair = run(['connection', 'create', '--data-root', dataRoot, '--directory', path.join(work, 'execution-pair'), '--origin', 'http://127.0.0.1:1',
    '--label', 'Installed generic MCP', '--scopes', 'read,create,execute,stop', '--capabilities', 'image-edit']);
  assert.equal(pair.harnessKind, 'generic');
  const stateFile = path.join(work, 'execution-provider-state.json'); fs.writeFileSync(stateFile, '{"flowSubmits":0}\n', { mode: 0o600 });
  const bootstrap = path.join(work, 'execution-bootstrap.mjs');
  fs.writeFileSync(bootstrap, 'const local=globalThis.fetch;await import(' + JSON.stringify(pathToFileURL(flowFixture).href) + ');\n'
    + 'const offline=globalThis.fetch;globalThis.fetch=(input,options)=>{const u=String(input instanceof Request?input.url:input);if(/^http:\\/\\/127\\.0\\.0\\.1:[0-9]+\\/api\\/v0\\//.test(u))return local(input,options);if(u!=="https://flow.fixture.invalid/v1/chat/completions")throw new Error("External network forbidden");return offline(input,options);};\n', { mode: 0o600 });
  const tokenFile = path.join(work, 'execution-owner-token');
  api = spawn(process.execPath, [cli, 'api', 'serve', '--data-root', dataRoot, '--provider-config', providerConfig, '--allow-execution',
    '--connections-file', pair.serverFile, '--token-file', tokenFile, '--allow-mcp'], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '--import=' + pathToFileURL(bootstrap).href,
      IRIS_ASYNC_FIXTURE_STATE: stateFile, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '' } }); commands++;
  api.stdout.on('data', bytes => { output += bytes; }); api.stderr.on('data', bytes => { stderr += bytes; });
  exit = new Promise(resolve => api.once('close', (status, signal) => { exited = true; resolve({ status, signal }); }));
  const deadline = Date.now() + 15000;
  while (!output.includes('\n') && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(output.includes('\n'), 'Installed execution CLI did not start: ' + stderr);
  const session = JSON.parse(output.split('\n')[0]), config = JSON.parse(fs.readFileSync(pair.clientFile));
  stage('api-ready');
  assert.equal(session.mcpEndpoint, session.origin + '/mcp');
  fs.writeFileSync(pair.clientFile, JSON.stringify({ ...config, origin: session.origin }) + '\n', { mode: 0o600 });
  const first = stdioMcpClient(cli, pair.clientFile, 'read,create,execute,stop'); clients.push(first); commands++;
  await first.initialize(); assert.equal((await first.request('tools/list')).tools.length, 12);
  stage('stdio-initialized');
  const upload = parse(await first.call('iris_core_import_image', { key: key(), imageBase64: fs.readFileSync(imageFile).toString('base64'), mediaType: 'image/png' }));
  const flow = parse(await first.call('iris_core_create_run', { key: key(), sourceArtifactId: upload.artifact.artifactId,
    modelRef: 'flow::edit', prompt: 'Installed SDK and real Provider factory fixture' })).flow;
  stage('stdio-imported-and-created');
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).flowSubmits, 0);
  const input = { key: key(), runId: flow.id, expectedRevision: flow.revision }, accepted = parse(await first.call('iris_core_continue', input));
  stage('stdio-continue-accepted');
  let saved;
  for (let i = 0; i < 150; i++) {
    saved = parse(await first.call('iris_core_operation', { operationId: accepted.operation.id })).operation;
    if (!['queued', 'running'].includes(saved.state)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(saved.state, 'succeeded');
  const view = parse(await first.call('iris_core_run', { runId: flow.id }));
  assert.equal(view.status, 'awaiting_selection'); assert.equal(view.task.attemptCount, 1);
  const result = await first.call('iris_core_image', { artifactId: view.output.artifactId }), image = result.content.find(item => item.type === 'image'); assert(image);
  const installed = path.dirname(path.dirname(cli));
  const { readCoreArtifactBytes } = await import(pathToFileURL(path.join(installed, 'lib/core-artifacts.js')));
  const actual = readCoreArtifactBytes(dataRoot, view.output.artifactId); assert.deepEqual(Buffer.from(image.data, 'base64'), actual.bytes);
  stage('stdio-exact-image-read');
  assert.equal((await first.close()).status, 0);
  stage('stdio-closed');
  const second = stdioMcpClient(cli, pair.clientFile, 'read,create,execute,stop', { version: '2026-07-28' }); clients.push(second); commands++;
  await second.initialize();
  assert.equal(parse(await second.call('iris_core_lookup', { key: input.key })).operation.id, accepted.operation.id);
  assert.equal(parse(await second.call('iris_core_continue', input)).operation.id, accepted.operation.id);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).flowSubmits, 1, 'real configured adapter may submit exactly once');
  assert.equal((await second.close()).status, 0);
  stage('modern-stdio-replay-closed');
  const selectedConfig = run(['mcp', 'config', '--connection-file', pair.clientFile, '--format', 'entry', '--tools', 'iris_core_models,iris_core_image']);
  const selectedClient = stdioMcpClient(cli, pair.clientFile, 'read', { launch: selectedConfig }); clients.push(selectedClient); commands++;
  await selectedClient.initialize();
  assert.deepEqual((await selectedClient.request('tools/list')).tools.map(item => item.name), ['iris_core_models', 'iris_core_image']);
  await assert.rejects(selectedClient.call('iris_core_continue', input), { rpcCode: -32602 });
  assert.equal((await selectedClient.close()).status, 0);
  stage('selected-tools-stdio-closed');
  const httpFile = path.join(path.dirname(pair.clientFile), 'http-config.json');
  const exported = run(['mcp', 'config', '--connection-file', pair.clientFile, '--transport', 'http', '--output', httpFile]);
  assert.equal(exported.containsCredentials, true); assert(!JSON.stringify(exported).includes(config.accessToken));
  const httpConfig = JSON.parse(fs.readFileSync(httpFile)).mcpServers.iris;
  assert.equal(httpConfig.url, session.mcpEndpoint); assert.equal(httpConfig.headers.Authorization, 'Bearer ' + config.accessToken);
  for (const version of ['2025-11-25', '2026-07-28']) {
    const http = httpMcpClient(session.origin, config.accessToken, { version }); await http.initialize();
    assert.equal((await http.request('tools/list')).tools.length, 12);
    assert.equal(parse(await http.call('iris_core_lookup', { key: input.key })).operation.id, accepted.operation.id);
    assert.equal(parse(await http.call('iris_core_continue', input)).operation.id, accepted.operation.id);
    const original = (await http.call('iris_core_image', { artifactId: view.output.artifactId })).content.find(item => item.type === 'image');
    assert.deepEqual(Buffer.from(original.data, 'base64'), actual.bytes);
    stage('http-era-verified ' + version);
  }
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).flowSubmits, 1);
  assert.equal(digest(fs.readFileSync(providerConfig)), configHash);
  for (const client of clients) for (const stream of Object.values(client.output())) assert(!stream.includes(config.accessToken));
  assert(!output.includes(config.accessToken));
  api.kill('SIGTERM'); const stopped = await exit;
  stage('api-closed');
  if (process.platform !== 'win32') assert.equal(stopped.status, 143);
  assert(!fs.existsSync(path.join(dataRoot, '.iris-runtime-writer-v0')));
  assert(!fs.existsSync(path.join(dataRoot, 'creation-requests/v1/runner/.iris-runtime-writer-v0')));
  console.log(JSON.stringify({ cliProcesses: commands, officialSdk: true, installedApiAndMcp: true, configuredProviderFactory: true,
    genericDefault: true, stdioAndHttpBothProtocolEras: true, exportedStdioCommandLaunched: true, selectedTools: 2, privateHttpExport: true,
    explicitV1: true, mockedSubmissions: 1, crossProcessReplay: true, noAutomaticResubmit: true, exactImageBytes: true,
    artifactSha256: digest(actual.bytes), noCredentialOutput: true, providerConfigUnchanged: true, gracefulStop: process.platform !== 'win32' }));
} finally {
  stage('shutdown-start');
  for (const client of clients.reverse()) await client.kill();
  if (api && !exited) { api.kill('SIGTERM'); await exit; }
  stage('shutdown-complete');
}
