import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-workbench-password-api'), dataRoot = path.join(root, 'core'), directory = path.join(root, 'auth');
const app = createApplicationRuntime({ dataRoot }), services = [], checks = [], password = 'API-password-example';
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile())
  .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, name))).digest('hex')]));
let current, pair;
async function start(port = 0, options = {}) {
  const api = createLocalReadApi({ dataRoot, serveWorkbench: true, workbenchAuth: { directory }, allowMcp: true, connectionsFile: pair.serverFile, ...options });
  services.push(api); current = { api, ...await api.start({ port }) }; return current;
}
async function request(route, value, headers = {}, expected = 200) {
  const response = await fetch(current.origin + route, { method: value === undefined ? 'GET' : 'POST', headers: {
    ...(value === undefined ? {} : { 'Content-Type': 'application/json', Origin: current.origin }), ...headers
  }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
}
const auth = token => ({ Authorization: 'Bearer ' + token }), BASE = '/api/v0/workbench/';
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  pair = createConnectionPair({ dataRoot, directory: path.join(root, 'grants'), origin: 'http://127.0.0.1:1', label: 'Independent MCP' });
  const before = tree(); await start();
  const setupUrl = current.loginUrl, owner = current.accessToken, ticket = new URL(setupUrl).hash.slice(7);
  const initial = await request(BASE + 'auth'); assert.equal(initial.configured, false); assert.equal(initial.mode, 'password');
  const html = await (await fetch(current.origin)).text(); assert(html.includes('data-auth="password"'));
  assert.equal((await fetch(current.origin + '/workbench-login.js')).status, 200);
  await request('/api/v0/session', undefined, {}, 401);
  await request('/api/v0/session', undefined, auth(ticket), 401);
  for (const origin of ['null', 'https://outside.invalid']) {
    await request(BASE + 'setup', { ticket, password, remember: true }, { Origin: origin }, 403);
  }
  const noOrigin = await fetch(current.origin + BASE + 'setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, password, remember: true }) });
  assert.equal(noOrigin.status, 403); await noOrigin.arrayBuffer();
  await request(BASE + 'setup', { ticket: 'a'.repeat(43), password, remember: true }, {}, 401);
  for (const value of [null, [], {}, { ticket, password }, { ticket, password, remember: true, extra: true }]) {
    await request(BASE + 'setup', value, {}, 400);
  }
  await request(BASE + 'setup', { ticket, password: 'short', remember: true }, {}, 400);
  await request(BASE + 'setup', { ticket, password, remember: 'true' }, {}, 400);
  await request(BASE + 'setup', { ticket, password: 'x'.repeat(2000), remember: true }, {}, 413);
  const signed = await request(BASE + 'setup', { ticket, password, remember: true });
  assert.notEqual(signed.accessToken, owner); assert.notEqual(signed.accessToken, ticket); assert.equal(signed.authId, initial.authId);
  await request(BASE + 'setup', { ticket, password, remember: true }, {}, 401);
  assert.equal((await request('/api/v0/session', undefined, auth(signed.accessToken))).readOnly, true);
  await request('/api/v0/session', undefined, { Cookie: 'iris_session=' + signed.accessToken }, 401);
  await request(BASE + 'password-login', { password: 'incorrect-password', remember: true }, {}, 401);
  const second = await request(BASE + 'password-login', { password, remember: false });
  await request(BASE + 'password-reset', {}, auth(second.accessToken), 401);
  await request(BASE + 'setup-link', {}, auth(second.accessToken), 401);
  await request(BASE + 'login-link', {}, auth(owner), 409);
  await request(BASE + 'login', { ticket }, {}, 409);
  checks.push('password shell, ownership-bound setup, strict same-origin/shape/body limits, independent browser authority, no cookies or legacy-link bypass');
  for (const action of ['setup', 'password-login', 'logout', 'setup-link', 'password-reset']) {
    const response = await fetch(current.origin + BASE + action); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST'); await response.arrayBuffer();
  }
  const wrongMethod = await fetch(current.origin + BASE + 'auth', { method: 'POST', headers: { Origin: current.origin }, body: '{}' });
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD'); await wrongMethod.arrayBuffer();
  await request(BASE + 'auth?ignored=true', undefined, {}, 400);
  const client = JSON.parse(fs.readFileSync(pair.clientFile));
  const mcp = httpMcpClient(current.origin, client.accessToken); await mcp.initialize();
  assert((await mcp.request('tools/list')).tools.length > 0);
  await request('/mcp', {}, auth(signed.accessToken), 401);
  await request(BASE + 'password-reset', {}, auth(client.accessToken), 401);
  await request(BASE + 'logout', {}, auth(second.accessToken));
  await request(BASE + 'logout', {}, auth(second.accessToken));
  await request('/api/v0/session', undefined, auth(second.accessToken), 401);
  await request('/api/v0/session', undefined, auth(signed.accessToken));
  checks.push('finite methods/query rules, MCP separation, exact and idempotent browser logout with other sessions retained');
  const port = Number(new URL(current.origin).port); await current.api.dispose(); await start(port);
  assert.equal(current.loginUrl, current.origin); assert.equal(current.authentication.configured, true);
  await request('/api/v0/session', undefined, auth(signed.accessToken));
  await request('/api/v0/session', undefined, auth(second.accessToken), 401);
  await request('/api/v0/session', undefined, auth(owner), 401);
  const again = await request(BASE + 'password-login', { password, remember: true });
  const reset = await request(BASE + 'password-reset', {}, auth(current.accessToken));
  assert(reset.setupUrl.startsWith(current.origin + '/#setup='));
  await request('/api/v0/session', undefined, auth(signed.accessToken), 401);
  await request('/api/v0/session', undefined, auth(again.accessToken), 401);
  await request(BASE + 'password-login', { password, remember: true }, {}, 409);
  const liveMcp = httpMcpClient(current.origin, client.accessToken); await liveMcp.initialize();
  assert((await liveMcp.request('tools/list')).tools.length > 0);
  assert.equal((await request(BASE + 'setup-link', {}, auth(current.accessToken))).setupUrl, reset.setupUrl);
  await request(BASE + 'setup', { ticket: new URL(reset.setupUrl).hash.slice(7), password: 'Replacement-password', remember: true });
  checks.push('normal restart retains password and original browser session; reset revokes all browser sessions while original MCP grants still work');
  await current.api.dispose();
  const occupied = net.createServer(); await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(start(occupied.address().port), { code: 'EADDRINUSE' }); }
  finally { await new Promise(resolve => occupied.close(resolve)); }
  await start(); assert.equal(current.authentication.configured, true);
  assert.deepEqual(tree(), before);
  const state = fs.readFileSync(path.join(directory, 'state.json'), 'utf8'); assert(!state.includes(password) && !state.includes(signed.accessToken));
  checks.push('port failure releases the auth lease; login/restart/reset leave Core byte-for-byte unchanged and store no plaintext passwords/sessions');
  console.log(JSON.stringify({ ok: true, checks }));
} finally { for (const service of services) await service.dispose(); await app.dispose(); }
