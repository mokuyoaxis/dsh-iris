import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { useTempDshHome } from './test-env.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const { root } = useTempDshHome('iris-network-routing-cli');
const network = path.join(root, 'network.json'), source = path.join(root, 'source.json'), wrapped = path.join(root, 'wrapped.json');
const data = path.join(root, 'core'), guard = path.join(root, 'fetch.mjs'), log = path.join(root, 'requests.jsonl');
fs.writeFileSync(source, JSON.stringify({ providers: [{ id: 'p', mediaProtocol: 'openai-images', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-private-key',
  models: [{ id: 'image', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': ['p::image'] } }), { mode: 0o600 });
const sourceBytes = fs.readFileSync(source);
fs.writeFileSync(guard, `import fs from 'node:fs';
globalThis.fetch = async (url, options={}) => {
 if(String(url)!=='https://fixture.invalid/v1/images/generations') throw new Error('unexpected fixture URL');
 fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({method: options.method})+String.fromCharCode(10));
 return Response.json({data:[{b64_json:${JSON.stringify(FAKE_PNG.toString('base64'))}}]});
};\n`, { mode: 0o600 });
let calls = 0;
const cli = (args, { status = 0, input } = {}) => {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, 'bin/dsh-iris.js', ...args], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DSH_HOME: path.join(root, 'unused-dsh') }, input });
  assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, status, r.stderr);
  assert(!(r.stdout + r.stderr).includes('synthetic-private-key')); calls++;
  return status === 0 ? JSON.parse(r.stdout) : r;
};
let state = cli(['network', 'routing', 'init', '--network-config', network]);
const created = cli(['network', 'catalog', 'create', '--network-config', network, '--provider-config', source, '--output', wrapped]);
assert.deepEqual(created.networkRequirement.configId, state.configId);
cli(['run', 'image', '--provider-config', wrapped, '--data-root', data, '--input', '{"prompt":"fixture","model_ref":"p::image"}'], { status: 1 });
assert(!fs.existsSync(log), 'missing network context cannot submit');
const result = cli(['run', 'image', '--provider-config', wrapped, '--network-config', network, '--data-root', data, '--input', '{"prompt":"fixture","model_ref":"p::image"}']);
assert.equal(result.task.semanticsVersion, 3); assert.equal(result.task.deliveryState, 'ready');
assert.equal(result.task.networkRoutes[0].route, 'inherit'); assert.equal(result.task.networkRoutes[0].operation, 'submit');
assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
const inspected = cli(['task', 'inspect', result.task.id, '--data-root', data]);
assert.equal(inspected.task.networkRoutes[0].requestCount, 1);
cli(['config', 'show', '--provider-config', wrapped]);
assert(JSON.parse(fs.readFileSync(wrapped)).catalog.providers.length === 1, 'health writes preserve envelope');
state = cli(['network', 'pools', 'add', '--network-config', network, '--input', JSON.stringify({ expectedRevision: state.revision,
  pool: { id: 'empty', mode: 'fixed', candidates: [] } })]);
state = cli(['network', 'bindings', 'set', '--network-config', network, '--provider-config', wrapped, '--input', JSON.stringify({ expectedRevision: state.revision, providerId: 'p', poolId: 'empty' })]);
cli(['run', 'image', '--provider-config', wrapped, '--network-config', network, '--data-root', data, '--input', '{"prompt":"fixture","model_ref":"p::image"}'], { status: 1 });
assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'an empty bound pool cannot silently inherit');
cli(['network', 'pools', 'remove', '--network-config', network, '--input', JSON.stringify({ expectedRevision: state.revision, id: 'empty', confirm: true })], { status: 1 });
cli(['network', 'bindings', 'remove', '--network-config', network, '--input', JSON.stringify({ expectedRevision: state.revision,
  catalogId: created.networkRequirement.catalogId, providerId: 'p', confirm: true })]);
assert.deepEqual(fs.readFileSync(source), sourceBytes); assert(!fs.existsSync(path.join(root, 'unused-dsh')));
console.log(JSON.stringify({ ok: true, cliCalls: calls, checks: ['explicit new catalog, missing-context rejection, inherited Task3 and dispatch facts', 'health and owner reads preserve wrapper, empty binding cannot inherit, pool reference guard', 'source configuration and daily roots remain unchanged'] }));
