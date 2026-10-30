import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-web-login'), dataRoot = path.join(root, 'core');
const app = createApplicationRuntime({ dataRoot }), services = [];
const LOGIN = '/api/v0/workbench/login', LINK = '/api/v0/workbench/login-link';
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile())
  .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, name))).digest('hex')]));
async function start(options = {}, port = 0) {
  const api = createLocalReadApi({ dataRoot, serveWorkbench: true, ...options }); services.push(api);
  return { api, ...await api.start({ port }) };
}
async function post(session, route, value, headers = {}) {
  const response = await fetch(session.origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const ticket = link => new URL(link).hash.slice('#login='.length);
const owner = session => ({ Authorization: 'Bearer ' + session.accessToken });
const redeem = (session, link = session.loginUrl) => post(session, LOGIN, { ticket: ticket(link) }, { Origin: session.origin });
const rawGet = (session, route, headers) => new Promise((resolve, reject) => {
  const request = http.get(session.origin + route, { headers }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
  request.on('error', reject);
});

try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'grants'), origin: 'http://127.0.0.1:1', label: 'Read-only MCP' });
  const before = tree();
  const session = await start({ connectionsFile: pair.serverFile, allowMcp: true });
  assert.match(ticket(session.loginUrl), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(session.loginUrl).origin, session.origin);
  assert.equal(new URL(session.loginUrl).search, '');
  assert.notEqual(ticket(session.loginUrl), session.accessToken);
  assert(Math.abs(Date.parse(session.loginExpiresAt) - Date.now() - 600000) < 10000);
  assert(!JSON.stringify(session.api.snapshot()).includes(ticket(session.loginUrl)));
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://outside.invalid' },
    { Origin: session.origin, 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await post(session, LOGIN, { ticket: ticket(session.loginUrl) }, headers)).status, 403);
  }
  const deniedHost = await new Promise((resolve, reject) => {
    const request = http.request(session.origin + LOGIN, { method: 'POST', headers: { Host: 'outside.invalid', Origin: session.origin, 'Content-Type': 'application/json' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }); request.on('error', reject); request.end(JSON.stringify({ ticket: ticket(session.loginUrl) }));
  });
  assert.equal(deniedHost, 403);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE']) {
    const response = await fetch(session.origin + LOGIN, { method, headers: { Origin: session.origin } });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST'); await response.text();
  }
  for (const value of [null, [], {}, { ticket: 'bad' }, { ticket: ticket(session.loginUrl), extra: true }]) {
    assert.equal((await post(session, LOGIN, value, { Origin: session.origin })).status, 400);
  }
  assert.equal((await post(session, LOGIN + '?ticket=ignored', { ticket: ticket(session.loginUrl) }, { Origin: session.origin })).status, 400);
  assert.equal((await post(session, LOGIN, { ticket: 'x'.repeat(300) }, { Origin: session.origin })).status, 413);
  assert.equal((await post(session, LOGIN, { ticket: ticket(session.loginUrl) }, { Origin: session.origin, 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await post(session, LOGIN, { ticket: session.accessToken }, { Origin: session.origin })).status, 401);
  assert.equal((await post(session, LINK, {})).status, 401);
  assert.equal((await post(session, LINK, { unexpected: true }, owner(session))).status, 400);

  // Only top-level navigation to the public shell may originate on another site.
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal(await rawGet(session, '/', navigation), 200);
  for (const route of ['/app.js', '/api/v0/session']) {
    assert.equal(await rawGet(session, route, { ...navigation, ...owner(session) }), 403);
  }
  assert.equal(await rawGet(session, '/', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }), 403);
  assert.equal(await rawGet(session, '/', { ...navigation, Origin: 'https://outside.invalid' }), 403);
  const simultaneous = await Promise.all([redeem(session), redeem(session)]);
  assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 401]);
  const result = simultaneous.find(item => item.status === 200), browserToken = result.body.accessToken;
  assert.notEqual(browserToken, session.accessToken); assert.notEqual(browserToken, ticket(session.loginUrl));
  assert.equal(result.headers.get('cache-control'), 'no-store'); assert(!result.headers.has('set-cookie')); assert(!result.headers.has('access-control-allow-origin'));
  const browserHeaders = { Authorization: 'Bearer ' + browserToken };
  const authenticated = await fetch(session.origin + '/api/v0/session', { headers: browserHeaders });
  assert.equal(authenticated.status, 200); assert.equal((await authenticated.json()).readOnly, true);
  assert.equal((await fetch(session.origin + '/api/v0/models', { headers: browserHeaders })).status, 200);
  assert.equal((await post(session, '/api/v0/runs', {}, browserHeaders)).status, 405, 'login cannot enable media writes');
  assert.equal((await fetch(session.origin + '/api/v0/session', { headers: { Authorization: 'Bearer ' + ticket(session.loginUrl) } })).status, 401);
  assert.equal((await post(session, '/mcp', {}, browserHeaders)).status, 401, 'workbench session is not an MCP grant');
  const clientToken = JSON.parse(fs.readFileSync(pair.serverFile, 'utf8')).grants[0].accessToken;
  assert.equal((await post(session, LINK, {}, { Authorization: 'Bearer ' + clientToken })).status, 401, 'MCP credential cannot mint owner links');

  const next = (await post(session, LINK, {}, owner(session))).body;
  const replacement = (await post(session, LINK, {}, browserHeaders)).body;
  assert.equal((await redeem(session, next.loginUrl)).status, 401, 'new link replaces only the pending ticket');
  assert.equal((await redeem(session, replacement.loginUrl)).status, 200);
  assert.equal((await fetch(session.origin + '/api/v0/session', { headers: browserHeaders })).status, 200, 'issuing links does not invalidate existing browser sessions');
  const expiring = (await post(session, LINK, {}, owner(session))).body, realNow = Date.now;
  try {
    Date.now = () => Date.parse(expiring.loginExpiresAt);
    assert.equal((await redeem(session, expiring.loginUrl)).status, 401, 'expiry is enforced at the boundary');
  } finally { Date.now = realNow; }
  const other = await start();
  assert.equal((await redeem(other, (await post(session, LINK, {}, owner(session))).body.loginUrl)).status, 401);
  assert.equal((await fetch(other.origin + '/api/v0/session', { headers: browserHeaders })).status, 401);
  const apiOnly = await start({ serveWorkbench: false });
  assert.equal(apiOnly.loginUrl, undefined);
  assert.equal((await post(apiOnly, LINK, {}, owner(apiOnly))).status, 405);
  assert.equal((await redeem(apiOnly, session.loginUrl)).status, 401);

  for (let count = 2; count < 32; count++) {
    const fresh = (await post(session, LINK, {}, owner(session))).body;
    assert.equal((await redeem(session, fresh.loginUrl)).status, 200);
  }
  const full = (await post(session, LINK, {}, owner(session))).body;
  assert.equal((await redeem(session, full.loginUrl)).status, 429, 'browser session memory is bounded');
  assert.equal((await fetch(session.origin + '/api/v0/session', { headers: browserHeaders })).status, 200, 'session limit never evicts a working tab');
  const port = Number(new URL(session.origin).port); await session.api.dispose();
  const restarted = await start({}, port);
  assert.equal((await redeem(restarted, full.loginUrl)).status, 401);
  assert.equal((await fetch(restarted.origin + '/api/v0/session', { headers: browserHeaders })).status, 401);
  assert.equal((await redeem(restarted)).status, 200);
  assert.deepEqual(tree(), before, 'login and recovery never modify Core');
  console.log('local web login: one-time/expiry/concurrency, browser sessions, Host/Origin, navigation, MCP isolation, limits and restart OK');
} finally { for (const service of services) await service.dispose(); await app.dispose(); }
