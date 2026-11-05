import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createProviderNetworkClient } from '../lib/provider-network.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { defineProviderAdapter, invokeProviderOperation, prepareProviderInput } from '../lib/provider-adapter.js';
import { configuredImagePorts } from '../lib/configured-image-runtime.js';
import { FAKE_PNG, FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';
import { COMFY_WORKFLOW, COMFY_SCHEMAS } from './fixtures/comfyui-protocol-fixture.mjs';

const nativeFetch = globalThis.fetch;
const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY'];
const proxyEnvironment = proxyNames.map(name => process.env[name]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-provider-network-'));
const clients = [];
const releaseGates = [];
const network = options => { const client = createProviderNetworkClient(options); clients.push(client); return client; };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  releaseGates.push(resolve);
  return { promise, resolve, reject };
};
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('provider-network fixture timed out')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
const closedError = error => error.code === 'IRIS_PROVIDER_NETWORK_CLOSED';
const arrivals = [], parallel = [], discoveries = [], cancelA = deferred(), cancelB = deferred(), releaseB = deferred();
const bodyHeaders = deferred(), releaseBody = deferred();
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const item = { path: url.pathname, client: request.headers['x-fixture-client'] };
  arrivals.push(item);
  const send = value => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/parallel') {
    parallel.push({ send, item });
    if (parallel.length === 2) for (const pending of [...parallel].reverse()) pending.send(pending.item);
  } else if (url.pathname === '/models') {
    discoveries.push({ send, item });
    if (discoveries.length === 2) for (const pending of [...discoveries].reverse()) pending.send({ data: [{ id: 'model-' + pending.item.client }] });
  } else if (url.pathname === '/cancel/a') {
    cancelA.resolve();
  } else if (url.pathname === '/cancel/b') {
    cancelB.resolve(); void releaseB.promise.then(() => send(item));
  } else if (url.pathname === '/body') {
    response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write('first-');
    void releaseBody.promise.then(() => response.end('last'));
  } else send(item);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = 'http://127.0.0.1:' + server.address().port;
const taggedFetch = name => (url, options = {}) => {
  const headers = new Headers(options.headers); headers.set('x-fixture-client', name);
  return nativeFetch(url, { ...options, headers });
};

try {
  // Explicit clients overlap on the wire without changing unrelated/default requests.
  const a = network({ fetchPort: taggedFetch('a') }), b = network({ fetchPort: taggedFetch('b') });
  const [first, second] = await within(Promise.all([
    a.run(async fetch => (await fetch(base + '/parallel')).json()),
    b.run(async fetch => (await fetch(base + '/parallel')).json())
  ]));
  assert.deepEqual([first.client, second.client], ['a', 'b']);
  assert.equal(parallel.length, 2);
  const providerFor = id => ({ id, mediaProtocol: 'openai-images', baseUrl: base, apiKey: 'fixture-key' });
  const configuredA = createConfiguredProviderAdapter(providerFor('client-a'), { network: a });
  const configuredB = createConfiguredProviderAdapter(providerFor('client-b'), { network: b });
  const discovered = await within(Promise.all([configuredA.operations.discover(), configuredB.operations.discover()]));
  assert.deepEqual(discovered.map(result => result.models), [['model-a'], ['model-b']]);
  const inherited = network();
  assert.equal((await inherited.run(async fetch => (await fetch(base + '/plain')).json())).client, undefined);
  assert.equal(globalThis.fetch, nativeFetch);

  // Default clients and adapters created before replacement resolve fetch at request time.
  const defaultAdapter = createConfiguredProviderAdapter({
    id: 'default-fetch', mediaProtocol: 'openai-images', baseUrl: 'https://default.invalid/v1', apiKey: 'fixture-key'
  });
  const defaultClient = network();
  let inheritedCalls = 0, explicitCalls = 0;
  const explicit = network({ fetchPort: async () => { explicitCalls++; return new Response('explicit'); } });
  globalThis.fetch = async url => {
    inheritedCalls++;
    return String(url).endsWith('/models') ? Response.json({ data: [{ id: 'fixture-model' }] }) : new Response('inherited');
  };
  try {
    assert.equal(await defaultClient.run(async fetch => (await fetch('https://default.invalid')).text()), 'inherited');
    assert.deepEqual((await defaultAdapter.operations.discover()).models, ['fixture-model']);
    assert.equal(await explicit.run(async fetch => (await fetch('https://explicit.invalid')).text()), 'explicit');
    assert.deepEqual([inheritedCalls, explicitCalls], [2, 1]);
  } finally { globalThis.fetch = nativeFetch; }

  // A failed explicit client must never retry or borrow the inherited connection.
  const failure = new TypeError('fixture connection failed');
  let failedCalls = 0, fallbackCalls = 0;
  const failed = network({ fetchPort: async () => { failedCalls++; throw failure; } });
  globalThis.fetch = async () => { fallbackCalls++; throw new Error('unexpected global fallback'); };
  try {
    await assert.rejects(failed.run(fetch => fetch('https://failed.invalid')), error => error === failure);
    const adapter = createConfiguredProviderAdapter({
      id: 'failed-network', mediaProtocol: 'openai-images', baseUrl: 'https://failed.invalid/v1', apiKey: 'fixture-key'
    }, { network: failed });
    const result = await invokeProviderOperation(adapter, 'submit', { capability: 'image', model: 'fixture', input: { prompt: 'fixture' } });
    assert.equal(result.kind, 'acceptance_unknown');
    assert.equal(result.error.category, 'network');
    assert.deepEqual([failedCalls, fallbackCalls], [2, 0]);
    assert.equal(failed.snapshot().activeOperations, 0);
  } finally { globalThis.fetch = nativeFetch; }

  // Abort one live request while the other client's request remains usable.
  const controller = new AbortController();
  const canceled = a.run(async fetch => (await fetch(base + '/cancel/a', { signal: controller.signal })).text());
  const canceledCheck = assert.rejects(canceled, error => error.name === 'AbortError');
  const unaffected = b.run(async fetch => (await fetch(base + '/cancel/b')).json());
  await within(Promise.all([cancelA.promise, cancelB.promise]));
  controller.abort(); await within(canceledCheck);
  assert.equal(b.snapshot().activeOperations, 1);
  releaseB.resolve();
  assert.equal((await within(unaffected)).client, 'b');

  // Headers are not operation completion: disposal waits until the body is consumed.
  let bodyCloses = 0;
  const streaming = network({ fetchPort: nativeFetch, close: () => { bodyCloses++; } });
  const reading = streaming.run(async fetch => {
    const response = await fetch(base + '/body'); bodyHeaders.resolve(); return response.text();
  });
  await within(bodyHeaders.promise);
  const disposed = streaming.dispose();
  assert.deepEqual(streaming.snapshot(), { state: 'closing', activeOperations: 1, cleanupFailed: false });
  assert.equal(bodyCloses, 0);
  await assert.rejects(streaming.run(() => assert.fail('closed client admitted new work')), closedError);
  releaseBody.resolve();
  assert.equal(await within(reading), 'first-last'); await within(disposed); await streaming.dispose();
  assert.deepEqual(streaming.snapshot(), { state: 'closed', activeOperations: 0, cleanupFailed: false });
  assert.equal(bodyCloses, 1);
  await assert.rejects(streaming.fetch(base + '/never'), closedError);

  // An admitted operation can make its second request after disposal has begun.
  const hopOne = deferred(), hopTwo = deferred(); let hopCloses = 0;
  const hopping = network({ fetchPort: taggedFetch('hops'), close: () => { hopCloses++; } });
  const hops = hopping.run(async fetch => {
    await (await fetch(base + '/hop/one')).json(); hopOne.resolve(); await hopTwo.promise;
    return (await fetch(base + '/hop/two')).json();
  });
  await within(hopOne.promise); const drained = hopping.dispose();
  await assert.rejects(hopping.run(() => null), closedError);
  assert.equal(hopCloses, 0); hopTwo.resolve();
  assert.equal((await within(hops)).path, '/hop/two'); await within(drained);
  assert.equal(hopCloses, 1);

  // Cleanup failure is retained and cannot cause a second cleanup attempt.
  const cleanupError = new Error('fixture cleanup failed'); let cleanupCalls = 0;
  const brokenCleanup = network({ close: async () => { cleanupCalls++; throw cleanupError; } });
  await assert.rejects(brokenCleanup.dispose(), error => error === cleanupError);
  await assert.rejects(brokenCleanup.dispose(), error => error === cleanupError);
  assert.deepEqual(brokenCleanup.snapshot(), { state: 'closed', activeOperations: 0, cleanupFailed: true });
  assert.equal(cleanupCalls, 1);
  await assert.rejects(brokenCleanup.run(() => null), closedError);

  // Every extension operation is admitted exactly once; synchronous mapError stays synchronous.
  const operationNames = ['discover', 'submit', 'poll', 'cancel', 'download'], called = [];
  const extensionNetwork = network();
  const extension = defineProviderAdapter({
    id: 'extension-fixture', protocol: 'openai-images', capabilities: ['image'],
    operations: Object.fromEntries([
      ...operationNames.map(name => [name, async () => {
        called.push(name); assert.equal(extensionNetwork.snapshot().activeOperations, 1, name);
        return name === 'submit' ? { kind: 'accepted', remoteTaskId: 'extension-task' } : name === 'discover' ? { models: [] } : {};
      }]),
      ['mapError', error => error]
    ]),
    async prepareInput() { called.push('prepareInput'); assert.equal(extensionNetwork.snapshot().activeOperations, 1); return { url: 'oss://fixture' }; }
  });
  const extensionAdapter = createConfiguredProviderAdapter({
    id: 'extension-fixture', mediaProtocol: 'openai-images', baseUrl: 'https://extension.invalid/v1', apiKey: 'fixture-key'
  }, { network: extensionNetwork, registry: { createAdapter: () => extension } });
  for (const name of operationNames) await extensionAdapter.operations[name]({ capability: 'image', model: 'fixture' });
  await prepareProviderInput(extensionAdapter, {});
  assert.deepEqual(called, [...operationNames, 'prepareInput']);
  assert.equal(extensionAdapter.operations.mapError(new Error('fixture'), {}).then, undefined);
  await extensionNetwork.dispose();
  for (const name of operationNames) await assert.rejects(extensionAdapter.operations[name]({}), closedError);
  assert.equal(extensionAdapter.operations.mapError(new Error('fixture'), {}).then, undefined);

  // All DashScope hops, including object storage and media CDN, use the same explicit client.
  // URLs are intercepted below. No request is sent to any real provider or CDN.
  const trace = [], uploadPolicy = deferred(), releasePolicy = deferred();
  const bytes = Buffer.from('fixture-media-bytes'); let providerCloses = 0;
  const provider = { id: 'dash-network', mediaProtocol: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'fixture-api-key' };
  let dashNetwork;
  dashNetwork = network({ close: () => { providerCloses++; }, fetchPort: async (url, options = {}) => {
    const parsed = new URL(url), headers = new Headers(options.headers);
    trace.push({ host: parsed.host, path: parsed.pathname, authorization: headers.get('authorization') });
    assert.equal(dashNetwork.snapshot().activeOperations, 1);
    if (parsed.pathname === '/api/v1/models') return Response.json({ output: { models: ['fixture-model', 'fixture-model'] } });
    if (parsed.pathname.endsWith('/text2image/image-synthesis')) return Response.json({ output: { task_id: 'fixture-task' } });
    if (parsed.pathname === '/api/v1/tasks/fixture-task') return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.invalid/image.png' }] } });
    if (parsed.host === 'cdn.invalid') { assert.equal(headers.get('authorization'), null); return new Response(bytes); }
    if (parsed.pathname === '/api/v1/uploads') {
      uploadPolicy.resolve(); await releasePolicy.promise;
      return Response.json({ data: { upload_dir: 'fixture', upload_host: 'https://upload.invalid/object',
        oss_access_key_id: 'fixture-id', signature: 'fixture-signature', policy: 'fixture-policy',
        x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } });
    }
    if (parsed.host === 'upload.invalid') {
      assert.equal(headers.get('authorization'), null);
      assert.equal(options.method, 'POST'); assert(options.body instanceof FormData);
      assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), bytes);
      assert.equal(dashNetwork.snapshot().state, 'closing'); return new Response('');
    }
    throw new Error('Unexpected fixture request: ' + parsed.pathname);
  } });
  assert.throws(() => createConfiguredProviderAdapter(provider, { network: dashNetwork, transport: {} }), TypeError);
  assert.throws(() => createConfiguredProviderAdapter(provider, { network: dashNetwork, fetchPort: nativeFetch }), TypeError);
  const dash = createConfiguredProviderAdapter(provider, { network: dashNetwork });
  let leakedRequests = 0;
  globalThis.fetch = async () => { leakedRequests++; throw new Error('explicit client escaped to global fetch'); };
  try {
    assert.deepEqual((await dash.operations.discover()).models, ['fixture-model']);
    const submitted = await dash.operations.submit({ capability: 'image', model: 'fixture-async', input: { prompt: 'fixture' } });
    assert.equal(submitted.remoteTaskId, 'fixture-task');
    const polled = await dash.operations.poll({ capability: 'image', remoteTaskId: submitted.remoteTaskId });
    assert.equal(polled.kind, 'succeeded');
    const targetPath = path.join(root, 'download.bin');
    assert.equal((await dash.operations.download({ artifact: polled.artifacts[0], targetPath, capability: 'image' })).bytes, bytes.length);
    assert.deepEqual(fs.readFileSync(targetPath), bytes);
    assert.equal(fs.statSync(targetPath).mode & 0o777, 0o600);
    const prepared = prepareProviderInput(dash, { model: 'fixture-upload', bytes, filename: 'fixture.wav' });
    await within(uploadPolicy.promise); const closing = dashNetwork.dispose();
    assert.equal(dashNetwork.snapshot().activeOperations, 1); assert.equal(providerCloses, 0);
    releasePolicy.resolve(); assert.match((await within(prepared)).url, /^oss:\/\/fixture\//);
    await within(closing); assert.equal(providerCloses, 1); assert.equal(leakedRequests, 0);
    assert.equal(trace.filter(item => item.path.endsWith('/text2image/image-synthesis')).length, 1);
    assert(trace.filter(item => item.host === 'dashscope.aliyuncs.com').every(item => item.authorization === 'Bearer fixture-api-key'));
    assert.deepEqual(trace.map(item => item.host), ['dashscope.aliyuncs.com', 'dashscope.aliyuncs.com', 'dashscope.aliyuncs.com', 'cdn.invalid', 'dashscope.aliyuncs.com', 'upload.invalid']);
  } finally { releasePolicy.resolve(); globalThis.fetch = nativeFetch; }

  // Real catalog candidate and saved-Task assembly select a client without exposing credentials.
  const configPath = path.join(root, 'network-providers.json'), resolverCalls = [], resolvedRequests = [];
  const assemblyProviders = ['ports-a', 'ports-b'].map((id, index) => ({
    id, mediaProtocol: 'dashscope', apiKey: 'fixture-private-key-' + id,
    baseUrl: index ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' : 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] },
      { id: 'wan2.2-t2v-plus', capabilities: ['video-gen'] },
      { id: 'qwen3-tts-flash', capabilities: ['tts'] },
      { id: 'fun-asr', capabilities: ['transcribe'] }
    ]
  }));
  const assemblyCatalog = { providers: assemblyProviders, assignments: Object.fromEntries([
    ['image-gen', 'wan2.2-t2i-flash'], ['video-gen', 'wan2.2-t2v-plus'], ['tts', 'qwen3-tts-flash'], ['transcribe', 'fun-asr']
  ].map(([capability, model]) => [capability, assemblyProviders.map(provider => provider.id + '::' + model)])) };
  fs.writeFileSync(configPath, JSON.stringify(assemblyCatalog), { mode: 0o600 });
  const assemblyClients = new Map(assemblyProviders.map(provider => [provider.id, network({ fetchPort: async (url, options) => {
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + provider.apiKey);
    assert.equal(new URL(url).host, new URL(provider.baseUrl).host);
    resolvedRequests.push(provider.id);
    return Response.json({ output: { models: [provider.id + '-discovered'] } });
  } })]));
  const ports = configuredImagePorts(configPath, undefined, { resolveProviderNetwork: context => {
    assert.deepEqual(Object.keys(context).sort(), ['modelRef', 'providerId', 'taskId']);
    assert(!assemblyProviders.some(provider => JSON.stringify(context).includes(provider.apiKey)));
    resolverCalls.push(context); return assemblyClients.get(context.providerId);
  } });
  const imageCandidates = ports.resolveImageCandidates({});
  const otherCandidates = [
    ...ports.resolveVideoCandidates({}),
    ...ports.resolveAudioCandidates({ capability: 'tts' }),
    ...ports.resolveAudioCandidates({ capability: 'transcribe' })
  ];
  assert.deepEqual(imageCandidates.map(candidate => candidate.model), ['ports-a::wan2.2-t2i-flash', 'ports-b::wan2.2-t2i-flash']);
  assert.equal(otherCandidates.length, 6);
  assert.equal(resolverCalls.length, 8, 'candidate resolvers run synchronously during adapter assembly');
  for (const [index, context] of resolverCalls.entries()) {
    assert.equal(context.providerId, assemblyProviders[index % 2].id);
    assert(context.modelRef.startsWith(context.providerId + '::')); assert.equal(context.taskId, undefined);
  }
  // Changing today's assignment cannot redirect the saved task to the other connection.
  assemblyCatalog.assignments['image-gen'] = [imageCandidates[0].model];
  fs.writeFileSync(configPath, JSON.stringify(assemblyCatalog), { mode: 0o600 });
  const savedTask = { id: 'task-network-fixture', capability: 'image', providerId: 'ports-b',
    modelRef: imageCandidates[1].model, providerBinding: imageCandidates[1].providerBinding };
  const taskAdapter = ports.resolveTaskAdapter(savedTask);
  assert.deepEqual(resolverCalls.at(-1), { providerId: 'ports-b', modelRef: savedTask.modelRef, taskId: savedTask.id });
  globalThis.fetch = async () => { throw new Error('configured runtime escaped its selected client'); };
  try {
    for (const candidate of [...imageCandidates, ...otherCandidates]) {
      const providerId = candidate.model.split('::')[0];
      assert.deepEqual((await candidate.adapter.operations.discover()).models, [providerId + '-discovered']);
    }
    assert.deepEqual((await taskAdapter.operations.discover()).models, ['ports-b-discovered']);
    assert.deepEqual(resolvedRequests, ['ports-a', 'ports-b', 'ports-a', 'ports-b', 'ports-a', 'ports-b', 'ports-a', 'ports-b', 'ports-b']);
  } finally {
    globalThis.fetch = nativeFetch;
    await Promise.all([...assemblyClients.values()].map(client => client.dispose()));
  }
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert([...assemblyClients.values()].every(client => client.snapshot().state === 'closed'));

  // The other synchronous built-ins also bind discovery and generation to their explicit client.
  let builtInGlobalCalls = 0;
  globalThis.fetch = async () => { builtInGlobalCalls++; throw new Error('built-in protocol escaped its explicit client'); };
  try {
    for (const fixture of [
      { protocol: 'openai-chat-images', capability: 'image', leaf: '/chat/completions', bytes: FAKE_PNG,
        response: { choices: [{ message: { content: '![image](data:image/png;base64,' + FAKE_PNG.toString('base64') + ')' } }] } },
      { protocol: 'openai-responses-images', capability: 'image', leaf: '/responses', bytes: FAKE_PNG,
        response: { status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: FAKE_PNG.toString('base64') }] } },
      { protocol: 'gemini-web-music', capability: 'music', leaf: '/chat/completions', bytes: FAKE_WAV,
        response: { choices: [{ message: { content: '[audio](data:audio/wav;base64,' + FAKE_WAV.toString('base64') + ')' } }] } }
    ]) {
      const requests = []; let selectedNetwork;
      selectedNetwork = network({ fetchPort: async (url, options = {}) => {
        assert.equal(selectedNetwork.snapshot().activeOperations, 1, fixture.protocol);
        assert.equal(new Headers(options.headers).get('authorization'), 'Bearer fixture-built-in-key');
        const pathname = new URL(url).pathname; requests.push(pathname);
        if (pathname === '/v1/models') return Response.json({ data: [{ id: 'fixture-model' }] });
        assert.equal(pathname, '/v1' + fixture.leaf); assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body); assert.equal(body.model, 'fixture-model'); assert.equal(body.stream, false);
        return Response.json(fixture.response);
      } });
      const adapter = createConfiguredProviderAdapter({ id: 'network-' + fixture.protocol, mediaProtocol: fixture.protocol,
        baseUrl: 'https://built-in.invalid/v1', apiKey: 'fixture-built-in-key' }, { network: selectedNetwork });
      assert.deepEqual((await adapter.operations.discover()).models, ['fixture-model']);
      const generated = await adapter.operations.submit({ capability: fixture.capability, model: 'fixture-model', input: { prompt: 'fixture' } });
      assert.equal(generated.kind, 'completed'); assert.equal(generated.artifacts.length, 1);
      assert.equal(generated.artifacts[0].kind, 'inline-base64');
      assert.deepEqual(Buffer.from(generated.artifacts[0].data, 'base64'), fixture.bytes);
      assert.deepEqual(requests, ['/v1/models', '/v1' + fixture.leaf]);
      await selectedNetwork.dispose();
    }

    // ComfyUI consumes the same network.fetch via its own fetchPort, including node inspection and /view.
    const comfyRequests = []; let comfyNetwork;
    comfyNetwork = network({ fetchPort: async (url, options = {}) => {
      assert.equal(comfyNetwork.snapshot().activeOperations, 1, 'ComfyUI lifecycle');
      assert.equal(new Headers(options.headers).get('authorization'), null, 'auth:none never forwards a retained key');
      const parsed = new URL(url); assert.equal(parsed.origin, 'https://comfy.invalid');
      const pathname = parsed.pathname; comfyRequests.push(pathname);
      if (pathname === '/service/system_stats') return Response.json({ system: { os: 'fixture' } });
      if (pathname.startsWith('/service/object_info/')) {
        const type = decodeURIComponent(pathname.slice('/service/object_info/'.length));
        assert(Object.hasOwn(COMFY_SCHEMAS, type)); return Response.json({ [type]: COMFY_SCHEMAS[type] });
      }
      if (pathname === '/service/prompt') {
        assert.equal(options.method, 'POST');
        assert.equal(JSON.parse(options.body).prompt['6'].inputs.text, 'fixture iris');
        return Response.json({ prompt_id: 'network-comfy-task', number: 0, node_errors: {} });
      }
      if (pathname === '/service/history/network-comfy-task') return Response.json({ 'network-comfy-task': {
        status: { completed: true, status_str: 'success' },
        outputs: { '9': { images: [{ filename: 'result.png', subfolder: 'Iris', type: 'output' }] } }
      } });
      assert.equal(pathname, '/service/view');
      assert.deepEqual(Object.fromEntries(parsed.searchParams), { filename: 'result.png', subfolder: 'Iris', type: 'output' });
      return new Response(FAKE_PNG, { headers: { 'Content-Type': 'image/png' } });
    } });
    const comfy = createConfiguredProviderAdapter({ id: 'network-comfy', mediaProtocol: 'comfyui',
      baseUrl: 'https://comfy.invalid/service', auth: 'none', apiKey: 'retained-fixture-key',
      models: [{ id: 'fixture-workflow', comfyWorkflow: COMFY_WORKFLOW }] }, { network: comfyNetwork });
    assert.deepEqual((await comfy.operations.discover()).models.map(model => model.id), ['fixture-workflow']);
    const comfyTask = await comfy.operations.submit({ capability: 'image', model: 'fixture-workflow', input: { prompt: 'fixture iris' } });
    assert.deepEqual(comfyTask, { kind: 'accepted', remoteTaskId: 'network-comfy-task' });
    const completed = await comfy.operations.poll({ model: 'fixture-workflow', remoteTaskId: comfyTask.remoteTaskId });
    assert.equal(completed.kind, 'succeeded');
    const comfyTarget = path.join(root, 'comfy-network.png');
    assert.equal((await comfy.operations.download({ artifact: completed.artifacts[0], targetPath: comfyTarget })).bytes, FAKE_PNG.length);
    assert.deepEqual(fs.readFileSync(comfyTarget), FAKE_PNG);
    assert.equal(comfyRequests.filter(name => name.startsWith('/service/object_info/')).length, Object.keys(COMFY_SCHEMAS).length);
    assert.deepEqual(comfyRequests.filter(name => !name.startsWith('/service/object_info/')),
      ['/service/system_stats', '/service/prompt', '/service/history/network-comfy-task', '/service/view']);
    await comfyNetwork.dispose(); assert.equal(builtInGlobalCalls, 0);
  } finally { globalThis.fetch = nativeFetch; }

  assert.deepEqual(proxyNames.map(name => process.env[name]), proxyEnvironment, 'network clients must not rewrite global proxy settings');
  assert.equal(globalThis.fetch, nativeFetch);
  assert.equal(arrivals.filter(item => item.path === '/never').length, 0);
  console.log('ALL OK - provider network: client isolation, inherited fetch, abort, full-operation disposal, multi-hop upload/download, extension lifecycle, configured runtime, all six built-in protocols, no global fallback');
} finally {
  globalThis.fetch = nativeFetch;
  for (const release of releaseGates) release();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await Promise.allSettled(clients.map(client => client.dispose()));
  fs.rmSync(root, { recursive: true, force: true });
}
