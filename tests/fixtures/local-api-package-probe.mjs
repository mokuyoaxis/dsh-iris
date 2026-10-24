// Copy this fixture outside the repository. It imports only Node builtins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const [cli, dataRoot, runId, providerConfig, tokenFile, mode = 'api', selectionFlag] = process.argv.slice(2);
assert(['api', 'web'].includes(mode));
assert(selectionFlag === undefined || selectionFlag === '--allow-selection');
const allowSelection = selectionFlag === '--allow-selection';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).filter(name => fs.lstatSync(path.join(directory, name)).isFile())
    .map(name => [name, digest(fs.readFileSync(path.join(directory, name)))]));
}
const before = tree(dataRoot), configHash = digest(fs.readFileSync(providerConfig));
assert(Object.keys(before).length > 0, 'package probe must inspect actual regular files');
const child = spawn(process.execPath, [cli, mode, 'serve', '--data-root', dataRoot, '--token-file', tokenFile,
  ...(allowSelection ? ['--allow-selection'] : ['--provider-config', providerConfig])],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
let stdout = '', stderr = '', exited = false;
child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); }); });
const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 25000);
try {
  const deadline = Date.now() + 15000;
  while (!stdout.includes('\n') && Date.now() < deadline && !exited) await new Promise(resolve => setTimeout(resolve, 50));
  assert(stdout.includes('\n'), 'installed API startup failed: ' + stderr);
  const session = JSON.parse(stdout.split('\n')[0]), token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.equal(session.readOnly, !allowSelection); assert(/^[A-Za-z0-9_-]{43}$/.test(token)); assert(!stdout.includes(token) && !stderr.includes(token));
  async function get(url, auth = true) {
    const response = await fetch(session.origin + url, { headers: auth ? { Authorization: 'Bearer ' + token } : {} });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes, json: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes) : null };
  }
  assert.equal((await get('/api/v0/session', false)).response.status, 401);
  if (mode === 'web') {
    for (const resource of ['/', '/app.js', '/transport.js', '/flow-view.js', '/connections.js', '/styles.css', '/iris-mark.svg']) {
      const asset = await get(resource, false); assert.equal(asset.response.status, 200, resource); assert(asset.bytes.length);
      assert(!asset.bytes.includes(token) && !asset.bytes.includes(dataRoot));
    }
    assert.equal((await get('/.internal/PLAN.md')).response.status, 404);
  } else assert.equal((await get('/', false)).response.status, 401);
  const info = (await get('/api/v0/session')).json; assert.equal(info.readOnly, !allowSelection);
  assert.equal(info.operations.includes('runs.select'), allowSelection);
  assert(!info.operations.includes('images.create') && !info.operations.includes('runs.continue'));
  const models = (await get('/api/v0/models')).json;
  if (allowSelection) assert.equal(models.configured, false);
  else assert(models.models.some(model => model.modelRef === 'flow::edit' && model.supportsImageEdit));
  const list = (await get('/api/v0/runs?limit=1')).json; assert.equal(list.total, 1); assert.equal(list.runs[0].id, runId);
  const run = (await get('/api/v0/runs/' + runId)).json; assert.equal(run.status, 'selected'); assert(run.selection);
  assert(!JSON.stringify(run).includes('providerBinding') && !JSON.stringify(run).includes('remoteTaskId'));
  const media = await get('/api/v0/artifacts/' + run.output.artifactId + '/content'); assert.equal(media.response.status, 200);
  const expected = fs.readFileSync(path.join(dataRoot, 'artifact-store/v0/objects', run.output.artifactId + '.png'));
  assert.deepEqual(media.bytes, expected);
  const selectedBytes = fs.readFileSync(path.join(dataRoot, 'artifact-store/v0/objects', run.selection.artifactId + '.png'));
  const download = await get('/api/v0/runs/' + runId + '/download'); assert.deepEqual(download.bytes, selectedBytes);
  assert.match(download.response.headers.get('content-disposition'), /^attachment;/);
  const denied = await fetch(session.origin + '/api/v0/runs/' + runId + '/continue', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.equal(denied.status, 405); await denied.text();
  let selection;
  if (allowSelection) {
    const artifactId = run.selection.artifactId === run.source.artifactId ? run.output.artifactId : run.source.artifactId;
    async function select(expectedRevision) {
      const response = await fetch(session.origin + '/api/v0/runs/' + runId + '/selection', { method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactId, expectedRevision }) });
      return { status: response.status, value: await response.json() };
    }
    const changed = await select(run.revision); assert.equal(changed.status, 200);
    assert.equal(changed.value.revision, run.revision + 1); assert.equal(changed.value.selection.artifactId, artifactId);
    const saved = tree(dataRoot), record = 'flow-store/v0/runs/' + runId + '.json';
    assert.deepEqual(Object.keys(saved).sort(), Object.keys(before).sort());
    assert.deepEqual(Object.keys(saved).filter(name => saved[name] !== before[name]), [record]);
    const repeated = await select(changed.value.revision); assert.equal(repeated.status, 200);
    assert.equal(repeated.value.revision, changed.value.revision); assert.deepEqual(tree(dataRoot), saved);
    const stale = await select(run.revision); assert.equal(stale.status, 409); assert.equal(stale.value.error.code, 'IRIS_API_RUN_CHANGED');
    assert.deepEqual(tree(dataRoot), saved);
    const recovered = (await get('/api/v0/runs/' + runId)).json;
    assert.equal(recovered.selection.artifactId, artifactId); assert.equal(recovered.revision, changed.value.revision);
    const finalDownload = await get('/api/v0/runs/' + runId + '/download');
    assert.deepEqual(finalDownload.bytes, fs.readFileSync(path.join(dataRoot, 'artifact-store/v0/objects', artifactId + '.png')));
    selection = { initialArtifactId: run.selection.artifactId, artifactId, revisionChecked: true, noOpPreservesBytes: true,
      staleRejected: true, onlyRunChanged: true, noProviderConfig: true, downloadOriginalBytes: true };
  } else assert.deepEqual(tree(dataRoot), before);
  assert.equal(digest(fs.readFileSync(providerConfig)), configHash);
  if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  child.kill('SIGTERM'); const stopped = await closed;
  if (process.platform === 'win32') assert.equal(stopped.signal, 'SIGTERM');
  else assert.equal(stopped.code, 143);
  await assert.rejects(fetch(session.origin + '/api/v0/session'));
  console.log(JSON.stringify({ mode, readOnly: !allowSelection, authenticated: true, coreBytesUnchanged: !allowSelection, configUnchanged: true,
    ...(selection ? { selection } : {}),
    mediaSha256: digest(media.bytes), downloadMatchesSelection: true, writesRefused: !allowSelection, disabledExecutionRefused: true, stopped: true,
    gracefulSignalStopVerified: process.platform !== 'win32', secretNotPrinted: true }));
} finally { clearTimeout(timer); if (!exited) { child.kill('SIGTERM'); await closed; } }
