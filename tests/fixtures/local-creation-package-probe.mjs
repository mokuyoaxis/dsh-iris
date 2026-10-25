// Run outside the repository against an installed CLI and its browser modules.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [cli, dataRoot, providerConfig, imageFile, tokenPrefix] = process.argv.slice(2);
const children = [], bytes = fs.readFileSync(imageFile), digest = value => crypto.createHash('sha256').update(value).digest('hex');
const configDigest = digest(fs.readFileSync(providerConfig)), uploadKey = crypto.randomUUID(), flowKey = crypto.randomUUID();
async function start(index, writes) {
  const tokenFile = tokenPrefix + index;
  const child = spawn(process.execPath, [cli, 'api', 'serve', '--data-root', dataRoot, '--token-file', tokenFile,
    '--provider-config', providerConfig, ...(writes ? ['--allow-local-writes'] : [])], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  const entry = { child, stdout: '', stderr: '', exited: false }; children.push(entry);
  child.stdout.on('data', data => { entry.stdout += data; }); child.stderr.on('data', data => { entry.stderr += data; });
  entry.closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { entry.exited = true; resolve({ code, signal }); }); });
  const until = Date.now() + 15000;
  while (!entry.stdout.includes('\n') && !entry.exited && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  assert(entry.stdout.includes('\n'), 'installed creation CLI did not start: ' + entry.stderr);
  entry.session = JSON.parse(entry.stdout.split('\n')[0]); entry.token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.equal(entry.session.readOnly, !writes); assert(!entry.stdout.includes(entry.token) && !entry.stderr.includes(entry.token));
  if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  return entry;
}
async function stop(entry) {
  if (!entry.exited) entry.child.kill('SIGTERM');
  const result = await entry.closed;
  if (process.platform === 'win32') assert.equal(result.signal, 'SIGTERM'); else assert.equal(result.code, 143);
}
async function post(entry, route, key, body, type = 'application/json') {
  const response = await fetch(entry.session.origin + route, { method: 'POST', headers: {
    Authorization: 'Bearer ' + entry.token, 'Idempotency-Key': key, 'Content-Type': type
  }, body });
  return { status: response.status, body: await response.json() };
}
async function get(entry, route) {
  const response = await fetch(entry.session.origin + route, { headers: { Authorization: 'Bearer ' + entry.token } });
  assert.equal(response.status, 200); return response.json();
}
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true })
  .filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile()).map(name => [name, digest(fs.readFileSync(path.join(dataRoot, name)))]));
const timer = setTimeout(() => { for (const entry of children) if (!entry.exited) entry.child.kill('SIGKILL'); }, 35000);
try {
  const first = await start(1, true);
  const rootId = (await get(first, '/api/v0/session')).rootId; assert(rootId);
  const upload = await post(first, '/api/v0/images', uploadKey, bytes, 'image/png'); assert.equal(upload.status, 201);
  const artifactId = upload.body.artifact.artifactId;
  const input = JSON.stringify({ sourceArtifactId: artifactId, modelRef: 'flow::edit', prompt: 'Package creation, no generation' });
  const flow = await post(first, '/api/v0/runs', flowKey, input); assert.equal(flow.status, 201);
  assert.equal(flow.body.flow.status, 'not_started'); assert.equal(flow.body.flow.task, null);
  const runId = flow.body.flow.id;
  assert.equal((await post(first, '/api/v0/runs/' + runId + '/continue', crypto.randomUUID(), '{}')).status, 404);
  await stop(first);
  const second = await start(2, true); assert.notEqual(first.token, second.token);
  assert.equal((await get(second, '/api/v0/session')).rootId, rootId);
  const replayUpload = await post(second, '/api/v0/images', uploadKey, bytes, 'image/png'); assert.equal(replayUpload.status, 200);
  assert.equal(replayUpload.body.artifact.artifactId, artifactId);
  const replayFlow = await post(second, '/api/v0/runs', flowKey, input); assert.equal(replayFlow.status, 200);
  assert.equal(replayFlow.body.flow.id, runId);
  const content = await fetch(second.session.origin + '/api/v0/artifacts/' + artifactId + '/content', { headers: { Authorization: 'Bearer ' + second.token } });
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
  await stop(second);
  const readonly = await start(3, false); assert.equal((await post(readonly, '/api/v0/images', uploadKey, bytes, 'image/png')).status, 405);
  const info = await get(readonly, '/api/v0/session'); assert.equal(info.rootId, rootId); assert(info.operations.includes('creation.lookup'));
  const beforeLookup = tree(), nativeFetch = globalThis.fetch, calls = [], values = new Map();
  const { createReadClient } = await import(pathToFileURL(path.resolve(path.dirname(cli), '../lib/web/transport.js')));
  const { createMediaClient } = await import(pathToFileURL(path.resolve(path.dirname(cli), '../lib/web/media-client.js')));
  const { RECOVERY_STORAGE_KEY } = await import(pathToFileURL(path.resolve(path.dirname(cli), '../lib/web/recovery.js')));
  values.set(RECOVERY_STORAGE_KEY, JSON.stringify({ schemaVersion: 0, origin: readonly.session.origin, rootId, actions: [
    { id: uploadKey, key: uploadKey, kind: 'image-import' }, { id: flowKey, key: flowKey, kind: 'flow-create', artifactId }
  ] }));
  const client = createReadClient(readonly.token), media = createMediaClient({ client, session: info, origin: readonly.session.origin,
    getStorage: () => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }) });
  try {
    globalThis.fetch = (url, options) => { calls.push(options.method); return nativeFetch(readonly.session.origin + url, options); };
    const found = await media.recover(); assert(found.every(item => item.status === 'confirmed'));
    assert.equal(found[0].result.result.artifactId, artifactId); assert.equal(found[1].result.result.runId, runId);
    assert.deepEqual(calls, ['GET', 'GET']); assert.equal(values.size, 0); assert.deepEqual(tree(), beforeLookup);
  } finally { media.close(); client.close(); globalThis.fetch = nativeFetch; }
  await stop(readonly);
  assert.equal(digest(fs.readFileSync(providerConfig)), configDigest);
  assert(!fs.existsSync(path.join(dataRoot, 'task-store/v0/tasks')) || fs.readdirSync(path.join(dataRoot, 'task-store/v0/tasks')).length === 0);
  const requests = fs.readdirSync(path.join(dataRoot, 'creation-requests/v0/requests')).filter(name => /^req_[a-f0-9]{64}\.json$/.test(name));
  assert.equal(requests.length, 2);
  for (const name of requests) {
    const text = fs.readFileSync(path.join(dataRoot, 'creation-requests/v0/requests', name), 'utf8');
    for (const secret of [uploadKey, flowKey, 'fixture-key-package', providerConfig, ...children.map(entry => entry.token)]) assert(!text.includes(secret));
    assert.equal(JSON.parse(text).state, 'succeeded');
  }
  assert(!fs.existsSync(path.join(dataRoot, '.iris-runtime-writer-v0')));
  console.log(JSON.stringify({ uploaded: true, runCreated: true, defaultReadOnly: true, crossProcessIdentityReplay: true,
    stableRootIdentity: true, installedBrowserRecovery: true, recoveryGets: 2, recoveryCoreBytesUnchanged: true,
    noTasks: true, noExecutionEndpoint: true, configUnchanged: true, secretNotPrintedOrRecorded: true,
    mediaSha256: digest(bytes), stopped: true, gracefulSignalStopVerified: process.platform !== 'win32' }));
} finally {
  clearTimeout(timer);
  for (const entry of children) if (!entry.exited) { entry.child.kill('SIGTERM'); await entry.closed; }
}
