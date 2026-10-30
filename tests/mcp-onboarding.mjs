import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { exportMcpConfiguration } from '../lib/mcp-config.js';
import { formatMcpConfiguration, MCP_CONNECTION_PRESETS } from '../lib/mcp-delivery.js';
import { checkedConnectionTemplate } from '../lib/connection-template.js';
import { checkMcpConnection } from '../lib/mcp-check.js';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-onboarding'), dataRoot = path.join(root, 'core'), directory = path.join(root, 'connections');
const application = createApplicationRuntime({ dataRoot }), children = [], checks = [], cli = path.resolve('bin/dsh-iris.js');
let api, session;
const uuid = () => crypto.randomUUID(), digest = value => crypto.createHash('sha256').update(value).digest('hex');
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile()).map(name => [name, digest(fs.readFileSync(path.join(dataRoot, name)))]));
function toml(content, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', 'import sys,json,tomllib;print(json.dumps(tomllib.load(sys.stdin.buffer)))'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', status => {
      if (status !== 0) reject(new Error('TOML parser failed: ' + stderr));
      else try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(content);
  });
}
function run(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', status => resolve({ status, stdout, stderr }));
  });
}
async function request(route, value, token = session.accessToken) {
  const response = await fetch(session.origin + '/api/v0/connection-management/' + route, { method: value === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { status: response.status, body: await response.json() };
}
try {
  const tricky = { command: '/tmp/space $x \\ " \n\t\u007f中文', args: ['literal `echo nope`', '${not-an-env}', '\b\f\r\u0001'] };
  const formatted = formatMcpConfiguration(tricky, { format: 'codex-toml', transport: 'stdio' });
  assert.deepEqual((await toml(formatted.content)).mcp_servers.iris, tricky);
  assert.deepEqual((await toml(formatted.content, { ...process.env, PYTHONIOENCODING: 'cp1252' })).mcp_servers.iris, tricky,
    'UTF-8 TOML bytes round-trip even when Python text stdin defaults to a legacy Windows encoding');
  checks.push('Codex TOML independently parses with spaces, quotes, newlines, control characters and literal shell/env syntax intact');
  await application.execute('flow.init', {}); await application.execute('execution.init', { audio: true });
  api = createLocalReadApi({ dataRoot, allowConnectionManagement: true, connectionStore: directory, allowMcp: true }); session = await api.start();
  const original = tree(), catalog = await request('templates');
  assert.equal(catalog.body.presets.length, 8); assert.deepEqual(catalog.body.templates, []); assert.equal(catalog.body.formats.length, 4);
  const key = uuid(); assert.equal((await request('connections', { key, label: 'Explicit preset client', scopes: ['read'], capabilities: ['image-edit'] })).status, 201);
  const profile = JSON.parse(fs.readFileSync(path.join(directory, 'profiles', key + '.json'))), authorization = digest(JSON.stringify([profile.scopes, profile.capabilities, profile.tools, profile.accessToken, profile.revision]));
  let clientFile;
  for (const preset of MCP_CONNECTION_PRESETS) {
    const exported = await request('connections/' + key + '/export', { presetId: preset.presetId }); assert.equal(exported.status, 200);
    const { configuration, content, containsCredentials, filename } = exported.body;
    const parsed = preset.format === 'codex-toml' ? await toml(content) : JSON.parse(content);
    assert.equal(digest(JSON.stringify(parsed)), digest(JSON.stringify(configuration)));
    assert.equal(containsCredentials, preset.transport === 'http');
    assert.equal(filename.endsWith('.toml'), preset.format === 'codex-toml');
    const entry = parsed.mcp_servers?.iris || parsed.mcpServers?.iris;
    if (preset.format === 'claude-json') assert.equal(entry.type, preset.transport);
    if (preset.transport === 'stdio') {
      assert.equal(content.includes(profile.accessToken), false);
      clientFile = entry.args[entry.args.indexOf('--connection-file') + 1]; assert.equal(entry.command, process.execPath);
      const remote = stdioMcpClient(cli, '', 'read', { launch: entry }); children.push(remote); await remote.initialize();
      assert.equal((await remote.request('tools/list')).tools.length, 8);
      const failure = await remote.call('iris_core_run', { runId: 'run_' + 'f'.repeat(24) });
      assert.equal(failure.isError, true); assert.equal(failure.structuredContent.error.code, 'IRIS_API_NOT_FOUND');
      assert.match(failure.structuredContent.error.requestId, /^[a-f0-9-]{36}$/);
      assert.equal(failure.structuredContent.error.recovery.runId, 'run_' + 'f'.repeat(24));
      assert(failure.content[0].text.includes('Request ID:')); assert.equal(JSON.stringify(failure).includes(profile.accessToken), false);
      assert.equal((await remote.close()).status, 0);
    } else {
      assert.equal(entry.url, session.origin + '/mcp');
      const headers = entry.http_headers || entry.headers;
      const remote = httpMcpClient(session.origin, headers.Authorization.slice(7)); await remote.initialize();
      assert.equal((await remote.request('tools/list')).tools.length, 8);
    }
  }
  const after = JSON.parse(fs.readFileSync(path.join(directory, 'profiles', key + '.json')));
  assert.equal(digest(JSON.stringify([after.scopes, after.capabilities, after.tools, after.accessToken, after.revision])), authorization);
  assert.deepEqual(tree(), original);
  checks.push('all eight explicit presets round-trip and connect to production stdio/HTTP tools without changing grants or business storage');
  for (const input of [{ presetId: 'unknown' }, { presetId: 'codex-http', transport: 'stdio' }, { presetId: 'codex-stdio', templateId: 'unknown' }, { format: 'codex-toml' }, { transport: null, format: 'entry' }, { transport: 'stdio', format: null }]) {
    assert.equal((await request('connections/' + key + '/export', input)).status, 400);
  }
  assert.throws(() => checkedConnectionTemplate({ schemaVersion: 0, title: 'Unsafe', transport: 'stdio', format: 'mcpServers', command: 'not allowed' }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  const custom = { schemaVersion: 0, title: 'My TOML client', transport: 'stdio', format: 'codex-toml' };
  const imported = await request('templates', custom); assert.equal(imported.status, 201);
  const templateBytes = fs.readFileSync(path.join(directory, 'templates', imported.body.templateId + '.json'));
  assert.equal((await request('templates', custom)).status, 200);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'templates', imported.body.templateId + '.json')), templateBytes);
  assert((await request('connections/' + key + '/export', { templateId: imported.body.templateId })).body.content.startsWith('[mcp_servers.iris]'));
  checks.push('presets/custom templates cannot add commands or authorization; format choices are explicit and content-addressed templates remain immutable');

  const status = await run('mcp', 'check', '--connection-file', clientFile); assert.equal(status.status, 0, status.stderr);
  const report = JSON.parse(status.stdout); assert.equal(report.ok, true); assert.equal(report.mediaTested, false); assert.equal(report.remoteDisconnect, 'confirmed');
  assert.deepEqual(report.checks, ['configuration', 'transport', 'handshake', 'tool-selection']); assert.equal(report.tools.length, 8);
  const excess = await run('mcp', 'check', '--connection-file', clientFile, '--scopes', 'read,execute');
  assert.equal(excess.status, 1); assert.equal(JSON.parse(excess.stdout).error.stage, 'authorization');
  const absent = await run('mcp', 'check', '--connection-file', path.join(root, 'not-found.json'));
  assert.equal(absent.status, 1); assert.equal(JSON.parse(absent.stdout).error.stage, 'configuration');
  const list = await run('mcp', 'presets'); assert.equal(JSON.parse(list.stdout).presets.length, 8);
  const native = await run('mcp', 'config', '--connection-file', clientFile, '--preset', 'codex-stdio');
  assert.equal(native.status, 0, native.stderr); assert.equal((await toml(native.stdout)).mcp_servers.iris.command, process.execPath);
  const output = path.join(path.dirname(clientFile), 'explicit-http.toml');
  const saved = await run('mcp', 'config', '--connection-file', clientFile, '--preset', 'codex-http', '--output', output);
  assert.equal(saved.status, 0, saved.stderr); assert.equal(JSON.parse(saved.stdout).containsCredentials, true);
  assert.equal(saved.stdout.includes(profile.accessToken), false); assert((await toml(fs.readFileSync(output, 'utf8'))).mcp_servers.iris.http_headers.Authorization.startsWith('Bearer '));
  if (process.platform !== 'win32') assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const retained = digest(fs.readFileSync(output));
  assert.throws(() => exportMcpConfiguration({ connectionFile: clientFile, presetId: 'codex-http', output }), { code: 'EEXIST' });
  assert.equal(digest(fs.readFileSync(output)), retained);
  const unsafe = await run('mcp', 'config', '--connection-file', clientFile, '--preset', 'codex-http');
  assert.equal(unsafe.status, 1); assert.equal((unsafe.stdout + unsafe.stderr).includes(profile.accessToken), false);
  for (const item of [status, excess, absent, list, native, saved]) assert.equal((item.stdout + item.stderr).includes(profile.accessToken), false);
  assert.deepEqual(tree(), original);
  checks.push('actual CLI check/presets/native export have bounded diagnostics, no media calls, no token stdout, private HTTP output and no overwrite');

  const stored = JSON.parse(fs.readFileSync(clientFile));
  await api.dispose();
  const offline = await checkMcpConnection({ connectionFile: clientFile }); assert.equal(offline.ok, false); assert.equal(offline.error.stage, 'transport');
  assert.equal(JSON.stringify(offline).includes(stored.accessToken), false);
  api = createLocalReadApi({ dataRoot, allowConnectionManagement: true, connectionStore: directory }); session = await api.start();
  assert.equal((await request('connections/' + key + '/export', { presetId: 'claude-http' })).status, 403);
  checks.push('offline Core reports transport stage and an HTTP preset cannot bypass a disabled HTTP gateway');
  console.log(JSON.stringify({ ok: true, checks, nativeClientsLaunched: false, protocolClientsLaunched: true, paidCalls: 0 }, null, 2));
} finally {
  for (const child of children) await child.kill();
  await api?.dispose(); await application.dispose();
}
