import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { useTempDshHome } from './test-env.js';
import crypto from 'node:crypto';
import { createNetworkProxyFixture } from './fixtures/network-proxy-fixture.mjs';
const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === '--package-root' && path.isAbsolute(args[1]));
const source = args[1] || fileURLToPath(new URL('..', import.meta.url));
const { createApplicationRuntime } = await import(pathToFileURL(path.join(source, 'lib/application-runtime.js')));
const { wrapProviderCatalog, encodeProviderConfig } = await import(pathToFileURL(path.join(source, 'lib/provider-config-format.js')));
const { root } = useTempDshHome('iris-network-cli-owner'), dataRoot = path.join(root, 'core'), network = path.join(root, 'network.json'), providers = path.join(root, 'providers.json');
const app = createApplicationRuntime({ dataRoot }), children = [];
const fixture = await createNetworkProxyFixture(root);
function launch(values) {
  const child = spawn(process.execPath, [path.join(source, 'bin/dsh-iris.js'), ...values], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', NODE_OPTIONS: '' } });
  const entry = { child, output: '', error: '', ended: false };
  child.stdout.on('data', bytes => { entry.output += bytes; }); child.stderr.on('data', bytes => { entry.error += bytes; });
  entry.closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { entry.ended = true; resolve({ code, signal }); }); });
  children.push(entry); return entry;
}
async function ready(entry) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (entry.output.includes('\n')) return JSON.parse(entry.output.split('\n')[0]);
    if (entry.ended) throw new Error('network CLI startup failed: ' + entry.error);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('network CLI startup exceeded 20 seconds');
}
try {
  fs.writeFileSync(providers, JSON.stringify({ providers: [] }), { mode: 0o600 });
  await app.execute('flow.init', {}); await app.execute('execution.init', {}); await app.dispose();
  const tokenFile = path.join(root, 'owner-token'), entry = launch(['web', 'serve', '--data-root', dataRoot, '--token-file', tokenFile,
    '--provider-config', providers, '--network-config', network, '--allow-network-management']);
  let session = await ready(entry), token = fs.readFileSync(tokenFile, 'utf8').trim();
  const call = async (endpoint, body) => {
    const response = await fetch(session.origin + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { Origin: session.origin, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal(session.networkManagement, true);
  const flags = await call('/api/v0/session'); assert.equal(flags.networkManagement, true); assert.equal(flags.providerManagement, false);
  assert.equal((await call('/api/v0/network-management/settings')).storage, 'missing'); assert(!fs.existsSync(network));
  const asset = await fetch(session.origin + '/network.js'); assert.equal(asset.status, 200); assert((await asset.text()).includes('createNetworkPanel'));
  const initialized = await call('/api/v0/network-management/init', {}); assert.equal(initialized.settings.network.schemaVersion, 2);
  const doctor = await call('/api/v0/network-management/doctor'); assert.equal(doctor.source, 'core-process'); assert.equal(doctor.networkTested, false);
  entry.child.kill('SIGTERM'); const stopped = await entry.closed;
  assert(process.platform === 'win32' ? stopped.signal === 'SIGTERM' : stopped.code === 143);
  assert(!entry.output.includes(token)); assert(!entry.error.includes(token));
  const proxy = await fixture.createProxy({ tag: 'packaged-cli' }), routed = path.join(root, 'providers-routed.json');
  fs.writeFileSync(routed, JSON.stringify(encodeProviderConfig(wrapProviderCatalog({ providers: [{ id: 'p', name: 'Pack fixture', mediaProtocol: 'openai-images',
    apiKey: 'synthetic-packaged-provider-key', baseUrl: fixture.httpOrigin, models: [] }] }, { schemaVersion: 1, configId: initialized.settings.network.configId, catalogId: crypto.randomUUID() }))), { mode: 0o600 });
  const nextTokenFile = path.join(root, 'second-token');
  const next = launch(['web', 'serve', '--data-root', dataRoot, '--token-file', nextTokenFile, '--provider-config', routed, '--network-config', network, '--allow-network-management']);
  session = await ready(next); token = fs.readFileSync(nextTokenFile, 'utf8').trim();
  let current = await call('/api/v0/network-management/settings');
  const mutate = async (action, fields) => { const r = await call('/api/v0/network-management/' + action, { expectedRevision: current.network.revision, ...fields }); current = r.settings; };
  await mutate('nodes/add', { node: { id: 'node', protocol: 'http', host: '127.0.0.1', port: proxy.port } });
  await mutate('pools/add', { pool: { id: 'pool', mode: 'fixed', candidates: [{ kind: 'node', nodeId: 'node' }] } });
  await mutate('bindings/set', { expectedProviderRevision: current.catalog.revision, providerId: 'p', poolId: 'pool' });
  const probed = await call('/api/v0/network-management/probe', { expectedRevision: current.network.revision, expectedProviderRevision: current.catalog.revision,
    providerId: 'p', target: 'ip', url: fixture.httpOrigin + '/doctor/ip' });
  assert.equal(probed.observedIp, '203.0.113.8'); assert.equal(probed.route.nodeId, 'node'); assert.equal(fixture.requests.length, 1); assert(proxy.connects.length > 0);
  assert.equal(fixture.requests[0].headers.authorization, undefined); assert(!JSON.stringify(probed).includes('synthetic-packaged-provider-key'));
  const bytes = fs.readFileSync(network); next.child.kill('SIGTERM'); await next.closed; assert.deepEqual(fs.readFileSync(network), bytes);
  const missing = launch(['api', 'serve', '--data-root', dataRoot, '--token-file', path.join(root, 'missing-token'), '--allow-network-management']);
  assert.equal((await missing.closed).code, 1); assert(missing.error.includes('IRIS_API_CONFIG_INVALID')); assert(!fs.existsSync(path.join(root, 'missing-token')));
  const duplicate = launch(['web', 'serve', '--allow-network-management', '--allow-network-management']);
  assert.equal((await duplicate.closed).code, 2);
  console.log('PASS actual CLI opt-in and restart, static asset, owner init/CAS/binding/Doctor, real proxy GET without Provider key, graceful close and invalid launch guards');
} finally { for (const entry of children) { if (!entry.ended) entry.child.kill('SIGTERM'); await entry.closed; } await fixture.close(); await app.dispose(); }
