import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeConfigCommand, settingsRevision } from '../lib/provider-config-service.js';
import { loadProviderCatalog } from '../lib/provider-catalog.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { COMFY_WORKFLOW, comfyProtocolFixture } from './fixtures/comfyui-protocol-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-workflow-check-redaction'), fixture = await comfyProtocolFixture();
const store = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const { createDshRuntime } = await import('../lib/dsh-core-adapter.js');
const { defineHostAdapter } = await import('../lib/host-contract.js');
const file = path.join(root, 'providers.json'), dataRoot = path.join(root, 'core');
const envName = 'IRIS_WORKFLOW_KEY_' + crypto.randomUUID().replaceAll('-', '').toUpperCase();
const secret = 'fixture-quote-"-slash-\\-tail', rotated = 'fixture-rotated-"-\\-tail';
let api, dsh;
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, entry]) => [key, ...strings(entry)]) : [];
function noSecret(report) {
  assert(strings(report).every(value => !value.includes(secret)), 'escaped and nested response values must be redacted before JSON formatting');
  assert.equal(report.executed, false); assert.equal(report.persisted, false); assert.equal(typeof report.ok, 'boolean');
  const choices = report.parameters.find(value => value.id === 'lora').availableChoices;
  assert.equal(choices[0], 'iris.safetensors'); assert.equal(choices[1], '[redacted]');
  assert.equal(choices[2].nested[0].echo, 'prefix [redacted] suffix');
}
function save(credential) {
  fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'comfy', name: 'Fixture', baseUrl: fixture.baseUrl,
    mediaProtocol: 'comfyui', ...credential, models: [{ id: 'portrait', capabilities: ['image-gen'], comfyWorkflow: COMFY_WORKFLOW }] }],
    assignments: { 'image-gen': ['comfy::portrait'] } }), { mode: 0o600 });
}
try {
  fixture.schemas.LoraLoader.input.required.lora_name[0] = ['iris.safetensors', secret,
    { nested: [{ echo: 'prefix ' + secret + ' suffix', [secret]: { ['prefix ' + secret]: secret } }] }];
  save({ apiKey: secret }); const inlineBytes = fs.readFileSync(file);
  const cli = await promisify(execFile)(process.execPath, ['bin/dsh-iris.js', 'models', 'workflow-check', 'comfy::portrait', '--provider-config', file],
    { timeout: 20000, encoding: 'utf8' });
  noSecret(JSON.parse(cli.stdout)); assert.deepEqual(fs.readFileSync(file), inlineBytes);
  assert(fixture.requests.every(request => request.method === 'GET' && request.authorization === 'Bearer ' + secret));

  process.env[envName] = secret; save({ apiKeyEnv: envName }); const envBytes = fs.readFileSync(file);
  fixture.beforeInfo = async () => { fixture.beforeInfo = undefined; process.env[envName] = rotated; };
  const report = await executeConfigCommand(file, 'settings.workflow-check', {
    expectedRevision: settingsRevision(loadProviderCatalog(file)), modelRef: 'comfy::portrait' });
  noSecret(report); assert.deepEqual(fs.readFileSync(file), envBytes);
  assert(fixture.requests.slice(-7).every(request => request.authorization === 'Bearer ' + secret), 'one check keeps its original credential even if the environment rotates');

  save({ auth: 'none', apiKey: secret }); const noAuthBytes = fs.readFileSync(file);
  const app = createApplicationRuntime({ dataRoot });
  try { await app.execute('flow.init', {}); } finally { await app.dispose(); }
  api = createLocalReadApi({ dataRoot, providerConfigPath: file, allowProviderManagement: true });
  const session = await api.start();
  for (const selected of [{ modelRef: 'comfy::portrait' }, { providerId: 'comfy', comfyWorkflow: COMFY_WORKFLOW }]) {
    const response = await fetch(session.origin + '/api/v0/provider-management/workflow-check', { method: 'POST',
      headers: { Authorization: 'Bearer ' + session.accessToken, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: settingsRevision(loadProviderCatalog(file)), ...selected }) });
    assert.equal(response.status, 200); noSecret(await response.json());
    assert(fixture.requests.slice(-7).every(request => !request.authorization), 'auth:none never sends the retained credential');
  }
  assert.deepEqual(fs.readFileSync(file), noAuthBytes); assert.equal(fixture.graphs.length, 0);
  dsh = createDshRuntime({ dataRoot: path.join(root, 'dsh-core') });
  const provider = store.upsert({ name: 'DSH fixture', baseUrl: fixture.baseUrl, apiKey: secret,
    mediaProtocol: 'comfyui', models: [{ id: 'portrait', capabilities: ['image-gen'], comfyWorkflow: COMFY_WORKFLOW }] });
  const dshFile = path.join(store.irisHome(), 'providers.json');
  async function checkDsh(id, selection, host) {
    const before = fs.readFileSync(dshFile);
    const result = await runAction(host, 'providers_check_comfy_workflow', { id, ...selection }, { core: dsh });
    noSecret(result.report); assert.deepEqual(fs.readFileSync(dshFile), before);
  }
  await checkDsh(provider.id, { model_id: 'portrait' });
  await checkDsh(provider.id, { workflow: COMFY_WORKFLOW });
  process.env[envName] = secret;
  store.upsert({ id: provider.id, apiKeyEnv: envName });
  fixture.beforeInfo = async () => { fixture.beforeInfo = undefined; process.env[envName] = rotated; };
  await checkDsh(provider.id, { model_id: 'portrait' });
  assert(fixture.requests.slice(-7).every(request => request.authorization === 'Bearer ' + secret));
  store.upsert({ id: provider.id, apiKey: secret, auth: 'none' });
  await checkDsh(provider.id, { workflow: COMFY_WORKFLOW });
  assert(fixture.requests.slice(-7).every(request => !request.authorization));
  const referenced = store.upsert({ name: 'DSH Host reference', mediaProtocol: 'comfyui',
    dshProvider: { provider: 'fixture', settingsNs: 'fixture' },
    models: [{ id: 'portrait', capabilities: ['image-gen'], comfyWorkflow: COMFY_WORKFLOW }] });
  const host = defineHostAdapter({ id: 'fixture-host', ports: { providerConnections: {
    resolve: async () => ({ baseUrl: fixture.baseUrl, apiKey: secret })
  } } });
  await checkDsh(referenced.id, { model_id: 'portrait' }, host);
  assert.equal(store.allProviders().find(provider => provider.id === referenced.id).apiKey, undefined);
  assert.equal(store.allProviders().find(provider => provider.id === referenced.id).baseUrl, undefined);
  assert.equal(fixture.graphs.length, 0);
  assert(strings(fixture.schemas).some(value => value.includes(secret)), 'redaction must not mutate upstream data');
  console.log('PASS workflow checks: real CLI/owner HTTP and DSH actions, saved/draft reports, quoted/backslash nested values, environment rotation, auth:none and Host references, zero generation and config changes');
} finally { delete process.env[envName]; await dsh?.dispose(); await api?.dispose(); await fixture.close(); }
