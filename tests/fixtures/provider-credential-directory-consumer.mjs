// Public CLI/SDK/HTTP only; also runs unchanged outside the repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCorePluginWorkbench } from '@mokuyoaxis/dsh-iris/plugins';

const packageFile = fileURLToPath(import.meta.resolve('@mokuyoaxis/dsh-iris/package.json'));
const cli = path.resolve(path.dirname(packageFile), JSON.parse(fs.readFileSync(packageFile)).bin['dsh-iris']);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-directory-consumer-')); fs.chmodSync(root, 0o700);
const config = path.join(root, 'providers.json'), dataRoot = path.join(root, 'core');
const envName = 'IRIS_DIRECTORY_REVIEW_' + crypto.randomUUID().replaceAll('-', '').toUpperCase();
const key = 'directory-fixture-' + crypto.randomBytes(900).toString('hex');
const checks = []; let mode = 'echo', api, requests = 0, processes = 0;
const server = http.createServer((request, response) => {
  assert.equal(request.headers.authorization === 'Bearer ' + key, true); requests++;
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'edit' }, { id: mode === 'echo' ? key : 'new-model' }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const provider = { id: 'account', name: 'echo:' + key, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
  apiKeyEnv: envName, mediaProtocol: 'openai-chat-images', models: [{ id: key, capabilities: ['image-gen'] }] };
const write = catalog => fs.writeFileSync(config, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 });
function clean(text) { assert(!text.includes(key) && !text.includes(key.slice(0, 48)), 'no full credential or truncated prefix'); }
async function run(args, expected = 0) {
  processes++; let result;
  try { result = await promisify(execFile)(process.execPath, [cli, ...args], { timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, [envName]: key, DSH_HOME: root, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '', IRIS_CORE_SCOPES: '', NODE_OPTIONS: '' } });
    assert.equal(expected, 0);
  } catch (error) { if (expected === 0) throw error; assert.equal(error.code, expected); result = error; }
  clean(result.stdout || ''); clean(result.stderr || '');
  if (expected) { assert.match(result.stderr, /(?:^|\n)IRIS_PROVIDER_DIRECTORY_CREDENTIALS:/); return; }
  return JSON.parse(result.stdout);
}
try {
  write({ providers: [provider], assignments: { 'image-gen': ['account::' + key] } });
  for (const args of [['config', 'show'], ['models', 'list'], ['assignments', 'list']]) await run([...args, '--provider-config', config]);
  checks.push('actual installed CLI redacts long credentials before summary/model/assignment formatting');
  write({ providers: [{ ...provider, name: 'Account', models: [{ id: 'edit', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': ['account::edit'] } });
  const before = fs.readFileSync(config);
  for (const apply of ['false', 'true']) {
    await run(['models', 'discover', 'account', '--provider-config', config, '--apply', apply], 1);
    assert.deepEqual(fs.readFileSync(config), before);
  }
  mode = 'clean';
  const result = await run(['models', 'discover', 'account', '--provider-config', config, '--apply', 'true']);
  assert.deepEqual(result.models.map(model => model.id), ['edit', 'new-model']);
  checks.push('CLI rejects echoed credentials with the specific safe code and no write; normal model IDs still import');
  await run(['flow', 'init', '--data-root', dataRoot]); await run(['execution', 'init', '--data-root', dataRoot]);
  process.env[envName] = key; mode = 'echo';
  api = createCorePluginWorkbench({ dataRoot, providerConfigPath: config, allowProviderManagement: true });
  const session = await api.start(), headers = { Authorization: 'Bearer ' + session.accessToken };
  const settingsResponse = await fetch(session.origin + '/api/v0/provider-management/settings', { headers });
  assert.equal(settingsResponse.status, 200); const settingsText = await settingsResponse.text(); clean(settingsText);
  const response = await fetch(session.origin + '/api/v0/provider-management/discover', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: JSON.parse(settingsText).revision, providerId: 'account' }) });
  assert.equal(response.status, 502); const text = await response.text(); clean(text);
  assert.equal(JSON.parse(text).error.code, 'IRIS_PROVIDER_DIRECTORY_CREDENTIALS');
  checks.push('public installed Workbench SDK returns a specific sanitized HTTP error for unsafe discovery');
  console.log(JSON.stringify({ ok: true, checks, root, cliProcesses: processes, requests }, null, 2));
} finally { delete process.env[envName]; await api?.dispose(); await new Promise(resolve => server.close(resolve)); }
