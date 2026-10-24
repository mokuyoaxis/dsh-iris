import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { exportMcpConfiguration } from '../lib/mcp-config.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-config'), dataRoot = path.join(root, 'core');
const app = createApplicationRuntime({ dataRoot }), cli = path.resolve('bin/dsh-iris.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, IRIS_CORE_CONNECTION_FILE: '' } });
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const paired = run('connection', 'create', '--data-root', dataRoot, '--directory', path.join(root, 'generic pair'),
    '--origin', 'http://127.0.0.1:3182', '--label', 'Generic MCP', '--capabilities', 'image-edit', '--tools', 'iris_core_models,iris_core_connections');
  assert.equal(paired.status, 0, paired.stderr);
  const pair = JSON.parse(paired.stdout); assert.equal(pair.harnessKind, 'generic');
  const before = fs.readFileSync(pair.clientFile), token = JSON.parse(before).accessToken;
  const config = exportMcpConfiguration({ connectionFile: pair.clientFile });
  assert.equal(config.mcpServers.iris.command, process.execPath);
  assert(config.mcpServers.iris.args.includes(pair.clientFile));
  assert(!JSON.stringify(config).includes(token));
  const selected = run('mcp', 'config', '--connection-file', pair.clientFile, '--capabilities', 'none', '--tools', 'iris_core_connections', '--format', 'entry');
  assert.equal(selected.status, 0, selected.stderr); assert(JSON.parse(selected.stdout).args.includes('none'));
  const discovered = run('mcp', 'capabilities'); assert.equal(discovered.status, 0);
  assert.deepEqual(JSON.parse(discovered.stdout).implementedMedia, ['image-edit/v0']);
  assert.throws(() => exportMcpConfiguration({ connectionFile: pair.clientFile, tools: ['iris_core_continue'] }), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED' });
  assert.throws(() => exportMcpConfiguration({ connectionFile: pair.clientFile, capabilities: ['video'] }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  assert.throws(() => exportMcpConfiguration({ connectionFile: pair.clientFile, transport: 'http' }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  const file = path.join(path.dirname(pair.clientFile), 'mcp-http.json');
  const exported = run('mcp', 'config', '--connection-file', pair.clientFile, '--transport', 'http', '--output', file);
  assert.equal(exported.status, 0, exported.stderr); assert(!exported.stdout.includes(token)); assert(!exported.stderr.includes(token));
  const httpConfig = JSON.parse(fs.readFileSync(file));
  assert.equal(httpConfig.mcpServers.iris.url, 'http://127.0.0.1:3182/mcp');
  assert.equal(httpConfig.mcpServers.iris.headers.Authorization, 'Bearer ' + token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const bytes = fs.readFileSync(file);
  assert.throws(() => exportMcpConfiguration({ connectionFile: pair.clientFile, transport: 'http', output: file }), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => exportMcpConfiguration({ connectionFile: pair.clientFile, transport: 'http', output: path.join(root, 'outside.json') }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  assert.throws(() => exportMcpConfiguration({ connectionFile: pair.clientFile, transport: 'http', scopes: ['read'], output: path.join(path.dirname(pair.clientFile), 'other.json') }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  assert.deepEqual(fs.readFileSync(pair.clientFile), before);
  const native = createConnectionPair({ dataRoot, directory: path.join(root, 'native'), origin: 'http://127.0.0.1:3182', label: 'DSH', harnessKind: 'dsh' });
  assert.throws(() => exportMcpConfiguration({ connectionFile: native.clientFile }), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  const duplicate = run('api', 'serve', '--allow-mcp', '--allow-mcp'); assert.equal(duplicate.status, 2);
  assert(!JSON.stringify([selected.stdout, discovered.stdout, exported.stdout, duplicate.stderr]).includes(token));
  console.log('PASS generic CLI default, finite capability discovery, portable absolute stdio export, selected tools, private HTTP config, no overwrite and zero credential stdout');
} finally { await app.dispose(); }
