// Independent consumer: Iris public SDK, public CLI and HTTP only; real Sharp processing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import { loadCorePluginRegistry, createCorePluginWorkbench } from '@mokuyoaxis/dsh-iris/plugins';

const require = createRequire(import.meta.url), execute = promisify(execFile);
const packageFile = require.resolve('@mokuyoaxis/dsh-iris/package.json'), packageRoot = path.dirname(packageFile);
const cli = path.resolve(packageRoot, JSON.parse(fs.readFileSync(packageFile)).bin['dsh-iris']);
const entry = fileURLToPath(import.meta.resolve('@mokuyoaxis/dsh-iris/contact-sheet'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-plugin-business-')), dataRoot = path.join(work, 'core');
const checks = [], opId = 'community.contact-sheet.create'; let api, registry, started;
async function run(...args) {
  const result = await execute(process.execPath, [cli, ...args, '--data-root', dataRoot], { env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  const envelope = JSON.parse(result.stdout); assert.notEqual(envelope.ok, false, result.stdout);
  return envelope.result ?? envelope;
}
async function start(present = true) {
  registry = await loadCorePluginRegistry({ entries: present ? [entry] : [] });
  api = createCorePluginWorkbench({ dataRoot, registry, allowedOperations: present ? [opId] : [],
    panelContributions: present ? { pages: ['community.contact-sheet.board'] } : {} });
  started = await api.start();
}
async function close() { await api?.dispose(); api = null; await registry?.dispose(); registry = null; }
async function request(url, input, expected = 200) {
  const response = await fetch(started.origin + url, { method: input ? 'POST' : 'GET', headers: {
    Authorization: 'Bearer ' + started.accessToken, ...(input ? { 'Content-Type': 'application/json', 'Idempotency-Key': input.key } : {})
  }, ...(input ? { body: JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'key'))) } : {}) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
async function terminal(id) {
  for (let i = 0; i < 300; i++) {
    const value = await request('/api/v0/operations/' + id);
    if (!['queued', 'running'].includes(value.operation.state)) return value.operation;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Operation did not finish');
}
try {
  await run('flow', 'init'); await run('execution', 'init');
  const sources = [];
  for (const [i, background] of ['#f00000', '#0000f0'].entries()) {
    const file = path.join(work, 'source-' + i + '.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toFile(file);
    sources.push((await run('artifact', 'import', '--input', JSON.stringify({ image_path: file }))).artifact.id);
  }
  await start();
  const session = await request('/api/v0/session'); assert.equal(session.pluginExecution, true); assert.equal(session.workbenchMediaReadOnly, true);
  assert.equal(session.panelContributions.pages[0].id, 'community.contact-sheet.board');
  const catalog = await request('/api/v0/plugin-operations/catalog');
  assert.equal(catalog.operations.length, 1); assert.equal(catalog.artifacts.length, 2);
  const call = { key: crypto.randomUUID(), operationId: opId, dependency: catalog.operations[0].dependency,
    input: { artifactIds: sources, columns: 2, cellSize: 128 } };
  const accepted = await request('/api/v0/plugin-operations', call, 202);
  const result = await terminal(accepted.operation.id); assert.equal(result.state, 'succeeded', JSON.stringify(result));
  assert.deepEqual(result.sourceArtifactIds, sources); assert.equal(result.result.artifactIds.length, 1);
  const outputId = result.result.artifactIds[0]; assert.equal(result.result.value.artifactId, outputId);
  const imageResponse = await fetch(started.origin + '/api/v0/artifacts/' + outputId + '/content', { headers: { Authorization: 'Bearer ' + started.accessToken } });
  assert.equal(imageResponse.status, 200);
  const bytes = Buffer.from(await imageResponse.arrayBuffer()), meta = await sharp(bytes).metadata();
  assert.equal(meta.width, 292); assert.equal(meta.height, 152);
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  assert.deepEqual(pixel(60, 60), [240, 0, 0]); assert.deepEqual(pixel(200, 60), [0, 0, 240]);
  checks.push('publicly loaded plugin creates real PNG with original input order, dimensions and pixel content, persisted by Core');
  const replay = await request('/api/v0/plugin-operations', call, 202); assert.equal(replay.idempotentReplay, true); assert.equal(replay.operation.id, result.id);
  await request('/api/v0/plugin-operations', { ...call, input: { ...call.input, columns: 1 } }, 409);
  checks.push('original UUID recovers same Operation/artifact; changed input under same UUID is rejected');
  await close(); await start();
  assert.deepEqual((await request('/api/v0/operations/' + result.id)).operation, result);
  assert.equal((await request('/api/v0/operations?key=' + call.key)).operation.id, result.id);
  assert.equal((await request('/api/v0/plugin-operations/catalog')).artifacts.length, 3);
  checks.push('clean Core service restart preserves exact terminal result and original-key lookup without replay');
  await registry.dispose();
  assert.equal((await request('/api/v0/plugin-operations/catalog')).operations[0].available, false);
  assert.equal((await request('/api/v0/operations/' + result.id)).operation.state, 'succeeded');
  await request('/api/v0/plugin-operations', { ...call, key: crypto.randomUUID() }, 409);
  checks.push('a closing/closed registry is unavailable in the business catalog and new execution while saved facts remain readable');
  await close(); await start(false);
  assert.deepEqual((await request('/api/v0/operations/' + result.id)).operation, result);
  assert.equal((await request('/api/v0/plugin-operations')).operations[0].id, result.id);
  assert.deepEqual((await request('/api/v0/plugin-operations/catalog')).operations, []);
  await request('/api/v0/plugin-operations', { ...call, key: crypto.randomUUID() }, 403);
  checks.push('plugin absence retains readable history and saved output identity while rejecting new execution');
  console.log(JSON.stringify({ ok: true, checks, work }, null, 2));
} finally { await close(); }
