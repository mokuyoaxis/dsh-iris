import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCoreServiceClient } from './core-service-client.js';
import { createMcpServerFactory, reportMcpClientInfo } from './mcp-server.js';
import { projectedMcpClient } from './core-connections.js';

const MAX_REQUEST_BYTES = 9 * 1024 * 1024, MAX_ACTIVE_MESSAGES = 4;

async function readBody(request) {
  if (Number(request.headers['content-length']) > MAX_REQUEST_BYTES) return { tooLarge: true };
  const chunks = []; let size = 0;
  // Keep the Node stream available to discard unread bytes after an early rejection.
  // An unconsumed Web-stream bridge can pause that drain at its own high-water mark.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return { tooLarge: true };
    chunks.push(chunk);
  }
  return { tooLarge: false, text: new TextDecoder().decode(Buffer.concat(chunks, size)) };
}

function rejectRequest(request, response, status, code, message, rpcCode = -32000) {
  if (response.destroyed) return Promise.resolve();
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: rpcCode, message, data: { code } } }));
  return new Promise(resolve => {
    let cleanupRequest = () => {};
    const finish = () => { cleanupRequest(); response.off('finish', finish); response.off('close', finish); resolve(); };
    response.once('finish', finish); response.once('close', finish);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      Connection: 'close', ...(status === 429 ? { 'Retry-After': '1' } : {}) });
    if (!request.complete && !request.destroyed) {
      // As in the Core HTTP edge, deliver the error before closing an unread upload.
      // Discard without buffering; the HTTP server's existing timeouts bound the drain.
      const end = () => { cleanupRequest(); response.end(); };
      cleanupRequest = () => { request.off('end', end); request.off('close', end); };
      request.once('end', end); request.once('close', end);
      if (request.method === 'HEAD') response.flushHeaders(); else response.write(bytes);
      request.resume();
    } else response.end(request.method === 'HEAD' ? undefined : bytes);
  });
}

/** Standard HTTP MCP edge. Core owns every business write; this edge only owns its local connections. */
export function createMcpHttpGateway({ getOrigin, authenticate, availableScopes, version }) {
  const entries = new Map(), jobs = new Set(), lifetime = new AbortController();
  let state = 'new', createMcpHandler, disposal, starting, activeMessages = 0;
  function start() {
    if (state !== 'new') return Promise.reject(Object.assign(new Error('MCP HTTP 入口只能显式启动一次'), { code: 'IRIS_MCP_CLOSED' }));
    state = 'starting';
    starting = (async () => {
      ({ createMcpHandler } = await import('@modelcontextprotocol/server'));
      if (state !== 'starting') throw Object.assign(new Error('MCP HTTP 启动已停止'), { code: 'IRIS_MCP_CLOSED' });
      state = 'open';
    })();
    return starting;
  }
  function entryFor(grant, accessToken) {
    if (entries.has(grant.connectionId)) return entries.get(grant.connectionId).ready;
    const { scopes, ...identity } = grant;
    const client = createCoreServiceClient({ connection: { schemaVersion: 0, origin: getOrigin(), ...identity, accessToken },
      requestedScopes: scopes.filter(scope => availableScopes.includes(scope)), harnessVersion: 'Iris HTTP MCP bridge ' + version });
    const entry = { client, ready: null };
    entry.ready = (async () => {
      try {
        await client.connect();
        const { factory } = await createMcpServerFactory({ client, version, transport: 'http' });
        const handler = createMcpHandler(context => {
          const server = factory();
          if (context.authInfo?.extra?.irisObservation) context.authInfo.extra.irisObservation.server = server;
          return server;
        }, { legacy: 'stateless', maxRequestBodySize: MAX_REQUEST_BYTES,
          maxSubscriptions: 4, onerror: () => console.error('[iris] MCP HTTP protocol error; private input omitted') });
        return { client, handler };
      } catch (error) {
        if (entries.get(grant.connectionId) === entry) entries.delete(grant.connectionId);
        await client.dispose(); throw error;
      }
    })();
    entries.set(grant.connectionId, entry);
    return entry.ready;
  }
  async function handleRequest(request, response, accessToken) {
    if (state !== 'open') throw Object.assign(new Error('MCP HTTP 服务正在关闭'), { code: 'IRIS_API_UNAVAILABLE' });
    const grant = authenticate(accessToken);
    const disconnected = new AbortController();
    const onClose = () => { if (!response.writableFinished) disconnected.abort(); };
    response.once('close', onClose);
    const signal = AbortSignal.any([disconnected.signal, lifetime.signal]);
    const onAbort = () => { request.destroy(); response.destroy(); };
    signal.addEventListener('abort', onAbort, { once: true });
    let reserved = 0;
    try {
      if (activeMessages >= MAX_ACTIVE_MESSAGES) return await rejectRequest(request, response, 429,
        'IRIS_MCP_HTTP_BUSY', 'MCP HTTP is busy; retry after an active response finishes.');
      activeMessages++; reserved = 1;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      let parsedBody;
      if (request.method === 'POST') {
        const body = await readBody(request);
        if (body.tooLarge) return await rejectRequest(request, response, 413,
          'IRIS_MCP_HTTP_BODY_TOO_LARGE', 'MCP request body exceeds the 9 MiB limit.');
        try { parsedBody = JSON.parse(body.text); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return await rejectRequest(request, response, 400, 'IRIS_MCP_HTTP_PARSE_ERROR', 'Parse error: invalid JSON.', -32700);
        }
        // One HTTP batch can otherwise fan out into many complete base64 media responses.
        const count = Array.isArray(parsedBody) ? Math.max(1, parsedBody.length) : 1;
        if (count > MAX_ACTIVE_MESSAGES) return await rejectRequest(request, response, 400,
          'IRIS_MCP_HTTP_BATCH_TOO_LARGE', 'MCP HTTP batches must not exceed 4 messages.', -32600);
        if (activeMessages + count - reserved > MAX_ACTIVE_MESSAGES) return await rejectRequest(request, response, 429,
          'IRIS_MCP_HTTP_BUSY', 'MCP HTTP is busy; retry after an active response finishes.');
        activeMessages += count - reserved; reserved = count;
      }
      signal.throwIfAborted();
      const input = new Request(getOrigin() + '/mcp', { method: request.method, headers, signal,
        ...(['GET', 'HEAD', 'POST'].includes(request.method) ? {} : { body: Readable.toWeb(request), duplex: 'half' }) });
      const { handler, client } = await entryFor(grant, accessToken);
      signal.throwIfAborted();
      const observation = {};
      const result = await handler.fetch(input, { ...(request.method === 'POST' ? { parsedBody } : {}),
        authInfo: { token: accessToken, clientId: grant.connectionId,
        scopes: grant.scopes, extra: { irisObservation: observation } } });
      if (result.ok && observation.server) void reportMcpClientInfo(client, projectedMcpClient(observation.server.server.getClientVersion()), 'http');
      if (signal.aborted || response.destroyed) { await result.body?.cancel(); return; }
      response.writeHead(result.status, { ...Object.fromEntries(result.headers), 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      if (result.body && request.method !== 'HEAD') await pipeline(Readable.fromWeb(result.body), response, { signal });
      else response.end();
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      activeMessages -= reserved;
      response.off('close', onClose); signal.removeEventListener('abort', onAbort);
    }
  }
  function handle(request, response, accessToken) {
    const job = handleRequest(request, response, accessToken); jobs.add(job);
    void job.then(() => jobs.delete(job), () => jobs.delete(job));
    return job;
  }
  function dispose() {
    if (disposal) return disposal;
    state = 'closing'; lifetime.abort();
    const pending = [...entries.values()];
    const disconnecting = pending.map(entry => entry.client.dispose());
    for (const result of disconnecting) void result.catch(() => {});
    disposal = (async () => {
      if (starting) await Promise.allSettled([starting]);
      const ready = await Promise.allSettled(pending.map(entry => entry.ready));
      const results = await Promise.allSettled([...disconnecting, ...ready.filter(result => result.status === 'fulfilled').map(result => result.value.handler.close())]);
      await Promise.allSettled([...jobs]);
      entries.clear(); state = 'closed';
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return disposal;
  }
  async function invalidateConnection(id) {
    const pending = entries.get(id); entries.delete(id);
    if (pending) {
      const closing = pending.client.dispose(); void closing.catch(() => {});
      const [ready] = await Promise.allSettled([pending.ready]);
      const results = await Promise.allSettled([closing, ...(ready.status === 'fulfilled' ? [ready.value.handler.close()] : [])]);
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    }
  }
  return Object.freeze({ start, handle, invalidateConnection, dispose, snapshot: () => ({ state, connections: entries.size }) });
}
