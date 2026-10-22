// Copy this fixture outside the repository. It imports only Node builtins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const [cli, dataRoot, runId, providerConfig, tokenFile] = process.argv.slice(2);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => { const file = path.join(entry.parentPath, entry.name); return [path.relative(directory, file), digest(fs.readFileSync(file))]; }));
}
const before = tree(dataRoot), configHash = digest(fs.readFileSync(providerConfig));
const child = spawn(process.execPath, [cli, 'api', 'serve', '--data-root', dataRoot, '--provider-config', providerConfig, '--token-file', tokenFile],
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
  assert(session.readOnly && /^[A-Za-z0-9_-]{43}$/.test(token)); assert(!stdout.includes(token) && !stderr.includes(token));
  async function get(url, auth = true) {
    const response = await fetch(session.origin + url, { headers: auth ? { Authorization: 'Bearer ' + token } : {} });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes, json: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes) : null };
  }
  assert.equal((await get('/api/v0/session', false)).response.status, 401);
  const info = (await get('/api/v0/session')).json; assert(info.readOnly);
  const models = (await get('/api/v0/models')).json; assert(models.models.some(model => model.modelRef === 'flow::edit' && model.supportsImageEdit));
  const list = (await get('/api/v0/runs?limit=1')).json; assert.equal(list.total, 1); assert.equal(list.runs[0].id, runId);
  const run = (await get('/api/v0/runs/' + runId)).json; assert.equal(run.status, 'selected'); assert(run.selection);
  assert(!JSON.stringify(run).includes('providerBinding') && !JSON.stringify(run).includes('remoteTaskId'));
  const media = await get('/api/v0/artifacts/' + run.output.artifactId + '/content'); assert.equal(media.response.status, 200);
  const expected = fs.readFileSync(path.join(dataRoot, 'artifact-store/v0/objects', run.output.artifactId + '.png'));
  assert.deepEqual(media.bytes, expected);
  const download = await get('/api/v0/runs/' + runId + '/download'); assert.deepEqual(download.bytes, expected);
  assert.match(download.response.headers.get('content-disposition'), /^attachment;/);
  const denied = await fetch(session.origin + '/api/v0/runs/' + runId + '/continue', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.equal(denied.status, 405); await denied.text();
  assert.deepEqual(tree(dataRoot), before); assert.equal(digest(fs.readFileSync(providerConfig)), configHash);
  if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  child.kill('SIGTERM'); const stopped = await closed;
  if (process.platform === 'win32') assert.equal(stopped.signal, 'SIGTERM');
  else assert.equal(stopped.code, 143);
  await assert.rejects(fetch(session.origin + '/api/v0/session'));
  console.log(JSON.stringify({ readOnly: true, authenticated: true, coreBytesUnchanged: true, configUnchanged: true,
    mediaSha256: digest(media.bytes), downloadMatchesSelection: true, writesRefused: true, stopped: true,
    gracefulSignalStopVerified: process.platform !== 'win32', secretNotPrinted: true }));
} finally { clearTimeout(timer); if (!exited) { child.kill('SIGTERM'); await closed; } }
