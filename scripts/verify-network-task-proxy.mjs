// Controlled lifecycle provider + actual Core storage, process restart and CONNECT.
// Optional package-root exercises the same runtime files from an actual tarball.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNetworkProxyFixture } from '../tests/fixtures/network-proxy-fixture.mjs';

const args = process.argv.slice(2);
let resumeFile, sourceRoot = fileURLToPath(new URL('..', import.meta.url));
while (args.length) {
  const flag = args.shift(), value = args.shift();
  assert(['--package-root', '--resume'].includes(flag) && value && path.isAbsolute(value), 'Usage: [--package-root <absolute-package>] [--resume <absolute-fixture-state>]');
  if (flag === '--package-root') sourceRoot = value; else resumeFile = value;
}
const load = name => import(pathToFileURL(path.join(sourceRoot, 'lib', name + '.js')));
const [{ createProviderNetworkManager }, { createCoreRuntime }, { createProviderTaskRunner }, { inspectCoreTask, listCoreTasks },
  { defineProviderAdapter }, { createConfiguredProviderAdapter, mapProviderAdapterError }, { wrapProviderCatalog, encodeProviderConfig },
  { createApplicationRuntime }, { createLocalReadApi }] = await Promise.all([
  load('network-routing'), load('core-runtime'), load('provider-task-runner'), load('core-tasks'),
  load('provider-adapter'), load('provider-adapters'), load('provider-config-format'), load('application-runtime'), load('local-api')
]);

function asyncAdapter(network, origin, requirement) {
  const operations = {
    submit: async (input, context) => network.run(async fetch => {
      const response = await fetch(origin + '/durable/submit', { method: 'POST', signal: input.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.input) });
      const body = await response.json(); assert.equal(response.status, 200);
      return { kind: 'accepted', remoteTaskId: body.taskId };
    }, { ...context, operation: 'submit' }),
    poll: async (input, context) => network.run(async fetch => {
      const response = await fetch(origin + '/durable/tasks/' + encodeURIComponent(input.remoteTaskId), { signal: input.signal });
      const body = await response.json(); assert.equal(response.status, 200);
      return { kind: 'succeeded', artifacts: [{ kind: 'remote-url', url: body.url, mediaType: 'image/png' }] };
    }, { ...context, operation: 'poll' }),
    download: async (input, context) => network.run(async fetch => {
      const response = await fetch(input.artifact.url, { signal: input.signal });
      const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, 200);
      fs.writeFileSync(input.targetPath, bytes, { mode: 0o600, flag: 'wx' }); return { bytes: bytes.length };
    }, { ...context, operation: 'download' }),
    mapError: mapProviderAdapterError
  };
  return Object.freeze({ ...defineProviderAdapter({ id: 'p', protocol: 'fixture-async', capabilities: ['image'], operations,
    unsupported: { discover: 'Controlled fixture has no discovery', cancel: 'Controlled fixture has no remote cancel' } }), networkRequirement: requirement });
}

function runtime(root) { const value = createCoreRuntime({ dataRoot: root, mode: 'writer' }); value.start(); return value; }

if (resumeFile) {
  const state = JSON.parse(fs.readFileSync(resumeFile)), core = runtime(state.dataRoot);
  const manager = createProviderNetworkManager({ networkConfigPath: state.file, tls: { ca: fs.readFileSync(state.caFile) }, proxyTls: { ca: fs.readFileSync(state.caFile) } });
  try {
    const client = manager.resolveProviderNetwork({ providerId: 'p', networkRequirement: state.requirement });
    const task = await createProviderTaskRunner(core).recover(state.taskId, asyncAdapter(client, state.origin, state.requirement));
    assert.equal(task.deliveryState, 'ready');
    console.log(JSON.stringify({ pid: process.pid, taskId: task.id, remoteTaskId: task.remoteTaskId, artifactIds: task.artifactIds }));
  } finally { await core.dispose(); await manager.dispose(); }
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-task-proxy-')), dataRoot = path.join(root, 'core');
  const fixture = await createNetworkProxyFixture(root), file = path.join(root, 'network.json');
  const requirement = { schemaVersion: 1, configId: crypto.randomUUID(), catalogId: crypto.randomUUID() };
  const managers = [], runtimes = [], checks = [];
  const makeManager = () => { const value = createProviderNetworkManager({ networkConfigPath: file, tls: { ca: fixture.ca }, proxyTls: { ca: fixture.ca } }); managers.push(value); return value; };
  const makeRuntime = () => { const value = runtime(dataRoot); runtimes.push(value); return value; };
  try {
    const a = await fixture.createProxy({ tag: 'original' }), b = await fixture.createProxy({ tag: 'next', tls: true });
    const config = { schemaVersion: 2, configId: requirement.configId, generation: 1,
      nodes: [{ id: 'a', protocol: 'http', host: '127.0.0.1', port: a.port }, { id: 'b', protocol: 'https', host: '127.0.0.1', port: b.port }],
      pools: [{ id: 'primary', mode: 'ordered', candidates: [{ kind: 'node', nodeId: 'a' }, { kind: 'node', nodeId: 'b' }] },
        { id: 'standby', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'b' }] }],
      bindings: [{ catalogId: requirement.catalogId, providerId: 'p', poolId: 'primary' }, { catalogId: requirement.catalogId, providerId: 'q', poolId: 'standby' }] };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const firstCore = makeRuntime(), firstManager = makeManager();
    const first = asyncAdapter(firstManager.resolveProviderNetwork({ providerId: 'p', networkRequirement: requirement }), fixture.httpOrigin, requirement);
    const submitted = await createProviderTaskRunner(firstCore).submit({ capability: 'image', providerInput: { prompt: 'controlled fixture' }, candidates: [{ adapter: first, model: 'p::image' }] });
    assert.equal(submitted.task.acceptance, 'accepted'); assert.equal(submitted.task.remoteTaskId, 'original-remote');
    assert.equal(submitted.task.semanticsVersion, 3); assert.equal(submitted.task.networkRoutes[0].nodeId, 'a');
    assert.equal(submitted.task.networkRoutes[0].requestCount, 1);
    await firstCore.dispose(); await firstManager.dispose();

    config.generation++;
    config.pools[0].candidates.reverse();
    fs.writeFileSync(file, JSON.stringify(config));
    const stateFile = path.join(root, 'resume-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ dataRoot, file, taskId: submitted.task.id, requirement,
      origin: fixture.httpOrigin, caFile: path.join(root, 'proxy-fixture-cert.pem') }), { mode: 0o600 });
    const originalConnections = a.connects.length;
    const child = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--resume', stateFile, '--package-root', sourceRoot],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
    fs.writeFileSync(path.join(root, 'resume-process.log'), child.stdout + child.stderr);
    const resumed = JSON.parse(child.stdout); assert.notEqual(resumed.pid, process.pid); assert.equal(resumed.taskId, submitted.task.id);
    const task = inspectCoreTask(dataRoot, submitted.task.id);
    assert.equal(task.deliveryState, 'ready'); assert.equal(task.remoteTaskId, 'original-remote');
    assert.deepEqual(task.networkRoutes.map(row => [row.operation, row.nodeId]), [['submit', 'a'], ['poll', 'b'], ['download', 'b']]);
    assert.equal(fixture.requests.filter(row => row.method === 'POST' && row.path === '/durable/submit').length, 1);
    assert.equal(fixture.requests.filter(row => row.method === 'GET' && row.path === '/durable/tasks/original-remote').length, 1);
    assert.equal(fixture.requests.filter(row => row.method === 'GET' && row.path === '/durable/result').length, 1);
    assert.equal(a.connects.length, originalConnections); assert(b.connects.length > 0);
    assert.equal(task.networkRoutes[0].configGeneration, 1); assert.equal(task.networkRoutes[1].configGeneration, 2);
    checks.push('separate Node process restores the original accepted Task and remote ID through a newly allowed exit: one original POST, one GET, one download');

    config.generation++; config.pools[0].candidates.reverse(); fs.writeFileSync(file, JSON.stringify(config));
    const core = makeRuntime(), manager = makeManager(), catalog = wrapProviderCatalog({ providers: [
      { id: 'p', mediaProtocol: 'openai-images', apiKey: 'synthetic-provider-key', baseUrl: fixture.httpOrigin + '/unknown/v1' },
      { id: 'q', mediaProtocol: 'openai-images', apiKey: 'synthetic-backup-key', baseUrl: fixture.httpOrigin + '/standby/v1' }
    ] }, requirement);
    const candidates = catalog.providers.map(provider => ({ model: provider.id + '::image', adapter: createConfiguredProviderAdapter(provider, {
      network: manager.resolveProviderNetwork({ providerId: provider.id, networkRequirement: requirement }) }) }));
    const standbyConnections = b.connects.length, runner = createProviderTaskRunner(core);
    const unknown = await runner.submit({ capability: 'image', providerInput: { prompt: 'received POST then reset' }, candidates });
    assert.equal(unknown.task.acceptance, 'unknown'); assert.equal(unknown.task.attempts.length, 1);
    assert.equal(unknown.task.networkRoutes[0].nodeId, 'a'); assert.equal(unknown.task.networkRoutes[0].operation, 'submit');
    assert.equal(fixture.requests.filter(row => row.path === '/unknown/v1/images/generations' && row.method === 'POST').length, 1);
    assert.equal(fixture.requests.filter(row => row.path.startsWith('/standby/')).length, 0); assert.equal(b.connects.length, standbyConnections);
    const beforeRecover = fixture.requests.length;
    await runner.recover(unknown.task.id, candidates[0].adapter);
    assert.equal(fixture.requests.length, beforeRecover, 'unknown acceptance cannot manufacture a new generation on recovery');
    assert(!JSON.stringify(unknown.task.networkRoutes).includes('synthetic-provider-key'));
    checks.push('actual configured OpenAI adapter preserves unknown acceptance after received POST and reset: zero backup exit/model POSTs; recovery never resubmits');

    const providerFile = path.join(root, 'providers.json');
    fs.writeFileSync(providerFile, JSON.stringify(encodeProviderConfig(wrapProviderCatalog({ providers: [{ id: 'p', mediaProtocol: 'openai-images',
      baseUrl: fixture.httpOrigin + '/sync/v1', apiKey: 'synthetic-cli-key', models: [{ id: 'image', capabilities: ['image-gen'] }] }],
      assignments: { 'image-gen': ['p::image'] } }, requirement))), { mode: 0o600 });
    const cli = await promisify(execFile)(process.execPath, [path.join(sourceRoot, 'bin/dsh-iris.js'), 'run', 'image', '--data-root', path.join(root, 'cli-core'),
      '--provider-config', providerFile, '--network-config', file, '--input', '{"model_ref":"p::image","prompt":"real proxy CLI fixture"}'],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '', DSH_HOME: path.join(root, 'unused-dsh') } });
    fs.writeFileSync(path.join(root, 'cli.log'), cli.stdout + cli.stderr);
    const cliTask = JSON.parse(cli.stdout).task;
    assert.equal(cliTask.deliveryState, 'ready'); assert.equal(cliTask.semanticsVersion, 3);
    assert.deepEqual(cliTask.networkRoutes.map(row => [row.operation, row.nodeId]), [['submit', 'a'], ['download', 'a']]);
    assert.equal(JSON.parse(fs.readFileSync(providerFile)).networkRequirement.configId, requirement.configId);
    assert(!fs.existsSync(path.join(root, 'unused-dsh')));
    checks.push('actual CLI consumes the explicit catalog and binding, persists proxy route facts, downloads the image and preserves the envelope');

    const apiRoot = path.join(root, 'api-core'), application = createApplicationRuntime({ dataRoot: apiRoot });
    try { await application.execute('flow.init', {}); await application.execute('execution.init', { imageGeneration: true }); }
    finally { await application.dispose(); }
    const apiManager = makeManager(), api = createLocalReadApi({ dataRoot: apiRoot, providerConfigPath: providerFile,
      networkConfigPath: file, networkManager: apiManager, allowLocalWrites: true, allowExecution: true });
    try {
      const session = await api.start();
      const post = async (endpoint, body) => {
        const response = await fetch(session.origin + endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken,
          'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      };
      const created = await post('/api/v0/generations', { modelRef: 'p::image', prompt: 'real proxy API fixture' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const continued = await post('/api/v0/runs/' + created.body.flow.id + '/continue', { expectedRevision: created.body.flow.revision });
      assert.equal(continued.status, 202, JSON.stringify(continued.body));
      const deadline = performance.now() + 10000; let apiTask;
      while (performance.now() < deadline) {
        apiTask = listCoreTasks(apiRoot).tasks[0];
        if (apiTask?.deliveryState === 'ready') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(apiTask?.deliveryState, 'ready'); assert.equal(apiTask.semanticsVersion, 3);
      assert.deepEqual(apiTask.networkRoutes.map(row => [row.operation, row.nodeId]), [['submit', 'a'], ['download', 'a']]);
    } finally { await api.dispose(); }
    assert.equal(fixture.requests.filter(row => row.path === '/sync/v1/images/generations' && row.method === 'POST').length, 2);
    assert.deepEqual(fixture.errors, []);
    checks.push('actual HTTP API creates and executes a protected Flow through a borrowed manager; Core persists the route before real proxy dispatch');
    console.log(JSON.stringify({ ok: true, checks, root, restartPid: resumed.pid, acceptedTaskId: task.id, unknownTaskId: unknown.task.id,
      acceptedRouteFacts: task.networkRoutes, upstreamRequests: fixture.requests.length, note: 'Controlled loopback lifecycle and OpenAI-compatible fixtures; no paid provider or real user configuration.' }, null, 2));
  } finally {
    await fixture.close(); for (const core of runtimes) await core.dispose(); for (const manager of managers) await manager.dispose();
  }
}
