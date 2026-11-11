import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCoreCapabilityCatalog } from '../lib/core-capability-catalog.js';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-network-cli-'));
const file = path.join(root, 'network.json');
const providerFile = path.join(root, 'providers.json');
const guard = path.join(root, 'network-guard.mjs');
const traffic = path.join(root, 'unexpected-network.log');
const secrets = ['fixture-private-proxy-user', 'fixture-private-proxy-password', 'fixture-invalid-url-user', 'fixture-invalid-url-password'];
const env = {
  ...process.env,
  DSH_HOME: path.join(root, 'unused-dsh'),
  IRIS_HOME: path.join(root, 'unused-iris'),
  IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '', IRIS_CORE_SCOPES: '',
  IRIS_N1_CLI_USER: secrets[0], IRIS_N1_CLI_PASSWORD: secrets[1]
};
const checks = [];
const bytes = () => fs.readFileSync(file);
const revision = value => createHash('sha256').update(value).digest('hex');
const privateMode = target => {
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o077, 0, 'configuration and backups must stay private');
};
const cli = (args, { input, status = 0, config = file, json = true, overrides } = {}) => {
  const supplied = config === null ? args : [...args, '--network-config', config];
  // Log only command names: input JSON and positional/flag values can contain
  // credentials, even in rejection cases. Keep the existing 30-second budget.
  const command = args[0] === 'network' ? args.slice(0, ['nodes', 'pools'].includes(args[1]) ? 3 : 2).join(' ') : args[0];
  const sequence = checks.length + 1, started = performance.now(), wallStarted = Date.now();
  console.log('NETWORK_CONFIG_CLI ' + JSON.stringify({ event: 'start', sequence, command, timeoutMs: 30000 }));
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, 'bin/dsh-iris.js', ...supplied], {
    cwd, encoding: 'utf8', env: { ...env, ...overrides }, input, timeout: 30000
  });
  console.log('NETWORK_CONFIG_CLI ' + JSON.stringify({ event: 'end', sequence, command,
    elapsedMs: Math.round(performance.now() - started), wallElapsedMs: Date.now() - wallStarted,
    status: result.status, signal: result.signal, ...(result.error ? { errorCode: result.error.code } : {}) }));
  assert.equal(result.error, undefined, 'CLI must finish within its existing subprocess budget');
  assert.equal(result.signal, null, 'CLI must exit normally');
  assert.equal(result.status, status, `${supplied.slice(0, 3).join(' ')}: ${result.stderr}`);
  for (const secret of secrets) assert(!result.stdout.includes(secret) && !result.stderr.includes(secret), 'credentials must not appear in CLI output or diagnostics');
  checks.push({ command: args.slice(0, 3).join(' '), status: result.status });
  return json && status === 0 ? JSON.parse(result.stdout) : result;
};
const write = (kind, verb, value, options) => cli(['network', kind, verb, '--input', JSON.stringify(value)], options);
const mutate = (kind, verb, value, options) => {
  const before = bytes();
  const result = write(kind, verb, { expectedRevision: revision(before), ...value }, options);
  assert.equal(typeof result.backupPath, 'string', 'a changed configuration must retain the original private bytes');
  assert.deepEqual(fs.readFileSync(result.backupPath), before);
  privateMode(result.backupPath); privateMode(file);
  assert.equal(result.revision, revision(bytes()));
  return result;
};
const rejected = (kind, verb, value, code) => {
  const before = bytes();
  const result = write(kind, verb, { expectedRevision: revision(before), ...value }, { status: 1 });
  assert.match(result.stderr, new RegExp(code));
  assert.deepEqual(bytes(), before, 'rejected edits must preserve original configuration bytes');
  return result;
};

try {
  fs.writeFileSync(guard, [
    "import fs from 'node:fs';",
    `globalThis.fetch = () => { fs.appendFileSync(${JSON.stringify(traffic)}, 'fetch\\n'); throw new Error('network resource management must stay offline'); };`
  ].join('\n') + '\n', { mode: 0o600 });
  const originalProvider = Buffer.from(JSON.stringify({ providers: [{ id: 'unchanged-provider', apiKeyEnv: 'UNUSED_PROVIDER_KEY' }], assignments: {} }, null, 2) + '\n');
  fs.writeFileSync(providerFile, originalProvider, { mode: 0o600 });
  const beforeCatalog = createCoreCapabilityCatalog().snapshot({ audioEnabled: true, videoEnabled: true });

  const help = cli(['--help'], { config: null, json: false });
  assert.match(help.stdout, /network <init\|show\|check>/);
  const initial = cli(['network', 'init']);
  const seeded = JSON.parse(bytes());
  assert.equal(seeded.schemaVersion, 1); assert.equal(seeded.generation, 1);
  assert.match(seeded.configId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(seeded.nodes, []); assert.deepEqual(seeded.pools, []);
  privateMode(file);
  assert.equal(initial.revision, revision(bytes()));
  const shown = cli(['network', 'show']);
  assert.equal(shown.revision, revision(bytes()));
  assert.equal(shown.routingActive, false);

  const nodeInput = { expectedRevision: shown.revision, node: {
    id: 'local-proxy', label: 'Local proxy', protocol: 'http', host: '127.0.0.1', port: 7890,
    auth: { usernameEnv: 'IRIS_N1_CLI_USER', passwordEnv: 'IRIS_N1_CLI_PASSWORD' }
  } };
  const beforeNode = bytes();
  const node = cli(['network', 'nodes', 'add', '--input', '-'], { input: JSON.stringify(nodeInput) });
  assert.deepEqual(fs.readFileSync(node.backupPath), beforeNode); privateMode(node.backupPath);
  assert.equal(node.revision, revision(bytes()));
  assert.equal(node.nodes[0].id, 'local-proxy');
  assert.equal(node.nodes[0].credentialStatus, 'ready');
  assert.deepEqual(JSON.parse(bytes()).nodes[0].auth, nodeInput.node.auth);

  const beforeEnvironment = bytes();
  assert.equal(cli(['network', 'show'], { overrides: { IRIS_N1_CLI_PASSWORD: '' } }).nodes[0].credentialStatus, 'missing');
  assert.equal(cli(['network', 'show'], { overrides: { IRIS_N1_CLI_USER: 'invalid:user' } }).nodes[0].credentialStatus, 'invalid');
  assert.deepEqual(bytes(), beforeEnvironment, 'credential readiness must not resolve or persist environment values');

  const poolInput = path.join(root, 'pool-input.json');
  fs.writeFileSync(poolInput, JSON.stringify({ expectedRevision: node.revision, pool: {
    id: 'local-pool', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'local-proxy' }]
  } }), { mode: 0o600 });
  const beforePool = bytes();
  const pool = cli(['network', 'pools', 'add', '--input-file', poolInput]);
  assert.deepEqual(fs.readFileSync(pool.backupPath), beforePool); privateMode(pool.backupPath);
  assert.deepEqual(pool.pools[0].candidates, [{ kind: 'node', nodeId: 'local-proxy' }], 'configuration must not silently append direct fallback');
  assert.equal(cli(['network', 'nodes', 'list']).nodes.length, 1);
  assert.equal(cli(['network', 'pools', 'list']).pools.length, 1);
  const checked = cli(['network', 'check']);
  assert.equal(checked.valid, true); assert.equal(checked.networkTested, false); assert.equal(checked.routingActive, false);

  const beforeNoop = bytes(), generationBeforeNoop = JSON.parse(beforeNoop).generation;
  const backupsBeforeNoop = fs.readdirSync(root).filter(name => name.startsWith('network.json.backup-'));
  const unchanged = write('nodes', 'set', { expectedRevision: revision(beforeNoop), node: { id: 'local-proxy' } });
  assert.equal(unchanged.changed, false); assert.equal(unchanged.backupPath, undefined);
  assert.equal(unchanged.generation, generationBeforeNoop);
  assert.deepEqual(bytes(), beforeNoop);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('network.json.backup-')), backupsBeforeNoop);

  const current = mutate('nodes', 'set', { node: { id: 'local-proxy', enabled: false } });
  assert.equal(current.nodes[0].enabled, false);
  rejected('nodes', 'remove', { id: 'local-proxy', confirm: true }, 'IRIS_NETWORK_CONFIG_IN_USE');
  const stale = write('nodes', 'set', { expectedRevision: node.revision, node: { id: 'local-proxy', enabled: true } }, { status: 1 });
  assert.match(stale.stderr, /IRIS_NETWORK_CONFIG_CHANGED/);
  assert.equal(JSON.parse(bytes()).nodes[0].enabled, false);

  const manual = JSON.parse(bytes()); manual.nodes[0].label = 'Manual edit without generation bump';
  const priorManual = revision(bytes());
  fs.writeFileSync(file, JSON.stringify(manual, null, 2) + '\n', { mode: 0o600 });
  const manualBytes = bytes();
  const manualConflict = write('nodes', 'set', { expectedRevision: priorManual, node: { id: 'local-proxy', enabled: true } }, { status: 1 });
  assert.match(manualConflict.stderr, /IRIS_NETWORK_CONFIG_CHANGED/);
  assert.deepEqual(bytes(), manualBytes, 'raw-byte revisions must also detect an external edit without a generation change');

  fs.writeFileSync(file + '.lock', 'owned by another writer\n', { mode: 0o600 });
  rejected('nodes', 'set', { node: { id: 'local-proxy', enabled: true } }, 'IRIS_NETWORK_CONFIG_BUSY');
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'owned by another writer\n', 'an unknown writer lock must not be removed or stolen');
  fs.unlinkSync(file + '.lock');

  rejected('nodes', 'add', { node: { id: 'invalid-url', protocol: 'http', host: `http://${secrets[2]}:${secrets[3]}@127.0.0.1`, port: 7890 } }, 'IRIS_NETWORK_CONFIG_INVALID');
  rejected('nodes', 'add', { node: { id: 'invalid-label', protocol: 'http', host: '127.0.0.1', port: 7890, label: `Bearer ${secrets[1]}\n` } }, 'IRIS_NETWORK_CONFIG_INVALID');
  const invalidJson = cli(['network', 'nodes', 'add', '--input', `{"password":"${secrets[1]}"`], { status: 2 });
  assert.match(invalidJson.stderr, /IRIS_CLI_USAGE/);
  cli(['network', 'show', '--input', '{}'], { status: 2 });
  cli(['network', 'show', '--unsupported-flag', 'true'], { status: 2 });
  const credentialUrl = `http://${secrets[2]}:${secrets[3]}@127.0.0.1:7890`;
  const beforeUrlArguments = bytes();
  const backupsBeforeUrlArguments = fs.readdirSync(root).filter(name => name.startsWith('network.json.backup-'));
  for (const args of [[credentialUrl], ['--' + credentialUrl, 'true']]) {
    const rejectedUrl = cli(['network', 'show', ...args], { status: 2 });
    assert(!rejectedUrl.stdout.includes(credentialUrl) && !rejectedUrl.stderr.includes(credentialUrl), 'invalid positional arguments and flags must not echo a credential-bearing URL');
    assert.deepEqual(bytes(), beforeUrlArguments);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('network.json.backup-')), backupsBeforeUrlArguments);
  }
  cli(['network', 'nodes', 'add'], { status: 2 });
  const existing = bytes();
  cli(['network', 'init'], { status: 1 });
  assert.deepEqual(bytes(), existing, 'init must never overwrite an existing configuration');
  cli(['network', 'show'], { status: 1, config: 'relative-network.json' });
  const absent = path.join(root, 'not-created.json');
  cli(['network', 'show'], { status: 1, config: absent });
  assert.equal(fs.existsSync(absent), false, 'read does not initialize missing configuration');

  const future = path.join(root, 'future.json');
  const futureBytes = Buffer.from(JSON.stringify({ ...JSON.parse(bytes()), schemaVersion: 999 }) + '\n');
  fs.writeFileSync(future, futureBytes, { mode: 0o600 });
  assert.match(cli(['network', 'show'], { config: future, status: 1 }).stderr, /IRIS_NETWORK_CONFIG_VERSION/);
  assert.match(write('nodes', 'add', { expectedRevision: revision(futureBytes), node: { id: 'future-edit', protocol: 'http', host: '127.0.0.1', port: 7891 } }, { config: future, status: 1 }).stderr, /IRIS_NETWORK_CONFIG_VERSION/);
  assert.deepEqual(fs.readFileSync(future), futureBytes);

  const ordered = mutate('pools', 'set', { pool: { id: 'local-pool', mode: 'ordered', candidates: [{ kind: 'node', nodeId: 'local-proxy' }, { kind: 'direct' }] } });
  assert.deepEqual(ordered.pools[0].candidates, [{ kind: 'node', nodeId: 'local-proxy' }, { kind: 'direct' }]);
  rejected('pools', 'remove', { id: 'local-pool' }, 'IRIS_NETWORK_CONFIG_INVALID');
  mutate('pools', 'remove', { id: 'local-pool', confirm: true });
  const removed = mutate('nodes', 'remove', { id: 'local-proxy', confirm: true });
  assert.deepEqual(removed.nodes, []); assert.deepEqual(removed.pools, []);

  assert.deepEqual(fs.readFileSync(providerFile), originalProvider, 'network resource edits must not migrate or edit Provider configuration');
  assert.deepEqual(createCoreCapabilityCatalog().snapshot({ audioEnabled: true, videoEnabled: true }), beforeCatalog, 'network owner management must not add MCP capabilities or scopes');
  for (const secret of secrets) {
    assert(!bytes().includes(Buffer.from(secret)));
    for (const name of fs.readdirSync(root).filter(name => name.startsWith('network.json.backup-'))) assert(!fs.readFileSync(path.join(root, name)).includes(Buffer.from(secret)), 'private backups must retain references, never environment values');
  }
  assert.equal(fs.existsSync(traffic), false, 'all resource commands must remain offline');
  assert.equal(fs.existsSync(env.DSH_HOME), false); assert.equal(fs.existsSync(env.IRIS_HOME), false);
  console.log(JSON.stringify({ ok: true, cliCalls: checks.length, checks: [
    'real CLI handles private input files, stdin and help without touching daily DSH/Core state',
    'node and fixed/ordered pool edits retain exact private backups, explicit direct candidates and reference protection',
    'stale or externally edited revisions, unknown locks and future versions fail without overwriting bytes',
    'invalid JSON and credential-bearing host diagnostics never expose credentials',
    'configuration stays offline and does not grant MCP tools or change Provider configuration'
  ] }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
