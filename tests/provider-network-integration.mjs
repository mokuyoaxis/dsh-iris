import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-provider-network');
const originalFetch = globalThis.fetch;
const officialOrigin = 'https://dashscope.aliyuncs.com';
const fixtureKey = 'iris-network-fixture-key';
const media = Buffer.from('fixture-video-stream-through-the-selected-network');
const audio = Buffer.from('fixture-upload-audio-bytes');
const transcript = 'Transcript fetched through the selected network.';
const received = [], traces = new Map(), servers = [], networks = [], cancelReleases = [], checks = [];
let apiOrigin, storageOrigin, registry;

// A missed injection must fail locally rather than contact the real Provider.
// This guard does not route requests; the explicitly injected clients do that.
const guardedFetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  assert.equal(url.hostname, '127.0.0.1', 'an unbound request tried to leave the local fixture');
  return originalFetch(input, options);
};
globalThis.fetch = guardedFetch;

async function listen(handler) {
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const row = { method: request.method, url: new URL(request.url, 'http://127.0.0.1'),
        headers: request.headers, body: Buffer.concat(chunks) };
      received.push(row);
      await handler(row, response);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error.message) } }));
    }
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

const json = (response, body) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture timed out: ' + label)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  const { createProviderNetworkClient } = await import('../lib/provider-network.js');
  const { createConfiguredProviderAdapter } = await import('../lib/provider-adapters.js');
  const { invokeProviderOperation, prepareProviderInput } = await import('../lib/provider-adapter.js');
  const { createProviderRegistry } = await import('../lib/provider-extensions.js');
  const { refreshModelDirectory } = await import('../lib/model-directory-service.js');

  storageOrigin = await listen((row, response) => {
    if (row.method === 'POST' && row.url.pathname === '/oss-upload') {
      response.writeHead(200); response.end();
    } else if (row.url.pathname === '/cdn/redirect') {
      response.writeHead(302, { Location: storageOrigin + '/cdn/redirected-lifecycle.mp4' }); response.end();
    } else if (['/cdn/video-lifecycle.mp4', '/cdn/redirected-lifecycle.mp4'].includes(row.url.pathname)) {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.write(media.subarray(0, 7)); response.end(media.subarray(7));
    } else if (row.url.pathname === '/transcripts/registry.json') {
      json(response, { transcripts: [{ text: transcript }] });
    } else {
      response.writeHead(404); response.end();
    }
  });
  apiOrigin = await listen((row, response) => {
    const lane = row.headers['x-iris-network-fixture'];
    if (row.url.pathname === '/api/v1/models') {
      const models = lane?.startsWith('directory-') ? [{ id: lane + '-model', capabilities: ['VG'] }]
        : [{ id: 'wan2.2-s2v', capabilities: ['VG'] }, { id: 'qwen-audio-3.0-asr-flash-filetrans', capabilities: ['ASR'] }];
      json(response, { output: { total: models.length, models } });
    } else if (row.url.pathname === '/api/v1/uploads') {
      json(response, { data: { upload_host: storageOrigin + '/oss-upload', upload_dir: 'fixture-uploads',
        oss_access_key_id: 'fixture-oss-access', signature: 'fixture-oss-signature', policy: 'fixture-policy',
        x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } });
    } else if (row.url.pathname === '/api/v1/services/aigc/image2video/video-synthesis') {
      json(response, { output: { task_id: 'video-lifecycle' } });
    } else if (row.url.pathname === '/api/v1/services/aigc/video-generation/video-synthesis') {
      json(response, { output: { task_id: 'sized-video' } });
    } else if (row.url.pathname === '/api/v1/services/audio/asr/transcription') {
      json(response, { output: { task_id: 'asr-registry' } });
    } else if (row.url.pathname === '/api/v1/tasks/video-lifecycle') {
      json(response, { output: { task_status: 'SUCCEEDED', video_url: storageOrigin + '/cdn/video-lifecycle.mp4' } });
    } else if (row.url.pathname === '/api/v1/tasks/asr-registry') {
      json(response, { output: { task_status: 'SUCCEEDED', results: [{ subtask_status: 'SUCCEEDED',
        transcription_url: storageOrigin + '/transcripts/registry.json' }] } });
    } else {
      response.writeHead(404); response.end();
    }
  });

  function network(lane) {
    const trace = []; traces.set(lane, trace);
    const client = createProviderNetworkClient({ fetchPort: (input, options) => {
      const request = new Request(input, options), url = new URL(request.url);
      assert([officialOrigin, storageOrigin].includes(url.origin), 'unexpected fixture destination');
      trace.push({ method: request.method, path: url.pathname, origin: url.origin });
      request.headers.set('x-iris-network-fixture', lane);
      const destination = url.origin === officialOrigin ? apiOrigin + url.pathname + url.search : url.href;
      return originalFetch(new Request(destination, request));
    } });
    networks.push(client);
    return client;
  }
  const provider = { id: 'network-fixture', apiKey: fixtureKey, mediaProtocol: 'dashscope',
    baseUrl: officialOrigin + '/compatible-mode/v1' };
  const lifecycleNetwork = network('lifecycle');
  const adapter = createConfiguredProviderAdapter({ ...provider }, { network: lifecycleNetwork });
  const discovered = await invokeProviderOperation(adapter, 'discover');
  assert.deepEqual(discovered.models.map(model => model.id), ['wan2.2-s2v', 'qwen-audio-3.0-asr-flash-filetrans']);
  const prepared = await prepareProviderInput(adapter, { model: 'wan2.2-s2v', bytes: audio, filename: 'fixture.wav' });
  assert.match(prepared.url, /^oss:\/\/fixture-uploads\/\d+-fixture\.wav$/);
  const submitted = await invokeProviderOperation(adapter, 'submit', { capability: 'video', model: 'wan2.2-s2v',
    input: { prompt: 'local network fixture', imgDataUrl: prepared.url, audioUrl: prepared.url } });
  assert.equal(submitted.kind, 'accepted'); assert.equal(submitted.remoteTaskId, 'video-lifecycle');
  const polled = await invokeProviderOperation(adapter, 'poll', { capability: 'video', remoteTaskId: submitted.remoteTaskId });
  assert.equal(polled.kind, 'succeeded'); assert.equal(polled.artifacts.length, 1);
  const videoPath = path.join(root, 'fixture.mp4');
  const downloaded = await invokeProviderOperation(adapter, 'download', { capability: 'video',
    artifact: polled.artifacts[0], targetPath: videoPath });
  assert.equal(downloaded.bytes, media.length); assert.deepEqual(fs.readFileSync(videoPath), media);
  assert.deepEqual(traces.get('lifecycle').map(({ method, path }) => [method, path]), [
    ['GET', '/api/v1/models'], ['GET', '/api/v1/uploads'], ['POST', '/oss-upload'],
    ['POST', '/api/v1/services/aigc/image2video/video-synthesis'],
    ['GET', '/api/v1/tasks/video-lifecycle'], ['GET', '/cdn/video-lifecycle.mp4']
  ]);
  const videoRequest = received.find(row => row.url.pathname.endsWith('/image2video/video-synthesis'));
  assert.equal(videoRequest.headers['x-dashscope-ossresourceresolve'], 'enable');
  assert.deepEqual(JSON.parse(videoRequest.body).input, { image_url: prepared.url, audio_url: prepared.url });
  checks.push('selected network covers real HTTP discovery, upload policy, multipart upload, submit, poll and streamed download');

  const sizedAdapter = createConfiguredProviderAdapter({ ...provider }, { network: network('t2v-size') });
  const sized = await invokeProviderOperation(sizedAdapter, 'submit', { capability: 'video', model: 'wan2.2-t2v-plus',
    input: { prompt: 'explicit size normalization', size: '832x480', duration: 5 } });
  assert.equal(sized.remoteTaskId, 'sized-video');
  const sizedRequest = received.find(row => row.headers['x-iris-network-fixture'] === 't2v-size');
  assert.deepEqual(JSON.parse(sizedRequest.body).parameters, { size: '832*480', duration: 5 });
  checks.push('DashScope video translates the Core widthxheight input into the vendor width*height wire format before submission');

  const redirectAdapter = createConfiguredProviderAdapter({ ...provider }, { network: network('redirect') });
  const redirectPath = path.join(root, 'redirected.mp4');
  const redirectDownload = await invokeProviderOperation(redirectAdapter, 'download', { capability: 'video',
    artifact: { kind: 'remote-url', url: storageOrigin + '/cdn/redirect' }, targetPath: redirectPath });
  assert.equal(redirectDownload.bytes, media.length); assert.deepEqual(fs.readFileSync(redirectPath), media);
  // The selected fetch implementation owns its internal redirect follow. N0
  // injects that implementation; this fixture is not a real proxy transport.
  assert.deepEqual(traces.get('redirect').map(row => row.path), ['/cdn/redirect']);
  const redirectRequests = received.filter(row => row.headers['x-iris-network-fixture'] === 'redirect');
  assert.deepEqual(redirectRequests.map(row => row.url.pathname), ['/cdn/redirect', '/cdn/redirected-lifecycle.mp4']);
  assert(redirectRequests.every(row => row.headers.authorization === undefined));
  checks.push('selected fetch follows a real local CDN redirect and delivers identical bytes without Provider credentials on either hop');

  registry = await createProviderRegistry();
  const registryNetwork = network('registry');
  const registered = createConfiguredProviderAdapter({ ...provider }, { registry, network: registryNetwork });
  assert.equal((await invokeProviderOperation(registered, 'discover')).models.length, 2);
  const registeredInput = await prepareProviderInput(registered, {
    model: 'qwen-audio-3.0-asr-flash-filetrans', bytes: audio, filename: 'registry.wav'
  });
  const asr = await invokeProviderOperation(registered, 'submit', { capability: 'transcribe',
    model: 'qwen-audio-3.0-asr-flash-filetrans', input: { audioUrl: registeredInput.url } });
  assert.equal(asr.kind, 'accepted'); assert.equal(asr.remoteTaskId, 'asr-registry');
  const asrResult = await invokeProviderOperation(registered, 'poll', { capability: 'transcribe', remoteTaskId: asr.remoteTaskId });
  assert.equal(asrResult.kind, 'succeeded'); assert.equal(asrResult.value.text, transcript);
  const transcriptPath = path.join(root, 'transcript.txt');
  await invokeProviderOperation(registered, 'download', { capability: 'transcribe',
    artifact: asrResult.artifacts[0], targetPath: transcriptPath });
  assert.equal(fs.readFileSync(transcriptPath, 'utf8'), transcript);
  assert.deepEqual(traces.get('registry').map(({ method, path }) => [method, path]), [
    ['GET', '/api/v1/models'], ['GET', '/api/v1/uploads'], ['POST', '/oss-upload'],
    ['POST', '/api/v1/services/audio/asr/transcription'],
    ['GET', '/api/v1/tasks/asr-registry'], ['GET', '/transcripts/registry.json']
  ]);
  checks.push('registry adapter preserves its network context through input preparation, transcription poll and separate result URL');

  // These bodies intentionally never end. The operation must finish canceling
  // them before the network owner can close the underlying connection pool.
  for (const [kind, status] of [['upload', 200], ['upload', 503], ['transcript', 503]]) {
    const events = [];
    let started, release;
    const cancelStarted = new Promise(resolve => { started = resolve; });
    const cancelGate = new Promise(resolve => { release = resolve; });
    cancelReleases.push(release);
    const discarded = new Response(new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.of(1)); },
      async cancel() { events.push('cancel-start'); started(); await cancelGate; events.push('cancel-complete'); }
    }), { status });
    const client = createProviderNetworkClient({
      close() { events.push('close'); },
      async fetchPort(input) {
        const url = new URL(input);
        if (url.pathname === '/api/v1/uploads') return Response.json({ data: {
          upload_host: 'https://discard.invalid/upload', upload_dir: 'fixture-discard',
          oss_access_key_id: 'fixture-oss-access', signature: 'fixture-oss-signature', policy: 'fixture-policy',
          x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true'
        } });
        if (url.pathname === '/api/v1/tasks/discard-transcript') return Response.json({ output: {
          task_status: 'SUCCEEDED', results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'https://discard.invalid/transcript' }]
        } });
        assert.equal(url.origin, 'https://discard.invalid');
        return discarded;
      }
    });
    networks.push(client);
    const fixture = createConfiguredProviderAdapter({ ...provider }, { network: client });
    const operation = kind === 'upload'
      ? prepareProviderInput(fixture, { model: 'fixture-upload', bytes: audio, filename: 'discard.wav' })
      : invokeProviderOperation(fixture, 'poll', { capability: 'transcribe', remoteTaskId: 'discard-transcript' });
    const settled = operation.then(value => ({ value }), error => ({ error }));
    await within(cancelStarted, kind + ' ' + status + ' cancellation');
    const disposal = client.dispose();
    assert.deepEqual(client.snapshot(), { state: 'closing', activeOperations: 1, cleanupFailed: false });
    assert.deepEqual(events, ['cancel-start'], 'close must wait for response cancellation to complete');
    release();
    const result = await within(settled, kind + ' ' + status + ' completion');
    await within(disposal, kind + ' ' + status + ' disposal');
    assert.deepEqual(events, ['cancel-start', 'cancel-complete', 'close']);
    assert.equal(discarded.bodyUsed, true);
    if (status === 200) {
      assert.equal(result.error, undefined); assert.match(result.value.url, /^oss:\/\/fixture-discard\//);
    } else {
      assert.match(result.error.message, /HTTP 503/);
      assert.equal(result.error.stage, kind === 'upload' ? 'upload' : 'poll');
      assert.equal(result.error.acceptance, kind === 'upload' ? 'not_accepted' : 'accepted');
    }
  }
  checks.push('unneeded upload bodies and rejected transcript bodies finish cancellation before disposal, preserving successful upload and HTTP failure semantics');

  // An existing media file cannot also be the parent directory of a download.
  // Reject that local destination before acquiring any remote response body.
  let localFailureFetches = 0, localFailureCloses = 0;
  const localFailureNetwork = createProviderNetworkClient({
    fetchPort() { localFailureFetches++; throw new Error('local destination failure must precede fetch'); },
    close() { localFailureCloses++; }
  });
  networks.push(localFailureNetwork);
  const localFailureAdapter = createConfiguredProviderAdapter({ ...provider }, { network: localFailureNetwork });
  await assert.rejects(invokeProviderOperation(localFailureAdapter, 'download', { capability: 'video',
    artifact: { kind: 'remote-url', url: storageOrigin + '/cdn/video-lifecycle.mp4' },
    targetPath: path.join(videoPath, 'impossible.mp4')
  }), error => {
    assert.equal(error.stage, 'download'); assert.equal(error.category, 'local_io');
    assert.equal(error.acceptance, 'accepted'); assert.equal(error.providerCode, 'EEXIST');
    return true;
  });
  assert.equal(localFailureFetches, 0);
  await localFailureNetwork.dispose();
  assert.equal(localFailureCloses, 1);
  assert.deepEqual(localFailureNetwork.snapshot(), { state: 'closed', activeOperations: 0, cleanupFailed: false });
  assert.deepEqual(fs.readFileSync(videoPath), media, 'local failure must preserve the existing media file');
  checks.push('local download directory failure remains local_io/accepted, performs zero fetches and closes normally without resubmission');

  for (const [name, options] of [['direct', {}], ['registry', { registry }]]) {
    const firstLane = 'directory-' + name + '-a', secondLane = 'directory-' + name + '-b';
    const firstNetwork = network(firstLane), secondNetwork = network(secondLane);
    let firstSaved, secondSaved;
    const [first, second] = await Promise.all([
      refreshModelDirectory(provider, { ...options, force: true, network: firstNetwork, save: value => { firstSaved = value; } }),
      refreshModelDirectory(provider, { ...options, force: true, network: secondNetwork, save: value => { secondSaved = value; } })
    ]);
    assert.equal(first.refreshed, true); assert.equal(second.refreshed, true);
    assert.equal(traces.get(firstLane).length, 1); assert.equal(traces.get(secondLane).length, 1);
    assert.deepEqual(firstSaved.models.map(model => model.id), [firstLane + '-model']);
    assert.deepEqual(secondSaved.models.map(model => model.id), [secondLane + '-model']);
    assert.equal(firstSaved.binding, secondSaved.binding, 'network isolation does not alter the persistent provider identity');
    const before = traces.get(firstLane).length;
    const shared = await Promise.all([1, 2].map(() => refreshModelDirectory(provider, {
      ...options, force: true, network: firstNetwork, save() {}
    })));
    assert(shared.every(result => result.refreshed));
    assert.equal(traces.get(firstLane).length, before + 1, 'same-context concurrent directory reads still coalesce');
  }
  checks.push('same-provider directory jobs are isolated between networks while same-network jobs still coalesce, with and without a registry');

  const uploads = received.filter(row => row.url.pathname === '/oss-upload');
  assert.equal(uploads.length, 2);
  for (const row of uploads) {
    assert.match(row.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert(row.body.includes(audio));
    for (const field of ['OSSAccessKeyId', 'Signature', 'policy', 'key', 'file']) {
      assert(row.body.includes(Buffer.from('name="' + field + '"')), 'multipart field missing: ' + field);
    }
    assert(!row.body.includes(Buffer.from(fixtureKey)));
  }
  for (const row of received) {
    assert(traces.has(row.headers['x-iris-network-fixture']), 'every HTTP hop must have a selected network');
    if (row.url.pathname.startsWith('/api/v1/')) assert.equal(row.headers.authorization, 'Bearer ' + fixtureKey);
    else assert.equal(row.headers.authorization, undefined, 'Provider Authorization must not reach OSS/CDN/transcript storage');
    assert.equal(row.headers['proxy-authorization'], undefined);
  }
  assert.equal(received.length, [...traces.values()].reduce((total, trace) => total + trace.length, 0) + 1,
    'the selected fetch implementation internally follows exactly one redirect');
  assert.equal(globalThis.fetch, guardedFetch, 'provider network assembly must not replace global fetch');
  checks.push('storage receives signed multipart fields and media bytes without Provider credentials; global fetch remains untouched by assembly');
  console.log(JSON.stringify({ ok: true, checks, requests: received.length }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  for (const release of cancelReleases) release();
  await registry?.dispose();
  await Promise.all(networks.map(client => client.dispose()));
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
