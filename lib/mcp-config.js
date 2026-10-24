import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedClientConnection, readPrivateConnectionJson, checkedConnectionScopes, connectionFail } from './core-connections.js';
import { checkedBridgeCapabilities, checkedBridgeTools, selectedBridgeTools } from './core-bridge-selection.js';

/** Export configuration only. Never starts Core, contacts a Provider, or edits a harness configuration. */
export function exportMcpConfiguration({ connectionFile, scopes, capabilities, tools, transport = 'stdio', format = 'mcpServers', output } = {}) {
  const connection = checkedClientConnection(readPrivateConnectionJson(connectionFile));
  if (connection.adapterId !== 'iris.mcp') connectionFail('IRIS_CONNECTION_INPUT_INVALID', '请选择 MCP 连接文件');
  if (!['stdio', 'http'].includes(transport) || !['mcpServers', 'entry'].includes(format)) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '配置格式或传输方式无效');
  let entry;
  if (transport === 'stdio') {
    if (scopes === undefined) scopes = ['read']; checkedConnectionScopes(scopes);
    if (capabilities === undefined) capabilities = connection.capabilities; checkedBridgeCapabilities(capabilities);
    if (tools === undefined) tools = selectedBridgeTools(capabilities, connection.tools); checkedBridgeTools(tools);
    if (capabilities.some(id => !connection.capabilities.includes(id)) || tools.some(name => !connection.tools.includes(name) || !selectedBridgeTools(capabilities).includes(name))) {
      connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '导出配置不能扩大连接的功能或工具范围');
    }
    entry = { command: process.execPath, args: [fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url)), 'mcp', 'serve',
      '--connection-file', path.resolve(connectionFile), '--scopes', scopes.join(','),
      '--capabilities', capabilities.length ? capabilities.join(',') : 'none', '--tools', tools.length ? tools.join(',') : 'none'] };
  } else {
    if (scopes !== undefined || capabilities !== undefined || tools !== undefined) connectionFail('IRIS_CONNECTION_INPUT_INVALID', 'HTTP 的功能/工具/权限在创建连接授权时选择；请导出该专用连接');
    if (!output) connectionFail('IRIS_CONNECTION_INPUT_INVALID', 'HTTP 配置含认证信息，需要明确的新私有输出文件，不写入 stdout');
    entry = { url: connection.origin + '/mcp', headers: { Authorization: 'Bearer ' + connection.accessToken } };
  }
  const config = format === 'entry' ? entry : { mcpServers: { iris: entry } };
  if (!output) return config;
  if (!path.isAbsolute(output)) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '配置输出必须是新的绝对路径');
  if (transport === 'http') {
    const parent = fs.realpathSync(path.dirname(output)), privateParent = fs.realpathSync(path.dirname(connectionFile));
    if (parent !== privateParent || process.platform !== 'win32' && fs.statSync(parent).mode & 0o077) {
      connectionFail('IRIS_CONNECTION_INPUT_INVALID', '含认证信息的配置只导出到原连接的私有目录');
    }
  }
  fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { contractVersion: 0, transport, format, output, containsCredentials: transport === 'http', configurationOnly: true };
}
