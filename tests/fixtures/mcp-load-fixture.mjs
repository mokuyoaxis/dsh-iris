import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { createLocalReadApi } from '../../lib/local-api.js';
import { createCoreArtifact } from '../../lib/core-artifacts.js';
import { createConnectionPair, readConnectionGrants } from '../../lib/core-connections.js';
import { imageFlowFixture, FLOW_SOURCE } from './image-flow-fixture.mjs';
import { httpMcpClient } from './mcp-http-client.mjs';

export async function until(predicate, label) {
  const end = Date.now() + 8000;
  while (!predicate() && Date.now() < end) await delay(10);
  assert(predicate(), label);
}
export function rpc(method = 'tools/list', params = {}, version = '2025-11-25', id = 1) {
  if (version === '2026-07-28') params = { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: 'iris-load-fixture', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {}
  } };
  return { jsonrpc: '2.0', id, method, params };
}
export function mcpHeaders(token, version, message) {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': version, ...(version === '2026-07-28' ? { 'Mcp-Method': message.method,
      ...(message.params?.name ? { 'Mcp-Name': message.params.name } : message.params?.uri ? { 'Mcp-Name': message.params.uri } : {}) } : {}) };
}

export async function mcpLoadFixture(root, { imageSize = 4 * 1024 * 1024 } = {}) {
  const dataRoot = path.join(root, 'core'), fixture = imageFlowFixture(dataRoot);
  const app = createApplicationRuntime({ dataRoot, ...fixture });
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const image = Buffer.concat([FLOW_SOURCE, Buffer.alloc(imageSize - FLOW_SOURCE.length)]);
  const artifact = await app.run('writer', runtime => runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot,
    { bytes: image, kind: 'imported-image', mediaType: 'image/png' })));
  const pairs = ['one', 'two'].map(label => createConnectionPair({ dataRoot, directory: path.join(root, label),
    origin: 'http://127.0.0.1:1', label, scopes: ['read', 'create', 'execute', 'stop'] }));
  const grants = path.join(root, 'grants.json');
  fs.writeFileSync(grants, JSON.stringify({ schemaVersion: 0, grants: pairs.flatMap(pair => readConnectionGrants(pair.serverFile)) }), { mode: 0o600 });
  const api = createLocalReadApi({ dataRoot, allowMcp: true, allowExecution: true, executionPorts: fixture, connectionsFile: grants });
  const started = await api.start(), tokens = pairs.map(pair => JSON.parse(fs.readFileSync(pair.clientFile)).accessToken);
  const rows = new Map(), owned = new Set(), heldWrites = new Set();
  const toWeb = Readable.toWeb, write = http.ServerResponse.prototype.write, end = http.ServerResponse.prototype.end;
  const ownIterator = Object.getOwnPropertyDescriptor(http.IncomingMessage.prototype, 'iterator'), iterator = http.IncomingMessage.prototype.iterator;
  const rowFor = request => {
    const id = request?.headers?.['x-iris-load-id'];
    if (request?.url !== '/mcp' || !id) return;
    if (!rows.has(id)) rows.set(id, { id, readBodyBytes: 0, writtenBodyBytes: 0, request });
    return rows.get(id);
  };
  Readable.toWeb = function(request, ...args) {
    const stream = toWeb.call(this, request, ...args), row = rowFor(request);
    if (!row) return stream;
    row.streamCreated = true; row.readMode ||= 'web';
    return stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
      if (row.readMode === 'web') row.readBodyBytes += chunk.byteLength; controller.enqueue(chunk);
    } }));
  };
  http.IncomingMessage.prototype.iterator = function(...args) {
    const source = iterator.apply(this, args), row = rowFor(this);
    if (!row || row.readMode === 'web') return source;
    row.streamCreated = true; row.readMode = 'iterator';
    return (async function* () { for await (const chunk of source) { row.readBodyBytes += chunk.length; yield chunk; } })();
  };
  http.ServerResponse.prototype.write = function(chunk, ...args) {
    const row = rowFor(this.req);
    if (row) {
      row.response = this; row.status = this.statusCode; row.writtenBodyBytes += Buffer.byteLength(chunk);
      if (heldWrites.has(row.id) && !row.corked) { this.cork(); row.corked = true; }
    }
    return write.call(this, chunk, ...args);
  };
  http.ServerResponse.prototype.end = function(chunk, ...args) {
    const row = rowFor(this.req);
    if (row) { row.response = this; row.status = this.statusCode; if (typeof chunk === 'string' || chunk instanceof Uint8Array) row.writtenBodyBytes += Buffer.byteLength(chunk); }
    return end.call(this, chunk, ...args);
  };
  const client = (index = 0, version = '2025-11-25') => httpMcpClient(started.origin, tokens[index], { version });
  for (let i = 0; i < tokens.length; i++) await client(i).initialize();
  async function post(message, { token = tokens[0], version = '2025-11-25', tag } = {}) {
    return fetch(started.origin + '/mcp', { method: 'POST', headers: { ...mcpHeaders(token, version, message), ...(tag ? { 'x-iris-load-id': tag } : {}) },
      body: JSON.stringify(message), signal: AbortSignal.timeout(10000) });
  }
  function partial(id, { token = tokens[0], prefixBytes = 256 * 1024, totalBytes = 1024 * 1024, chunked = false } = {}) {
    const request = http.request(started.origin + '/mcp', { method: 'POST', headers: {
      ...mcpHeaders(token, '2025-11-25', rpc()), 'x-iris-load-id': id,
      ...(chunked ? {} : { 'Content-Length': totalBytes })
    } });
    const response = new Promise(resolve => {
      request.once('response', incoming => { incoming.on('error', () => {}); incoming.resume(); resolve({ status: incoming.statusCode }); });
      request.once('error', error => resolve({ error: error.code }));
    });
    owned.add(request); request.on('error', () => {}); request.write(' '.repeat(prefixBytes));
    return { id, request, response, prefixBytes, totalBytes };
  }
  function pausedMedia(id, { token = tokens[0], version = '2025-11-25', message = rpc('tools/call', { name: 'iris_core_image', arguments: { artifactId: artifact.id } }, version) } = {}) {
    const destination = new URL(started.origin), body = JSON.stringify(message);
    const socket = net.createConnection({ host: destination.hostname, port: Number(destination.port) });
    socket.pause(); socket.on('error', () => {}); owned.add(socket);
    socket.once('connect', () => socket.write('POST /mcp HTTP/1.1\r\nHost: ' + destination.host + '\r\n'
      + Object.entries({ ...mcpHeaders(token, version, message), 'x-iris-load-id': id, 'Content-Length': Buffer.byteLength(body) })
        .map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n' + body));
    return { id, socket };
  }
  async function close() {
    Readable.toWeb = toWeb; http.ServerResponse.prototype.write = write; http.ServerResponse.prototype.end = end;
    if (ownIterator) Object.defineProperty(http.IncomingMessage.prototype, 'iterator', ownIterator);
    else delete http.IncomingMessage.prototype.iterator;
    for (const item of owned) item.destroy();
    await api.dispose(); await app.dispose();
  }
  return { api, app, dataRoot, fixture, started, tokens, pairs, image, artifact, rows, client, post, partial, pausedMedia, close,
    hold(id) { heldWrites.add(id); },
    release(id) { heldWrites.delete(id); const row = rows.get(id); if (row?.corked && !row.response.destroyed) { row.corked = false; row.response.uncork(); } } };
}
