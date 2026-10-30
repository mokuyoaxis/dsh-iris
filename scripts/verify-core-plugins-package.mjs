import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert(args.length >= 4 && args.length % 2 === 0 && args[0] === '--package' && args[2] === '--output',
  'Usage: --package <absolute-tgz> --output <new-absolute-directory> [--typescript <absolute-tsc.js>] [--client-sdk-root <installed-official-client>]');
const extra = new Map();
for (let i = 4; i < args.length; i += 2) { assert(['--typescript', '--client-sdk-root'].includes(args[i]) && !extra.has(args[i])); assert(path.isAbsolute(args[i + 1])); extra.set(args[i], args[i + 1]); }
const typescript = extra.get('--typescript'), clientSdkRoot = extra.get('--client-sdk-root');
assert(path.isAbsolute(args[1]) && path.isAbsolute(args[3]));
if (args[5]) assert(path.isAbsolute(args[5]));
const repo = fileURLToPath(new URL('../', import.meta.url)), out = args[3], work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-core-plugins-package-'));
fs.mkdirSync(out, { mode: 0o700 });
const report = { status: 'running', work, checks: [], paidCalls: 0, freshDependencyInstall: false,
  packageSha256: crypto.createHash('sha256').update(fs.readFileSync(args[1])).digest('hex') };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const check = value => { report.checks.push(value); save(); };
const calls = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* Drain the controlled input. */ }
  calls.push({ method: req.method, path: req.url }); res.setHeader('content-type', 'application/json');
  if (req.url === '/submit' && req.method === 'POST') res.end(JSON.stringify({ kind: 'accepted', remoteTaskId: 'package-original' }));
  else if (req.url === '/tasks/package-original') res.end(JSON.stringify({ kind: 'succeeded', artifacts: [
    { kind: 'inline-base64', data: png, mediaType: 'image/png' }
  ] }));
  else res.writeHead(404).end();
});
function run(command, values, cwd, extraEnv = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, values, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

try {
  save();
  const archive = path.join(work, 'archive'); fs.mkdirSync(archive);
  const unpacked = await run('tar', ['-xzf', args[1], '-C', archive], work); assert.equal(unpacked.status, 0, unpacked.stderr);
  const installed = path.join(archive, 'package'), consumer = path.join(work, 'consumer');
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./plugins'].types, './lib/plugins.d.ts');
  assert(fs.statSync(path.join(installed, 'lib/plugins.d.ts')).isFile());
  for (const unwanted of ['tests', '.internal', 'node_modules']) assert(!fs.existsSync(path.join(installed, unwanted)));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(consumer, 'node_modules', '@mokuyoaxis'), { recursive: true });
  fs.symlinkSync(installed, path.join(consumer, 'node_modules', '@mokuyoaxis', 'dsh-iris'), 'dir');
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ type: 'module' }));
  const plugin = path.join(consumer, 'node_modules', 'iris-fixture-core-plugin');
  fs.cpSync(path.join(repo, 'tests/fixtures/core-plugin-package'), plugin, { recursive: true });
  const entry = path.join(plugin, 'index.mjs');
  assert(!fs.readFileSync(entry, 'utf8').includes('../lib/'));
  check('candidate exports runtime/types; independent plugin package resolves only the public SDK; private evidence and fixture files are absent from the archive');

  if (typescript) {
    fs.copyFileSync(path.join(repo, 'tests/fixtures/core-plugin-types.mts'), path.join(consumer, 'types.mts'));
    const typeConfig = path.join(consumer, 'tsconfig.json');
    fs.writeFileSync(typeConfig, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, target: 'ES2022', module: 'NodeNext',
      moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], types: [], skipLibCheck: false }, files: ['./types.mts'] }));
    const typed = await run(process.execPath, [typescript, '--project', typeConfig], consumer);
    fs.writeFileSync(path.join(out, 'types.json'), JSON.stringify(typed, null, 2) + '\n');
    assert.equal(typed.status, 0, typed.stdout || typed.stderr);
    check('independent TypeScript consumer type-checks the packaged SDK and author examples with strict NodeNext and no skipped declaration checking');
  }

  const probe = path.join(consumer, 'probe.mjs');
  fs.writeFileSync(probe, [
    "import assert from 'node:assert/strict';",
    "import { loadCorePluginRegistry, createCorePluginHost, createCoreCapabilityCatalog } from '@mokuyoaxis/dsh-iris/plugins';",
    'const registry = await loadCorePluginRegistry({entries:[' + JSON.stringify(entry) + ']});',
    'const snapshot = registry.snapshot();',
    "assert.deepEqual(Object.fromEntries(Object.entries(snapshot.contributions).map(([key,value])=>[key,value.length])),{providers:1,operations:2,pages:1,renderers:1,settings:0});",
    'const catalog = createCoreCapabilityCatalog({registry});',
    "assert.equal(catalog.snapshot({audioEnabled:true}).tools.length,19);",
    "assert.deepEqual(catalog.selectOperations(),[]);",
    "assert.equal(catalog.snapshot().contributions.operations[1].access.mcp,'durable-operation-required');",
    "assert.equal(catalog.snapshot().contributions.pages[0].entry,undefined);",
    "assert.throws(()=>catalog.selectOperations(['unknown']),{code:'IRIS_PLUGIN_OPERATION_DENIED'});",
    'const host = createCorePluginHost({registry,dataRoot:' + JSON.stringify(path.join(work, 'host-core')) + ",allowedOperations:['example.media.import','example.media.list']});",
    'try {',
    "  const result = await host.call('example.media.import',{image:" + JSON.stringify(png) + '});',
    "  assert.match(result.value.artifactId,/^artifact_/);",
    "  assert.equal((await host.call('example.media.list',{})).value.total,1);",
    "  await assert.rejects(host.call('example.media.list',{extra:true}),{code:'IRIS_PLUGIN_INPUT_INVALID'});",
    "  assert.equal(registry.snapshot().activeCalls,0);",
    '  console.log(JSON.stringify({ok:true,dependency:result.dependency}));',
    '} finally { await host.dispose(); await registry.dispose(); }'
  ].join('\n'));
  const probeResult = await run(process.execPath, [probe], consumer);
  fs.writeFileSync(path.join(out, 'consumer.json'), JSON.stringify(probeResult, null, 2) + '\n');
  assert.equal(probeResult.status, 0, probeResult.stderr); assert.equal(JSON.parse(probeResult.stdout).ok, true);
  assert.equal(calls.length, 0);
  check('outside-repository consumer discovers four contribution kinds through the public catalog without implicit grants, and runs a selected operation through actual Core storage/queue without a Provider call');

  // An explicit compatibility wrapper consumes the SDK and the existing Provider CLI contract.
  // The new manifest itself is deliberately not presented as a supported --provider-extension entry.
  const wrapper = path.join(consumer, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, [
    "import { createCorePluginRegistry } from '@mokuyoaxis/dsh-iris/plugins';",
    'import { fixturePlugin } from ' + JSON.stringify(pathToFileURL(entry).href) + ';',
    'export default async function () {',
    " const registry = await createCorePluginRegistry({plugins:[fixturePlugin({version:process.env.IRIS_PLUGIN_FIXTURE_VERSION || '1.0.0'})]});",
    " return {contractVersion:0,id:'example.media',version:registry.snapshot().plugins[0].version,",
    ' protocols:registry.snapshot().contributions.providers.map(item=>registry.providers.descriptor(item.id)),dispose:()=>registry.dispose()};',
    '}'
  ].join('\n'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = path.join(work, 'providers.json'), dataRoot = path.join(work, 'task-core'), cli = path.join(installed, 'bin/dsh-iris.js');
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'external', auth: 'none', enabled: true,
    baseUrl: 'http://127.0.0.1:' + server.address().port, mediaProtocol: 'example.media.images',
    models: [{ id: 'image', capabilities: ['image-gen'], imageProtocol: 'example.media.images' }]
  }], assignments: { 'image-gen': { mode: 'auto', models: [] } } }), { mode: 0o600 });
  let command = 0;
  async function cliRun(values, { extension = true, version, expected = 0 } = {}) {
    const result = await run(process.execPath, [cli, ...values, ...(extension ? ['--provider-extension', wrapper] : [])], consumer,
      version ? { IRIS_PLUGIN_FIXTURE_VERSION: version } : {});
    fs.writeFileSync(path.join(out, 'cli-' + ++command + '.json'), JSON.stringify(result, null, 2) + '\n');
    assert.equal(result.status, expected, result.stderr || result.stdout);
    return result.stdout && expected === 0 ? JSON.parse(result.stdout) : result;
  }
  const generated = await cliRun(['run', 'image', '--data-root', dataRoot, '--provider-config', config,
    '--input', JSON.stringify({ prompt: 'candidate plugin dependency evidence', model_ref: 'external::image' })]);
  assert.equal(generated.task.pluginDependency.pluginVersion, '1.0.0'); assert.equal(calls.length, 1);
  const id = generated.task.id, binding = generated.task.providerBinding;
  await cliRun(['task', 'observe', id, '--data-root', dataRoot, '--provider-config', config], { version: '1.0.1', expected: 1 });
  assert.equal(calls.length, 1);
  const historical = await cliRun(['task', 'inspect', id, '--data-root', dataRoot], { extension: false });
  assert.equal(historical.task.pluginDependency.pluginVersion, '1.0.0');
  assert.equal(historical.task.providerBinding, binding);
  const observed = await cliRun(['task', 'observe', id, '--data-root', dataRoot, '--provider-config', config]);
  assert.equal(observed.task.id, id); assert.equal(observed.task.deliveryState, 'ready');
  assert.equal(observed.task.providerBinding, binding); assert.equal(calls.filter(value => value.path === '/submit').length, 1);
  const exported = path.join(work, 'original.png');
  await cliRun(['artifact', 'export', observed.task.artifactIds[0], '--data-root', dataRoot, '--output', exported], { extension: false });
  assert.deepEqual(fs.readFileSync(exported), Buffer.from(png, 'base64'));
  check('packaged CLI plus explicit legacy wrapper persists plugin pins, rejects an upgrade without network, and recovers/exports the original Task bytes across processes');
  const presets = await cliRun(['mcp', 'presets'], { extension: false }); assert.equal(presets.presets.length, 8);
  const connectedRoot = path.join(work, 'onboarding-core'), pairDirectory = path.join(work, 'onboarding-pair');
  await cliRun(['flow', 'init', '--data-root', connectedRoot], { extension: false });
  await cliRun(['execution', 'init', '--data-root', connectedRoot, '--audio'], { extension: false });
  const pair = await cliRun(['connection', 'create', '--data-root', connectedRoot, '--directory', pairDirectory,
    '--origin', 'http://127.0.0.1:1', '--label', 'Packaged explicit client'], { extension: false });
  const native = await run(process.execPath, [cli, 'mcp', 'config', '--connection-file', pair.clientFile, '--preset', 'codex-stdio'], consumer);
  fs.writeFileSync(path.join(out, 'onboarding-native.json'), JSON.stringify(native, null, 2) + '\n');
  assert.equal(native.status, 0, native.stderr); assert(native.stdout.startsWith('[mcp_servers.iris]'));
  const nativeFile = path.join(work, 'onboarding.toml'); fs.writeFileSync(nativeFile, native.stdout);
  const valid = await run('python3', ['-c', 'import sys,tomllib;v=tomllib.load(open(sys.argv[1],"rb"));assert "command" in v["mcp_servers"]["iris"]', nativeFile], consumer);
  assert.equal(valid.status, 0, valid.stderr);
  const offline = await cliRun(['mcp', 'check', '--connection-file', pair.clientFile], { extension: false, expected: 1 });
  assert.equal(JSON.parse(offline.stdout).error.stage, 'transport');
  check('packaged CLI exposes explicit presets, independently parsed native TOML, and a bounded offline-Core check without a second service');
  const panelPlugin = path.join(consumer, 'node_modules/iris-fixture-panel-plugin');
  fs.cpSync(path.join(repo, 'tests/fixtures/panel-plugin-package'), panelPlugin, { recursive: true });
  const panelManifest = path.join(work, 'alternative-panel.json');
  fs.writeFileSync(path.join(work, 'alternative-panel.html'), '<!doctype html><title>Alternative Panel</title>');
  fs.writeFileSync(panelManifest, JSON.stringify({ contractVersion: 0, id: 'example.alternative', version: '1.0.0', assets: { '/': 'alternative-panel.html' } }));
  const panelProbe = path.join(consumer, 'panel-probe.mjs');
  fs.writeFileSync(panelProbe, [
    "import assert from 'node:assert/strict';",
    "import {loadCorePluginRegistry,createCorePluginWorkbench} from '@mokuyoaxis/dsh-iris/plugins';",
    'const registry=await loadCorePluginRegistry({entries:[' + JSON.stringify(path.join(panelPlugin, 'index.mjs')) + ']});',
    'let web;',
    'try {',
    'web=createCorePluginWorkbench({registry,dataRoot:' + JSON.stringify(connectedRoot) + ",panelContributions:{pages:['example.panel.library'],settings:['example.panel.connection'],renderers:['example.panel.png']}});",
    "const started=await web.start();const headers={Authorization:'Bearer '+started.accessToken};",
    "const facts=await(await fetch(started.origin+'/api/v0/session',{headers})).json();",
    "assert.equal(facts.panelContributions.settings[0].dependency.kind,'settings');assert.equal(facts.providerManagement,false);",
    "assert.equal((await fetch(started.origin+facts.panelContributions.pages[0].entry)).status,200);",
    "assert.equal((await fetch(started.origin+'/plugin-panel.js')).status,200);assert.equal((await fetch(started.origin+'/plugin-surface.css')).status,200);",
    "assert.equal((await fetch(started.origin+'/api/v0/session')).status,401);await web.dispose();",
    'web=createCorePluginWorkbench({registry,dataRoot:' + JSON.stringify(connectedRoot) + ',panelManifestPath:' + JSON.stringify(panelManifest) + '});',
    "const other=await web.start();assert((await(await fetch(other.origin+'/')).text()).includes('Alternative Panel'));",
    "assert.equal((await fetch(other.origin+'/app.js')).status,401);console.log(JSON.stringify({ok:true}));",
    '} finally {await web?.dispose();await registry.dispose();}'
  ].join('\n'));
  const panelResult = await run(process.execPath, [panelProbe], consumer);
  fs.writeFileSync(path.join(out, 'panel-consumer.json'), JSON.stringify(panelResult, null, 2) + '\n');
  assert.equal(panelResult.status, 0, panelResult.stderr); assert.equal(JSON.parse(panelResult.stdout).ok, true);
  check('independent packaged Panel plugin uses only public SDK to serve three selected mounts and pinned assets with authenticated data; full Panel replacement remains available');
  // The production business is copied from this tarball into its own package scope.
  const business = path.join(consumer, 'node_modules', 'iris-contact-sheet');
  fs.cpSync(path.join(installed, 'plugins/contact-sheet'), business, { recursive: true });
  fs.writeFileSync(path.join(business, 'package.json'), JSON.stringify({ name: 'iris-contact-sheet', version: '0.1.0', type: 'module',
    peerDependencies: { '@mokuyoaxis/dsh-iris': '*', sharp: '^0.35.5' } }) + '\n');
  fs.symlinkSync(fs.realpathSync(path.join(repo, 'node_modules/sharp')), path.join(consumer, 'node_modules/sharp'), 'dir');
  const businessEntry = path.join(business, 'index.mjs');
  assert([...fs.readFileSync(businessEntry, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].every(match => ['sharp', '@mokuyoaxis/dsh-iris/plugins'].includes(match[1])));
  for (const name of ['scripts/verify-plugin-business.mjs', 'tests/fixtures/plugin-business-consumer.mjs',
    'tests/plugin-business-lifecycle.mjs', 'tests/plugin-business-crash.mjs', 'tests/fixtures/plugin-business-crash-child.mjs']) {
    fs.mkdirSync(path.dirname(path.join(consumer, name)), { recursive: true }); fs.copyFileSync(path.join(repo, name), path.join(consumer, name));
  }
  const businessEnv = { IRIS_TEST_BUSINESS_ENTRY: businessEntry };
  for (const name of ['plugin-business-lifecycle', 'plugin-business-crash']) {
    const checked = await run(process.execPath, [path.join(consumer, 'tests', name + '.mjs')], consumer, businessEnv, 60000);
    fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(checked, null, 2) + '\n'); assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  }
  check('real business in a separate package uses public SDK/Sharp only; packaged Core passes local stop, interrupted partial output, exact versions, permission reduction and two actual SIGKILL recovery windows');
  if (clientSdkRoot) {
    const mcp = await run(process.execPath, [path.join(consumer, 'scripts/verify-plugin-business.mjs'), '--client-sdk-root', clientSdkRoot,
      '--output', path.join(out, 'business-mcp')], consumer, businessEnv, 90000);
    fs.writeFileSync(path.join(out, 'business-mcp.json'), JSON.stringify(mcp, null, 2) + '\n'); assert.equal(mcp.status, 0, mcp.stderr || mcp.stdout);
    assert.equal(JSON.parse(mcp.stdout).ok, true);
    check('actual external official MCP client executes the independently packaged real business through both transports/protocols, with original-key recovery, plugin absence and reduced grants');
  }
  report.status = 'passed'; report.calls = calls; save();
  console.log(JSON.stringify({ ok: true, report: path.join(out, 'report.json'), checks: report.checks.length }));
} catch (error) {
  report.status = 'failed'; report.error = { code: error.code, message: error.message }; report.calls = calls; save(); throw error;
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
