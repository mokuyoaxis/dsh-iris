import { bridgeToolsForScopes, callCoreBridgeTool } from './core-bridge-tools.js';
import { projectedMcpClient } from './core-connections.js';
import { coreConnectionDiagnostic } from './core-connection-diagnostics.js';

/** Client labels are optional observations. Their failure must not delay a Core
 * command or discard its receipt; command authorization remains in Core. */
export async function reportMcpClientInfo(client, clientInfo, transport) {
  try { await client.reportClientInfo(clientInfo, transport); }
  catch (error) {
    console.error('[iris] MCP client declaration not recorded: ' + (/^IRIS_[A-Z_]+$/.test(error?.code) ? error.code : 'IRIS_MCP_METADATA_FAILED'));
  }
}

/** One official-SDK tool factory for both standard transports and protocol eras. */
export async function createMcpServerFactory({ client, version, transport = 'stdio' }) {
  const [{ McpServer }, { z }] = await Promise.all([import('@modelcontextprotocol/server'), import('zod')]);
  const snapshot = client.snapshot();
  const tools = bridgeToolsForScopes(snapshot.scopes, snapshot.capabilities, snapshot.tools, snapshot.pluginOperations);
  const factory = () => {
    const server = new McpServer({ name: 'iris-core', version }, { capabilities: { tools: {} },
      instructions: 'Iris is a proxy to an explicitly started Core. Inspect the granted catalog first. Execute only a user-selected operation; preserve its request UUID and exact dependency. An Operation receipt is not completion. After interruption or lost responses, inspect/lookup the original Operation; never automatically replay a write or start another Core. Display actual saved image content only after reading it.' });
    if (transport === 'stdio') server.server.oninitialized = () => {
      void reportMcpClientInfo(client, projectedMcpClient(server.server.getClientVersion()), transport);
    };
    for (const tool of tools) server.registerTool(tool.name, {
      description: tool.description, inputSchema: z.fromJSONSchema(tool.parameters),
      annotations: { readOnlyHint: tool.scope === 'read', destructiveHint: tool.scope === 'stop',
        idempotentHint: true, openWorldHint: tool.scope !== 'read' }
    }, async (args, context) => {
      try {
        void reportMcpClientInfo(client, projectedMcpClient(context.mcpReq.envelope?.['io.modelcontextprotocol/clientInfo'] || server.server.getClientVersion()), transport);
        const result = await callCoreBridgeTool(client, tool.name, args, { signal: context.mcpReq.signal });
        if (result.image) return { content: [{ type: 'image', data: result.image.bytes.toString('base64'), mimeType: result.image.mediaType },
          { type: 'text', text: JSON.stringify({ artifactId: result.image.artifactId, bytes: result.image.bytes.length }) }] };
        if (result.audio) return { content: [{ type: 'audio', data: result.audio.bytes.toString('base64'), mimeType: result.audio.mediaType },
          { type: 'text', text: JSON.stringify({ artifactId: result.audio.artifactId, bytes: result.audio.bytes.length }) }] };
        return { content: [{ type: 'text', text: JSON.stringify(result.value) }], structuredContent: result.value };
      } catch (error) {
        const diagnostic = coreConnectionDiagnostic(error, { stage: 'tool', references: args });
        return { isError: true, content: [{ type: 'text', text: diagnostic.code + ' [' + diagnostic.stage + ']: ' + diagnostic.message + ' ' + diagnostic.action
          + (diagnostic.requestId ? ' Request ID: ' + diagnostic.requestId : '') }], structuredContent: { contractVersion: 0, error: diagnostic } };
      }
    });
    return server;
  };
  return { factory, tools: tools.map(tool => tool.name) };
}
