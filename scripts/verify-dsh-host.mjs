/**
 * 手动验证已安装 DSH 的真实服务；不安装依赖，不接触用户 profile/数据，不调用真实模型。
 * node scripts/verify-dsh-host.mjs --dsh-root /absolute/path/to/@deepseek-ai/dsh
 * 目前验收目标为 0.2.0-rc.2。临时数据和 report.json 留在仓库外供复核。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--dsh-root' && path.isAbsolute(args[1]), '需要显式 --dsh-root 绝对路径');
const dshRoot = fs.realpathSync(args[1]);
const manifest = JSON.parse(fs.readFileSync(path.join(dshRoot, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@deepseek-ai/dsh');
assert.equal(manifest.version, '0.2.0-rc.2', '该验收脚本目前仅验证 rc.2');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-dsh-host-'));
const reportFile = path.join(work, 'report.json');
const report = { status: 'running', dsh: { root: dshRoot, version: manifest.version }, work, checks: [] };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'pass' }); }
  catch (error) { report.checks.push({ name, status: 'fail', message: error.message }); }
  save();
}
process.env.DSH_HOME = path.join(work, 'dsh-home');
process.env.IRIS_IMPORT_WORKBENCH_CONFIG = '';
// 插件按宿主进程入口定位版本；隔离 harness 模拟已核实的 DSH bin 入口。
process.argv[1] = path.join(dshRoot, 'lib/bin.js');
report.simulatedDshEntry = true;
const requireDsh = createRequire(path.join(dshRoot, 'package.json'));
const load = name => import(pathToFileURL(requireDsh.resolve(name)).href);
const fetchLocal = globalThis.fetch;
let allowedOrigin;
let blockedRequests = 0;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!allowedOrigin || url.origin !== allowedOrigin) {
    blockedRequests++;
    throw new Error('验收禁止外部网络/模型请求');
  }
  return fetchLocal(input, options);
};
console.log('验收目录：' + work);
const fibers = [];
try {
  const [{ Context }, { LocalAttachmentStore }, { SystemPrompt }, { ToolRuntime }, { SkillRegistry },
    { LlmRuntime, LlmAdapter }, { AgentDefaultModelConfig }, { WebServer }, { evaluatePluginCompatibility }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-attachment-local'), load('@deepseek-ai/dsh-system-prompt'),
    load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-skill'), load('@deepseek-ai/dsh-llm'),
    load('@deepseek-ai/dsh-agent-default-model'), load('@deepseek-ai/dsh-host-webserver'), load('@deepseek-ai/dsh-app-boot')
  ]);
  const ctx = new Context();
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
    return fiber;
  };
  await mount(LocalAttachmentStore, { dshHome: process.env.DSH_HOME });
  await mount(SystemPrompt, {});
  await mount(ToolRuntime, {});
  await mount(SkillRegistry, {});
  await mount(LlmRuntime, {});
  const defaultFiber = await mount(AgentDefaultModelConfig, { provider: 'rc2-fixture', model: 'fixture-vision' });
  await mount(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' });
  allowedOrigin = 'http://127.0.0.1:' + ctx.get('webServer').port;
  const { createDshHostAdapter, detectDshVersion } = await import('../lib/dsh-host-adapter.js');
  const { hostRuntimeEvidence, EXPECTED_IRIS_TOOLS, EXPECTED_IRIS_CLIENT_SEATS } = await import('../lib/host-runtime.js');
  const sharp = (await import('sharp')).default;
  const source = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const ref = await ctx.get('attachments').saveImage({ data: source, mediaType: 'image/png', name: 'fixture.png' });
  let snapshot = { events: [{ data: { content: [{ type: 'image', attachment: ref }] } }] };
  let selected = { byId: { fixture: { id: 'fixture', retainedBy: { mainView: 1 } } }, ids: ['fixture'] };
  const listeners = new Set();
  await mount((scope) => {
    scope.provide('sessionQuery', { async readSession() { return snapshot; } });
    scope.provide('sessions', { list: {
      getSnapshot: () => selected,
      subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); }
    } });
  });
  const host = () => createDshHostAdapter(ctx, { version: manifest.version });
  const currentPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await check('actual rc.2 loader accepts manifest without exemptions', () => {
    assert.equal(evaluatePluginCompatibility(currentPackage, {}, manifest.version), undefined);
    assert.equal(detectDshVersion({ entry: path.join(dshRoot, 'lib/bin.js') }), manifest.version);
  });
  await check('session attachment DTO survives real readImage integrity checks', async () => {
    const found = await host().ports.sessions.findImageAttachment('fixture', ref.attachmentId);
    assert.equal(found.bytes, ref.bytes);
    assert.equal(found.width, ref.width);
    assert.equal(found.height, ref.height);
    const read = await host().ports.attachments.readImage(found);
    assert.deepEqual(Buffer.from(read.data), source);
    assert(!JSON.stringify(found).includes(work));
  });
  let modelCalls = 0;
  let fixtureFailure = '';
  const modelRequests = [];
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: id === 'fixture-vision' ? ['text', 'image'] : ['text'] };
    }
    async *stream(request) {
      modelCalls++;
      modelRequests.push(request);
      if (fixtureFailure === 'before') throw new Error('private fixture failure');
      yield { type: 'text-delta', index: 0, text: 'fixture answer' };
      if (fixtureFailure === 'after') throw new Error('private fixture failure');
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture answer' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  await mount((scope) => { scope.get('llm').registerAdapter(['rc2-fixture'], new FixtureAdapter()); });
  await check('DSH default vision uses an exact image-capable route', async () => {
    assert.equal(await host().ports.visionModel.analyze({ question: 'fixture', ref }), 'fixture answer');
    assert.equal(modelCalls, 1);
    assert.equal(modelRequests[0].provider, 'rc2-fixture');
    assert.equal(modelRequests[0].model, 'fixture-vision');
    assert.deepEqual(modelRequests[0].messages[0].content[1].attachment, ref);
  });
  await check('text-only default never invokes vision or drops its image', async () => {
    await defaultFiber.dispose();
    const textFiber = await mount(AgentDefaultModelConfig, { provider: 'rc2-fixture', model: 'fixture-text' });
    const before = modelCalls;
    await assert.rejects(host().ports.visionModel.analyze({ question: 'fixture', ref }));
    assert.equal(modelCalls, before);
    await textFiber.dispose();
    await mount(AgentDefaultModelConfig, { provider: 'rc2-fixture', model: 'fixture-vision' });
  });
  await check('actual Runtime failure finishes reject empty and partial answers', async () => {
    try {
      for (const failure of ['before', 'after']) {
        fixtureFailure = failure;
        await assert.rejects(host().ports.visionModel.analyze({ question: 'fixture', ref }), error =>
          /DSH 视觉调用失败/.test(error.message) && !error.message.includes('private fixture failure'));
      }
    } finally { fixtureFailure = ''; }
  });
  const iris = await import('../lib/index.js');
  const irisFiber = await mount({ name: iris.name, inject: iris.inject, apply: iris.apply });
  await check('all Iris tools and bundled skills register in actual Cordis services', async () => {
    assert.deepEqual(ctx.get('tools').schemas().map(item => item.name).sort(), [...EXPECTED_IRIS_TOOLS].sort());
    assert.deepEqual((await ctx.get('skills').list()).map(item => item.name).sort(), ['iris-compose-media', 'iris-verify-ui']);
  });
  await check('real WebServer serves Iris Host Doctor without calling a model', async () => {
    const before = modelCalls;
    const response = await fetch(allowedOrigin + '/iris/api/doctor');
    assert.equal(response.status, 200);
    const doctor = await response.json();
    assert(doctor.checks.some(item => item.id === 'dsh-version' && item.status === 'ok'));
    assert.equal(modelCalls, before);
  });
  await check('actual tool dispatch reaches Core diff and publishes a real DSH image', async () => {
    const other = path.join(work, 'other.png');
    await sharp({ create: { width: 8, height: 6, channels: 3, background: '#0000ff' } }).png().toFile(other);
    const result = await ctx.get('tools').execute({
      callId: crypto.randomUUID(), name: 'iris_pixel_diff',
      arguments: { attachment_a_id: ref.attachmentId, image_b_path: other },
      agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    const image = result.content.find(item => item.type === 'image');
    assert(image, JSON.stringify(result));
    const read = await ctx.get('attachments').readImage(image.attachment);
    const metadata = await sharp(read.data).metadata();
    assert.equal(metadata.width, 8);
    assert.equal(metadata.height, 6);
  });

  const clientSource = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const bundleCache = new Map();
  const window = { addEventListener() {}, removeEventListener() {} };
  // 宿主 React 在 Web asset 中提供，安装树没有可 require 的 React 包。
  // 只验证真实 SlotRegistry 注册/生命周期；这里不把 React/DOM 渲染算成实机证据。
  const react = {
    Component: class {}, PureComponent: class {},
    createContext() { return { Provider() {} }; },
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    memo(component) { return component; }, forwardRef(component) { return component; }
  };
  function clientRequire(request) {
    if (request === 'react') return react;
    if (request === 'react-dom' || request === 'react-dom/client') return {};
    if (request === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement };
    return requireDsh(request);
  }
  function bundledClient(name) {
    if (bundleCache.has(name)) return bundleCache.get(name);
    let entry;
    window.__ModuleLoader__ = { load(value) { entry = value; } };
    vm.runInNewContext(fs.readFileSync(requireDsh.resolve(name + '/client'), 'utf8'), { window, console, setTimeout, clearTimeout, queueMicrotask });
    const value = entry.factory(clientRequire);
    bundleCache.set(name, value);
    return value;
  }
  const { SlotRegistry } = bundledClient('@deepseek-ai/dsh-client-ui-renderer');
  await mount(SlotRegistry);
  await mount({ inject: ['slots'], apply(scope) {
    scope.slots.register({ name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' }
    } }, () => null);
  } });
  let entry;
  const reports = [];
  window.__ModuleLoader__ = { load(value) { entry = value; } };
  window.fetch = async (_url, options) => { reports.push(JSON.parse(options.body)); return { ok: true }; };
  const storage = { getItem() { return null; }, setItem() {} };
  const sandbox = { window, console, localStorage: storage, document: {
    getElementById() { return null; }, createElement() { return { dataset: {} }; }, head: { appendChild() {} }
  } };
  vm.runInNewContext(clientSource, sandbox);
  const client = entry.factory(clientRequire);
  const clientFiber = await mount(client);
  await check('actual rc.2 SlotRegistry accepts all four Iris client seats', () => {
    for (const seat of EXPECTED_IRIS_CLIENT_SEATS) assert.equal(ctx.get('slots').entries(seat).length, 1);
    assert.deepEqual(reports.at(-1).seats, [...EXPECTED_IRIS_CLIENT_SEATS]);
  });
  await check('client session observation is registered and released with its fiber', async () => {
    assert.equal(listeners.size, 1);
    selected = { ids: [], byId: {} };
    for (const listener of listeners) listener();
    await clientFiber.dispose();
    assert.equal(listeners.size, 0);
    for (const seat of EXPECTED_IRIS_CLIENT_SEATS) assert.equal(ctx.get('slots').entries(seat).length, 0);
  });
  await check('Iris unload removes tools, skills and routes from real services', async () => {
    assert.equal(hostRuntimeEvidence().server.loaded, true);
    await irisFiber.dispose();
    assert.equal(ctx.get('tools').schemas().length, 0);
    assert.equal((await ctx.get('skills').list()).length, 0);
    assert.equal((await fetch(allowedOrigin + '/iris/api/doctor')).status, 404);
  });
  await check('no external requests or real models', () => assert.equal(blockedRequests, 0));
  report.modelFixtureCalls = modelCalls;
  report.externalRequests = blockedRequests;
  snapshot = null;
} catch (error) {
  report.checks.push({ name: 'setup/completion', status: 'fail', message: error.message });
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  globalThis.fetch = fetchLocal;
  report.status = report.checks.some(item => item.status === 'fail') ? 'fail' : 'pass';
  save();
}
for (const row of report.checks) console.log(row.status.toUpperCase() + ' ' + row.name + (row.message ? ': ' + row.message : ''));
console.log('报告：' + reportFile);
process.exitCode = report.status === 'pass' ? 0 : 1;
