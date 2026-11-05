// Test-only protocol driver. Iris itself uses the official MCP server SDK.
// Harnesses should import exported MCP configuration, not copy this driver.
export async function mcpProbe(configuration) {
  let sequence = 0;
  async function request(method, params, notification = false) {
    const id = notification ? undefined : ++sequence;
    const response = await fetch(configuration.url, { method: 'POST', headers: {
      ...configuration.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25'
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }), signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    if (notification && response.status === 202) return;
    const messages = response.headers.get('content-type')?.startsWith('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))) : [JSON.parse(text)];
    const message = messages.find(item => item.id === id) || messages.at(-1);
    if (!response.ok || message.error) throw new Error(message.error?.message || 'MCP HTTP ' + response.status);
    return message.result;
  }
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'iris-plugin-starter-test', version: '0.1.0' } });
  await request('notifications/initialized', {}, true);
  return { request, call: (name, args) => request('tools/call', { name, arguments: args }) };
}
