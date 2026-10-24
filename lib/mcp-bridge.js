import { createCoreServiceClient } from './core-service-client.js';
import { createMcpServerFactory } from './mcp-server.js';

/** Official SDK stdio server. All business calls use the same explicitly authorized Core service. */
export function createMcpBridge({ connectionFile, requestedScopes = ['read'], capabilities, tools, version, stdin = process.stdin, stdout = process.stdout } = {}) {
  const client = createCoreServiceClient({ connectionFile, requestedScopes, requestedCapabilities: capabilities, requestedTools: tools, harnessVersion: 'Iris MCP bridge ' + version });
  let state = 'new', handle, disposal, resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => {});
  async function start() {
    if (state !== 'new') throw new Error('MCP 桥只能显式启动一次');
    state = 'starting';
    try {
      await client.connect();
      if (client.snapshot().adapterId !== 'iris.mcp') throw Object.assign(new Error('连接文件不是 MCP 授权'), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
      const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      const built = await createMcpServerFactory({ client, version });
      const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: 9 * 1024 * 1024 });
      handle = serveStdio(built.factory, { transport, legacy: 'serve', maxSubscriptions: 4,
        onerror: () => console.error('[iris] MCP transport error; no private request data logged') });
      const sdkClose = transport.onclose;
      transport.onclose = () => { sdkClose?.(); void dispose().catch(() => {}); };
      state = 'open';
      return { contractVersion: 0, tools: built.tools, connection: client.snapshot() };
    } catch (error) {
      state = 'failed';
      try { await client.dispose(); } catch (_) { /* Original initialization failure remains the caller's error. */ }
      rejectClosed(error); throw error;
    }
  }
  function dispose() {
    if (disposal) return disposal;
    state = 'closing';
    disposal = Promise.resolve().then(async () => {
      try { await handle?.close(); const result = await client.dispose(); state = 'closed'; resolveClosed({ state, remoteDisconnect: result.remoteDisconnect }); }
      catch (error) { state = 'failed'; rejectClosed(error); throw error; }
    });
    return disposal;
  }
  return Object.freeze({ start, dispose, closed, snapshot: () => ({ state, connection: client.snapshot() }) });
}
