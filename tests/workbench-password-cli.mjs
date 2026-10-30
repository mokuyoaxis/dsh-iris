// Runs unchanged against an unpacked package; only public CLI and HTTP contracts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url), manifest = require.resolve('@mokuyoaxis/dsh-iris/package.json');
const cli = path.resolve(path.dirname(manifest), JSON.parse(fs.readFileSync(manifest)).bin['dsh-iris']);
const work = fs.mkdtempSync(path.join(process.env.IRIS_TEST_EVIDENCE_DIRECTORY || os.tmpdir(), 'iris-password-cli-'));
const dataRoot = path.join(work, 'core'), irisHome = path.join(work, 'iris-home'), children = [], checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch(args) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    IRIS_HOME: irisHome, DSH_HOME: path.join(work, 'dsh-home'), IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  const result = { child, stdout: '', stderr: '', exited: false }; children.push(result);
  child.stdout.on('data', value => { result.stdout += value; }); child.stderr.on('data', value => { result.stderr += value; });
  result.closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { result.exited = true; resolve({ code, signal }); }); });
  return result;
}
async function command(args, expected = 0) {
  const result = launch(args), exit = await result.closed;
  assert.equal(exit.code, expected, result.stderr); return result;
}
async function start(args) {
  const result = launch(args);
  for (let i = 0; i < 400; i++) {
    if (result.stdout.includes('\n')) return { process: result, ...JSON.parse(result.stdout.split('\n')[0]) };
    if (result.exited) assert.fail(result.stderr);
    await delay(50);
  }
  assert.fail('Workbench startup timeout');
}
async function stop(server) {
  if (!server.process.exited) server.process.child.kill('SIGTERM');
  const exit = await server.process.closed;
  if (process.platform !== 'win32') assert.equal(exit.code, 143, server.process.stderr);
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile())
  .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, name))).digest('hex')]));
async function request(server, action, value, token, expected = 200) {
  const response = await fetch(server.origin + '/api/v0/' + action, { method: value ? 'POST' : 'GET', headers: {
    ...(value ? { 'Content-Type': 'application/json', Origin: server.origin } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {})
  }, ...(value ? { body: JSON.stringify(value) } : {}) });
  const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
}
try {
  await command(['flow', 'init', '--data-root', dataRoot]);
  const before = tree(), args = ['web', 'serve', '--data-root', dataRoot];
  let server = await start(args);
  assert.equal(server.authentication.mode, 'password'); assert.equal(server.authentication.configured, false); assert.equal(server.tokenFile, undefined);
  assert(server.authStore.startsWith(path.join(irisHome, 'web-auth') + path.sep));
  const control = read(path.join(server.authStore, 'active.json'));
  assert(!server.process.stdout.includes(control.accessToken) && !server.process.stderr.includes(control.accessToken));
  const setup = JSON.parse((await command(['web', 'login', '--data-root', dataRoot])).stdout);
  assert.equal(setup.loginUrl, server.loginUrl);
  const signed = await request(server, 'workbench/setup', { ticket: new URL(setup.loginUrl).hash.slice(7), password: 'CLI-example-password', remember: true });
  const plain = JSON.parse((await command(['web', 'login', '--data-root', dataRoot])).stdout);
  assert.equal(plain.loginUrl, server.origin); assert(!plain.loginUrl.includes('#'));
  checks.push('ordinary web serve needs no Token options; private default state and a non-expiring initial setup entry; later login command returns the normal address');
  const port = new URL(server.origin).port; await stop(server);
  assert.equal(read(path.join(server.authStore, 'active.json')).accessToken, null);
  server = await start([...args, '--port', port]);
  assert.equal(server.loginUrl, server.origin); assert.equal(server.authentication.configured, true);
  await request(server, 'session', undefined, signed.accessToken);
  await request(server, 'session', undefined, control.accessToken, 401);
  const reset = JSON.parse((await command(['web', 'password', 'reset', '--data-root', dataRoot])).stdout);
  assert.equal(reset.passwordReset, true); assert(reset.loginUrl.startsWith(server.origin + '/#setup='));
  assert.equal(read(path.join(server.authStore, 'active.json')).pid, server.process.child.pid);
  await request(server, 'session', undefined, signed.accessToken, 401);
  await request(server, 'workbench/setup', { ticket: new URL(reset.loginUrl).hash.slice(7), password: 'CLI-replacement-password', remember: false });
  assert.deepEqual(tree(), before);
  checks.push('fixed-port restart retains the remembered browser session and rotates only owner control; live CLI reset preserves PID and business files');
  await stop(server);
  const offline = JSON.parse((await command(['web', 'password', 'reset', '--data-root', dataRoot])).stdout);
  assert.equal(offline.passwordReset, true); assert.equal(offline.loginUrl, undefined);
  server = await start([...args, '--port', port]); assert.equal(server.authentication.configured, false);
  const durable = await request(server, 'workbench/setup', { ticket: new URL(server.loginUrl).hash.slice(7), password: 'Crash-example-password', remember: true });
  const killedPid = server.process.child.pid; server.process.child.kill('SIGKILL');
  const killed = await server.process.closed; assert.equal(killed.signal, 'SIGKILL');
  const busy = await command([...args, '--port', port], 1); assert.match(busy.stderr, /IRIS_CORE_DATA_ROOT_BUSY/);
  await command(['runtime', 'recover', '--data-root', path.join(server.authStore, 'ownership'), '--confirm-stale-pid', String(killedPid)]);
  server = await start([...args, '--port', port]);
  await request(server, 'session', undefined, durable.accessToken); await stop(server);
  checks.push('an owned SIGKILL retains password/session state, blocks lease stealing and recovers only after explicit stale-PID confirmation');
  await command(['web', 'serve', '--data-root', dataRoot, '--auth-store', path.join(dataRoot, 'bad-auth')], 1);
  assert.equal(fs.existsSync(path.join(dataRoot, 'bad-auth')), false);
  await command(['web', 'serve', '--data-root', dataRoot, '--auth-store', server.authStore, '--token-file', path.join(work, 'wrong-token')], 2);
  await command(['api', 'serve', '--data-root', dataRoot], 2);
  await command(['web', 'login', '--data-root', dataRoot, '--origin', server.origin], 2);
  await command(['web', 'password', 'reset', '--data-root', 'relative'], 2);
  assert.deepEqual(tree(), before);
  checks.push('offline reset uses the auth lease only; unsafe stores and conflicting/relative flags fail without changing Core or creating Token files');
  console.log(JSON.stringify({ ok: true, checks, work }, null, 2));
} finally { for (const result of children) if (!result.exited) { result.child.kill('SIGTERM'); await result.closed; } }
