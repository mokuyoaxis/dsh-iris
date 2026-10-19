/** Actual DSH Loader/Settings/Credentials services in a private, disposable profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isSupportedDshVersion } from '../lib/dsh-compatibility.js';

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--dsh-root' && path.isAbsolute(args[1]), '需要 --dsh-root 绝对路径');
const dshRoot = fs.realpathSync(args[1]);
const manifest = JSON.parse(fs.readFileSync(path.join(dshRoot, 'package.json')));
assert.equal(manifest.name, '@deepseek-ai/dsh');
assert(isSupportedDshVersion(manifest.version));
const requireDsh = createRequire(path.join(dshRoot, 'package.json'));
const url = name => pathToFileURL(requireDsh.resolve(name)).href;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-provider-services-'));
const profile = path.join(work, 'profile');
fs.mkdirSync(profile);
process.env.DSH_HOME = path.join(work, 'home');
process.env.IRIS_IMPORT_WORKBENCH_CONFIG = '';
process.chdir(work); // The real credential service must never consult the project's .env.
globalThis.fetch = async () => { throw new Error('服务验收禁止网络/模型请求'); };
const report = { status: 'running', dsh: manifest.version, work, checks: [] };
const save = () => fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const fixture = path.join(work, 'fixture.mjs');
fs.writeFileSync(fixture, `
import z from ${JSON.stringify(url('@deepseek-ai/schemastery'))};
import { LlmAdapter } from ${JSON.stringify(url('@deepseek-ai/dsh-llm'))};
export const Config = z.object({ providers: z.dict(z.object({
  baseURL: z.string(), apiKeyEnv: z.string()
})).default({}).volatile() });
export function apply(ctx, config) {
  const llm = ctx.get('llm');
  const routes = Object.keys(config.providers.get());
  llm.registerAdapter(routes, new LlmAdapter());
  llm.registerConfigurableProviders(routes.map(provider => ({ provider, displayName: provider,
    settingsNs: ctx.fiber.entry.options.id, settingsPath: ['providers', provider] })));
}
`);
const patchFile = path.join(profile, 'cordis.patch.yml');
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'iris-isolated-provider-check', private: true,
  dsh: { profile: { bundles: [] } } }));
fs.writeFileSync(patchFile, JSON.stringify([{ insert: [{ id: 'llm-pi-ai', name: fixture, config: {
  providers: { fixture: { baseURL: 'http://127.0.0.1:17863/v1', apiKeyEnv: 'IRIS_SERVICE_FIXTURE_KEY' } }
} }] }]));
const bootFile = path.join(work, 'boot.yml');
fs.writeFileSync(bootFile, '[]\n');
let ctx;
try {
  const [{ boot }, { ConfigEditor }, { SettingsForms }, { LocalCredentialProvider }, { LlmRuntime }] = await Promise.all([
    import(url('@deepseek-ai/dsh-app-boot')), import(url('@deepseek-ai/dsh-config-editor')),
    import(url('@deepseek-ai/dsh-settings')), import(url('@deepseek-ai/dsh-credentials-local')),
    import(url('@deepseek-ai/dsh-llm'))
  ]);
  ctx = await boot('iris-service-check', bootFile, JSON.parse(fs.readFileSync(patchFile)), async scope => {
    scope.provide('profileContext', { dir: profile, home: process.env.DSH_HOME, patchPath: patchFile,
      installAnchor: path.join(dshRoot, 'package.json'), name: 'iris-service-check', overlays: [], cwd: work, startedBundles: [] });
    await scope.plugin(LlmRuntime, {});
    await scope.plugin(LocalCredentialProvider, { dshHome: process.env.DSH_HOME, watch: false });
    await scope.plugin(ConfigEditor, {});
    await scope.plugin(SettingsForms, {});
  }, pathToFileURL(path.join(dshRoot, 'package.json')).href);
  const { createDshHostAdapter } = await import('../lib/dsh-host-adapter.js');
  const { runAction } = await import('../lib/actions.js');
  const { withDshProviderConfig } = await import('../lib/dsh-provider-config.js');
  const store = await import('../lib/config.js');
  const host = () => createDshHostAdapter(ctx, { version: manifest.version });
  const credentials = ctx.get('credentials');
  const settings = ctx.get('settings');
  const reference = { provider: 'fixture', settingsNs: 'llm-pi-ai' };
  await credentials.set('IRIS_SERVICE_FIXTURE_KEY', 'isolated-fixture-one');
  const entries = await host().ports.providerConnections.list();
  assert.equal(entries.find(item => item.provider === 'fixture')?.available, true);
  assert(!JSON.stringify(entries).includes('isolated-fixture-one'));
  report.checks.push('actual Loader directory, redacted Settings and LocalCredentialProvider enumerate a usable reference');
  const configured = await runAction(host(), 'providers_upsert', { name: 'isolated shared', dshProvider: reference,
    mediaProtocol: 'openai-images' });
  assert(configured.providerId);
  assert(!JSON.stringify(store.allProviders()).includes('isolated-fixture-one'));
  assert.equal(store.allProviders()[0].baseUrl, undefined);
  const read = () => withDshProviderConfig(host(), () => ({ apiKey: store.providers()[0]?.apiKey, baseUrl: store.providers()[0]?.baseUrl }));
  assert.deepEqual(await read(), { apiKey: 'isolated-fixture-one', baseUrl: 'http://127.0.0.1:17863/v1' });
  await credentials.set('IRIS_SERVICE_FIXTURE_KEY', 'isolated-fixture-two');
  assert.equal((await read()).apiKey, 'isolated-fixture-two');
  report.checks.push('reference-only persistence and next-operation key rotation use actual credential writes');
  const descriptor = settings.describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai');
  assert(descriptor);
  const entry = [...ctx.get('loader').entries()].find(item => item.options.id === 'llm-pi-ai');
  assert(entry);
  await entry.update({ config: { providers: { fixture: {
    baseURL: 'http://127.0.0.1:17864/v1', apiKeyEnv: 'IRIS_SERVICE_FIXTURE_KEY'
  } } } });
  assert.equal(settings.describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai').value.providers.fixture.baseURL,
    'http://127.0.0.1:17864/v1');
  assert.equal((await read()).baseUrl, 'http://127.0.0.1:17864/v1');
  report.checks.push('actual Loader config update reaches redacted Settings and next-operation resolution');
  await credentials.unset('IRIS_SERVICE_FIXTURE_KEY');
  assert.equal((await host().ports.providerConnections.list())[0].available, false);
  await withDshProviderConfig(host(), () => assert.equal(store.providers().length, 0));
  report.checks.push('actual credential removal disables the runtime copy without rewriting the Iris reference');
  await credentials.modifyRecord('llm-pi-ai/fixture', async () => ({ kind: 'api-key', key: 'isolated-record-key' }));
  await entry.update({ config: { providers: { fixture: { baseURL: 'http://127.0.0.1:17864/v1' } } } });
  assert.equal((await read()).apiKey, 'isolated-record-key');
  assert(!JSON.stringify(store.allProviders()).includes('isolated-record-key'));
  report.checks.push('actual default pi-ai API Key records resolve without a copied Iris key');
  await credentials.modifyRecord('llm-pi-ai/fixture', async () => ({ kind: 'grant', payload: { fixture: true } }));
  assert.equal((await host().ports.providerConnections.list())[0].available, false);
  await assert.rejects(host().ports.providerConnections.resolve(reference), /登录授权/);
  report.checks.push('actual OAuth/grant records are rejected as media credentials');
  await entry.fiber.dispose();
  assert.deepEqual(await host().ports.providerConnections.list(), []);
  assert.deepEqual(store.allProviders()[0].dshProvider, reference);
  report.checks.push('real plugin disposal removes its directory/route while preserving the Iris reference');
  report.status = 'pass';
  save();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: path.join(work, 'report.json') }));
} catch (error) {
  report.status = 'fail';
  report.error = { name: error.name, code: error.code, message: error.message };
  save();
  console.error(error);
  console.error('报告：' + path.join(work, 'report.json'));
  process.exitCode = 1;
} finally { if (ctx) await ctx.fiber.dispose(); }
