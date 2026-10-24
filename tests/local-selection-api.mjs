import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { readFlowRun } from '../lib/flow-store.js';
import { FLOW_MODEL, FLOW_SOURCE, FLOW_RESULT, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-local-selection');
const apps = [], servers = [], clients = [], releases = [];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function tree(directory) {
  const entries = {};
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) for (const [key, value] of Object.entries(tree(file))) entries[name + '/' + key] = value;
    else entries[name] = hash(fs.readFileSync(file));
  }
  return entries;
}
async function make(name, options = {}) {
  const dataRoot = path.join(root, name), fixture = imageFlowFixture(dataRoot, options);
  const app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const create = () => app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'PRIVATE_SELECTION_PROMPT' });
  const created = await create(), completed = await app.execute('flow.continue', { run_id: created.run.id });
  return { dataRoot, app, fixture, source, create, completed };
}
async function start(dataRoot, options = {}) {
  const api = createLocalReadApi({ dataRoot, ...options }); servers.push(api);
  return { api, ...await api.start() };
}
async function request(session, route, options = {}) {
  const response = await fetch(session.origin + route, { ...options,
    headers: { Authorization: 'Bearer ' + session.accessToken, ...options.headers } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, headers: response.headers,
    value: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes) : null };
}
const select = (session, id, artifactId, expectedRevision, options = {}) => request(session, '/api/v0/runs/' + id + '/selection', {
  method: 'POST', body: JSON.stringify({ artifactId, expectedRevision }), ...options,
  headers: { 'Content-Type': 'application/json', ...options.headers }
});
const inspect = async (session, id) => (await request(session, '/api/v0/runs/' + id)).value;
async function raw(session, extra) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(new URL(session.origin).port), '127.0.0.1'); let bytes = '';
    socket.setTimeout(8000, () => socket.destroy(new Error('raw selection timeout')));
    socket.on('error', reject); socket.on('data', chunk => { bytes += chunk; });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(bytes)?.[1])));
    socket.on('connect', () => socket.write(extra));
  });
}
async function terminal(session, id) {
  for (let index = 0; index < 200; index++) {
    const result = await request(session, '/api/v0/operations/' + id);
    if (!['queued', 'running'].includes(result.value.operation.state)) return result.value.operation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('controlled selection operation did not finish');
}

try {
  const item = await make('main'), id = item.completed.run.id, source = item.source.id, output = item.completed.run.output.artifactId;
  const runFile = path.join(fs.realpathSync(item.dataRoot), 'flow-store/v0/runs', id + '.json');
  const initialEvents = readFlowEvents(item.dataRoot);
  assert.throws(() => createLocalReadApi({ dataRoot: item.dataRoot, allowSelection: 'yes' }), TypeError);
  for (const expected_revision of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(item.app.execute('flow.select', { run_id: id, artifact_id: source, expected_revision }), { code: 'IRIS_FLOW_INPUT_INVALID' });
  }
  const baselineRevision = item.completed.run.revision;
  const raced = await Promise.allSettled([source, output].map(artifact_id => item.app.execute('flow.select', {
    run_id: id, artifact_id, expected_revision: baselineRevision
  })));
  assert.equal(raced.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(raced.find(value => value.status === 'rejected').reason.code, 'IRIS_FLOW_REVISION_CONFLICT');
  assert.equal(readFlowRun(item.dataRoot, id).revision, baselineRevision + 1, 'the shared writer checks the caller revision inside the update');

  const beforeDisabled = tree(item.dataRoot), reader = await start(item.dataRoot);
  assert.equal((await select(reader, id, output, baselineRevision + 1)).status, 405);
  const readSession = (await request(reader, '/api/v0/session')).value;
  assert.equal(readSession.readOnly, true); assert(!readSession.operations.includes('runs.select'));
  assert.deepEqual(tree(item.dataRoot), beforeDisabled);
  const session = await start(item.dataRoot, { allowSelection: true, serveWorkbench: true });
  const info = (await request(session, '/api/v0/session')).value;
  assert.equal(info.readOnly, false); assert.equal(info.workbenchMediaReadOnly, false); assert.equal(info.connectionManagement, false);
  assert.deepEqual(info.operations, [...readSession.operations, 'runs.select']);
  assert.equal(session.api.snapshot().readOnly, false);
  assert.equal((await request(session, '/api/v0/models')).value.configured, false, 'selection needs no Provider');
  for (const route of ['/api/v0/images', '/api/v0/runs', '/api/v0/runs/' + id + '/continue', '/api/v0/connection-management/connections']) {
    assert.equal((await request(session, route, { method: 'POST', body: '{}' })).status, 405, route);
  }
  assert.equal(fs.existsSync(path.join(item.dataRoot, 'creation-requests')), false, 'selection does not initialize request or execution storage');

  let current = await inspect(session, id);
  const selected = await select(session, id, output, current.revision);
  assert.equal(selected.status, 200); assert.equal(selected.value.selection.artifactId, output);
  assert.equal(selected.value.revision, current.revision + 1);
  current = selected.value;
  const beforeNoop = tree(item.dataRoot);
  assert.deepEqual((await select(session, id, output, current.revision)).value, current);
  assert.deepEqual(tree(item.dataRoot), beforeNoop, 'same choice and revision never rewrite the Run');
  const stale = await select(session, id, output, current.revision - 1);
  assert.equal(stale.status, 409); assert.equal(stale.value.error.code, 'IRIS_API_RUN_CHANGED');
  assert.deepEqual(tree(item.dataRoot), beforeNoop, 'same target never bypasses stale-revision validation');

  const beforeRace = current.revision;
  const concurrency = await Promise.all([source, output].map(artifactId => select(session, id, artifactId, beforeRace)));
  assert(concurrency.every(value => value.status === 200 || value.status === 409));
  current = await inspect(session, id);
  assert.equal(current.revision, beforeRace + 1, 'concurrent same-version requests perform exactly one actual change');
  const a = current.selection.artifactId, b = a === source ? output : source, oldRevision = current.revision;
  const toB = await select(session, id, b, oldRevision); assert.equal(toB.status, 200);
  const toA = await select(session, id, a, toB.value.revision); assert.equal(toA.status, 200);
  assert.equal(toA.value.revision, oldRevision + 2);
  assert.equal((await select(session, id, a, oldRevision)).value.error.code, 'IRIS_API_RUN_CHANGED', 'ABA cannot revive a stale selection');
  current = toA.value;

  const other = await item.create();
  const foreign = (await item.app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const rejectedBefore = tree(item.dataRoot);
  for (const artifactId of [foreign.id, item.completed.run.comparison.artifactId, 'artifact_' + 'f'.repeat(24)]) {
    const result = await select(session, id, artifactId, current.revision);
    assert.equal(result.status, 409); assert.equal(result.value.error.code, 'IRIS_API_SELECTION_INVALID');
  }
  assert.equal((await select(session, other.run.id, source, other.run.revision)).value.error.code, 'IRIS_API_RUN_NOT_READY');
  assert.equal((await select(session, 'run_' + 'f'.repeat(24), source, 1)).status, 404);
  assert.equal((await select(session, 'invalid', source, 1)).status, 400);
  const route = '/api/v0/runs/' + id + '/selection';
  const postBody = body => request(session, route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  for (const value of [{}, [], null, { artifactId: source }, { artifactId: source, expectedRevision: 0 },
    { artifactId: source, expectedRevision: '1' }, { artifactId: source, expectedRevision: 1.5 },
    { artifactId: source, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { artifactId: [source], expectedRevision: current.revision },
    { artifactId: source, expectedRevision: current.revision, path: '/private/file' },
    { artifactId: '../outside', expectedRevision: current.revision }]) assert.equal((await postBody(JSON.stringify(value))).status, 400);
  assert.equal((await postBody('{')).status, 400);
  assert.equal((await postBody(Buffer.from([0xc3]))).status, 400);
  assert.equal((await postBody(' '.repeat(8193))).status, 413);
  assert.equal((await request(session, route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: Readable.from([' '.repeat(4096), ' '.repeat(4097)]), duplex: 'half' })).status, 413);
  assert.equal((await select(session, id, source, current.revision, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await select(session, id, source, current.revision, { headers: { 'Content-Encoding': 'gzip' } })).status, 400);
  for (const headers of [{ Origin: 'https://outside.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await select(session, id, source, current.revision, { headers })).status, 403);
  }
  assert.equal((await select(session, id, source, current.revision, { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } })).status, 401);
  assert.equal((await request(session, route + '?path=x', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await request(session, route, { method: 'PUT' })).status, 405);
  const authority = new URL(session.origin).host, body = JSON.stringify({ artifactId: source, expectedRevision: current.revision });
  const rawPost = extra => `POST ${route} HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: Bearer ${session.accessToken}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}Connection: close\r\n\r\n${body}`;
  assert.equal(await raw(session, rawPost('Host: outside.invalid\r\n')), 403);
  assert.equal(await raw(session, rawPost('Authorization: Bearer ' + session.accessToken + '\r\n')), 401);
  assert.equal(await raw(session, rawPost('Content-Type: application/json\r\n')), 400);
  const abortDiagnostics = [], reportError = console.error;
  console.error = (...args) => abortDiagnostics.push(args);
  try {
    await new Promise((resolve, reject) => {
      const req = http.request(session.origin + route, { method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
      req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
      req.once('close', resolve);
      req.write(body.slice(0, -1), () => req.destroy());
    });
    assert.equal((await inspect(session, id)).revision, current.revision, 'disconnect before the body is complete cannot save a choice');
    assert.deepEqual(abortDiagnostics, [], 'an expected body disconnect is not an unexpected server failure');
  } finally { console.error = reportError; }
  assert.deepEqual(tree(item.dataRoot), rejectedBefore, 'all rejected inputs and identities leave every Core file unchanged');

  const lease = createCoreRuntime({ dataRoot: item.dataRoot, mode: 'writer' }); lease.start();
  try { assert.equal((await select(session, id, b, current.revision)).value.error.code, 'IRIS_API_ROOT_BUSY'); }
  finally { await lease.dispose(); }
  const beforeFailure = fs.readFileSync(runFile), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === runFile) throw Object.assign(new Error('PRIVATE_SELECTION_WRITE_FAILURE'), { code: 'EIO' }); return rename(from, to); };
  try {
    const failed = await select(session, id, b, current.revision);
    assert.equal(failed.status, 500); assert.equal(failed.value.error.code, 'IRIS_API_INTERNAL');
    assert(!failed.bytes.includes('PRIVATE_SELECTION_WRITE_FAILURE'));
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(runFile), beforeFailure, 'failed atomic replacement preserves the previous selection');

  // Drop the response body after headers, then recover only by reading the saved Run.
  const lost = await new Promise((resolve, reject) => {
    const req = http.request(session.origin + route, { method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken,
      'Content-Type': 'application/json' } }, res => { res.destroy(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify({ artifactId: b, expectedRevision: current.revision }));
  }); assert.equal(lost, 200);
  current = await inspect(session, id); assert.equal(current.selection.artifactId, b);
  const downloaded = await request(session, '/api/v0/runs/' + id + '/download');
  assert.deepEqual(downloaded.bytes, b === source ? FLOW_SOURCE : FLOW_RESULT);
  const savedTree = tree(item.dataRoot);
  await session.api.dispose();
  const restarted = await start(item.dataRoot, { allowSelection: true });
  assert.equal((await inspect(restarted, id)).selection.artifactId, b);
  assert.equal((await request(restarted, '/api/v0/session', { headers: { Authorization: 'Bearer ' + session.accessToken } })).status, 401);
  assert.deepEqual(tree(item.dataRoot), savedTree, 'restart and GET do not rewrite selection');
  assert.deepEqual(readFlowEvents(item.dataRoot), initialEvents, 'selection, recovery, download and all rejections never call a Provider');
  for (const [name, digest] of Object.entries(rejectedBefore)) {
    if (name !== 'flow-store/v0/runs/' + id + '.json') assert.equal(tree(item.dataRoot)[name], digest, name + ' must remain unchanged');
  }
  console.log('PASS selection: shared-writer CAS, same choice, ABA, foreign/unready refs, hostile inputs, no implicit modes, atomic failure, lost response, restart and original bytes');

  let unblock, entered;
  const executionRoot = path.join(root, 'v1'), fixture = imageFlowFixture(executionRoot, { beforeSubmit: async () => { entered?.(); await new Promise(resolve => { unblock = resolve; releases.push(resolve); }); } });
  const app = createApplicationRuntime({ dataRoot: executionRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const imported = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const target = await app.execute('flow.create', { source_artifact_id: imported.id, model_ref: FLOW_MODEL, prompt: 'Paused operation' });
  const pair = createConnectionPair({ dataRoot: executionRoot, directory: path.join(root, 'pair'), origin: 'http://127.0.0.1:1',
    label: 'Full grants', scopes: ['read', 'create', 'execute', 'stop'] });
  const exec = await start(executionRoot, { allowExecution: true, allowSelection: true, serveWorkbench: true,
    executionPorts: fixture, connectionsFile: pair.serverFile });
  const connection = { ...JSON.parse(fs.readFileSync(pair.clientFile)), origin: exec.origin };
  const client = createCoreServiceClient({ connection, requestedScopes: ['read', 'create', 'execute', 'stop'] }); clients.push(client);
  const hello = await client.connect();
  const headers = { Authorization: 'Bearer ' + connection.accessToken, 'Iris-Connection-Id': connection.connectionId,
    'Iris-Runtime-Id': hello.instance.runtimeInstanceId };
  const clientInfo = (await request(exec, '/api/v0/session', { headers })).value;
  assert(!clientInfo.operations.includes('runs.select'), 'full MCP scopes never gain owner selection');
  assert.equal((await select(exec, target.run.id, imported.id, target.run.revision, { headers })).status, 403);
  assert.equal((await select(exec, target.run.id, imported.id, target.run.revision, { headers: { Authorization: headers.Authorization } })).status, 401);
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const accepted = await client.continueRun({ key: crypto.randomUUID(), runId: target.run.id, expectedRevision: target.run.revision });
  await enteredGate;
  const busy = await select(exec, target.run.id, imported.id, target.run.revision);
  assert.equal(busy.status, 409); assert.equal(busy.value.error.code, 'IRIS_API_ROOT_BUSY');
  unblock(); assert.equal((await terminal(exec, accepted.operation.id)).state, 'succeeded');
  const finished = await inspect(exec, target.run.id), selectedBefore = readFlowEvents(executionRoot);
  assert.equal((await select(exec, target.run.id, imported.id, finished.revision, { headers })).status, 403);
  assert.equal((await select(exec, target.run.id, imported.id, finished.revision)).status, 200);
  assert.deepEqual(readFlowEvents(executionRoot), selectedBefore);
  assert.equal((await request(exec, '/api/v0/session')).value.connectionManagement, false, 'Web execution and selection work without connection management');
  assert.equal(fixture.calls.submit.length, 1);
  const creationOnly = await start(executionRoot, { allowLocalWrites: true });
  const creationInfo = (await request(creationOnly, '/api/v0/session')).value;
  assert(creationInfo.operations.includes('images.create')); assert(!creationInfo.operations.includes('runs.select'));
  assert.equal((await select(creationOnly, target.run.id, imported.id, finished.revision + 1)).status, 405,
    'enabling local creation never implicitly enables owner selection');
  console.log('PASS selection permissions: full connection denied, owner-only capability, busy execution refused, explicit Web execution independent of connection management');
} finally {
  for (const release of releases) release();
  for (const client of clients) if (client.snapshot().state === 'open') await client.dispose();
  for (const server of servers) await server.dispose();
  for (const app of apps) await app.dispose();
}
