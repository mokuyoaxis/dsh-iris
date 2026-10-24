import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCoreServiceClient } from './core-service-client.js';
import { createMcpServerFactory } from './mcp-server.js';
import { projectedMcpClient } from './core-connections.js';

/** Standard HTTP MCP edge. Core owns every business write; this edge only owns its local connections. */
export function createMcpHttpGateway({ getOrigin, authenticate, availableScopes, version }) {
  const entries = new Map(), lifetime = new AbortController();
  let state = 'new', createMcpHandler, disposal;
  async function start() {
    if (state !== 'new') throw new Error('MCP HTTP 入口只能显式启动一次');
    ({ createMcpHandler } = await import('@modelcontextprotocol/server'));
    state = 'open';
  }
  function entryFor(grant, accessToken) {
    if (entries.has(grant.connectionId)) return entries.get(grant.connectionId);
    const { scopes, ...identity } = grant;
    const client = createCoreServiceClient({ connection: { schemaVersion: 0, origin: getOrigin(), ...identity, accessToken },
      requestedScopes: scopes.filter(scope => availableScopes.includes(scope)), harnessVersion: 'Iris HTTP MCP bridge ' + version });
    const entry = (async () => {
      try {
        await client.connect();
        const { factory } = await createMcpServerFactory({ client, version, transport: 'http' });
        const handler = createMcpHandler(context => {
          const server = factory();
          if (context.authInfo?.extra?.irisObservation) context.authInfo.extra.irisObservation.server = server;
          return server;
        }, { legacy: 'stateless', maxRequestBodySize: 9 * 1024 * 1024,
          maxSubscriptions: 4, onerror: () => console.error('[iris] MCP HTTP protocol error; private input omitted') });
        return { client, handler };
      } catch (error) {
        entries.delete(grant.connectionId); await client.dispose(); throw error;
      }
    })();
    entries.set(grant.connectionId, entry);
    return entry;
  }
  async function handle(request, response, accessToken) {
    if (state !== 'open') throw Object.assign(new Error('MCP HTTP 服务正在关闭'), { code: 'IRIS_API_UNAVAILABLE' });
    const grant = authenticate(accessToken);
    const { handler, client } = await entryFor(grant, accessToken);
    const disconnected = new AbortController();
    const onClose = () => { if (!response.writableFinished) disconnected.abort(); };
    response.once('close', onClose);
    const signal = AbortSignal.any([disconnected.signal, lifetime.signal]);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const input = new Request(getOrigin() + '/mcp', { method: request.method, headers, signal,
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Readable.toWeb(request), duplex: 'half' }) });
      const observation = {};
      const result = await handler.fetch(input, { authInfo: { token: accessToken, clientId: grant.connectionId,
        scopes: grant.scopes, extra: { irisObservation: observation } } });
      if (result.ok && observation.server) await client.reportClientInfo(projectedMcpClient(observation.server.server.getClientVersion()), 'http');
      if (signal.aborted || response.destroyed) { await result.body?.cancel(); return; }
      response.writeHead(result.status, { ...Object.fromEntries(result.headers), 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      if (result.body && request.method !== 'HEAD') await pipeline(Readable.fromWeb(result.body), response);
      else response.end();
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally { response.off('close', onClose); }
  }
  function dispose() {
    if (disposal) return disposal;
    state = 'closing'; lifetime.abort();
    disposal = (async () => {
      const ready = await Promise.allSettled(entries.values());
      const results = await Promise.allSettled(ready.filter(result => result.status === 'fulfilled').map(async result => {
        await result.value.handler.close(); await result.value.client.dispose();
      }));
      entries.clear(); state = 'closed';
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return disposal;
  }
  async function invalidateConnection(id) {
    const pending = entries.get(id); entries.delete(id);
    if (pending) { const entry = await pending; await entry.handler.close(); await entry.client.dispose(); }
  }
  return Object.freeze({ start, handle, invalidateConnection, dispose });
}
