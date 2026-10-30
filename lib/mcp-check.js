import { createCoreServiceClient } from './core-service-client.js';
import { checkedClientConnection, readPrivateConnectionJson, connectionFail } from './core-connections.js';
import { bridgeToolsForScopes } from './core-bridge-tools.js';
import { coreConnectionDiagnostic } from './core-connection-diagnostics.js';

/** Explicit configuration + one temporary handshake. Never opens a writer, calls media or starts Core. */
export async function checkMcpConnection({ connectionFile, scopes = ['read'], capabilities, tools } = {}) {
  const result = { contractVersion: 0, ok: false, checks: [], lifecycle: { core: 'externally-started', bridge: 'client-owned' }, mediaTested: false };
  let client, stage = 'configuration';
  try {
    const connection = checkedClientConnection(readPrivateConnectionJson(connectionFile));
    if (connection.adapterId !== 'iris.mcp') connectionFail('IRIS_CONNECTION_INPUT_INVALID', '请选择 MCP client.json');
    result.checks.push('configuration'); result.origin = connection.origin;
    client = createCoreServiceClient({ connection, requestedScopes: scopes, requestedCapabilities: capabilities, requestedTools: tools,
      harnessVersion: 'Iris MCP connection check' });
    stage = 'handshake'; await client.connect();
    result.checks.push('transport', 'handshake'); result.connection = client.snapshot();
    result.tools = bridgeToolsForScopes(result.connection.scopes, result.connection.capabilities, result.connection.tools, result.connection.pluginOperations).map(tool => tool.name);
    result.checks.push('tool-selection'); result.ok = true;
  } catch (error) { result.error = coreConnectionDiagnostic(error, { stage }); }
  finally {
    if (client) try { result.remoteDisconnect = (await client.dispose()).remoteDisconnect; }
    catch (error) { result.ok = false; result.error = coreConnectionDiagnostic(error, { stage: 'disconnect' }); }
  }
  return result;
}
