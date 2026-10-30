import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { downloadTo, listModels, openAiGenerateImage } from '../lib/adapters.js';
import { readProviderText, PROVIDER_RESPONSE_LIMITS } from '../lib/provider-response.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-response-limits'), checks = [];
const server = http.createServer(async (req, res) => {
  req.resume(); res.setHeader('Content-Type', 'application/json');
  if (req.url === '/declared') { res.setHeader('Content-Length', '4096'); res.end(Buffer.alloc(4096)); }
  else if (req.url === '/chunked') { res.write(Buffer.alloc(256)); res.end(Buffer.alloc(512)); }
  else if (req.url === '/compressed') { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(Buffer.alloc(4096, 65))); }
  else if (req.url === '/v1/models') { res.setHeader('Content-Length', String(PROVIDER_RESPONSE_LIMITS.json + 1)); res.end(Buffer.alloc(PROVIDER_RESPONSE_LIMITS.json + 1)); }
  else if (req.url === '/v1/images/generations') res.end(JSON.stringify({ data: [{ b64_json: Buffer.alloc(1600 * 1024).toString('base64') }] }));
  else if (req.url === '/error') { res.statusCode = 503; res.end('{}'); }
  else res.end('你好，Iris');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port, file = path.join(root, 'image.png');
try {
  for (const resource of ['/declared', '/chunked', '/compressed']) {
    await assert.rejects(readProviderText(await fetch(base + resource), { maxBytes: 512 }), { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' });
    fs.writeFileSync(file, 'original', { mode: 0o600 });
    await assert.rejects(downloadTo(base + resource, file, { maxBytes: 512 }), { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'original'); assert(!fs.readdirSync(root).some(name => name.includes('.download-')), resource + ' retained a partial download');
  }
  checks.push('declared, chunked and decompressed oversize bodies are rejected without replacing the destination or retaining partial files');
  const createWriteStream = fs.createWriteStream;
  let observedOutput, closed;
  fs.createWriteStream = (destination, options) => {
    observedOutput = createWriteStream(destination, { ...options, fs: { ...fs,
      open(...args) { setTimeout(() => fs.open(...args), 25); },
      close(fd, callback) { fs.close(fd, error => setTimeout(() => callback(error), 25)); }
    } });
    closed = new Promise(resolve => observedOutput.once('close', resolve));
    return observedOutput;
  };
  try {
    await assert.rejects(downloadTo(base + '/declared', file, { maxBytes: 512 }), { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' });
    assert.equal(observedOutput.closed, true, 'a rejected download waits for its file handle to close');
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert(!fs.readdirSync(root).some(name => name.includes('.download-')));
  } finally { fs.createWriteStream = createWriteStream; await closed; }
  checks.push('delayed file open and close finish before rejection and partial-file cleanup');
  assert.equal(await readProviderText(await fetch(base), { maxBytes: 128 }), '你好，Iris');
  await downloadTo(base, file, { maxBytes: 128 }); assert.equal(fs.readFileSync(file, 'utf8'), '你好，Iris');
  await assert.rejects(downloadTo(base + '/error', file), error => error.category === 'provider' && error.httpStatus === 503);
  checks.push('normal UTF-8 bytes are unchanged and upstream HTTP failures retain their status/category');
  await assert.rejects(listModels({ baseUrl: base + '/v1' }), { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' });
  const images = await openAiGenerateImage({ baseUrl: base + '/v1', model: 'fixture', prompt: 'fixture' });
  assert.equal(images.length, 1); assert(images[0].b64.length > PROVIDER_RESPONSE_LIMITS.json);
  checks.push('metadata JSON is bounded independently from valid larger inline-media JSON');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
