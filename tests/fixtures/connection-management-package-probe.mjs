// Run an installed package from outside the repository; all business calls are read-only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stdioMcpClient } from './mcp-client.mjs';
import { httpMcpClient } from './mcp-http-client.mjs';

const [cli, work] = process.argv.slice(2), dataRoot = path.join(work, 'managed-core'), store = path.join(work, 'managed-store');
const children = [], bridges = [];
let session, token;
function launch(args) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { child, stdout: '', stderr: '', exited: false }; children.push(entry);
  child.stdout.on('data', bytes => { entry.stdout += bytes; }); child.stderr.on('data', bytes => { entry.stderr += bytes; });
  entry.closed = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', (code, signal) => { entry.exited = true; resolve({ code, signal }); });
  }); return entry;
}
async function command(args) { const entry = launch(args); assert.equal((await entry.closed).code, 0, entry.stderr); return JSON.parse(entry.stdout); }
async function start(suffix, port) {
  const tokenFile = path.join(work, 'managed-token-' + suffix);
  const entry = launch(['web', 'serve', '--data-root', dataRoot, '--token-file', tokenFile,
    '--allow-connection-management', '--connection-store', store, '--allow-mcp', ...(port ? ['--port', port] : [])]);
  for (let index = 0; index < 400; index++) {
    if (entry.stdout.includes('\n')) { session = JSON.parse(entry.stdout.split('\n')[0]); token = fs.readFileSync(tokenFile, 'utf8').trim(); return entry; }
    if (entry.exited) throw new Error('Installed management CLI failed: ' + entry.stderr);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Installed management CLI startup timed out');
}
async function stop(entry) { if (!entry.exited) entry.child.kill('SIGTERM'); return entry.closed; }
async function api(route, value) {
  const response = await fetch(session.origin + '/api/v0/connection-management' + route, { headers: {
    Authorization: 'Bearer ' + token, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(value === undefined ? {} : { method: 'POST', body: JSON.stringify(value) }) });
  const body = await response.json(); assert(response.ok, JSON.stringify(body)); return body;
}
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile())
  .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, name))).digest('hex')]));
try {
  await command(['flow', 'init', '--data-root', dataRoot]); await command(['execution', 'init', '--data-root', dataRoot]);
  const before = tree(), server = await start('first'); assert.equal(session.connectionManagement, true); assert.equal(session.readOnly, true);
  const source = await (await fetch(session.origin + '/connections.js')).text(); assert(source.includes('createConnectionPanel'));
  const input = { key: crypto.randomUUID(), label: 'Installed arbitrary harness', scopes: ['read'], capabilities: ['image-edit'] };
  const { connectionId } = await api('/connections', input);
  const template = { schemaVersion: 0, title: 'Installed generic client', transport: 'stdio', format: 'entry' };
  const imported = await api('/templates', template);
  assert.equal((await api('/templates', template)).idempotentReplay, true);
  const delivered = await api('/connections/' + connectionId + '/skill', {}), bundleFile = path.join(work, 'managed-skill.json'), skillDirectory = path.join(work, 'installed-skills');
  fs.writeFileSync(bundleFile, JSON.stringify(delivered.bundle) + '\n');
  const installation = await command(['skills', 'install', '--bundle', bundleFile, '--directory', skillDirectory]);
  const skillFile = path.join(installation.destination, 'SKILL.md'); assert.equal(fs.readFileSync(skillFile, 'utf8'), delivered.preview);
  assert.equal((await command(['skills', 'status', '--bundle', bundleFile, '--directory', skillDirectory])).status, 'current');
  fs.appendFileSync(skillFile, '\nLocal change retained\n'); const localBytes = fs.readFileSync(skillFile);
  const refused = launch(['skills', 'install', '--bundle', bundleFile, '--directory', skillDirectory]);
  assert.notEqual((await refused.closed).code, 0); assert(refused.stderr.includes('IRIS_SKILL_CONFLICT')); assert.deepEqual(fs.readFileSync(skillFile), localBytes);
  const exported = (await api('/connections/' + connectionId + '/export', { templateId: imported.templateId })).configuration;
  assert(exported.args[0].startsWith(path.dirname(path.dirname(cli))), 'stdio export points to this installed package');
  const bridge = stdioMcpClient(cli, '', 'read', { launch: exported, name: 'Installed stdio client' }); bridges.push(bridge);
  await bridge.initialize(); assert.deepEqual((await bridge.request('tools/list')).tools.map(tool => tool.name), delivered.bundle.tools); await bridge.call('iris_core_models', {});
  assert.equal((await bridge.close()).status, 0);
  const http = (await api('/connections/' + connectionId + '/export', { transport: 'http', format: 'entry' })).configuration;
  const accessToken = http.headers.Authorization.slice(7), remote = httpMcpClient(session.origin, accessToken, { name: 'Installed HTTP client' });
  await remote.initialize(); await remote.call('iris_core_models', {});
  let record = (await api('/connections')).connections[0]; assert.equal(record.lastContact.clientInfo.name, 'Installed HTTP client');
  assert(!JSON.stringify(record).includes(accessToken));
  await api('/connections/' + connectionId + '/update', { label: input.label, scopes: ['read'], capabilities: [], tools: [], expectedRevision: record.revision });
  assert.deepEqual((await remote.request('tools/list')).tools, []);
  record = (await api('/connections')).connections[0]; await api('/connections/' + connectionId + '/revoke', { expectedRevision: record.revision });
  await assert.rejects(remote.request('tools/list'), error => error.status === 401);
  assert(!server.stdout.includes(token) && !server.stdout.includes(accessToken)); assert(!server.stderr.includes(accessToken));
  const port = new URL(session.origin).port; await stop(server); assert.deepEqual(tree(), before);
  const restarted = await start('second', port);
  assert.equal((await api('/connections')).connections[0].state, 'revoked');
  assert.equal((await api('/templates')).templates[0].templateId, imported.templateId); assert.deepEqual(fs.readFileSync(skillFile), localBytes);
  await assert.rejects(httpMcpClient(session.origin, accessToken).request('tools/list'), error => error.status === 401);
  await stop(restarted); assert.deepEqual(tree(), before);
  console.log(JSON.stringify({ managedConnection: true, installedAssets: true, stdioAndHttp: true, clientInfoPersisted: true,
    toolChangesImmediate: true, revokeSurvivesRestart: true, coreBytesUnchanged: true, noGeneration: true, secretNotPrinted: true,
    immutableTemplateAcrossRestart: true, selectedSkillMatchesSdk: true, installedBundleCli: true, localEditsProtected: true }));
} finally {
  for (const bridge of bridges) await bridge.kill();
  for (const entry of children) await stop(entry);
}
