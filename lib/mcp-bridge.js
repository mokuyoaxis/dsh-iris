import { createCoreServiceClient } from './core-service-client.js';
import { createMcpServerFactory } from './mcp-server.js';
import { annotateCoreConnectionError, coreConnectionDiagnostic } from './core-connection-diagnostics.js';

/** Official SDK stdio server. All business calls use the same explicitly authorized Core service. */
export function createMcpBridge({ connectionFile, requestedScopes = ['read'], capabilities, tools, version, stdin = process.stdin, stdout = process.stdout } = {}) {
  const client = createCoreServiceClient({ connectionFile, requestedScopes, requestedCapabilities: capabilities, requestedTools: tools, harnessVersion: 'Iris MCP bridge ' + version });
  let state = 'new', handle, disposal, starting, closeRequested = false, resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => {});
  function requireStarting() {
    if (closeRequested) throw Object.assign(new Error('MCP 桥启动已停止'), { code: 'IRIS_MCP_CLOSED' });
  }
  function start() {
    if (state !== 'new') return Promise.reject(Object.assign(new Error('MCP 桥只能显式启动一次'), { code: 'IRIS_MCP_CLOSED' }));
    state = 'starting';
    starting = (async () => { try {
      await client.connect();
      requireStarting();
      if (client.snapshot().adapterId !== 'iris.mcp') throw Object.assign(new Error('连接文件不是 MCP 授权'), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
      const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      requireStarting();
      const built = await createMcpServerFactory({ client, version });
      requireStarting();
      const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: 9 * 1024 * 1024 });
      handle = serveStdio(built.factory, { transport, legacy: 'serve', maxSubscriptions: 4,
        onerror: () => console.error('[iris] MCP transport error; no private request data logged') });
      const sdkClose = transport.onclose;
      transport.onclose = () => { sdkClose?.(); void dispose().catch(error => console.error('[iris] ' + JSON.stringify(coreConnectionDiagnostic(error, { stage: 'shutdown' })))); };
      state = 'open';
      return { contractVersion: 0, tools: built.tools, connection: client.snapshot() };
    } catch (error) {
      if (!closeRequested) state = 'failed';
      try { await client.dispose(); } catch (_) { /* Original initialization failure remains the caller's error. */ }
      if (!closeRequested) rejectClosed(error);
      throw annotateCoreConnectionError(error, 'startup');
    } })();
    return starting;
  }
  function dispose() {
    if (disposal) return disposal;
    closeRequested = true; state = 'closing';
    const disconnecting = client.dispose();
    void disconnecting.catch(() => {});
    disposal = Promise.resolve().then(async () => {
      try {
        if (starting) await Promise.allSettled([starting]);
        const results = await Promise.allSettled([handle?.close(), disconnecting]);
        const failed = results.filter(result => result.status === 'rejected');
        if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'MCP 桥释放失败');
        state = 'closed'; resolveClosed({ state, remoteDisconnect: results[1].value.remoteDisconnect });
      }
      catch (error) { state = 'failed'; rejectClosed(error); throw error; }
    });
    return disposal;
  }
  return Object.freeze({ start, dispose, closed, snapshot: () => ({ state, connection: client.snapshot() }) });
}
