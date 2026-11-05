import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
import { executeNetworkConfigCommand } from '../lib/network-config-service.js';
import { validateNetworkConfig, networkNodeCredentialStatus } from '../lib/network-config.js';

const { root } = useTempDshHome('iris-network-config');
const file = path.join(root, 'network.json');
const providerFile = path.join(root, 'providers.json');
const providerBytes = Buffer.from('{"providers":[],"assignments":{},"preserve":"existing-provider-file"}\n');
fs.writeFileSync(providerFile, providerBytes, { mode: 0o600 });
const checks = [], originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = () => { fetchCalls++; throw new Error('configuration must not use the network'); };
const username = 'fixture-private-user', password = 'fixture-private-password';
const env = { IRIS_TEST_PROXY_USER: username, IRIS_TEST_PROXY_PASS: password };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const disk = () => JSON.parse(fs.readFileSync(file));
const view = () => executeNetworkConfigCommand(file, 'show', {}, { env });
const backups = () => fs.readdirSync(root).filter(name => name.startsWith('network.json.backup-'));
const code = token => error => typeof error?.code === 'string' && error.code.startsWith('IRIS_NETWORK_') && error.code.includes(token);
const secure = value => {
  const text = JSON.stringify(value);
  assert(!text.includes(username)); assert(!text.includes(password));
};
const edit = async (command, input) => {
  const before = disk(), current = await view();
  const result = await executeNetworkConfigCommand(file, command, { expectedRevision: current.revision, ...input }, { env });
  secure(result);
  assert.equal(result.revision, sha(fs.readFileSync(file)));
  assert.equal(disk().configId, before.configId);
  return result;
};
const denied = async (command, input, expected) => {
  const before = fs.readFileSync(file), names = backups();
  await assert.rejects(async () => executeNetworkConfigCommand(file, command, input, { env }), expected);
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(backups(), names);
};

try {
  await assert.rejects(async () => executeNetworkConfigCommand('relative-network.json', 'init'), code('INVALID'));
  assert(!fs.existsSync(file));
  const initial = await executeNetworkConfigCommand(file, 'init', {}, { env });
  const first = await view(), initialBytes = fs.readFileSync(file);
  assert.equal(disk().schemaVersion, 1);
  assert.match(first.configId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert(Number.isSafeInteger(first.generation));
  assert.equal(first.revision, sha(initialBytes));
  assert.deepEqual(first.nodes, []); assert.deepEqual(first.pools, []);
  secure(initial);
  await assert.rejects(async () => executeNetworkConfigCommand(file, 'init', {}, { env }));
  assert.deepEqual(fs.readFileSync(file), initialBytes);
  const checked = await executeNetworkConfigCommand(file, 'check', {}, { env });
  assert.equal(checked.valid, true); assert.equal(fetchCalls, 0);
  checks.push('explicit private initialization is exclusive, versioned and independent of the original Provider file; show/check never fetch');

  const beforeNodeGeneration = disk().generation;
  let current = await edit('nodes.add', { node: { id: 'clash-local', label: 'Local mixed-port', protocol: 'http', host: '127.0.0.1', port: 7890 } });
  assert.equal(disk().generation, beforeNodeGeneration + 1);
  assert.equal(current.nodes[0].id, 'clash-local');
  assert.equal(disk().nodes[0].port, 7890);
  await edit('nodes.add', { node: { id: 'proxy-remote', label: 'Remote TLS proxy', protocol: 'https', host: 'proxy.example.invalid', port: 8443,
    auth: { usernameEnv: 'IRIS_TEST_PROXY_USER', passwordEnv: 'IRIS_TEST_PROXY_PASS' } } });
  await edit('nodes.add', { node: { id: 'ipv6-local', protocol: 'http', host: '::1', port: 7891 } });
  assert.equal(disk().nodes.find(node => node.id === 'ipv6-local').label, 'ipv6-local');
  const authenticated = disk().nodes.find(node => node.id === 'proxy-remote');
  assert.equal(networkNodeCredentialStatus(authenticated, env), 'ready');
  assert.equal(networkNodeCredentialStatus(authenticated, {}), 'missing');
  assert.equal(networkNodeCredentialStatus(authenticated, { ...env, IRIS_TEST_PROXY_PASS: 'unsafe\nvalue' }), 'invalid');
  assert.deepEqual(authenticated.auth, { usernameEnv: 'IRIS_TEST_PROXY_USER', passwordEnv: 'IRIS_TEST_PROXY_PASS' });
  await edit('nodes.set', { node: { id: 'proxy-remote', label: 'Renamed without replacing authentication' } });
  assert.deepEqual(disk().nodes.find(node => node.id === 'proxy-remote').auth, authenticated.auth);
  for (const name of fs.readdirSync(root).filter(name => name.startsWith('network.json'))) secure(fs.readFileSync(path.join(root, name), 'utf8'));
  checks.push('HTTP/HTTPS/IPv6 nodes keep stable IDs and preserve explicit environment references through partial edits without persisting or projecting values');

  const nodeInput = { id: 'invalid', protocol: 'http', host: '127.0.0.1', port: 7890 };
  for (const patch of [{ protocol: 'socks5' }, { port: 0 }, { port: 65536 }, { port: 3.5 }, { host: 'http://127.0.0.1' },
    { host: 'user:pass@proxy.invalid' }, { host: 'proxy.invalid/path' }, { host: 'proxy.invalid?secret=hidden' },
    { auth: { username: username, password } }, { auth: { usernameEnv: 'IRIS_TEST_PROXY_USER' } },
    { auth: { usernameEnv: 'BAD-NAME', passwordEnv: 'IRIS_TEST_PROXY_PASS' } }, { enabled: 'true' }, { label: null }, { unexpected: true }]) {
    current = await view();
    await denied('nodes.add', { expectedRevision: current.revision, node: { ...nodeInput, ...patch } }, code('INVALID'));
  }
  current = await view();
  await denied('nodes.add', { expectedRevision: current.revision, node: { ...nodeInput, id: 'clash-local' } }, code('EXISTS'));
  await denied('nodes.set', { expectedRevision: current.revision, node: { id: 'absent', label: 'not created by typo' } });
  checks.push('invalid protocols, address/userinfo/path injection, ports, auth shapes and duplicate IDs are rejected without writes or backups');

  await edit('pools.add', { pool: { id: 'fixed-local', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'clash-local' }] } });
  await edit('pools.add', { pool: { id: 'ordered-explicit', mode: 'ordered', candidates: [
    { kind: 'node', nodeId: 'proxy-remote' }, { kind: 'node', nodeId: 'clash-local' }, { kind: 'direct' }
  ] } });
  await edit('pools.add', { pool: { id: 'draft-empty', mode: 'fixed', candidates: [] } });
  assert.equal(disk().pools.find(pool => pool.id === 'draft-empty').label, 'draft-empty');
  assert.deepEqual(disk().pools.find(pool => pool.id === 'ordered-explicit').candidates, [
    { kind: 'node', nodeId: 'proxy-remote' }, { kind: 'node', nodeId: 'clash-local' }, { kind: 'direct' }
  ]);
  assert.deepEqual(disk().pools.find(pool => pool.id === 'draft-empty').candidates, []);
  current = await view();
  assert.equal(current.routingActive, false); assert.equal(current.pools.find(pool => pool.id === 'draft-empty').status, 'empty');
  assert.deepEqual((await executeNetworkConfigCommand(file, 'nodes.list', {}, { env })).nodes, current.nodes);
  assert.deepEqual((await executeNetworkConfigCommand(file, 'pools.list', {}, { env })).pools, current.pools);
  const poolInput = { id: 'bad-pool', mode: 'ordered', candidates: [] };
  for (const patch of [{ mode: 'random' }, { mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'clash-local' }, { kind: 'direct' }] },
    { candidates: [{ kind: 'node', nodeId: 'absent' }] },
    { candidates: [{ kind: 'node', nodeId: 'clash-local' }, { kind: 'node', nodeId: 'clash-local' }] },
    { candidates: [{ kind: 'direct' }, { kind: 'direct' }] }, { candidates: [{ kind: 'direct', nodeId: 'clash-local' }] },
    { candidates: Array.from({ length: 17 }, () => ({ kind: 'direct' })) }, { label: null }, { additional: true }]) {
    current = await view();
    await denied('pools.add', { expectedRevision: current.revision, pool: { ...poolInput, ...patch } }, code('INVALID'));
  }
  checks.push('fixed and ordered pools preserve explicit candidate order/direct choice, allow empty drafts and reject missing or duplicate references');

  await edit('nodes.set', { node: { id: 'clash-local', enabled: false } });
  assert.equal(disk().pools.find(pool => pool.id === 'fixed-local').candidates[0].nodeId, 'clash-local');
  current = await view();
  assert.equal(current.pools.find(pool => pool.id === 'fixed-local').status, 'unavailable');
  await denied('nodes.remove', { expectedRevision: current.revision, id: 'clash-local', confirm: true }, code('IN_USE'));
  await edit('pools.set', { pool: { id: 'fixed-local', enabled: false } });
  current = await view();
  assert.equal(current.pools.find(pool => pool.id === 'fixed-local').status, 'disabled');
  await denied('nodes.remove', { expectedRevision: current.revision, id: 'clash-local', confirm: true }, code('IN_USE'));
  await edit('pools.remove', { id: 'fixed-local', confirm: true });
  await edit('pools.set', { pool: { id: 'ordered-explicit', candidates: [{ kind: 'node', nodeId: 'proxy-remote' }, { kind: 'direct' }] } });
  await edit('nodes.remove', { id: 'clash-local', confirm: true });
  assert(!disk().nodes.some(node => node.id === 'clash-local'));
  await edit('nodes.set', { node: { id: 'proxy-remote', auth: null } });
  assert.equal(disk().nodes.find(node => node.id === 'proxy-remote').auth, undefined);
  current = await view();
  await denied('pools.remove', { expectedRevision: current.revision, id: 'draft-empty', confirm: false }, code('INVALID'));
  checks.push('disabled references remain intact and block node deletion; explicit pool edits release references, and credential removal is explicit');

  current = await view();
  const sameBefore = fs.readFileSync(file), sameBackups = backups();
  const same = await executeNetworkConfigCommand(file, 'nodes.set', { expectedRevision: current.revision, node: { id: 'proxy-remote', label: 'Renamed without replacing authentication' } }, { env });
  assert.equal(same.changed, false); assert.equal(same.revision, current.revision); assert.deepEqual(fs.readFileSync(file), sameBefore);
  assert.deepEqual(backups(), sameBackups);
  const stale = current.revision;
  await edit('nodes.set', { node: { id: 'proxy-remote', label: 'New owner edit' } });
  await denied('nodes.set', { expectedRevision: stale, node: { id: 'proxy-remote', label: 'stale overwrite' } }, code('CHANGED'));
  current = await view();
  fs.appendFileSync(file, '\n');
  await denied('nodes.set', { expectedRevision: current.revision, node: { id: 'proxy-remote', label: 'overwrite manual edit' } }, code('CHANGED'));
  current = await view();
  assert.equal(current.revision, sha(fs.readFileSync(file)));
  checks.push('identical patches do not rewrite or back up; revision hashes reject both stale owner edits and manual byte edits without generation changes');

  const lock = file + '.lock', lockBytes = Buffer.from('unknown-lock-owner-evidence');
  fs.writeFileSync(lock, lockBytes, { mode: 0o600, flag: 'wx' });
  await denied('nodes.set', { expectedRevision: current.revision, node: { id: 'proxy-remote', label: 'must wait for owner' } }, code('BUSY'));
  assert.deepEqual(fs.readFileSync(lock), lockBytes); fs.unlinkSync(lock);
  const beforeFailure = fs.readFileSync(file), failedBackups = backups(), rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('controlled atomic commit failure at ' + file), { code: 'EIO', syscall: 'rename', path: from, dest: to }); return rename(from, to); };
    await assert.rejects(async () => executeNetworkConfigCommand(file, 'nodes.set', { expectedRevision: current.revision,
      node: { id: 'proxy-remote', label: 'uncommitted edit' } }, { env }), error => error.code === 'IRIS_NETWORK_CONFIG_IO' && !error.message.includes(root));
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), beforeFailure);
  assert(!fs.existsSync(lock));
  const addedBackups = backups().filter(name => !failedBackups.includes(name));
  assert.equal(addedBackups.length, 1); assert.deepEqual(fs.readFileSync(path.join(root, addedBackups[0])), beforeFailure);
  checks.push('an unknown lock is preserved; atomic replacement failure keeps original bytes and generation, retains a private backup and releases only its own lock');

  // Another owner can replace the file after our first read but before the
  // short write lock is held. The lock must not turn that stale read into a save.
  for (const newerVersion of [false, true]) {
    const raced = path.join(root, 'raced-' + crypto.randomUUID() + '.json');
    const original = fs.readFileSync(file); fs.writeFileSync(raced, original, { mode: 0o600 });
    const competing = newerVersion ? Buffer.from(JSON.stringify({ ...JSON.parse(original), schemaVersion: 999 }) + '\n')
      : Buffer.from(original.toString() + '\n');
    const open = fs.openSync;
    try {
      fs.openSync = (target, flags, ...args) => {
        if (target === raced + '.lock' && flags === 'wx') fs.writeFileSync(raced, competing);
        return open(target, flags, ...args);
      };
      await assert.rejects(async () => executeNetworkConfigCommand(raced, 'nodes.set', { expectedRevision: sha(original),
        node: { id: 'proxy-remote', label: 'must not overwrite competing owner' } }, { env }), code(newerVersion ? 'VERSION' : 'CHANGED'));
    } finally { fs.openSync = open; }
    assert.deepEqual(fs.readFileSync(raced), competing); assert(!fs.existsSync(raced + '.lock'));
    assert(!fs.readdirSync(root).some(name => name.startsWith(path.basename(raced) + '.backup-')));
  }
  const canceled = new AbortController(); canceled.abort();
  const canceledPath = path.join(root, 'canceled-init.json');
  await assert.rejects(async () => executeNetworkConfigCommand(canceledPath, 'init', {}, { signal: canceled.signal, env }), { name: 'AbortError' });
  assert(!fs.existsSync(canceledPath));
  current = await view();
  const beforeCancel = fs.readFileSync(file);
  await assert.rejects(async () => executeNetworkConfigCommand(file, 'nodes.set', { expectedRevision: current.revision,
    node: { id: 'proxy-remote', enabled: false } }, { signal: canceled.signal, env }), { name: 'AbortError' });
  assert.deepEqual(fs.readFileSync(file), beforeCancel);
  checks.push('the locked reread rejects a competing byte edit or future schema before backup/write, and cancellation has no initialization or mutation side effects');

  // This host is an explicit owner-supplied value. Matching an independently
  // configured environment password must not make the display reveal it.
  const projectedFile = path.join(root, 'projection-fixture.json');
  const sharedHostValue = 'synthetic-password-host.example.invalid';
  const projectedEnv = { IRIS_REVIEW_PROXY_USER: 'synthetic-review-user', IRIS_REVIEW_PROXY_PASS: sharedHostValue };
  const projectedInitial = await executeNetworkConfigCommand(projectedFile, 'init', {}, { env: projectedEnv });
  const projected = await executeNetworkConfigCommand(projectedFile, 'nodes.add', { expectedRevision: projectedInitial.revision,
    node: { id: 'projection-fixture', protocol: 'https', host: sharedHostValue, port: 8443,
      auth: { usernameEnv: 'IRIS_REVIEW_PROXY_USER', passwordEnv: 'IRIS_REVIEW_PROXY_PASS' } } }, { env: projectedEnv });
  const projectedRaw = fs.readFileSync(projectedFile), projectedStored = JSON.parse(projectedRaw);
  assert.equal(projectedStored.nodes[0].host, sharedHostValue, 'persist only the explicitly supplied host, without resolving authentication into stored fields');
  assert.deepEqual(projectedStored.nodes[0].auth, { usernameEnv: 'IRIS_REVIEW_PROXY_USER', passwordEnv: 'IRIS_REVIEW_PROXY_PASS' });
  assert(!JSON.stringify(projected).includes(sharedHostValue));
  const projectedRead = await executeNetworkConfigCommand(projectedFile, 'show', {}, { env: projectedEnv });
  assert(!JSON.stringify(projectedRead).includes(sharedHostValue));
  assert.equal(projectedRead.nodes[0].id, 'projection-fixture');
  assert.equal(projectedRead.configId, projectedInitial.configId);
  assert.equal(projectedRead.configId, projectedStored.configId);
  assert.equal(projectedRead.revision, sha(projectedRaw));
  assert.equal(projectedRead.revision, projected.revision);
  assert.deepEqual(fs.readFileSync(projectedFile), projectedRaw);
  checks.push('explicit null labels are invalid while omitted labels use IDs; host display redacts an exact synthetic environment password match without changing resource identity, revision or owner-supplied storage');

  const valid = disk(); validateNetworkConfig(valid);
  const manyNodes = Array.from({ length: 17 }, (_, index) => ({ ...valid.nodes[0], id: 'boundary-node-' + index }));
  const bounded = { ...valid, nodes: manyNodes, pools: [{ id: 'bounded-ordered', mode: 'ordered',
    candidates: manyNodes.slice(0, 16).map(node => ({ kind: 'node', nodeId: node.id })) }] };
  validateNetworkConfig(bounded);
  assert.throws(() => validateNetworkConfig({ ...bounded, pools: [{ ...bounded.pools[0],
    candidates: manyNodes.map(node => ({ kind: 'node', nodeId: node.id })) }] }), code('INVALID'));
  for (const change of [{ schemaVersion: 999 }, { unknownFutureField: true }, { generation: -1 }, { configId: 'unstable' },
    { nodes: [...valid.nodes, valid.nodes[0]] }, { pools: [...valid.pools, valid.pools[0]] }]) {
    const separate = path.join(root, 'invalid-' + crypto.randomUUID() + '.json');
    fs.writeFileSync(separate, JSON.stringify({ ...valid, ...change }), { mode: 0o600 });
    const original = fs.readFileSync(separate);
    await assert.rejects(async () => executeNetworkConfigCommand(separate, 'show', {}, { env }));
    await assert.rejects(async () => executeNetworkConfigCommand(separate, 'nodes.set', { expectedRevision: sha(original), node: { id: 'proxy-remote', enabled: true } }, { env }));
    assert.deepEqual(fs.readFileSync(separate), original); assert(!fs.existsSync(separate + '.lock'));
  }
  const oversize = path.join(root, 'oversize.json');
  fs.writeFileSync(oversize, ' '.repeat(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(async () => executeNetworkConfigCommand(oversize, 'show', {}, { env }));
  await assert.rejects(async () => executeNetworkConfigCommand(providerFile, 'show', {}, { env }));
  assert.deepEqual(fs.readFileSync(providerFile), providerBytes);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    for (const name of backups()) assert.equal(fs.statSync(path.join(root, name)).mode & 0o077, 0);
    fs.chmodSync(file, 0o644);
    await assert.rejects(async () => view()); fs.chmodSync(file, 0o600);
    const linked = path.join(root, 'network-link.json'); fs.symlinkSync(file, linked);
    await assert.rejects(async () => executeNetworkConfigCommand(linked, 'show', {}, { env }));
  }
  assert.equal(fetchCalls, 0); assert.deepEqual(fs.readFileSync(providerFile), providerBytes);
  checks.push('unknown versions/fields, duplicate identities, invalid roots, oversized or nonprivate/symlink files fail closed without migration, overwrite or network activity');
  console.log(JSON.stringify({ ok: true, checks, root }, null, 2));
} finally { globalThis.fetch = originalFetch; }
