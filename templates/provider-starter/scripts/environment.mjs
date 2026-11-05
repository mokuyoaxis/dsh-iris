// Public CLI/HTTP acceptance. No private Core imports, Task writes or alternate queues.
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { setup } from './setup.mjs';
import { coreCli, cleanEnvironment, runCli } from './core-cli.mjs';
import { createFixture } from './fixture.mjs';

export const credentialEnv = 'IRIS_B4_STARTER_FIXTURE_KEY';
export const syntheticKey = 'synthetic-b4-starter-key';
export async function createEnvironment({ proxyUrl } = {}) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'iris-provider-starter-')); await chmod(work, 0o700);
  // Windows kill(SIGTERM) forces termination; exercise the public CLI's normal
  // shutdown handler through the same isolated IPC preload used by Core tests.
  const cooperativeSignals = process.platform === 'win32' || process.env.IRIS_TEST_CLI_SIGNAL_MODE === 'ipc';
  const signalPreload = path.join(work, 'signal-preload.mjs');
  if (cooperativeSignals) await writeFile(signalPreload, `process.on('message', message => {
  if (message === 'iris-test-sigterm' && !process.emit('SIGTERM')) throw new Error('CLI SIGTERM handler is not installed');
});
process.channel.unref();
`, { mode: 0o600 });
  const fixture = await createFixture();
  const prepared = await setup({ directory: path.join(work, 'demo'), endpoint: fixture.origin, credentialEnv });
  let networkConfigPath;
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
      'acceptance proxy must be an explicit credential-free loopback HTTP URL');
    networkConfigPath = path.join(work, 'network.json');
    const command = (...args) => runCli(['network', ...args, '--network-config', networkConfigPath]);
    let value = await command('routing', 'init');
    value = await command('nodes', 'add', '--input', JSON.stringify({ expectedRevision: value.revision,
      node: { id: 'fixture-net', protocol: 'http', host: '127.0.0.1', port: Number(url.port) } }));
    value = await command('pools', 'add', '--input', JSON.stringify({ expectedRevision: value.revision,
      pool: { id: 'fixture-pool', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'fixture-net' }] } }));
    const routed = path.join(prepared.directory, 'providers-routed.json');
    await command('catalog', 'create', '--provider-config', prepared.providerConfigPath, '--output', routed);
    await command('bindings', 'set', '--provider-config', routed, '--input', JSON.stringify({ expectedRevision: value.revision, providerId: 'wan-reference', poolId: 'fixture-pool' }));
    prepared.providerConfigPath = routed;
  }
  const scheduler = path.join(work, 'scheduler.json');
  const event = (phase, detail = {}) => appendFile(path.join(work, 'events.jsonl'), JSON.stringify({ phase, at: new Date().toISOString(), ...detail }) + '\n', { mode: 0o600 });
  await writeFile(scheduler, JSON.stringify({ schemaVersion: 1, httpConcurrency: 2, requestsPerSecond: 100, remoteLimit: 4 }), { mode: 0o600 });
  let child, exited, exit, started, sequence = 0, serviceStderr = () => '';
  async function start({ present = true, version, key = syntheticKey } = {}) {
    await event('starting', { present, ...(version ? { version } : {}) });
    let entry = prepared.entry;
    if (version) {
      entry = path.join(work, 'version-' + version + '.mjs');
      // Wrap this external template, never a private Iris implementation.
      await writeFile(entry, `import plugin from ${JSON.stringify(pathToFileURL(prepared.entry).href)};\nexport default { ...plugin, manifest: { ...plugin.manifest, version: ${JSON.stringify(version)} } };\n`, { mode: 0o600 });
    }
    await writeFile(prepared.configPath, JSON.stringify({ schemaVersion: 0, entries: present ? [entry] : [] }) + '\n', { mode: 0o600 });
    const tokenFile = path.join(work, 'owner-' + (++sequence)); let stdout = '', stderr = ''; exited = false;
    serviceStderr = () => stderr;
    child = spawn(process.execPath, [...(cooperativeSignals ? ['--import', pathToFileURL(signalPreload).href] : []), coreCli, 'web', 'serve', '--data-root', prepared.dataRoot,
      '--plugin-config', prepared.configPath, '--provider-config', prepared.providerConfigPath, '--allow-execution', '--allow-provider-management',
      '--connection-store', prepared.connectionStore, '--allow-connection-management', '--allow-mcp',
      '--scheduler-config', scheduler, '--token-file', tokenFile, ...(networkConfigPath ? ['--network-config', networkConfigPath] : [])], {
      stdio: ['ignore', 'pipe', 'pipe', ...(cooperativeSignals ? ['ipc'] : [])], env: { ...cleanEnvironment(), [credentialEnv]: key }
    });
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    exit = new Promise(resolve => child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); }));
    const deadline = performance.now() + 15000;
    while (!stdout.includes('\n') && !exited && performance.now() < deadline) await delay(10);
    assert(stdout.includes('\n'), 'Core CLI startup failed: ' + stderr);
    started = { ...JSON.parse(stdout.split('\n')[0]), accessToken: (await readFile(tokenFile, 'utf8')).trim() };
    await event('started', { pid: child.pid });
    child.once('close', () => { void writeFile(path.join(work, 'service-' + sequence + '.stderr.log'), stderr, { mode: 0o600 }); });
    return started;
  }
  async function stop() {
    if (child) await event('stopping', { pid: child.pid });
    if (child && !exited) {
      if (cooperativeSignals) child.send('iris-test-sigterm');
      else child.kill('SIGTERM');
    }
    if (child) {
      const result = await Promise.race([exit, delay(10000, undefined, { ref: false }).then(() => { throw new Error('Core CLI did not close within 10 seconds'); })]);
      assert.equal(result.code, 143, JSON.stringify({ ...result, stderr: serviceStderr(), work }));
      await event('stopped', result);
    }
    child = undefined;
  }
  async function raw(route, { value, key, headers, method = value === undefined ? 'GET' : 'POST' } = {}) {
    // Each restarted service is a distinct acceptance instance; never reuse its predecessor's idle socket.
    return fetch(started.origin + route, { method, headers: { Connection: 'close', Authorization: 'Bearer ' + started.accessToken,
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(20000) });
  }
  async function http(route, options, expected = 200) {
    const response = await raw(route, options), value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value)); assert(!JSON.stringify(value).includes(syntheticKey)); return value;
  }
  async function terminal(id) {
    for (let i = 0; i < 500; i++) {
      const operation = (await http('/api/v0/operations/' + id)).operation;
      if (!['queued', 'running'].includes(operation.state)) return operation;
      await delay(10);
    }
    assert.fail('Operation did not finish');
  }
  const base = '/api/v0/connection-management/connections';
  const listConnections = async () => (await http(base)).connections;
  async function connection(capabilities = ['image-generate']) {
    const value = await http(base, { value: { key: crypto.randomUUID(), label: 'Provider starter acceptance',
      scopes: ['read', 'create', 'execute', 'stop'], capabilities } }, 201);
    return (await listConnections()).find(record => record.connectionId === value.connectionId);
  }
  const exported = async record => (await http(base + '/' + record.connectionId + '/export', { value: { transport: 'http', format: 'entry' } })).configuration;
  async function reduce(record) {
    const current = (await listConnections()).find(item => item.connectionId === record.connectionId);
    return http(base + '/' + record.connectionId + '/update', { value: { expectedRevision: current.revision, label: current.label,
      scopes: ['read'], capabilities: current.capabilities, tools: current.tools, pluginOperations: current.pluginOperations } });
  }
  return { work, prepared, fixture, start, stop, raw, http, terminal, connection, exported, reduce,
    get started() { return started; }, async close() { try { await stop(); } finally { await fixture.close(); } } };
}
