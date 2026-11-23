import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { readCoreArtifactBytes, createCoreArtifact } from '../lib/core-artifact-store.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { createCoreServiceClient } from '../lib/core-service-client.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-outbox');
const dataRoot = path.join(root, 'core'), outboxDir = path.join(root, 'outbox'), inboxDir = path.join(root, 'inbox');
const fixture = imageFlowFixture(dataRoot);
const app = createApplicationRuntime({ dataRoot, ...fixture });
const cli = path.resolve('bin/dsh-iris.js'), tool = 'iris_core_export_outbox';
const scopes = ['read', 'create'], clients = [], children = [];
const grantsFile = path.join(root, 'grants.json'), store = path.join(root, 'connections');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const uuid = () => crypto.randomUUID();
const final = name => path.join(outboxDir, name);
const stages = () => fs.readdirSync(outboxDir).filter(name => name.startsWith('.iris-outbox-'));
const recordPath = key => path.join(dataRoot, 'outbox-requests-v0', hash(key) + '.json');
let api, session;

function pair(label, capabilities, tools, allowedScopes = scopes) {
  return createConnectionPair({ dataRoot, directory: path.join(root, label), origin: 'http://127.0.0.1:1',
    scopes: allowedScopes, label, capabilities, tools });
}
async function start(options) {
  api = createLocalReadApi({ dataRoot, ...options });
  session = await api.start();
}
async function post(route, value, moreHeaders = {}) {
  const response = await fetch(session.origin + '/api/v0/' + route, { method: 'POST',
    headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json', ...moreHeaders },
    body: JSON.stringify(value) });
  return { status: response.status, body: await response.json() };
}
async function write({ key, ...value }) {
  return post('outbox/export', value, { 'Idempotency-Key': key });
}
async function connect(grant, options) {
  const credentials = { ...read(grant.clientFile), origin: session.origin };
  const client = createCoreServiceClient({ connection: credentials, requestedScopes: grant.scopes, ...options });
  clients.push(client);
  const hello = await client.connect();
  return { client, hello };
}
async function manage(route, value) {
  const response = value === undefined
    ? await fetch(session.origin + '/api/v0/connection-management' + route, { headers: { Authorization: 'Bearer ' + session.accessToken } })
    : null;
  const { status, body } = response ? { status: response.status, body: await response.json() }
    : await post('connection-management' + route, value);
  assert(status >= 200 && status < 300, JSON.stringify(body));
  return body;
}
function receipt(artifact, name, bytes) {
  return { contractVersion: 0, name, artifactId: artifact.id, mediaType: artifact.mediaType, bytes: bytes.length, sha256: hash(bytes) };
}
function assertReceipt(result, expected) {
  assert(!result.isError, JSON.stringify(result));
  assert.deepEqual(result.structuredContent, expected);
}
function assertCode(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code);
  assert(!JSON.stringify(result.body).includes(root));
}

try {
  fs.mkdirSync(outboxDir);
  fs.mkdirSync(inboxDir);
  await app.execute('flow.init', {});
  await app.execute('execution.init', { vision: true });
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const cropA = (await app.execute('crop', { artifact_id: source.id, left: 0, top: 0, width: 16, height: 16 })).artifact;
  const cropB = (await app.execute('crop', { artifact_id: source.id, left: 16, top: 0, width: 16, height: 16 })).artifact;
  const diamond = (await app.execute('media.diff', { image_a_artifact_id: cropA.id, image_b_artifact_id: cropB.id })).artifact;
  assert.equal(diamond.relations.length, 2);
  const large = Buffer.alloc(1024 * 1024, 'abc ');
  const { restrictedFrame, restrictedImage, largeText } = await app.run('writer', runtime => runtime.run('execute', ({ dataRoot: core }) => {
    const video = createCoreArtifact(core, { kind: 'adopted', mediaType: 'video/mp4', bytes: Buffer.from('video fixture') });
    return {
      restrictedFrame: createCoreArtifact(core, { kind: 'video-frame', mediaType: 'image/png', bytes: FLOW_SOURCE,
        metadata: { width: 48, height: 32 }, relations: [{ type: 'frame-of', artifactId: video.id }] }),
      restrictedImage: createCoreArtifact(core, { kind: 'adopted', mediaType: 'image/png', bytes: FLOW_SOURCE,
        relations: [{ type: 'derived-from', artifactId: video.id }] }),
      largeText: createCoreArtifact(core, { kind: 'adopted', mediaType: 'text/plain', bytes: large })
    };
  }));
  // An allowed Run may reference a derived image whose source remains out of scope for export.
  await app.execute('flow.create', { source_artifact_id: restrictedFrame.id, model_ref: FLOW_MODEL, prompt: 'Reference a derived fixture' });
  const full = pair('full', ['outbox', 'local-media', 'image-edit'], [tool, 'iris_core_image']);
  const outboxOnly = pair('no-source-access', ['outbox'], [tool]);
  const noTool = pair('default-tools', ['outbox', 'local-media']);
  const noGroup = pair('no-outbox', ['local-media']);
  const readOnly = pair('read-only', ['outbox', 'local-media'], [tool], ['read']);
  assert(!noTool.tools.includes(tool));
  assert.throws(() => pair('tool-without-group', ['local-media'], [tool]), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
  fs.writeFileSync(grantsFile, JSON.stringify({ schemaVersion: 0,
    grants: [full, outboxOnly, noTool, noGroup, readOnly].map(item => read(item.serverFile).grants[0]) }), { mode: 0o600 });
  const options = { connectionsFile: grantsFile, allowMcp: true, allowLocalWrites: true };
  const defaultInput = { key: uuid(), artifactId: source.id, name: 'owner.png' };

  assert.throws(() => createLocalReadApi({ dataRoot, outboxDir: 'relative' }), { code: 'IRIS_API_CONFIG_INVALID' });
  for (const configuration of [{ outboxDir: root }, { outboxDir: dataRoot }, { outboxDir: path.join(root, 'missing') },
    { outboxDir: inboxDir, inboxDir }, { outboxDir, providerConfigPath: final('providers.json') },
    { outboxDir, privateConfigPaths: [final('scheduler.json')] }, { outboxDir, privateConfigPaths: [final('plugins.json')] }]) {
    const invalid = createLocalReadApi({ dataRoot, ...configuration });
    await assert.rejects(invalid.start(), { code: 'IRIS_API_CONFIG_INVALID' });
  }
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'outbox-alias');
    fs.symlinkSync(outboxDir, alias, 'dir');
    await assert.rejects(createLocalReadApi({ dataRoot, outboxDir: alias + path.sep }).start(), { code: 'IRIS_API_CONFIG_INVALID' });
    const privateAlias = path.join(root, 'private-alias');
    fs.symlinkSync(outboxDir, privateAlias, 'dir');
    await assert.rejects(createLocalReadApi({ dataRoot, outboxDir, privateConfigPaths: [path.join(privateAlias, 'token')] }).start(),
      { code: 'IRIS_API_CONFIG_INVALID' });
  }

  await start({});
  assertCode(await write(defaultInput), 404, 'IRIS_API_NOT_FOUND');
  await api.dispose();
  await start(options);
  await assert.rejects(connect(full), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', status: 403 });
  const disabled = await connect(full, { requestedCapabilities: ['local-media', 'image-edit'] });
  assert(!disabled.hello.instance.tools.includes(tool));
  assert(!disabled.hello.instance.capabilities.includes('outbox'));
  await assert.rejects(disabled.client.exportOutbox(defaultInput), { code: 'IRIS_API_NOT_FOUND', status: 404 });
  await disabled.client.dispose();
  await api.dispose();
  await start({ outboxDir });
  assert(!api.snapshot().outboxEnabled);
  assertCode(await write(defaultInput), 405, 'IRIS_API_READ_ONLY');
  await api.dispose();

  await start({ ...options, outboxDir, inboxDir, allowConnectionManagement: true, connectionStore: store });
  assert(api.snapshot().outboxEnabled);
  const catalog = await manage('/catalog');
  assert.deepEqual(catalog.groups.find(group => group.id === 'outbox').tools, [tool]);
  assert.deepEqual(catalog.media.find(media => media.id === 'outbox').capabilities, ['outbox']);
  assert(!JSON.stringify(catalog).includes(root));
  const profile = { key: uuid(), label: 'Managed outbox', scopes, capabilities: ['outbox', 'local-media'] };
  await manage('/connections', profile);
  assert(!(await manage('/connections/' + profile.key + '/skill', {})).preview.includes(tool));
  const explicit = uuid();
  await manage('/connections', { ...profile, key: explicit, tools: [tool] });
  const skill = (await manage('/connections/' + explicit + '/skill', {})).preview;
  assert(skill.includes(tool) && skill.includes('reuse the same UUID'));
  for (const grant of [noTool, noGroup, readOnly]) {
    const { client } = await connect(grant);
    await assert.rejects(client.exportOutbox(defaultInput), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', status: 403 });
    const mcp = httpMcpClient(session.origin, read(grant.clientFile).accessToken);
    await mcp.initialize();
    assert(!(await mcp.request('tools/list')).tools.some(item => item.name === tool));
  }

  const { client } = await connect(full), { client: restricted } = await connect(outboxOnly);
  await assert.rejects(restricted.exportOutbox(defaultInput), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', status: 403 });
  await assert.rejects(client.exportOutbox({ ...defaultInput, artifactId: restrictedFrame.id }), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', status: 403 });
  await assert.rejects(client.exportOutbox({ ...defaultInput, artifactId: restrictedImage.id }), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', status: 403 });
  assert.deepEqual(fs.readdirSync(outboxDir), []);
  const h25 = httpMcpClient(session.origin, read(full.clientFile).accessToken, { version: '2025-11-25' });
  const h26 = httpMcpClient(session.origin, read(full.clientFile).accessToken, { version: '2026-07-28' });
  const transports = [h25, h26];
  const config = { ...read(full.clientFile), origin: session.origin };
  fs.writeFileSync(full.clientFile, JSON.stringify(config), { mode: 0o600 });
  for (const version of ['2025-11-25', '2026-07-28']) {
    const stdio = stdioMcpClient(cli, full.clientFile, scopes.join(','), { name: 'outbox-stdio', version });
    children.push(stdio); transports.push(stdio);
  }
  const input = { key: uuid(), artifactId: diamond.id, name: '热力图.PNG' };
  const bytes = readCoreArtifactBytes(dataRoot, diamond.id).bytes;
  const expected = receipt(diamond, input.name, bytes);
  for (const transport of transports) {
    await transport.initialize();
    const definition = (await transport.request('tools/list')).tools.find(item => item.name === tool);
    assert.deepEqual(definition.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assertReceipt(await transport.call(tool, input), expected);
  }
  const prior = fs.statSync(final(input.name), { bigint: true });
  assert.equal(prior.nlink, 1n, 'published file has no spare staging link');
  if (process.platform !== 'win32') assert.equal(prior.mode & 0o777n, 0o600n);
  assert.deepEqual(await write(input), { status: 200, body: expected });
  await assert.rejects(restricted.exportOutbox(input), { code: 'IRIS_CONNECTION_CAPABILITY_DENIED', status: 403 });
  assert.equal(fs.statSync(final(input.name), { bigint: true }).ino, prior.ino);
  assert.deepEqual(fs.readFileSync(final(input.name)), bytes);
  assert.deepEqual(stages(), []);
  const collision = await h26.call(tool, { ...input, key: uuid() });
  assert.equal(collision.structuredContent.error.code, 'IRIS_OUTBOX_FILE_EXISTS');
  assert(!JSON.stringify(collision).includes(root));
  assertCode(await write({ ...input, name: 'replacement.png' }), 409, 'IRIS_OUTBOX_KEY_CONFLICT');
  assertCode(await write({ ...input, artifactId: source.id }), 409, 'IRIS_OUTBOX_KEY_CONFLICT');
  fs.renameSync(final(input.name), final('已取走.png'));
  assert.deepEqual(await write(input), { status: 200, body: expected });
  assert(!fs.existsSync(final(input.name)));
  const concurrent = { ...defaultInput, key: uuid(), name: 'concurrent.png' };
  const replies = await Promise.all([write(concurrent), write(concurrent)]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 201]);
  assert.deepEqual(replies[0].body, replies[1].body);

  for (const name of ['../escape.png', '/abspath.png', 'nested/image.png', 'a\\b.png', '.hidden.png', 'CON.png', 'photo.png:other',
    'pic.png.', 'photo.txt', '画'.repeat(88) + '.png', 'ill\ud800.png']) {
    assertCode(await write({ ...defaultInput, name }), 400, 'IRIS_OUTBOX_INPUT_INVALID');
  }
  assertCode(await write({ ...defaultInput, destination: '/untrusted' }), 400, 'IRIS_API_INPUT_INVALID');
  assertCode(await write({ ...defaultInput, key: 'not-a-uuid' }), 400, 'IRIS_API_INPUT_INVALID');
  const different = Buffer.from('unrelated existing file');
  fs.writeFileSync(final('existing.png'), different);
  assertCode(await write({ ...defaultInput, name: 'existing.png' }), 409, 'IRIS_OUTBOX_FILE_EXISTS');
  assert.deepEqual(fs.readFileSync(final('existing.png')), different);
  if (process.platform !== 'win32') {
    const untouched = path.join(root, 'untouched.png');
    fs.writeFileSync(untouched, different);
    fs.symlinkSync(untouched, final('symlink.png'));
    assertCode(await write({ ...defaultInput, name: 'symlink.png' }), 409, 'IRIS_OUTBOX_FILE_EXISTS');
    assert(fs.lstatSync(final('symlink.png')).isSymbolicLink());
    assert.deepEqual(fs.readFileSync(untouched), different);
  }

  const failed = { ...defaultInput, key: uuid(), name: 'write-fails.png' };
  const failedTarget = path.join(fs.realpathSync.native(outboxDir), failed.name);
  const actualLink = fs.linkSync;
  fs.linkSync = (source, target) => {
    if (target === failedTarget) throw Object.assign(new Error('fixture failure'), { code: 'ENOSPC' });
    return actualLink(source, target);
  };
  try { assertCode(await write(failed), 503, 'IRIS_OUTBOX_UNAVAILABLE'); }
  finally { fs.linkSync = actualLink; }
  assert(!fs.existsSync(final(failed.name)));
  assert.deepEqual(stages(), []);
  assert.deepEqual(await write(failed), { status: 200, body: receipt(source, failed.name, FLOW_SOURCE) });

  for (const child of children) assert.equal((await child.close()).status, 0);
  await Promise.all(clients.map(item => item.dispose()));
  await api.dispose();

  if (process.platform !== 'win32') {
    const crashChild = fileURLToPath(new URL('./fixtures/outbox-crash-child.mjs', import.meta.url));
    for (const stage of ['copy', 'publish', 'different-inode', 'different-hash']) {
      const original = { key: uuid(), artifactId: largeText.id, name: stage + '.txt' };
      const killed = spawnSync(process.execPath, [crashChild, stage, fs.realpathSync(dataRoot), fs.realpathSync(outboxDir),
        original.key, original.artifactId, original.name], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      assert(killed.stdout.includes('CHECKPOINT ' + stage), killed.stderr);
      const record = read(recordPath(original.key)), temporary = final(record.stage.name);
      assert.equal(record.state, stage === 'copy' ? 'prepared' : 'publishing');
      const lease = inspectCoreWriterLease(dataRoot);
      assert.equal(lease.status, 'present');
      if (stage === 'copy') {
        assert(fs.statSync(temporary).size < large.length);
        assert(!fs.existsSync(final(original.name)));
      } else {
        assert.deepEqual(fs.readFileSync(final(original.name)), large);
        assert.equal(fs.statSync(temporary).ino, fs.statSync(final(original.name)).ino);
      }
      if (stage === 'different-inode') {
        const replacement = final('unrelated-same-bytes.txt');
        fs.writeFileSync(replacement, large);
        fs.renameSync(final(original.name), final('moved-original.txt'));
        fs.renameSync(replacement, final(original.name));
      }
      const contents = stage === 'different-hash' ? Buffer.alloc(large.length, 'other') : large;
      if (stage === 'different-hash') fs.writeFileSync(final(original.name), contents);

      await start({ allowLocalWrites: true, outboxDir });
      assertCode(await write(original), 409, 'IRIS_API_ROOT_BUSY');
      recoverCoreWriterLease(dataRoot, { confirmStalePid: lease.pid });
      if (stage.startsWith('different-')) {
        assertCode(await write(original), 409, 'IRIS_OUTBOX_UNCONFIRMED');
        assert(fs.existsSync(temporary));
        assert.deepEqual(fs.readFileSync(final(original.name)), contents);
      } else {
        assert.deepEqual(await write(original), { status: 200, body: receipt(largeText, original.name, large) });
        assert.deepEqual(fs.readFileSync(final(original.name)), large);
        assert.deepEqual(stages(), []);
      }
      await api.dispose();
    }

    await start({ allowLocalWrites: true, outboxDir });
    const retired = path.join(root, 'outbox-retired');
    fs.renameSync(outboxDir, retired);
    fs.mkdirSync(outboxDir);
    assertCode(await write(defaultInput), 503, 'IRIS_OUTBOX_UNAVAILABLE');
    assert.deepEqual(fs.readdirSync(outboxDir), []);
    await api.dispose();
  }

  for (const command of ['api', 'web']) {
    const tokenFile = path.join(root, command + '-token');
    const bad = spawnSync(process.execPath, [cli, command, 'serve', '--data-root', dataRoot, '--token-file', final('token'),
      '--allow-local-writes', '--outbox-dir', outboxDir], { encoding: 'utf8', timeout: 20000 });
    assert.equal(bad.status, 1, bad.stderr);
    assert(bad.stderr.includes('IRIS_API_CONFIG_INVALID'));
    assert(!fs.existsSync(final('token')));
    const child = stdioMcpClient(cli, '', '', { launch: { command: process.execPath, args: [cli, command, 'serve', '--data-root', dataRoot,
      '--token-file', tokenFile, '--allow-local-writes', '--outbox-dir', outboxDir] } });
    children.push(child);
    const lines = createInterface({ input: child.child.stdout });
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(15000) });
    lines.close();
    const info = JSON.parse(line);
    assert.equal(info.outboxEnabled, true);
    session = { origin: info.origin, accessToken: fs.readFileSync(tokenFile, 'utf8').trim() };
    const input = { ...defaultInput, key: uuid(), name: command + '-cli.png' };
    assert.deepEqual(await write(input), { status: 201, body: receipt(source, input.name, FLOW_SOURCE) });
    child.child.kill('SIGTERM');
    const stopped = await child.close();
    assert(stopped.status === 143 || stopped.signal === 'SIGTERM');
  }
  assert.equal(fixture.calls.submit.length, 0);
  console.log('PASS authorized outbox stdio/HTTP, atomic publication, matching extensions, original UUIDs and process interruption recovery');
} finally {
  await Promise.allSettled(children.map(child => child.kill()));
  await Promise.allSettled(clients.map(client => client.dispose()));
  await api?.dispose();
  await app.dispose();
}
