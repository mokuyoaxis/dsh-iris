import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { LEGACY_BRIDGE_TOOLS_V0 } from '../lib/core-bridge-selection.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { MAX_INBOX_FILE_BYTES, MAX_INBOX_SCAN_ENTRIES, listInboxFiles, resolveInboxDirectory } from '../lib/inbox-store.js';
import { createVisionProviderAdapter } from '../lib/vision-provider-adapter.js';
import { FLOW_SOURCE } from './fixtures/image-flow-fixture.mjs';
import { TRANSCRIBE_MODEL, audioFlowFixture } from './fixtures/audio-flow-fixture.mjs';
import { stdioMcpClient } from './fixtures/mcp-client.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-mcp-inbox');
const uuid = () => crypto.randomUUID();
const parse = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(block => block.type === 'text').text); };

function makeLargeWav(dataBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

const children = [], apis = [], apps = [];
let cliChild = null;

try {
  // === 1. Startup validation & forbidden overlap rejection ===
  const v5Root = path.join(root, 'v5-core');
  const v5Store = path.join(root, 'v5-connections');
  const providerCfg = path.join(root, 'cfg', 'providers.json');
  fs.mkdirSync(path.dirname(providerCfg), { recursive: true, mode: 0o700 });
  fs.writeFileSync(providerCfg, JSON.stringify({ providers: [], assignments: {} }) + '\n', { mode: 0o600 });

  const visionAdapter = createVisionProviderAdapter(
    { id: 'vision-fixture', type: 'openai', baseUrl: 'https://vision.invalid/v1', apiKey: 'CONTROLLED_KEY' },
    {
      fetchPort: async () => new Response(
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })
        + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
  );
  const audioFixture = audioFlowFixture();
  const v5Ports = {
    resolveVisionCandidates: () => [{ adapter: visionAdapter, model: 'vision-fixture::vision', providerBinding: 'sha256:' + 'a'.repeat(64), selectionReason: 'explicit' }],
    resolveAudioCandidates: audioFixture.resolveAudioCandidates,
    resolveTaskAdapter: task => task.providerId === 'audio-fixture' ? audioFixture.resolveTaskAdapter(task) : visionAdapter
  };
  const v5App = createApplicationRuntime({ dataRoot: v5Root, ...v5Ports });
  apps.push(v5App);
  await v5App.execute('flow.init', {});
  await v5App.execute('execution.init', { vision: true });

  // Relative path rejected in constructor without I/O.
  assert.throws(() => createLocalReadApi({ dataRoot: v5Root, inboxDir: 'relative/inbox' }), { code: 'IRIS_API_CONFIG_INVALID' });

  // Non-existent dir, regular file, symlink dir, and overlapping dirs rejected at start().
  const regularFile = path.join(root, 'not-a-dir.txt');
  fs.writeFileSync(regularFile, 'hi');
  const realInbox = path.join(root, 'inbox');
  fs.mkdirSync(realInbox, { mode: 0o700 });
  const symlinkInbox = path.join(root, 'inbox-link');
  fs.symlinkSync(realInbox, symlinkInbox);
  const insideCore = path.join(v5Root, 'inside-inbox');
  fs.mkdirSync(insideCore, { mode: 0o700 });

  for (const badDir of [
    path.join(root, 'does-not-exist'),
    regularFile,
    symlinkInbox,
    v5Root,
    insideCore,
    root, // parent containing v5Root!
    path.dirname(providerCfg) // contains providerConfigPath!
  ]) {
    const badApi = createLocalReadApi({ dataRoot: v5Root, providerConfigPath: providerCfg, inboxDir: badDir });
    await assert.rejects(badApi.start(), { code: 'IRIS_API_CONFIG_INVALID' }, 'must reject inboxDir: ' + badDir);
    await badApi.dispose();
  }
  fs.rmSync(insideCore, { recursive: true, force: true });

  // === 2. Default disabled when inboxDir omitted ===
  const noInboxApi = createLocalReadApi({ dataRoot: v5Root, allowLocalWrites: true });
  apis.push(noInboxApi);
  const noInboxSession = await noInboxApi.start();
  const sNoInbox = await (await fetch(noInboxSession.origin + '/api/v0/session', { headers: { Authorization: 'Bearer ' + noInboxSession.accessToken } })).json();
  assert.equal(sNoInbox.inbox, undefined);
  assert.equal((await fetch(noInboxSession.origin + '/api/v0/inbox', { headers: { Authorization: 'Bearer ' + noInboxSession.accessToken } })).status, 404);
  assert.equal((await fetch(noInboxSession.origin + '/api/v0/inbox/import', {
    method: 'POST', headers: { Authorization: 'Bearer ' + noInboxSession.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
    body: JSON.stringify({ name: 'a.png' })
  })).status, 404);
  await noInboxApi.dispose();

  // === 3. Populate controlled inbox with large media (>6 MiB Base64 cap!) + adversarial entries ===
  // 7 MiB valid PNG (uncompressible random noise via PNG? Even simpler: real valid PNG + trailing harmless bytes? No, sharp checks valid PNG; generate ~7 MiB valid PNG from pseudo-random RGB buffer!)
  const noiseRaw = crypto.randomBytes(1600 * 1500 * 3);
  const bigPng = await sharp(noiseRaw, { raw: { width: 1600, height: 1500, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert(bigPng.length > 6.5 * 1024 * 1024 && bigPng.length < MAX_INBOX_FILE_BYTES, 'bigPng size ' + bigPng.length);
  const bigWav = makeLargeWav(7 * 1024 * 1024); // 7 MiB WAV (> MCP Base64 ~6 MiB cap!)
  assert(bigWav.length > 7 * 1024 * 1024 && bigWav.length < MAX_INBOX_FILE_BYTES);

  fs.writeFileSync(path.join(realInbox, 'big-photo.png'), bigPng, { mode: 0o600 });
  fs.writeFileSync(path.join(realInbox, 'long-clip.wav'), bigWav, { mode: 0o600 });
  fs.writeFileSync(path.join(realInbox, 'disguised.png'), 'SECRET_ENV_VALUE=super-secret-123\n', { mode: 0o600 });
  fs.writeFileSync(path.join(realInbox, '.hidden.png'), FLOW_SOURCE, { mode: 0o600 });
  fs.writeFileSync(path.join(realInbox, 'secret.json'), '{"apiKey":"NEVER_EXPOSE"}', { mode: 0o600 });
  fs.writeFileSync(path.join(realInbox, 'notes.txt'), 'not media', { mode: 0o600 });
  fs.mkdirSync(path.join(realInbox, 'subdir'), { mode: 0o700 });
  fs.writeFileSync(path.join(realInbox, 'subdir', 'nested.png'), FLOW_SOURCE, { mode: 0o600 });
  const outsidePng = path.join(root, 'outside-secret.png');
  fs.writeFileSync(outsidePng, FLOW_SOURCE, { mode: 0o600 });
  fs.symlinkSync(outsidePng, path.join(realInbox, 'symlink-escape.png'));
  fs.writeFileSync(path.join(realInbox, 'oversized.png'), Buffer.alloc(MAX_INBOX_FILE_BYTES + 1), { mode: 0o600 });

  const legacyPair = createConnectionPair({
    dataRoot: v5Root, directory: path.join(root, 'v5-legacy'), origin: 'http://127.0.0.1:1',
    label: 'Legacy v0', scopes: ['read', 'create'], capabilities: ['image-edit'], tools: [...LEGACY_BRIDGE_TOOLS_V0]
  });

  const api = createLocalReadApi({
    dataRoot: v5Root, allowExecution: true, allowMcp: true, executionPorts: v5Ports,
    allowConnectionManagement: true, connectionStore: v5Store, connectionsFile: legacyPair.serverFile,
    inboxDir: realInbox
  });
  apis.push(api);
  const session = await api.start();
  assert.equal(api.snapshot().inboxEnabled, true);

  const sessionInfo = await (await fetch(session.origin + '/api/v0/session', { headers: { Authorization: 'Bearer ' + session.accessToken } })).json();
  assert.equal(sessionInfo.inbox, true);
  assert(sessionInfo.operations.includes('inbox.list'));
  assert(sessionInfo.operations.includes('inbox.import'));

  const manage = async (route, value) => {
    const response = await fetch(session.origin + '/api/v0/connection-management' + route, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + session.accessToken, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    assert(response.ok, route + ' HTTP ' + response.status);
    return response.json();
  };

  const catalog = await manage('/catalog');
  assert(catalog.groups.some(g => g.id === 'inbox'));
  assert.deepEqual(catalog.media.find(m => m.id === 'inbox').capabilities, ['inbox']);

  // Create connections: full inbox+vision+transcribe+local-media, read-only inbox, and no-inbox image-edit.
  const fullId = uuid();
  await manage('/connections', { key: fullId, label: 'Inbox full', scopes: ['read', 'create'], capabilities: ['inbox', 'vision', 'transcribe', 'local-media'] });
  const fullHttpCfg = (await manage('/connections/' + fullId + '/export', { transport: 'http', format: 'entry' })).configuration;
  const fullStdioCfg = (await manage('/connections/' + fullId + '/export', { transport: 'stdio', format: 'entry' })).configuration;
  const fullSkill = await manage('/connections/' + fullId + '/skill', {});
  assert(fullSkill.preview.includes('Read-only inbox import · 收件目录安全入库'));
  assert(fullSkill.preview.includes('iris_core_import_inbox_file'));

  const roInboxId = uuid();
  await manage('/connections', { key: roInboxId, label: 'Inbox read-only', scopes: ['read'], capabilities: ['inbox'] });
  const roInboxToken = (await manage('/connections/' + roInboxId + '/export', { transport: 'http', format: 'entry' })).configuration.headers.Authorization.slice(7);

  const noInboxGrantId = uuid();
  await manage('/connections', { key: noInboxGrantId, label: 'No inbox', scopes: ['read', 'create'], capabilities: ['image-edit'] });
  const noInboxToken = (await manage('/connections/' + noInboxGrantId + '/export', { transport: 'http', format: 'entry' })).configuration.headers.Authorization.slice(7);

  const fullHttp = httpMcpClient(session.origin, fullHttpCfg.headers.Authorization.slice(7), { version: '2026-07-28', name: 'inbox-http' });
  await fullHttp.initialize();
  const fullStdio = stdioMcpClient(path.resolve('bin/dsh-iris.js'), '', 'read,create', { version: '2025-11-25', name: 'inbox-stdio', launch: fullStdioCfg });
  children.push(fullStdio);
  await fullStdio.initialize();

  // Check annotations: inbox is readOnly, import_inbox_file is idempotent local create (openWorldHint: false).
  const fullTools = (await fullHttp.request('tools/list')).tools;
  assert.deepEqual(fullTools.find(t => t.name === 'iris_core_inbox').annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(fullTools.find(t => t.name === 'iris_core_import_inbox_file').annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });

  // List inbox files: only safe top-level <=20 MiB image/audio regular files appear; zero host paths exposed.
  const listed = parse(await fullHttp.call('iris_core_inbox', {}));
  assert.equal(listed.configured, true);
  assert.equal(listed.audioEnabled, true);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.files.map(f => f.name).sort(), ['big-photo.png', 'disguised.png', 'long-clip.wav']);
  assert(!JSON.stringify(listed).includes(root));
  assert(!JSON.stringify(listed).includes(realInbox));
  assert.deepEqual(parse(await fullHttp.call('iris_core_inbox', { kind: 'audio' })).files.map(f => f.name), ['long-clip.wav']);
  assert.equal(parse(await fullStdio.call('iris_core_inbox', { kind: 'image', limit: 1 })).files.length, 1);

  // Import >7 MiB PNG via HTTP MCP (no Base64!), then idempotent replay via stdio MCP.
  const imgKey = uuid();
  const importedPng = parse(await fullHttp.call('iris_core_import_inbox_file', { key: imgKey, name: 'big-photo.png' }));
  assert.equal(importedPng.idempotentReplay, false);
  assert.equal(importedPng.sourceName, 'big-photo.png');
  assert.equal(importedPng.artifact.mediaType, 'image/png');
  assert.equal(importedPng.artifact.size, bigPng.length);
  assert.equal(importedPng.artifact.width, 1600);
  assert.equal(importedPng.artifact.height, 1500);
  assert(!JSON.stringify(importedPng).includes(root));
  assert.deepEqual(readCoreArtifactBytes(v5Root, importedPng.artifact.artifactId).bytes, bigPng);

  const replayedPng = parse(await fullStdio.call('iris_core_import_inbox_file', { key: imgKey, name: 'big-photo.png' }));
  assert.equal(replayedPng.idempotentReplay, true);
  assert.equal(replayedPng.artifact.artifactId, importedPng.artifact.artifactId);

  // Original file in inboxDir stays completely untouched (read-only).
  assert.deepEqual(fs.readFileSync(path.join(realInbox, 'big-photo.png')), bigPng);

  // Imported artifact flows directly into local-media crop & vision creation!
  const croppedBig = parse(await fullHttp.call('iris_core_crop', { artifactId: importedPng.artifact.artifactId, left: 0, top: 0, width: 64, height: 64 }));
  assert.equal(croppedBig.artifact.width, 64);
  const visDraft = parse(await fullHttp.call('iris_core_create_vision', {
    key: uuid(), sourceArtifactId: importedPng.artifact.artifactId, modelRef: 'vision-fixture::vision', question: 'Analyze large image'
  }));
  assert.equal(visDraft.flow.source.artifactId, importedPng.artifact.artifactId);

  // Import >7 MiB WAV audio via stdio MCP (beyond Base64 limit!) and create a transcription Run!
  const audioKey = uuid();
  const importedWav = parse(await fullStdio.call('iris_core_import_inbox_file', { key: audioKey, name: 'long-clip.wav' }));
  assert.equal(importedWav.idempotentReplay, false);
  assert.equal(importedWav.artifact.mediaType, 'audio/wav');
  assert.equal(importedWav.artifact.size, bigWav.length);
  assert.deepEqual(readCoreArtifactBytes(v5Root, importedWav.artifact.artifactId).bytes, bigWav);
  const asrDraft = parse(await fullHttp.call('iris_core_create_transcription', {
    key: uuid(), sourceArtifactId: importedWav.artifact.artifactId, modelRef: TRANSCRIBE_MODEL
  }));
  assert.equal(asrDraft.flow.source.artifactId, importedWav.artifact.artifactId);

  // Reusing imgKey with different file bytes produces conflict (409).
  fs.writeFileSync(path.join(realInbox, 'other.png'), FLOW_SOURCE, { mode: 0o600 });
  const keyConflict = await fullHttp.call('iris_core_import_inbox_file', { key: imgKey, name: 'other.png' });
  assert.equal(keyConflict.isError, true);
  assert.equal(keyConflict.structuredContent.error.code, 'IRIS_API_KEY_CONFLICT');

  // Adversarial rejections: disguised text, symlink escape, traversal, dotfiles, unsupported ext, oversized, missing.
  const disguised = await fullHttp.call('iris_core_import_inbox_file', { key: uuid(), name: 'disguised.png' });
  assert.equal(disguised.isError, true);
  assert(!JSON.stringify(disguised).includes('SECRET_ENV_VALUE'));

  for (const badName of ['symlink-escape.png', '../outside-secret.png', 'subdir/nested.png', '.hidden.png', 'secret.json', 'notes.txt', 'missing.png']) {
    const res = await fullHttp.call('iris_core_import_inbox_file', { key: uuid(), name: badName });
    assert.equal(res.isError, true, 'must reject ' + badName);
    assert(!JSON.stringify(res).includes(root));
  }
  const tooBig = await fullHttp.call('iris_core_import_inbox_file', { key: uuid(), name: 'oversized.png' });
  assert.equal(tooBig.isError, true);
  assert.equal(tooBig.structuredContent.error.code, 'IRIS_API_INPUT_TOO_LARGE');

  // Authorization isolation: read-only inbox, no-inbox connection, and legacy frozen connection.
  const roInboxClient = httpMcpClient(session.origin, roInboxToken, { version: '2026-07-28' });
  await roInboxClient.initialize();
  assert.deepEqual((await roInboxClient.request('tools/list')).tools.map(t => t.name).sort(), ['iris_core_connection', 'iris_core_connections', 'iris_core_inbox']);
  await assert.rejects(roInboxClient.call('iris_core_import_inbox_file', { key: uuid(), name: 'other.png' }), { rpcCode: -32602 });

  const noInboxClient = httpMcpClient(session.origin, noInboxToken, { version: '2026-07-28' });
  await noInboxClient.initialize();
  assert(!(await noInboxClient.request('tools/list')).tools.some(t => t.name.includes('inbox')));

  const legacyClient = httpMcpClient(session.origin, JSON.parse(fs.readFileSync(legacyPair.clientFile, 'utf8')).accessToken, { version: '2026-07-28' });
  await legacyClient.initialize();
  assert(!(await legacyClient.request('tools/list')).tools.some(t => t.name.includes('inbox')));

  // === 4. v1 non-audio root: inbox lists images only, rejects audio import with IRIS_FLOW_AUDIO_ROOT_REQUIRED ===
  const v1Root = path.join(root, 'v1-core');
  const v1App = createApplicationRuntime({ dataRoot: v1Root });
  apps.push(v1App);
  await v1App.execute('flow.init', {});
  await v1App.execute('execution.init', {});
  const v1Api = createLocalReadApi({ dataRoot: v1Root, allowLocalWrites: true, inboxDir: realInbox });
  apis.push(v1Api);
  const v1Session = await v1Api.start();
  const v1List = await (await fetch(v1Session.origin + '/api/v0/inbox', { headers: { Authorization: 'Bearer ' + v1Session.accessToken } })).json();
  assert.equal(v1List.audioEnabled, false);
  assert(!v1List.files.some(f => f.kind === 'audio'));
  const v1AudioReject = await fetch(v1Session.origin + '/api/v0/inbox/import', {
    method: 'POST', headers: { Authorization: 'Bearer ' + v1Session.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
    body: JSON.stringify({ name: 'long-clip.wav' })
  });
  assert.equal(v1AudioReject.status, 409);
  assert.equal((await v1AudioReject.json()).error.code, 'IRIS_FLOW_AUDIO_ROOT_REQUIRED');
  const v1ImgOk = await fetch(v1Session.origin + '/api/v0/inbox/import', {
    method: 'POST', headers: { Authorization: 'Bearer ' + v1Session.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
    body: JSON.stringify({ name: 'other.png' })
  });
  assert.equal(v1ImgOk.status, 201);
  await v1ImgOk.arrayBuffer();
  await v1Api.dispose();

  // Read-only Core with inboxDir: GET /api/v0/inbox succeeds, POST /api/v0/inbox/import returns 405.
  const roCore = createLocalReadApi({ dataRoot: v1Root, allowLocalWrites: false, inboxDir: realInbox });
  apis.push(roCore);
  const roCoreSession = await roCore.start();
  assert.equal((await fetch(roCoreSession.origin + '/api/v0/inbox', { headers: { Authorization: 'Bearer ' + roCoreSession.accessToken } })).status, 200);
  const roImport = await fetch(roCoreSession.origin + '/api/v0/inbox/import', {
    method: 'POST', headers: { Authorization: 'Bearer ' + roCoreSession.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
    body: JSON.stringify({ name: 'other.png' })
  });
  assert.equal(roImport.status, 405);
  await roImport.arrayBuffer();
  await roCore.dispose();

  // === 5. Scan filtering before cap: 500 .txt OR 500 empty .png files + 1 valid PNG MUST return the PNG (truncated: false); >500 valid PNGs sets truncated: true ===
  const noisyInbox = path.join(root, 'noisy-inbox');
  fs.mkdirSync(noisyInbox, { mode: 0o700 });
  for (let i = 0; i < MAX_INBOX_SCAN_ENTRIES; i++) {
    fs.writeFileSync(path.join(noisyInbox, String(i).padStart(4, '0') + '.txt'), 'noise', { mode: 0o600 });
  }
  fs.writeFileSync(path.join(noisyInbox, 'z-valid.png'), FLOW_SOURCE, { mode: 0o600 });
  const noisyListed = listInboxFiles(resolveInboxDirectory(noisyInbox), { audioEnabled: true, kind: 'all', limit: 30 });
  assert.equal(noisyListed.truncated, false, '500 non-media files must not hide a valid image');
  assert.equal(noisyListed.total, 1);
  assert.deepEqual(noisyListed.files.map(f => f.name), ['z-valid.png']);

  const emptyPngInbox = path.join(root, 'empty-png-inbox');
  fs.mkdirSync(emptyPngInbox, { mode: 0o700 });
  for (let i = 0; i < MAX_INBOX_SCAN_ENTRIES; i++) {
    fs.writeFileSync(path.join(emptyPngInbox, 'a-' + String(i).padStart(4, '0') + '.png'), Buffer.alloc(0), { mode: 0o600 });
  }
  fs.writeFileSync(path.join(emptyPngInbox, 'z-valid.png'), FLOW_SOURCE, { mode: 0o600 });
  const emptyPngListed = listInboxFiles(resolveInboxDirectory(emptyPngInbox), { audioEnabled: true, kind: 'image', limit: 30 });
  assert.equal(emptyPngListed.truncated, false, '500 empty PNGs must not hide a later valid image');
  assert.equal(emptyPngListed.total, 1);
  assert.deepEqual(emptyPngListed.files.map(f => f.name), ['z-valid.png']);

  const exact500Inbox = path.join(root, 'exact-500-inbox');
  fs.mkdirSync(exact500Inbox, { mode: 0o700 });
  for (let i = 0; i < MAX_INBOX_SCAN_ENTRIES; i++) {
    fs.writeFileSync(path.join(exact500Inbox, `img-${String(i).padStart(4, '0')}.png`), FLOW_SOURCE, { mode: 0o600 });
  }
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(exact500Inbox, `z-empty-${i}.png`), Buffer.alloc(0), { mode: 0o600 });
  }
  const exact500Listed = listInboxFiles(resolveInboxDirectory(exact500Inbox), { audioEnabled: false, kind: 'image', limit: 50 });
  assert.equal(exact500Listed.truncated, false, 'trailing invalid files after 500 valid files must not mark truncated');
  assert.equal(exact500Listed.total, MAX_INBOX_SCAN_ENTRIES);

  const manyImagesInbox = path.join(root, 'many-images-inbox');
  fs.mkdirSync(manyImagesInbox, { mode: 0o700 });
  for (let i = 0; i < MAX_INBOX_SCAN_ENTRIES + 5; i++) {
    fs.writeFileSync(path.join(manyImagesInbox, `img-${String(i).padStart(4, '0')}.png`), FLOW_SOURCE, { mode: 0o600 });
  }
  const cappedListed = listInboxFiles(resolveInboxDirectory(manyImagesInbox), { audioEnabled: false, kind: 'image', limit: 50 });
  assert.equal(cappedListed.truncated, true, '>500 valid media files must set truncated: true');
  assert.equal(cappedListed.total, MAX_INBOX_SCAN_ENTRIES);
  assert.equal(cappedListed.files.length, 50);

  // === 6. Real CLI api serve --inbox-dir startup & read check ===
  await fullStdio.close();
  await api.dispose();
  const tokenFile = path.join(root, 'cli-owner.token');
  cliChild = spawn(process.execPath, [
    path.resolve('bin/dsh-iris.js'), 'api', 'serve',
    '--data-root', v1Root, '--token-file', tokenFile,
    '--allow-local-writes', '--inbox-dir', realInbox
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  cliChild.stdout.on('data', d => { stdout += d; });
  cliChild.stderr.on('data', d => { stderr += d; });
  const deadline = Date.now() + 10000;
  while (!stdout.includes('\n') && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert(stdout.includes('\n'), 'CLI api serve --inbox-dir failed: ' + stderr);
  const cliInfo = JSON.parse(stdout.split('\n')[0]);
  assert.equal(cliInfo.inboxEnabled, true);
  const cliToken = fs.readFileSync(tokenFile, 'utf8').trim();
  const cliInbox = await (await fetch(cliInfo.origin + '/api/v0/inbox', { headers: { Authorization: 'Bearer ' + cliToken } })).json();
  assert(cliInbox.files.some(f => f.name === 'other.png'));
  cliChild.kill('SIGTERM');
  await new Promise(resolve => cliChild.once('close', resolve));
  cliChild = null;

  console.log('PASS MCP read-only inbox (7 MiB PNG + 7 MiB WAV without Base64, stdio+HTTP idempotency, O_NOFOLLOW symlink/traversal/disguised/oversized guards, v1 audio gate, CLI --inbox-dir)');
} finally {
  if (cliChild) { cliChild.kill('SIGTERM'); await new Promise(resolve => cliChild.once('close', resolve)); }
  for (const child of children.reverse()) await child.kill();
  for (const api of apis.reverse()) await api.dispose();
  for (const app of apps.reverse()) await app.dispose();
}
