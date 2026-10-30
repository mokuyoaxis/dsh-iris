// Public consumer: execute the installed CLI, HTTP API and formal MCP, without Iris implementation imports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';

const require = createRequire(import.meta.url), packageFile = require.resolve('@mokuyoaxis/dsh-iris/package.json');
const cli = path.resolve(path.dirname(packageFile), JSON.parse(fs.readFileSync(packageFile)).bin['dsh-iris']);
const work = fs.mkdtempSync(path.join(process.env.IRIS_TEST_EVIDENCE_DIRECTORY || os.tmpdir(), 'iris-launch-cli-'));
const dataRoot = path.join(work, 'core'), directory = path.join(work, 'sessions'), connectionStore = path.join(work, 'connections');
const configFile = path.join(work, 'startup.json'), children = [], bridges = [], checks = [], businessId = 'community.contact-sheet.create';
const selected = { schemaVersion: 0, entries: ['builtin:contact-sheet'], operations: [businessId], panel: { pages: ['community.contact-sheet.board'] } };
const saveConfig = value => fs.writeFileSync(configFile, JSON.stringify(value));
saveConfig(selected);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Windows kill(SIGTERM) terminates unconditionally. Deliver the handler event
// through a test-only preload; POSIX still exercises the actual OS signal.
const cooperativeSignals = process.platform === 'win32' || process.env.IRIS_TEST_CLI_SIGNAL_MODE === 'ipc';
const signalPreload = path.join(work, 'signal-preload.mjs');
if (cooperativeSignals) fs.writeFileSync(signalPreload, `process.on('message', message => {
  if (message === 'iris-test-sigterm' && !process.emit('SIGTERM')) throw new Error('CLI SIGTERM handler is not installed');
});
process.channel.unref();
`);
const signalArgs = cooperativeSignals ? ['--import', pathToFileURL(signalPreload).href] : [];
function launch(args, service = false) {
  const useIpc = service && cooperativeSignals;
  const child = spawn(process.execPath, [...(useIpc ? signalArgs : []), cli, ...args], { stdio: ['ignore', 'pipe', 'pipe', ...(useIpc ? ['ipc'] : [])],
    env: { ...process.env, DSH_HOME: work, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '' } });
  const entry = { child, useIpc, stdout: '', stderr: '', exited: false }; children.push(entry);
  child.stdout.on('data', bytes => { entry.stdout += bytes; }); child.stderr.on('data', bytes => { entry.stderr += bytes; });
  entry.closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { entry.exited = true; resolve({ code, signal }); });
  });
  return entry;
}
async function command(args, expected = 0) {
  const entry = launch(args), result = await entry.closed;
  assert.equal(result.code, expected, entry.stderr); return entry;
}
function cliDiagnostic(stderr) {
  const records = stderr.split(/\r?\n/).filter(line => line.startsWith('{'));
  assert.equal(records.length, 1, 'expected one structured CLI diagnostic among runtime stderr messages');
  return JSON.parse(records[0]);
}
async function ready(entry) {
  for (let i = 0; i < 400; i++) {
    if (entry.stdout.includes('\n')) return JSON.parse(entry.stdout.split('\n')[0]);
    if (entry.exited) assert.fail('CLI exited before ready: ' + entry.stderr);
    await delay(50);
  }
  assert.fail('CLI startup timed out');
}
async function stop(entry) {
  if (!entry.exited) {
    if (entry.useIpc) entry.child.send('iris-test-sigterm');
    else entry.child.kill('SIGTERM');
  }
  const result = await entry.closed;
  assert.equal(result.code, 143, entry.stderr);
  return result;
}
let session, token;
async function start(args) {
  const entry = launch(args, true); session = await ready(entry); token = fs.readFileSync(session.tokenFile, 'utf8').trim();
  assert(!entry.stdout.includes(token)); assert(!entry.stderr.includes(token));
  return entry;
}
async function raw(route, value, headers = {}) {
  return fetch(session.origin + route, { method: value ? 'POST' : 'GET', headers: {
    Authorization: 'Bearer ' + token, ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers
  }, ...(value ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.timeout(20000) });
}
async function query(route, value, expected = 200, headers = {}) {
  const response = await raw(route, value, headers), body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body)); return body;
}
const parsed = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(item => item.type === 'text').text); };
async function terminal(client, id) {
  for (let i = 0; i < 300; i++) {
    const operation = parsed(await client.call('iris_core_operation', { operationId: id })).operation;
    if (!['queued', 'running'].includes(operation.state)) return operation;
    await delay(10);
  }
  assert.fail('Operation did not finish');
}
const BASE = '/api/v0/connection-management/connections';
try {
  assert.deepEqual(JSON.parse((await command(['plugins', 'list'])).stdout).builtins, ['builtin:contact-sheet']);
  const inspected = JSON.parse((await command(['plugins', 'inspect', '--plugin-config', configFile])).stdout);
  assert.equal(inspected.plugins[0].id, 'community.contact-sheet');
  assert.equal(fs.existsSync(dataRoot), false, 'inspect does not initialize Core or a lease');
  await command(['flow', 'init', '--data-root', dataRoot]); await command(['execution', 'init', '--data-root', dataRoot]);
  const sources = [];
  for (const [i, background] of ['#f00000', '#0000f0'].entries()) {
    const file = path.join(work, 'source-' + i + '.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toFile(file);
    sources.push(JSON.parse((await command(['artifact', 'import', '--data-root', dataRoot, '--input', JSON.stringify({ image_path: file })])).stdout).artifact.id);
  }
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const args = ['web', 'serve', '--data-root', dataRoot, '--port', String(port), '--token-dir', directory, '--plugin-config', configFile,
    '--connection-store', connectionStore, '--allow-connection-management', '--allow-mcp'];
  let server = await start(args);
  const originalTokenFile = session.tokenFile, originalTokenBytes = fs.readFileSync(originalTokenFile), originalToken = token;
  const facts = await query('/api/v0/session');
  assert.equal(facts.pluginExecution, true); assert.equal(facts.workbenchMediaReadOnly, true);
  assert(!facts.operations.includes('runs.continue') && !facts.operations.includes('images.create'));
  assert.equal(facts.panelContributions.pages[0].id, 'community.contact-sheet.board');
  assert.equal((await query(BASE)).connections.length, 0, 'loading/enabling creates no connection grant');
  assert.equal((await fetch(session.origin + '/')).status, 200);
  assert.equal((await fetch(session.origin + facts.panelContributions.pages[0].entry)).status, 200);
  const catalog = await query('/api/v0/plugin-operations/catalog'), pin = catalog.operations[0].dependency;
  const record = await query(BASE, { key: crypto.randomUUID(), label: 'Explicit launch consumer', scopes: ['read', 'execute', 'stop'],
    capabilities: [], pluginOperations: [pin] }, 201);
  const exported = await query(BASE + '/' + record.connectionId + '/export', { transport: 'http', format: 'entry' });
  const httpConfiguration = structuredClone(exported.configuration);
  const stdioExport = await query(BASE + '/' + record.connectionId + '/export', { transport: 'stdio', format: 'entry' });
  const connectionFile = stdioExport.configuration.args[stdioExport.configuration.args.indexOf('--connection-file') + 1];
  const originalClientBytes = fs.readFileSync(connectionFile);
  const http = httpMcpClient(session.origin, httpConfiguration.headers.Authorization.slice(7)); await http.initialize();
  const tools = (await http.request('tools/list')).tools.map(item => item.name);
  assert(tools.includes('iris_core_plugin_call') && !tools.includes('iris_core_continue') && !tools.includes('iris_core_create_generation'));
  const call = { key: crypto.randomUUID(), operationId: businessId, dependency: pin, input: { artifactIds: sources, columns: 2, cellSize: 128 } };
  const accepted = parsed(await http.call('iris_core_plugin_call', call));
  const operation = await terminal(http, accepted.operation.id); assert.equal(operation.state, 'succeeded', JSON.stringify(operation));
  const outputId = operation.result.artifactIds[0];
  const bytes = Buffer.from((await http.call('iris_core_image', { artifactId: outputId })).content.find(item => item.type === 'image').data, 'base64');
  const metadata = await sharp(bytes).metadata(); assert.equal(metadata.width, 292); assert.equal(metadata.height, 152);
  const pixels = await sharp(bytes).removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixels.subarray((60 * 292 + 60) * 3, (60 * 292 + 60) * 3 + 3)], [240, 0, 0]);
  assert.deepEqual([...pixels.subarray((60 * 292 + 200) * 3, (60 * 292 + 200) * 3 + 3)], [0, 0, 240]);
  checks.push('CLI loads exact builtin, serves its real page, keeps media read-only and creates real PNG through an explicitly selected formal HTTP MCP connection');

  await stop(server); server = await start(args);
  assert.equal(new URL(session.origin).port, String(port)); assert.notEqual(session.tokenFile, originalTokenFile);
  assert.notEqual(token, originalToken); assert.deepEqual(fs.readFileSync(originalTokenFile), originalTokenBytes);
  assert.equal((await raw('/api/v0/session', undefined, { Authorization: 'Bearer ' + originalToken })).status, 401);
  assert.deepEqual((await query(BASE + '/' + record.connectionId + '/export', { transport: 'http', format: 'entry' })).configuration, httpConfiguration);
  const stdio = stdioMcpClient(cli, connectionFile, 'read,execute,stop'); bridges.push(stdio); await stdio.initialize();
  assert.equal(parsed(await stdio.call('iris_core_lookup', { key: call.key })).operation.id, operation.id);
  assert.deepEqual(parsed(await stdio.call('iris_core_operation', { operationId: operation.id })).operation, operation);
  assert.equal(parsed(await stdio.call('iris_core_plugin_call', call)).operation.id, operation.id);
  assert.deepEqual(Buffer.from((await stdio.call('iris_core_image', { artifactId: outputId })).content.find(item => item.type === 'image').data, 'base64'), bytes);
  assert.deepEqual(fs.readFileSync(connectionFile), originalClientBytes);
  assert.equal((await stdio.close()).status, 0);
  checks.push('identical fixed-port CLI restart creates a fresh owner file, preserves earlier bytes and exports, and recovers exact UUID/Operation/PNG through the original stdio connection');

  await stop(server); saveConfig({ schemaVersion: 0, entries: [], operations: [] }); server = await start(args);
  assert.deepEqual((await query('/api/v0/operations/' + operation.id)).operation, operation);
  assert.deepEqual((await query('/api/v0/plugin-operations/catalog')).operations, []);
  assert.equal((await raw('/api/v0/artifacts/' + outputId + '/content')).status, 200);
  await query('/api/v0/plugin-operations', { operationId: businessId, dependency: pin, input: call.input }, 403, { 'Idempotency-Key': crypto.randomUUID() });
  assert.deepEqual(fs.readFileSync(connectionFile), originalClientBytes);
  await stop(server);
  saveConfig({ schemaVersion: 0, entries: ['builtin:contact-sheet'] });
  server = await start(['web', 'serve', '--data-root', dataRoot, '--token-dir', directory, '--plugin-config', configFile]);
  const unselected = await query('/api/v0/session'); assert.notEqual(unselected.pluginExecution, true);
  assert.equal(unselected.panelContributions, undefined); assert(!unselected.operations.includes('plugins.execute'));
  await stop(server);
  checks.push('empty execution selection plus missing plugin retains saved history/PNG and rejects writes; loading alone mounts no page and enables no business');

  const lifecycle = path.join(work, 'lifecycle.jsonl'), lifecycleEntry = path.join(work, 'lifecycle.mjs');
  const sdk = import.meta.resolve('@mokuyoaxis/dsh-iris/plugins');
  function lifecyclePlugin({ slow = false, failCleanup = false } = {}) {
    fs.writeFileSync(lifecycleEntry, `import fs from 'node:fs';
import { definePlugin } from ${JSON.stringify(sdk)};
export default definePlugin({manifest: {contractVersion:0,id:'example.lifecycle',version:'1.0.0',compatibility:{min:'0.3.0-alpha.1',maxExclusive:'0.4.0'},
contributions:{operations:[{id:'read',version:'1.0.0',title:'Lifecycle fixture',mode:'reader',commands:['artifact.list'],inputSchema:{type:'object',properties:{},additionalProperties:false}}]}},
async activate(context) { context.onDispose(() => { fs.appendFileSync(${JSON.stringify(lifecycle)}, JSON.stringify({event:'dispose'}) + String.fromCharCode(10));
${failCleanup ? "throw new Error('controlled cleanup failure');" : ''} });
fs.appendFileSync(${JSON.stringify(lifecycle)}, JSON.stringify({event:'activate'}) + String.fromCharCode(10));
${slow ? 'await new Promise(resolve => setTimeout(resolve, 500));' : ''} return {operations:{read:async () => ({})}}; }});
`);
    saveConfig({ schemaVersion: 0, entries: [lifecycleEntry], operations: [] });
  }
  lifecyclePlugin();
  const busy = await start(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory, '--plugin-config', configFile]);
  const failed = await command(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory, '--plugin-config', configFile], 1);
  assert.match(failed.stderr, /IRIS_.*(?:BUSY|LOCKED|LEASE)/);
  await stop(busy);
  assert.deepEqual(fs.readFileSync(lifecycle, 'utf8').trim().split('\n').map(line => JSON.parse(line).event), ['activate', 'activate', 'dispose', 'dispose']);
  const occupied = net.createServer(); await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const occupiedPort = await command(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory,
      '--plugin-config', configFile, '--port', String(occupied.address().port)], 1);
    assert.match(occupiedPort.stderr, /EADDRINUSE/);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
  const invalidConstructor = await command(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory,
    '--plugin-config', configFile, '--allow-provider-management'], 1);
  assert.match(invalidConstructor.stderr, /IRIS_API_CONFIG_INVALID/);
  const existing = path.join(work, 'existing-token'); fs.writeFileSync(existing, 'preserve me');
  const tokenFailure = await command(['api', 'serve', '--data-root', dataRoot, '--token-file', existing, '--plugin-config', configFile], 1);
  assert.match(tokenFailure.stderr, /IRIS_API_TOKEN_FILE_UNAVAILABLE/); assert.equal(fs.readFileSync(existing, 'utf8'), 'preserve me');
  const retry = await start(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory, '--plugin-config', configFile]); await stop(retry);
  lifecyclePlugin({ slow: true });
  const before = fs.readFileSync(lifecycle, 'utf8').length;
  const canceled = launch(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory, '--plugin-config', configFile], true);
  for (let i = 0; i < 400 && fs.readFileSync(lifecycle, 'utf8').length === before; i++) await delay(10);
  assert(fs.readFileSync(lifecycle, 'utf8').length > before, 'activation started before SIGTERM');
  await stop(canceled); assert.equal(canceled.stdout, '');
  assert.deepEqual(fs.readFileSync(lifecycle, 'utf8').slice(before).trim().split('\n').map(line => JSON.parse(line).event), ['activate', 'dispose']);
  lifecyclePlugin({ failCleanup: true });
  const cleanup = await start(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory, '--plugin-config', configFile]);
  await stop(cleanup); assert.match(cleanup.stderr, /IRIS_CLI_SERVICE_CLEANUP_FAILED/);
  assert.match(cleanup.stderr, /controlled cleanup failure/);
  const combined = await command(['api', 'serve', '--data-root', dataRoot, '--token-file', existing, '--plugin-config', configFile], 1);
  const combinedError = cliDiagnostic(combined.stderr);
  assert.equal(combinedError.stage, 'shutdown'); assert.equal(combinedError.startup.code, 'IRIS_API_TOKEN_FILE_UNAVAILABLE');
  assert.equal(combinedError.errors[0].stage, 'plugin-stop'); assert.match(combined.stderr, /controlled cleanup failure/);
  const warning = '(node:123) ExperimentalWarning: Importing JSON modules is an experimental feature\n';
  assert.deepEqual(cliDiagnostic(warning + combined.stderr + warning), combinedError, 'runtime warnings before or after the real diagnostic cannot replace its startup/cleanup facts');
  assert.throws(() => cliDiagnostic(warning));
  assert.throws(() => cliDiagnostic('{malformed}\n'));
  assert.throws(() => cliDiagnostic('{}\n{}\n'));
  saveConfig({ schemaVersion: 0, entries: [], operations: [] });
  const recovered = await start(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory, '--plugin-config', configFile]); await stop(recovered);
  checks.push('busy-root/port/constructor/token failures and SIGTERM during activation release registry/leases; combined startup/cleanup errors retain both causes after Core releases its lease');

  const both = await command(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory, '--token-file', existing], 2);
  assert.match(both.stderr, /只选择/);
  const mixed = await command(['plugins', 'inspect', '--plugin-config', configFile, '--provider-extension', lifecycleEntry], 2);
  assert.match(mixed.stderr, /不能混用/);
  saveConfig(selected);
  const noApiPanel = await command(['api', 'serve', '--data-root', dataRoot, '--token-dir', directory, '--plugin-config', configFile], 1);
  assert.match(noApiPanel.stderr, /IRIS_PLUGIN_LAUNCH_INVALID/);
  const malformed = await command(['plugins', 'inspect', '--plugin-config', path.join(work, 'missing.json')], 1);
  const diagnostic = cliDiagnostic(malformed.stderr); assert.equal(diagnostic.stage, 'plugin-config'); assert.equal(diagnostic.code, 'ENOENT');
  checks.push('conflicting legacy extension/token flags and API Panel choice fail explicitly; structured startup errors locate the config and stage');
  console.log(JSON.stringify({ ok: true, checks, work, signalDelivery: cooperativeSignals ? 'test-ipc-handler-event' : 'native-posix-signal' }, null, 2));
} finally {
  for (const bridge of bridges) await bridge.kill();
  for (const child of children) if (!child.exited) await stop(child);
}
