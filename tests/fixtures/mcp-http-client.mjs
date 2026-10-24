// Protocol test driver, not an implementation shipped to users.
export function httpMcpClient(origin, token, { version = '2025-11-25', name = 'independent-http-test-driver' } = {}) {
  let sequence = 0;
  async function send(method, params, notification = false) {
    const id = notification ? undefined : ++sequence;
    if (version === '2026-07-28') params = { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name, version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    } };
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': version, ...(version === '2026-07-28' ? { 'Mcp-Method': method,
        ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}) } : {})
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }), signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    if (notification && response.status === 202) return;
    const messages = response.headers.get('content-type')?.startsWith('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))) : [JSON.parse(text)];
    const message = messages.find(message => message.id === id) || messages.at(-1);
    if (!response.ok || message.error) throw Object.assign(new Error(message.error?.message || 'HTTP MCP rejected'), { rpcCode: message.error?.code, status: response.status });
    return message.result;
  }
  return {
    request: send, call: (name, args) => send('tools/call', { name, arguments: args }),
    initialize: async () => {
      if (version === '2026-07-28') return send('server/discover', {});
      const result = await send('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name, version: '1.0.0' } });
      await send('notifications/initialized', {}, true); return result;
    }
  };
}
