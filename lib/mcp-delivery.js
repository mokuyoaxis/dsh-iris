import { connectionFail } from './core-connections.js';

export const MCP_CONFIG_FORMATS = Object.freeze(['mcpServers', 'entry', 'claude-json', 'codex-toml']);
const clients = [
  { id: 'generic', title: '通用 MCP', format: 'mcpServers', documentationUrl: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers', hint: '合并到客户端的 mcpServers 配置，或手动选择单条 entry。' },
  { id: 'claude', title: 'Claude Code', format: 'claude-json', documentationUrl: 'https://code.claude.com/docs/en/mcp', hint: '将 iris 条目合并到项目 .mcp.json 的 mcpServers；已有配置请保留，随后在 /mcp 确认。' },
  { id: 'codex', title: 'Codex', format: 'codex-toml', documentationUrl: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli', hint: '将 [mcp_servers.iris] 段合并到明确选择的 config.toml；保留其他段，随后在 /mcp 确认。' },
  { id: 'kimi', title: 'Kimi Code', format: 'mcpServers', documentationUrl: 'https://moonshotai.github.io/kimi-code/en/customization/mcp', hint: '合并到明确选择的 mcp.json 的 mcpServers，创建新会话后在 /mcp 确认；安装位置由用户决定。' }
];
export const MCP_CONNECTION_PRESETS = Object.freeze(clients.flatMap(client => ['stdio', 'http'].map(transport => Object.freeze({
  presetId: client.id + '-' + transport, title: client.title + ' · ' + (transport === 'stdio' ? '本机 stdio' : 'HTTP'),
  transport, format: client.format, documentationUrl: client.documentationUrl, hint: client.hint
}))));

export function resolveMcpConfigurationChoice({ presetId, transport, format } = {}) {
  if (presetId !== undefined) {
    if (transport !== undefined || format !== undefined) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '接入预设不能与手动传输/格式混用');
    const preset = MCP_CONNECTION_PRESETS.find(item => item.presetId === presetId);
    if (!preset) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '没有此接入预设；可选择通用 MCP 或手动格式');
    return { transport: preset.transport, format: preset.format };
  }
  if (transport === undefined) transport = 'stdio';
  if (format === undefined) format = 'mcpServers';
  if (!['stdio', 'http'].includes(transport) || !MCP_CONFIG_FORMATS.includes(format)) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '配置格式或传输方式无效');
  return { transport, format };
}

/** Fixed, typed fields only. No shell interpolation, executable template or arbitrary TOML fragment. */
export function formatMcpConfiguration(entry, { transport, format }) {
  let configuration, content, filename = 'iris-mcp.json', mediaType = 'application/json';
  if (format === 'codex-toml') {
    const native = transport === 'stdio' ? { command: entry.command, args: entry.args } : { url: entry.url, http_headers: entry.headers };
    configuration = { mcp_servers: { iris: native } };
    const lines = ['[mcp_servers.iris]'];
    for (const [key, value] of Object.entries(native)) {
      const quote = item => JSON.stringify(item).replace(/\x7f/g, '\\u007f');
      const text = key === 'http_headers' ? '{ ' + Object.entries(value).map(([name, item]) => quote(name) + ' = ' + quote(item)).join(', ') + ' }' : quote(value);
      lines.push(key + ' = ' + text);
    }
    content = lines.join('\n') + '\n'; filename = 'iris-mcp.toml'; mediaType = 'text/plain';
  } else {
    configuration = format === 'entry' ? entry : { mcpServers: { iris: format === 'claude-json' ? { type: transport, ...entry } : entry } };
    content = JSON.stringify(configuration, null, 2) + '\n';
  }
  return { configuration, content, filename, mediaType };
}
