import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === '--package' && args[2] === '--output', 'Usage: --package <absolute-tgz> --output <new-absolute-directory>');
assert(path.isAbsolute(args[1]) && path.isAbsolute(args[3]));
const repo = fileURLToPath(new URL('../', import.meta.url)), out = args[3];
fs.mkdirSync(out, { mode: 0o700 });
const report = { status: 'running', checks: [], actualPaidCalls: 0, freshDependencyInstall: false,
  candidateSha256: crypto.createHash('sha256').update(fs.readFileSync(args[1])).digest('hex') };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const check = name => { report.checks.push(name); save(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#f00' } }).png().toBuffer();
const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#0f0' } }).png().toBuffer();
const eventsFile = path.join(out, 'extension-events.jsonl');
const env = { ...process.env, IRIS_EXTENSION_TEST_LOG: eventsFile };
const processes = new Set(), requests = [];
let ready = false, sequence = 0, origin;
const upstream = http.createServer(async (request, response) => {
  let body = '';
  for await (const bytes of request) body += bytes;
  const authorized = request.headers.authorization === 'Bearer fixture-extension-not-a-real-key';
  requests.push({ method: request.method, url: request.url, authorized, ...(body ? { body: JSON.parse(body) } : {}) });
  if (request.url !== '/image' && !authorized) { response.writeHead(401).end(); return; }
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/models') response.end(JSON.stringify({ models: [{ id: 'edit', capabilities: ['IG'] }] }));
  else if (request.url === '/jobs' && request.method === 'POST') response.end(JSON.stringify({ id: 'remote-' + ++sequence }));
  else if (/^\/jobs\/remote-\d+$/.test(request.url)) response.end(JSON.stringify({ ready, url: origin + '/image' }));
  else if (request.url === '/image') { response.setHeader('Content-Type', 'image/png'); response.end(image); }
  else response.writeHead(404).end();
});

function processRun(command, values, cwd, timeout = 30000) {
  const child = spawn(command, values, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timer;
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => { clearTimeout(timer); processes.delete(child); resolve({ status, signal, stdout, stderr }); });
  });
  timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  processes.add(child);
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + upstream.address().port;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-provider-extension-'));
  report.work = work;
  const extracted = path.join(work, 'archive'); fs.mkdirSync(extracted);
  const untar = await processRun('tar', ['-xzf', args[1], '-C', extracted], out).done;
  assert.equal(untar.status, 0, untar.stderr);
  const installed = path.join(extracted, 'package'), consumer = path.join(work, 'consumer');
  fs.mkdirSync(path.join(consumer, 'node_modules', '@mokuyoaxis'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
  fs.symlinkSync(installed, path.join(consumer, 'node_modules', '@mokuyoaxis', 'dsh-iris'), 'dir');
  const plugin = path.join(consumer, 'node_modules', 'iris-fixture-provider-extension');
  fs.cpSync(path.join(repo, 'tests', 'fixtures', 'provider-extension-package'), plugin, { recursive: true });
  const entry = path.join(plugin, 'index.mjs'), cli = path.join(installed, 'bin', 'dsh-iris.js');
  assert(!fs.readFileSync(entry, 'utf8').includes('../lib/'));
  const flags = ['--provider-extension', entry], config = path.join(out, 'providers.json');
  async function cliRun(values, { extension = true, expected = 0 } = {}) {
    const value = await processRun(process.execPath, [cli, ...values, ...(extension ? flags : [])], consumer).done;
    assert.equal(value.status, expected, value.stderr || value.stdout);
    return value.stdout ? JSON.parse(value.stdout) : null;
  }
  const metadata = await cliRun(['providers', 'protocols']);
  assert.equal(metadata.protocols.length, 7); assert.equal(requests.length, 0);
  assert(!JSON.stringify(metadata).includes(origin));
  check('archive-extracted Iris resolves a separate package through the declared extension export; registration makes no model call');
  await cliRun(['config', 'init', '--provider-config', config]);
  await cliRun(['providers', 'add', '--provider-config', config, '--input', JSON.stringify({ id: 'external', baseUrl: origin,
    apiKey: 'fixture-extension-not-a-real-key', mediaProtocol: 'fixture-images', enabled: true,
    models: [{ id: 'edit', capabilities: ['image-gen'], imageProtocol: 'fixture-images' }] })]);
  await cliRun(['assignments', 'set', '--provider-config', config, '--input', JSON.stringify({ capability: 'image-gen', mode: 'auto' })]);
  assert.equal((await cliRun(['config', 'check', '--provider-config', config])).valid, true);
  const discovered = await cliRun(['models', 'discover', 'external', '--provider-config', config]);
  assert(discovered.models.some(model => model.id === 'edit'));
  const listed = await cliRun(['models', 'list', '--provider-config', config]);
  assert.equal(listed.models[0].imageRouting.mediaProtocol, 'fixture-images');
  const caps = await cliRun(['capabilities', 'list', '--provider-config', config]);
  assert.deepEqual(caps.capabilities.find(value => value.capability === 'image-gen').candidates, ['external::edit']);
  assert.equal(sequence, 0);
  check('custom discovery, model-level protocol validation and automatic function candidates use the same registry without generating');

  const dataRoot = path.join(out, 'cli-core');
  const generated = await cliRun(['run', 'image', '--data-root', dataRoot, '--provider-config', config, '--input', JSON.stringify({ prompt: 'controlled external protocol' })]);
  assert.equal(generated.task.acceptance, 'accepted'); assert.equal(sequence, 1);
  const taskId = generated.task.id, binding = generated.task.providerBinding;
  const beforeMissing = requests.length;
  await cliRun(['task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', config], { extension: false, expected: 1 });
  assert.equal(requests.length, beforeMissing);
  const historical = await cliRun(['task', 'inspect', taskId, '--data-root', dataRoot], { extension: false });
  assert.equal(historical.task.id, taskId); assert.equal(historical.task.providerBinding, binding);
  ready = true;
  const observed = await cliRun(['task', 'observe', taskId, '--data-root', dataRoot, '--provider-config', config]);
  assert.equal(observed.task.id, taskId); assert.equal(observed.task.providerBinding, binding);
  assert.equal(observed.task.deliveryState, 'ready'); assert.equal(sequence, 1);
  const destination = path.join(out, 'cli-result.png');
  await cliRun(['artifact', 'export', observed.task.artifactIds[0], '--data-root', dataRoot, '--output', destination], { extension: false });
  assert.deepEqual(fs.readFileSync(destination), image);
  check('CLI restart restores the original remote Task and bytes; absent extension blocks observation without generating or changing history');

  const serviceRoot = path.join(out, 'service-core');
  await cliRun(['flow', 'init', '--data-root', serviceRoot], { extension: false });
  await cliRun(['execution', 'init', '--data-root', serviceRoot], { extension: false });
  let boot = 0;
  async function startService(execution, extension) {
    const tokenFile = path.join(out, 'session-' + ++boot + '.token');
    const instance = processRun(process.execPath, [cli, 'web', 'serve', '--data-root', serviceRoot, '--provider-config', config,
      '--token-file', tokenFile, ...(execution ? ['--allow-execution', '--allow-selection'] : []), ...(extension ? flags : [])], consumer);
    let exited = false; void instance.done.then(() => { exited = true; });
    for (let index = 0; index < 300 && !fs.existsSync(tokenFile) && !exited; index++) await wait(20);
    assert(fs.existsSync(tokenFile), instance.stderr());
    for (let index = 0; index < 100 && !instance.stdout().includes('\n') && !exited; index++) await wait(10);
    const session = JSON.parse(instance.stdout().split('\n')[0]);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    return { ...instance, origin: session.origin, token };
  }
  async function stopService(service) {
    service.child.kill('SIGTERM'); const value = await service.done; assert.equal(value.status, 143, value.stderr);
  }
  async function call(service, route, { method = 'GET', body, key = crypto.randomUUID(), type = 'application/json' } = {}) {
    const response = await fetch(service.origin + route, { method, headers: { Authorization: 'Bearer ' + service.token,
      ...(method === 'POST' ? { 'Content-Type': type, 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(response.ok, `${route}: ${response.status} ${bytes}`);
    return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : bytes;
  }
  async function terminal(service, id) {
    for (let index = 0; index < 300; index++) {
      const value = await call(service, '/api/v0/operations/' + id);
      if (!['queued', 'running'].includes(value.operation.state)) {
        assert.equal(value.operation.state, 'succeeded', JSON.stringify(value)); return value;
      }
      await wait(20);
    }
    throw new Error('package operation did not reach a terminal state');
  }
  ready = false;
  const beforeService = requests.length, service = await startService(true, true);
  const models = await call(service, '/api/v0/models');
  assert.equal(models.models[0].supportsImageEdit, true); assert.equal(requests.length, beforeService);
  const imported = await call(service, '/api/v0/images', { method: 'POST', body: source, type: 'image/png' });
  const created = await call(service, '/api/v0/runs', { method: 'POST', body: JSON.stringify({ sourceArtifactId: imported.artifact.artifactId,
    modelRef: 'external::edit', prompt: 'controlled image edit' }) });
  assert.equal(sequence, 1); const runId = created.flow.id, key = crypto.randomUUID();
  const continueBody = JSON.stringify({ expectedRevision: created.flow.revision });
  const accepted = await call(service, '/api/v0/runs/' + runId + '/continue', { method: 'POST', body: continueBody, key });
  await terminal(service, accepted.operation.id);
  const pending = await call(service, '/api/v0/runs/' + runId);
  assert.equal(sequence, 2); assert.equal(pending.task.acceptance, 'accepted');
  const replay = await call(service, '/api/v0/runs/' + runId + '/continue', { method: 'POST', body: continueBody, key });
  assert.equal(replay.operation.id, accepted.operation.id); assert.equal(replay.idempotentReplay, true); assert.equal(sequence, 2);
  assert.equal(requests.filter(value => value.method === 'POST').at(-1).body.imageDigest, sha(source));
  await stopService(service);
  check('installed Core API uses the new edit protocol, original image bytes and original-Key replay with exactly one submit');

  ready = true;
  const beforeRestart = requests.length, restored = await startService(true, true);
  const restoredRun = await call(restored, '/api/v0/runs/' + runId);
  assert.equal(restoredRun.task.id, pending.task.id); assert.equal(requests.length, beforeRestart);
  const continued = await call(restored, '/api/v0/runs/' + runId + '/continue', { method: 'POST', body: JSON.stringify({ expectedRevision: restoredRun.revision }) });
  await terminal(restored, continued.operation.id);
  const completed = await call(restored, '/api/v0/runs/' + runId);
  assert.equal(completed.task.id, pending.task.id); assert.equal(completed.task.deliveryState, 'ready'); assert.equal(sequence, 2);
  await call(restored, '/api/v0/runs/' + runId + '/selection', { method: 'POST', body: JSON.stringify({ artifactId: completed.output.artifactId, expectedRevision: completed.revision }) });
  assert.deepEqual(await call(restored, '/api/v0/runs/' + runId + '/download'), image);
  await stopService(restored);
  check('Core restart makes no implicit calls; explicit continuation polls the original Task and delivers/selects/downloads original bytes');

  const readonlyBefore = requests.length, readonly = await startService(false, false);
  const unavailableModels = await call(readonly, '/api/v0/models');
  assert.equal(unavailableModels.total, 0); assert.equal(unavailableModels.gap, 'protocol_unavailable');
  assert.equal((await call(readonly, '/api/v0/runs/' + runId)).task.id, pending.task.id);
  assert.deepEqual(await call(readonly, '/api/v0/runs/' + runId + '/download'), image);
  assert.equal(requests.length, readonlyBefore); await stopService(readonly);
  check('without the extension a default read-only service still serves historical Run and selected image without Provider calls');

  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(value => JSON.parse(value));
  for (const pid of new Set(events.map(value => value.pid))) {
    assert.equal(events.filter(value => value.pid === pid && value.kind === 'activate').length, 1);
    assert.equal(events.filter(value => value.pid === pid && value.kind === 'dispose').length, 1);
  }
  check('every independently loaded CLI/service extension instance disposes once, including controlled service shutdown');
  report.counts = { submits: sequence, polls: requests.filter(value => /^\/jobs\/remote-/.test(value.url)).length,
    discoveries: requests.filter(value => value.url === '/models').length, extensionInstances: new Set(events.map(value => value.pid)).size };
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; }
finally {
  for (const child of processes) child.kill('SIGTERM');
  await new Promise(resolve => upstream.close(resolve));
  save(); console.log(JSON.stringify({ status: report.status, checks: report.checks.length, output: out, ...(report.failure ? { failure: report.failure } : {}) }, null, 2));
}
