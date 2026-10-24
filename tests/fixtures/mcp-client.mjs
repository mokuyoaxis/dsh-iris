// Test client only. The server under test is the production official-SDK npm entry.
import { spawn } from 'node:child_process';
export function stdioMcpClient(cli, connectionFile, scopes = 'read', { version = '2025-11-25', extraArgs = [], name = 'iris-acceptance-client', launch } = {}) {
  const child = spawn(launch?.command || process.execPath, launch?.args || [cli, 'mcp', 'serve', '--connection-file', connectionFile, '--scopes', scopes, ...extraArgs],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '' } });
  let sequence = 0, input = '', stdout = '', stderr = '', closed = false;
  const pending = new Map();
  child.stdout.on('data', bytes => {
    stdout += bytes; input += bytes;
    for (;;) {
      const end = input.indexOf('\n'); if (end < 0) break;
      const line = input.slice(0, end); input = input.slice(end + 1); if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (error) { for (const job of pending.values()) job.reject(error); pending.clear(); return; }
      const job = pending.get(message.id);
      if (job) { pending.delete(message.id); clearTimeout(job.timer); message.error ? job.reject(Object.assign(new Error(message.error.message), { rpcCode: message.error.code })) : job.resolve(message.result); }
    }
  });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exit = new Promise(resolve => child.once('close', (status, signal) => {
    closed = true;
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('MCP child closed: ' + status + '/' + signal + ': ' + stderr)); }
    pending.clear(); resolve({ status, signal });
  }));
  function request(method, params) {
    if (version === '2026-07-28') params = { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name, version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    } };
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      if (closed) { reject(new Error('MCP process already closed')); return; }
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out: ' + method)); }, 20000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  async function initialize() {
    if (version === '2026-07-28') return request('server/discover', {});
    const hello = await request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name, version: '1.0.0' } });
    notify('notifications/initialized'); return hello;
  }
  async function close() { if (!closed) child.stdin.end(); return exit; }
  async function kill() { if (!closed) child.kill('SIGKILL'); return exit; }
  return { child, request, notify, initialize, close, kill, output: () => ({ stdout, stderr }), call: (name, args) => request('tools/call', { name, arguments: args }) };
}
