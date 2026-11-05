import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { adoptCoreArtifactFile } from '../lib/core-artifacts.js';
import { createDshRuntime } from '../lib/dsh-core-adapter.js';
import { serveApi } from '../lib/api.js';
import { MAX_VIDEO_BYTES } from '../lib/video-flow-input.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-dsh-stream'), dataRoot = path.join(root, 'core'), source = path.join(root, 'source.mp4');
const fd = fs.openSync(source, 'wx', 0o600);
try { fs.ftruncateSync(fd, MAX_VIDEO_BYTES + 1); } finally { fs.closeSync(fd); }
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
let artifact;
try { artifact = await runtime.run('execute', () => adoptCoreArtifactFile(dataRoot, { sourcePath: source, mediaType: 'video/mp4' })); }
finally { await runtime.dispose(); }
const core = createDshRuntime({ dataRoot });
const server = http.createServer((req, res) => { void Promise.resolve(serveApi(req, res, undefined, core)).catch(error => res.destroy(error)); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = 'http://127.0.0.1:' + server.address().port + '/iris/api/core/artifact/' + artifact.id + '/media';
const read = fs.readFileSync, stream = fs.createReadStream;
let fullReads = 0, streams = 0, openStreams = 0;
fs.readFileSync = (file, ...args) => {
  if (String(file).startsWith(path.join(dataRoot, 'artifact-store/v0/objects') + path.sep)) {
    fullReads++; throw new Error('whole-object read forbidden at DSH media route');
  }
  return read(file, ...args);
};
fs.createReadStream = (file, ...args) => {
  const result = stream(file, ...args);
  if (String(file).startsWith(path.join(dataRoot, 'artifact-store/v0/objects') + path.sep)) {
    streams++; openStreams++; result.once('close', () => openStreams--);
  }
  return result;
};
async function drained() {
  const until = Date.now() + 5000;
  while ((core.snapshot().operations || openStreams) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(core.snapshot().operations, 0); assert.equal(openStreams, 0);
}
try {
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), artifact.size);
  assert.equal((await head.arrayBuffer()).byteLength, 0); assert.equal(fullReads, 0); assert.equal(streams, 0);
  const result = await fetch(url), hash = crypto.createHash('sha256');
  assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'video/mp4');
  let received = 0;
  for await (const chunk of result.body) { received += chunk.length; hash.update(chunk); }
  assert.equal(received, artifact.size); assert.equal(hash.digest('hex'), artifact.digest.value);
  assert.equal(fullReads, 0); assert.equal(streams, 1); await drained();

  await new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      response.once('data', () => { response.destroy(); resolve(); });
      response.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    });
    request.once('error', reject);
  });
  await drained();
  const object = path.join(dataRoot, 'artifact-store/v0/objects', artifact.id + '.mp4');
  const changed = fs.openSync(object, 'r+');
  try { fs.writeSync(changed, Buffer.from('X'), 0, 1, 0); } finally { fs.closeSync(changed); }
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 404, 'HEAD still verifies the content digest');
  assert.equal((await fetch(url)).status, 404, 'do not stream corrupt content');
  await drained();
  const restored = fs.openSync(object, 'r+');
  try { fs.writeSync(restored, Buffer.from([0]), 0, 1, 0); } finally { fs.closeSync(restored); }
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const active = core.streamCoreArtifactMediaForDsh(artifact.id, async ({ stream }) => {
    for await (const _chunk of stream) { started(); await new Promise(resolve => setTimeout(resolve, 10)); }
  });
  void active.catch(() => {});
  await began;
  const disposing = core.dispose();
  await assert.rejects(active, { name: 'AbortError' });
  await disposing; assert.equal(openStreams, 0);
  assert.equal((await fetch(url)).status, 503);
  console.log('PASS DSH streamed media/HEAD, >32 MiB general video, full hashes, disconnect drain and closed runtime');
} finally {
  fs.readFileSync = read; fs.createReadStream = stream;
  await core.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
