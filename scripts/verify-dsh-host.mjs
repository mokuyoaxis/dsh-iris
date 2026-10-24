/**
 * 手动验证已安装 DSH 的真实服务；不安装依赖，不接触用户 profile/数据，不调用真实模型。
 * node scripts/verify-dsh-host.mjs --dsh-root /absolute/path/to/@deepseek-ai/dsh
 * 目标版本见 lib/dsh-compatibility.js。临时数据和 report.json 留在仓库外供复核。
 * Node客户端夹具另需与 renderer 同版本的官方 dsh-client-ui-slots SDK。
 * 已安装宿主未单独提供它时，可显式传 --client-sdk-root /absolute/path/to/sdk-fixture。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isSupportedDshVersion } from '../lib/dsh-compatibility.js';

const args = process.argv.slice(2);
assert((args.length === 2 || args.length === 4) && args[0] === '--dsh-root' && path.isAbsolute(args[1])
  && (args.length === 2 || args[2] === '--client-sdk-root' && path.isAbsolute(args[3])),
'需要显式 --dsh-root 绝对路径，可另传 --client-sdk-root 绝对路径');
const dshRoot = fs.realpathSync(args[1]);
const manifest = JSON.parse(fs.readFileSync(path.join(dshRoot, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@deepseek-ai/dsh');
assert(isSupportedDshVersion(manifest.version), '该验收脚本只检查明确支持的 DSH 版本');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-dsh-host-'));
const reportFile = path.join(work, 'report.json');
const report = { status: 'running', dsh: { root: dshRoot, version: manifest.version }, work, checks: [] };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const fingerprints = directory => Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
  const file = path.join(directory, entry.name);
  return [entry.name, entry.isDirectory() ? fingerprints(file) : crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
}));
async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'pass' }); }
  catch (error) { report.checks.push({ name, status: 'fail', message: error.message,
    stack: error.stack, ...(error.cause ? { cause: { name: error.cause.name, code: error.cause.code, message: error.cause.message } } : {}) }); }
  save();
}
process.env.DSH_HOME = path.join(work, 'dsh-home');
process.env.IRIS_IMPORT_WORKBENCH_CONFIG = '';
process.env.IRIS_CORE_CONNECTION_FILE = '';
process.env.IRIS_CORE_SCOPES = '';
// 插件按宿主进程入口定位版本；隔离 harness 模拟已核实的 DSH bin 入口。
process.argv[1] = path.join(dshRoot, 'lib/bin.js');
report.simulatedDshEntry = true;
const requireDsh = createRequire(path.join(dshRoot, 'package.json'));
const requireClientSdk = args[3] ? createRequire(path.join(args[3], 'package.json')) : requireDsh;
if (args[3]) report.clientSdkRoot = fs.realpathSync(args[3]);
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
  return fetchLocal(input, options).catch(error => {
    (report.failedLocalRequests ||= []).push({ url: url.href, message: error.message,
      ...(error.cause ? { cause: { name: error.cause.name, code: error.cause.code, message: error.cause.message } } : {}) });
    save(); throw error;
  });
};
console.log('验收目录：' + work);
const fibers = [];
try {
  const [{ Context }, { LocalAttachmentStore }, { SystemPrompt }, { ToolRuntime }, { SkillRegistry },
    { LlmRuntime, LlmAdapter }, { AgentDefaultModelConfig }, { WebServer }, boot] = await Promise.all([
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
  const { hostRuntimeEvidence, EXPECTED_IRIS_TOOLS, EXPECTED_IRIS_SKILLS, EXPECTED_IRIS_CLIENT_SEATS } = await import('../lib/host-runtime.js');
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
  await check('actual host loader accepts the final manifest without exemptions', async () => {
    if (typeof boot.evaluatePluginCompatibility === 'function') {
      assert.equal(boot.evaluatePluginCompatibility(currentPackage, {}, manifest.version), undefined);
      report.loader = { method: 'evaluatePluginCompatibility', exemptions: false };
    } else {
      // 历史宿主没有现代兼容检查 helper，直接用其原生 Profile/Boot 装载。
      const profile = path.join(process.env.DSH_HOME, 'profiles', 'iris-host-check');
      const project = fs.realpathSync(new URL('../', import.meta.url));
      fs.mkdirSync(path.join(profile, 'node_modules/@mokuyoaxis'), { recursive: true });
      fs.symlinkSync(project, path.join(profile, 'node_modules/@mokuyoaxis/dsh-iris'), 'dir');
      fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'iris-host-check', private: true,
        dependencies: { '@mokuyoaxis/dsh-iris': 'file:' + project }, dsh: { profile: { bundles: ['@mokuyoaxis/dsh-iris'] } } }));
      fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
      const anchor = path.join(dshRoot, 'package.json');
      const loaded = typeof boot.loadProfileDirectory === 'function'
        ? boot.loadProfileDirectory('iris-host-check', profile, anchor)
        : boot.loadProfile('iris-host-check', 'iris-host-check', anchor, process.env.DSH_HOME);
      assert.equal(loaded.layers.length, 1);
      assert.equal(fs.realpathSync(loaded.layers[0].packageDir), project);
      const empty = path.join(work, 'empty.yml'); fs.writeFileSync(empty, '[]\n');
      let profileCtx;
      try {
        profileCtx = await boot.boot('iris-host-check', empty, loaded.layers.flatMap(layer => layer.patches), async scope => {
          for (const plugin of [SystemPrompt, ToolRuntime, SkillRegistry]) await scope.plugin(plugin, {});
        }, pathToFileURL(path.join(profile, 'package.json')).href);
        assert.deepEqual(profileCtx.get('tools').schemas().map(value => value.name).sort(), [...EXPECTED_IRIS_TOOLS].sort());
        assert.deepEqual((await profileCtx.get('skills').list()).map(value => value.name).sort(), [...EXPECTED_IRIS_SKILLS].sort());
        assert(!fs.existsSync(path.join(profile, 'compatibility.json')));
        report.loader = { method: 'profile + boot', tools: EXPECTED_IRIS_TOOLS.length, skills: EXPECTED_IRIS_SKILLS.length,
          localPackageLink: true, exemptions: false };
      } finally { if (profileCtx) await profileCtx.fiber.dispose(); }
    }
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
      if (fixtureFailure === 'thinking') {
        yield { type: 'reasoning-delta', index: 1, text: 'private fixture thinking' };
        yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'private fixture thinking' } };
      }
      const answer = request.messages[0].content.some(block => block.type === 'text' && block.text.includes('在图片中定位'))
        ? '{"x1":125,"y1":166.67,"x2":625,"y2":666.66}' : 'fixture answer';
      yield { type: 'text-delta', index: 0, text: answer };
      if (fixtureFailure === 'after') throw new Error('private fixture failure');
      if (fixtureFailure === 'ocr-cancel') await new Promise((_, reject) => {
        const abort = () => reject(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
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
  const { optimizePrompt } = await import('../lib/prompt-optimizer.js');
  await check('M2 optimizer consumes actual Runtime text and keeps output rules verbatim', async () => {
    const before = modelCalls;
    try {
      fixtureFailure = 'thinking';
      const result = await optimizePrompt(host(), { text: '  fixture draft  ', target: 'image', rules: [
        { id: 'edit', label: '改写', kind: 'optimization', text: '保留意图' },
        { id: 'end', label: '约束', kind: 'output', position: 'suffix', text: '不要水印' }
      ] });
      assert.equal(result.optimized, 'fixture answer\n\n不要水印');
      assert.equal(result.original, '  fixture draft  ');
      assert.equal(modelCalls, before + 1);
      assert.equal(modelRequests.at(-1).messages.length, 1);
      assert.equal(modelRequests.at(-1).tools, undefined);
      assert(!JSON.stringify(result).includes('private fixture thinking'));
    } finally { fixtureFailure = ''; }
  });
  await check('M2 rejects actual Runtime error terminal after partial text', async () => {
    try {
      fixtureFailure = 'after';
      await assert.rejects(optimizePrompt(host(), { text: 'fixture' }), error =>
        error.code === 'IRIS_MODEL_REQUEST_FAILED' && !error.message.includes('private fixture failure'));
    } finally { fixtureFailure = ''; }
  });
  const { runVisionRequest, buildVisionModelCandidates } = await import('../lib/vision-model-routing.js');
  const { HOST_VISION_REF } = await import('../lib/models.js');
  const hostProviders = [{ id: HOST_VISION_REF }];
  const fixtureConfig = await import('../lib/config.js');
  fixtureConfig.setAssignmentOrder('vision', [HOST_VISION_REF]);
  const visionInput = { bytes: new Uint8Array(source), mediaType: 'image/png' };
  await check('M3 candidate snapshots never invoke a model or save an image', () => {
    const before = modelCalls;
    for (const candidate of buildVisionModelCandidates(host(), { providers: hostProviders })) candidate.port.describe();
    assert.equal(modelCalls, before);
  });
  await check('M3 actual Runtime receives exactly the shared image bytes', async () => {
    const before = modelCalls;
    const result = await runVisionRequest(host(), { providers: hostProviders, question: 'fixture', image: visionInput });
    assert.equal(result.answer, 'fixture answer');
    assert.equal(result.model, 'fixture-vision');
    assert.equal(modelCalls, before + 1);
    const request = modelRequests.at(-1);
    assert.equal(request.messages.length, 1); assert.equal(request.tools, undefined);
    const actual = request.messages[0].content.find(block => block.type === 'image');
    assert(actual);
    const stored = await ctx.get('attachments').readImage(actual.attachment);
    assert.deepEqual(Buffer.from(stored.data), source);
    assert(!JSON.stringify(result).includes(work));
  });
  await check('M3 actual Runtime error terminal rejects partial text', async () => {
    try {
      fixtureFailure = 'after';
      await assert.rejects(runVisionRequest(host(), { providers: hostProviders, question: 'fixture', image: visionInput }), error =>
        error.code === 'IRIS_MODEL_REQUEST_FAILED' && error.invocation === 'responded' && !error.message.includes('private'));
    } finally { fixtureFailure = ''; }
  });
  await check('M3 pre-abort skips image preparation and actual model generation', async () => {
    const controller = new AbortController(); controller.abort();
    const before = modelCalls;
    let prepares = 0;
    await assert.rejects(runVisionRequest(host(), { question: 'fixture', signal: controller.signal,
      prepareImage() { prepares++; return visionInput; } }), error => error.code === 'IRIS_MODEL_ABORTED');
    assert.equal(prepares, 0); assert.equal(modelCalls, before);
  });
  const iris = await import('../lib/index.js');
  const irisFiber = await mount({ name: iris.name, inject: iris.inject, apply: iris.apply });
  await check('all Iris tools and bundled skills register in actual Cordis services', async () => {
    assert.deepEqual(ctx.get('tools').schemas().map(item => item.name).sort(), [...EXPECTED_IRIS_TOOLS].sort());
    assert.deepEqual((await ctx.get('skills').list()).map(item => item.name).sort(), [...EXPECTED_IRIS_SKILLS].sort());
  });
  await check('image import persists uploads and session attachments through real tools and HTTP without models', async () => {
    const before = modelCalls;
    const uploaded = await (await fetch(allowedOrigin + '/iris/api/upload?name=import-fixture.bin', { method: 'POST', body: source })).json();
    assert(uploaded.ok);
    const response = await fetch(allowedOrigin + '/iris/api/actions/image_import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_path: uploaded.path })
    });
    const imported = await response.json(); assert.equal(response.status, 200);
    assert.equal(imported.artifact.kind, 'imported-image'); assert.equal(imported.artifact.mediaType, 'image/png');
    assert.deepEqual(Buffer.from(await (await fetch(allowedOrigin + imported.imageUrl)).arrayBuffer()), source);
    assert.deepEqual(fs.readFileSync(uploaded.path), source, '导入保留上传源文件');
    assert(!JSON.stringify(imported).includes(work), '导入结果不暴露宿主路径');
    for (const arguments_ of [{ image_path: uploaded.path }, { attachment_id: ref.attachmentId }]) {
      const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_import_image', arguments: arguments_,
        agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      const text = result.content.find(block => block.type === 'text').text;
      const id = /artifact_[a-f0-9]{24}/.exec(text)?.[0]; assert(id);
      const { readCoreArtifactBytes } = await import('../lib/core-artifacts.js');
      const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
      assert.deepEqual(readCoreArtifactBytes(dshCoreDataRoot(), id).bytes, source);
    }
    assert.equal(modelCalls, before);
  });
  await check('M3 actual look/relook tool dispatch consumes one complete model call each', async () => {
    const input = path.join(work, 'vision-input.png');
    fs.writeFileSync(input, source);
    const before = modelCalls;
    for (const [name, arguments_] of [
      ['iris_look_at_image', { image_path: input, question: 'fixture' }],
      ['iris_relook_attachment', { attachment_id: ref.attachmentId, question: 'fixture' }]
    ]) {
      const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name, arguments: arguments_,
        agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert(result.content.some(block => block.type === 'text' && block.text.includes('fixture answer')));
      const actual = modelRequests.at(-1).messages[0].content.find(block => block.type === 'image');
      assert.deepEqual(Buffer.from((await ctx.get('attachments').readImage(actual.attachment)).data), source);
    }
    assert.equal(modelCalls, before + 2);
  });
  await check('M3 actual WebServer look action uses the shared complete result', async () => {
    const before = modelCalls;
    const response = await fetch(allowedOrigin + '/iris/api/actions/look', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_path: path.join(work, 'vision-input.png'), question: 'fixture' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert(result.ok && result.text.includes('fixture answer'));
    assert.equal(modelCalls, before + 1);
  });
  const ocrInput = path.join(work, 'ocr-input.png');
  const ocrSource = await sharp({ create: { width: 128, height: 300, channels: 3, background: '#ff0000' } }).png().toBuffer();
  fs.writeFileSync(ocrInput, ocrSource);
  await check('M4 actual Agent OCR and WebServer OCR preserve zero overlap and per-block bytes', async () => {
    const before = modelCalls;
    const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_long_ocr',
      arguments: { image_path: ocrInput, chunk_height: 100, overlap: 0 },
      agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert(result.content.some(block => block.type === 'text' && block.text.includes('[第3段 y=200] fixture answer')));
    const response = await fetch(allowedOrigin + '/iris/api/actions/ocr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_path: ocrInput, chunk_height: 100, overlap: 0 })
    });
    const gui = await response.json();
    assert.equal(response.status, 200); assert(gui.ok && gui.text.includes('OCR 完成') && gui.text.includes('[第3段 y=200]'));
    assert.equal(modelCalls, before + 6);
    for (const [index, request] of modelRequests.slice(-6).entries()) {
      const actual = request.messages[0].content.find(block => block.type === 'image');
      const stored = await ctx.get('attachments').readImage(actual.attachment);
      const expected = await sharp(ocrSource).extract({ left: 0, top: index % 3 * 100, width: 128, height: 100 }).png().toBuffer();
      assert.deepEqual(Buffer.from(stored.data), expected);
    }
  });
  await check('M4 actual Runtime OCR abort stops all later chunks without partial return', async () => {
    const { runOcrRequest } = await import('../lib/ocr-model-routing.js');
    const controller = new AbortController();
    const before = modelCalls;
    try {
      fixtureFailure = 'ocr-cancel';
      const pending = runOcrRequest(host(), { providers: hostProviders, image: { bytes: new Uint8Array(ocrSource), mediaType: 'image/png' },
        chunkHeight: 100, overlap: 0, signal: controller.signal });
      pending.catch(() => {});
      const deadline = performance.now() + 2000;
      while (modelCalls === before && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(modelCalls, before + 1);
      controller.abort();
      await assert.rejects(pending, error => error.code === 'IRIS_MODEL_ABORTED');
      assert.equal(modelCalls, before + 1); assert(modelRequests.at(-1).signal.aborted);
    } finally { controller.abort(); fixtureFailure = ''; }
  });
  await check('M4 actual Agent and WebServer locate retain original pixel bbox and bytes', async () => {
    const before = modelCalls;
    const input = path.join(work, 'vision-input.png');
    const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_locate',
      arguments: { image_path: input, target: 'red region' }, agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
    assert.equal(result.isError, false); assert(result.content.some(block => block.text?.includes('bbox (1,1,5,4) / 8x6')));
    const response = await fetch(allowedOrigin + '/iris/api/actions/locate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_path: input, target: 'red region' }) });
    const gui = await response.json(); assert.equal(response.status, 200); assert(gui.ok && gui.text.includes('bbox (1,1,5,4)'));
    assert.equal(modelCalls, before + 2);
    for (const request of modelRequests.slice(-2)) {
      const image = request.messages[0].content.find(block => block.type === 'image');
      assert.deepEqual(Buffer.from((await ctx.get('attachments').readImage(image.attachment)).data), source);
    }
  });
  await check('Core image Artifacts feed actual look/locate/OCR tools and WebServer with no Core writes', async () => {
    const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
    const { createCoreRuntime } = await import('../lib/core-runtime.js');
    const { createCoreArtifact } = await import('../lib/core-artifacts.js');
    const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'writer' }); runtime.start();
    try {
      const image = await runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, {
        bytes: source, mediaType: 'image/png', kind: 'generated-image', metadata: {}
      }));
      const screenshot = await runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, {
        bytes: ocrSource, mediaType: 'image/png', kind: 'html-screenshot', metadata: {}
      }));
      const before = fingerprints(dshCoreDataRoot()), beforeCalls = modelCalls;
      for (const [name, action, input] of [
        ['iris_look_at_image', 'look', { artifact_id: image.id, question: 'fixture' }],
        ['iris_locate', 'locate', { artifact_id: image.id, target: 'red region' }],
        ['iris_long_ocr', 'ocr', { artifact_id: screenshot.id, chunk_height: 100, overlap: 0 }]
      ]) {
        const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name, arguments: input,
          agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
        assert.equal(result.isError, false, JSON.stringify(result));
        assert(result.content.some(block => block.text?.includes(input.artifact_id)));
        const response = await fetch(allowedOrigin + '/iris/api/actions/' + action, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
        const gui = await response.json(); assert.equal(response.status, 200); assert(gui.ok);
        assert.equal(gui.artifactId, input.artifact_id);
        if (action === 'ocr') {
          for (const [index, request] of modelRequests.slice(-6).entries()) {
            const ref = request.messages[0].content.find(block => block.type === 'image').attachment;
            const expected = await sharp(ocrSource).extract({ left: 0, top: index % 3 * 100, width: 128, height: 100 }).png().toBuffer();
            assert.deepEqual(Buffer.from((await ctx.get('attachments').readImage(ref)).data), expected);
          }
        } else for (const request of modelRequests.slice(-2)) {
          const ref = request.messages[0].content.find(block => block.type === 'image').attachment;
          assert.deepEqual(Buffer.from((await ctx.get('attachments').readImage(ref)).data), source);
        }
      }
      assert.equal(modelCalls, beforeCalls + 10);
      assert.deepEqual(fingerprints(dshCoreDataRoot()), before);
    } finally { await runtime.dispose(); }
  });
  await check('workbench HTTP pages and filters all media and reads original PNG by card ID', async () => {
    const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
    const { createCoreRuntime } = await import('../lib/core-runtime.js');
    const { createCoreArtifact } = await import('../lib/core-artifacts.js');
    const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'writer' }); runtime.start();
    try {
      const ids = [];
      for (let index = 0; index < 26; index++) {
        const artifact = await runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot,
          { bytes: source, mediaType: 'image/png', kind: 'workbench-fixture', metadata: {} }));
        ids.push(artifact.id);
      }
      for (const [type, mediaType] of [['video', 'video/mp4'], ['audio', 'audio/wav'], ['text', 'text/plain']]) {
        await runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot,
          { bytes: Buffer.from('fixture media'), mediaType, kind: 'workbench-fixture-' + type, metadata: {} }));
        const response = await fetch(allowedOrigin + '/iris/api/works?source=core&media_type=' + type + '&kind=workbench-fixture-' + type);
        const page = await response.json(); assert.equal(response.status, 200); assert.equal(page.total, 1);
        assert.equal(page.items[0].mime, mediaType); assert(!JSON.stringify(page).includes(dshCoreDataRoot()));
      }
      const first = await (await fetch(allowedOrigin + '/iris/api/works?kind=workbench-fixture&limit=24')).json();
      const second = await (await fetch(allowedOrigin + '/iris/api/works?kind=workbench-fixture&limit=24&offset=24')).json();
      assert.equal(first.total, 26); assert.equal(first.items.length, 24); assert.equal(second.items.length, 2);
      assert.deepEqual([...first.items, ...second.items].map(item => item.id).sort(), ids.sort());
      const before = modelCalls;
      for (const action of ['look', 'ocr']) {
        const response = await fetch(allowedOrigin + '/iris/api/actions/' + action, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artifact_id: first.items[0].id }) });
        const result = await response.json(); assert.equal(response.status, 200); assert(result.ok);
        assert.equal(result.artifactId, first.items[0].id);
        if (action === 'ocr') { assert.equal(result.status, 'complete'); assert.equal(result.successfulChunks, 1); }
        const requestRef = modelRequests.at(-1).messages[0].content.find(block => block.type === 'image').attachment;
        const sent = (await ctx.get('attachments').readImage(requestRef)).data;
        const expected = action === 'look' ? source : await sharp(source).extract({ left: 0, top: 0, width: 8, height: 6 }).png().toBuffer();
        assert.deepEqual(Buffer.from(sent), expected);
      }
      assert.equal(modelCalls, before + 2);
    } finally { await runtime.dispose(); }
  });
  await check('workbench management uses real HTTP preview, ZIP, quarantine and restore without models', async () => {
    const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
    const { createCoreRuntime } = await import('../lib/core-runtime.js');
    const { createCoreArtifact, readCoreArtifactBytes } = await import('../lib/core-artifacts.js');
    const root = dshCoreDataRoot(), runtime = createCoreRuntime({ dataRoot: root, mode: 'writer' }); runtime.start();
    const callsBefore = modelCalls;
    let original, derived;
    const post = (action, body) => fetch(allowedOrigin + '/iris/api/works/' + action, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      original = await runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot,
        { bytes: source, mediaType: 'image/png', kind: 'workbench-management', metadata: { width: 8, height: 6 } }));
      derived = await runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot,
        { bytes: source, mediaType: 'image/png', kind: 'workbench-management', relations: [{ type: 'derived-from', artifactId: original.id }] }));
      const before = fingerprints(root);
      const detail = await fetch(allowedOrigin + '/iris/api/works/core/' + original.id);
      assert.equal(detail.status, 200); assert.equal((await detail.json()).item.digest, original.digest.value);
      const preview = await post('delete', { artifact_ids: [original.id] }); assert.equal(preview.status, 200);
      assert.equal((await preview.json()).allowed, false);
      const archive = await post('download', { items: [original, derived].map(item => ({ source: 'core', id: item.id })) });
      assert.equal(archive.status, 200); assert.equal(archive.headers.get('content-type'), 'application/zip');
      const bytes = Buffer.from(await archive.arrayBuffer()); assert.equal(bytes.readUInt32LE(0), 0x04034b50);
      assert(bytes.includes(source)); assert.deepEqual(fingerprints(root), before);
    } finally { await runtime.dispose(); }
    const deleted = await post('delete', { artifact_ids: [original.id, derived.id], confirm_delete: true });
    assert.equal(deleted.status, 200); const transaction = await deleted.json(); assert(transaction.recoverable);
    assert.throws(() => readCoreArtifactBytes(root, original.id));
    const transactions = await (await fetch(allowedOrigin + '/iris/api/works/transactions')).json();
    assert(transactions.transactions.some(item => item.transactionId === transaction.transactionId));
    const restored = await post('restore', { transaction_id: transaction.transactionId, confirm_restore: true });
    assert.equal(restored.status, 200); assert.equal((await restored.json()).state, 'restored');
    assert.deepEqual(readCoreArtifactBytes(root, original.id).bytes, source);
    assert.deepEqual(readCoreArtifactBytes(root, derived.id).bytes, source);
    assert.equal(modelCalls, callsBefore);
  });
  await check('M4 actual Agent and WebServer summary invoke one same-byte sheet each', async () => {
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('验收摘要需要现有 ffmpeg');
    const video = path.join(work, 'summary.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=160x100:rate=12:duration=2',
      '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' }).status, 0);
    const before = modelCalls;
    const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_media_summarize',
      arguments: { video_path: video, max_frames: 3, transcribe: false }, agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
    assert.equal(result.isError, false);
    const published = result.content.find(block => block.type === 'image').attachment;
    const modeled = modelRequests.at(-1).messages[0].content.find(block => block.type === 'image').attachment;
    assert.deepEqual((await ctx.get('attachments').readImage(published)).data, (await ctx.get('attachments').readImage(modeled)).data);
    const response = await fetch(allowedOrigin + '/iris/api/actions/media_summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_path: video, max_frames: 3 }) });
    const gui = await response.json(); assert.equal(response.status, 200); assert(gui.ok && gui.text.includes('fixture answer'));
    const modeledGui = modelRequests.at(-1).messages[0].content.find(block => block.type === 'image').attachment;
    assert.deepEqual(Buffer.from(gui.imageDataUrl.split(',')[1], 'base64'), Buffer.from((await ctx.get('attachments').readImage(modeledGui)).data));
    assert.equal(modelCalls, before + 2);
  });
  await check('Core frame Artifacts feed actual Agent and WebServer summaries without ffmpeg or Core writes', async () => {
    const video = path.join(work, 'summary.mp4');
    const extracted = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_video_frames',
      arguments: { video_path: video, max_frames: 3 }, agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
    assert.equal(extracted.isError, false);
    const idsText = extracted.content.find(block => block.text?.includes('frame_artifact_ids:')).text;
    const ids = JSON.parse(/frame_artifact_ids: (\[[^\n]+\])/.exec(idsText)[1]);
    const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
    const { createCoreRuntime } = await import('../lib/core-runtime.js');
    const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'writer' }); runtime.start();
    const beforeCore = fingerprints(dshCoreDataRoot()), beforeCalls = modelCalls;
    const originalPath = process.env.PATH, emptyPath = path.join(work, 'no-media-tools'); fs.mkdirSync(emptyPath);
    fs.renameSync(video, video + '.unavailable'); process.env.PATH = emptyPath;
    try {
      const input = { frame_artifact_ids: [...ids].reverse(), transcribe_text: '已有转写文字' };
      const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_media_summarize',
        arguments: input, agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
      assert.equal(result.isError, false); assert(result.content.some(block => block.text?.includes('已选帧')));
      const displayed = result.content.find(block => block.type === 'image').attachment;
      const modeled = modelRequests.at(-1).messages[0].content.find(block => block.type === 'image').attachment;
      assert.deepEqual((await ctx.get('attachments').readImage(displayed)).data, (await ctx.get('attachments').readImage(modeled)).data);
      const response = await fetch(allowedOrigin + '/iris/api/actions/media_summarize', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      const gui = await response.json(); assert.equal(response.status, 200); assert(gui.ok);
      assert.deepEqual(gui.frames.map(frame => frame.artifactId), ids);
      const guiModeled = modelRequests.at(-1).messages[0].content.find(block => block.type === 'image').attachment;
      assert.deepEqual(Buffer.from(gui.imageDataUrl.split(',')[1], 'base64'), Buffer.from((await ctx.get('attachments').readImage(guiModeled)).data));
      assert.equal(modelCalls, beforeCalls + 2);
      assert.deepEqual(fingerprints(dshCoreDataRoot()), beforeCore);
    } finally { process.env.PATH = originalPath; await runtime.dispose(); }
  });
  await check('M4 generated-image description shares strict completion and cancellation', async () => {
    const { describeGeneratedImage } = await import('../lib/composite-vision-routing.js');
    const before = modelCalls;
    assert.equal(await describeGeneratedImage(host(), { providers: hostProviders, image: visionInput, originalPrompt: 'fixture' }), 'fixture answer');
    const controller = new AbortController(); controller.abort();
    assert.equal(await describeGeneratedImage(host(), { image: visionInput, signal: controller.signal }), '');
    assert.equal(modelCalls, before + 1);
    try {
      fixtureFailure = 'after';
      assert.equal(await describeGeneratedImage(host(), { providers: hostProviders, image: visionInput }), '');
    } finally { fixtureFailure = ''; }
    assert.equal(modelCalls, before + 2);
  });
  await check('real WebServer serves Iris Host Doctor without calling a model', async () => {
    const before = modelCalls;
    const response = await fetch(allowedOrigin + '/iris/api/doctor');
    assert.equal(response.status, 200);
    const doctor = await response.json();
    assert(doctor.checks.some(item => item.id === 'dsh-version' && item.status === 'ok'));
    assert.equal(modelCalls, before);
  });
  await check('real WebServer only assembles without a model invocation', async () => {
    const before = modelCalls;
    const configResponse = await fetch(allowedOrigin + '/iris/api/prompt-optimizer/config');
    assert.equal((await configResponse.json()).capabilities.assemble, true);
    const response = await fetch(allowedOrigin + '/iris/api/prompt-optimizer/optimize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'fixture draft', mode: 'assemble', rules: [
        { id: 'end', label: '约束', kind: 'output', position: 'suffix', text: '不要水印' }
      ] })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.optimized, 'fixture draft\n\n不要水印');
    assert.equal(result.route, null);
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

  await check('Music tool delivers an inline audio fixture as a persistent Core Artifact', async () => {
    const config = await import('../lib/config.js');
    const { readCoreArtifactMediaForDsh } = ctx.get('irisRuntime');
    // 空 WAV 仅验收协议与字节交付，不代表试听或真实生曲质量。
    const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=', 'base64');
    const provider = config.upsert({ name: 'music fixture', baseUrl: allowedOrigin + '/music-fixture/v1',
      apiKey: 'fixture-only-key', mediaProtocol: 'openai-images', models: [
        { id: 'fixture-music', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' }
      ] });
    const model = provider.id + '::fixture-music'; config.setAssignmentOrder('music-gen', [model]);
    const originalFetch = globalThis.fetch, before = modelCalls;
    let calls = 0;
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input));
      if (url.origin === allowedOrigin && url.pathname === '/music-fixture/v1/chat/completions') {
        assert.equal(JSON.parse(options.body).model, 'fixture-music'); calls++;
        return Promise.resolve(Response.json({ choices: [{ message: {
          content: '[audio](data:audio/wav;base64,' + wav.toString('base64') + ')'
        } }] }));
      }
      return originalFetch(input, options);
    };
    try {
      const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_generate_music',
        arguments: { prompt: 'offline compatibility fixture', model, retry_502: 0 },
        agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const id = /artifact_[a-f0-9]{24}/.exec(text)?.[0]; assert(id, text);
      const media = await readCoreArtifactMediaForDsh(id);
      assert.equal(media.artifact.mediaType, 'audio/wav'); assert.deepEqual(media.bytes, wav);
      const response = await fetch(allowedOrigin + '/iris/api/core/artifact/' + id + '/media');
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
      assert.equal(calls, 1); assert.equal(modelCalls, before);
      report.music = { artifactId: id, fixtureProviderCalls: calls, audioBytes: wav.length };
    } finally { globalThis.fetch = originalFetch; }
  });
  await check('native Qwen edit preserves its Core source and publishes a real DSH image attachment', async () => {
    const config = await import('../lib/config.js');
    const { createCoreRuntime } = await import('../lib/core-runtime.js');
    const { createCoreArtifact, readCoreArtifactBytes } = await import('../lib/core-artifacts.js');
    const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
    const { readCoreArtifactMediaForDsh } = ctx.get('irisRuntime');
    const original = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const output = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#00ff00' } }).png().toBuffer();
    const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'writer' }); runtime.start();
    let sourceArtifact;
    try { sourceArtifact = await runtime.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot,
      { bytes: original, mediaType: 'image/png', kind: 'imported-image', metadata: {} })); }
    finally { await runtime.dispose(); }
    const provider = config.upsert({ name: 'Qwen fixture', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'fixture-only-key', mediaProtocol: 'dashscope', models: [
        { id: 'qwen-image-2.0-pro', capabilities: ['image-gen'], imageProtocol: 'dashscope', visionInput: { maxDimension: 64 } }
      ] });
    const model = provider.id + '::qwen-image-2.0-pro'; config.setAssignmentOrder('image-gen', [model]);
    const originalFetch = globalThis.fetch, before = modelCalls;
    let calls = 0, downloads = 0;
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      // 标准协议端点仅作为标识；这里在网络边界截获，绝不连接上游。
      if (url.origin === 'https://dashscope.aliyuncs.com' && url.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
        const body = JSON.parse(options.body), content = body.input.messages[0].content;
        assert.equal(body.model, 'qwen-image-2.0-pro'); assert.equal(content[1].text, 'change red to green');
        assert.equal((await sharp(Buffer.from(content[0].image.split(',')[1], 'base64')).metadata()).width, 64);
        calls++;
        return Response.json({ output: { choices: [{ message: { content: [{ image: allowedOrigin + '/edit-fixture.png' }] } }] } });
      }
      if (url.origin === allowedOrigin && url.pathname === '/edit-fixture.png') {
        downloads++; return new Response(output, { headers: { 'Content-Type': 'image/png' } });
      }
      return originalFetch(input, options);
    };
    try {
      const result = await ctx.get('tools').execute({ callId: crypto.randomUUID(), name: 'iris_edit_image',
        arguments: { source_artifact_id: sourceArtifact.id, prompt: 'change red to green', model },
        agent: { ctx, session: { id: 'fixture' } }, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      const image = result.content.find(block => block.type === 'image'); assert(image, JSON.stringify(result));
      assert.deepEqual(Buffer.from((await ctx.get('attachments').readImage(image.attachment)).data), output);
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const ids = [...new Set(text.match(/artifact_[a-f0-9]{24}/g) || [])];
      const edited = (await Promise.all(ids.map(id => readCoreArtifactMediaForDsh(id))))
        .find(item => item.artifact.relations?.some(edge => edge.type === 'derived-from' && edge.artifactId === sourceArtifact.id));
      assert(edited, text); assert.deepEqual(edited.bytes, output);
      assert.deepEqual(readCoreArtifactBytes(dshCoreDataRoot(), sourceArtifact.id).bytes, original);
      assert.equal(calls, 1); assert.equal(downloads, 1); assert.equal(modelCalls, before + 1);
      const described = modelRequests.at(-1).messages[0].content.find(block => block.type === 'image').attachment;
      assert.deepEqual(Buffer.from((await ctx.get('attachments').readImage(described)).data), output);
      report.qwenEdit = { sourceArtifactId: sourceArtifact.id, artifactId: edited.artifact.id, fixtureProviderCalls: calls, downloads };
    } finally { globalThis.fetch = originalFetch; }
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
    if (request === '@deepseek-ai/dsh-client-ui-slots') return clientSlots;
    return requireDsh(request);
  }
  const rendererManifest = requireDsh('@deepseek-ai/dsh-client-ui-renderer/package.json');
  const slotsManifest = requireClientSdk('@deepseek-ai/dsh-client-ui-slots/package.json');
  assert.equal(slotsManifest.version, rendererManifest.version, '客户端夹具必须使用与目标 renderer 同版本的官方 SlotCore');
  const clientSlots = await import(pathToFileURL(requireClientSdk.resolve('@deepseek-ai/dsh-client-ui-slots')).href);
  report.clientSdk = { renderer: rendererManifest.version, slots: slotsManifest.version };
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
  await check('actual host SlotRegistry accepts all four Iris client seats', () => {
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
  await check('real providers HTTP exposes cooldown and persistent quota without model calls', async () => {
    const config = await import('../lib/config.js');
    const before = modelCalls;
    const provider = config.upsert({ name: 'health fixture', auth: 'none', baseUrl: 'https://health.fixture.invalid/v1',
      mediaProtocol: 'openai-images', models: [{ id: 'fixture-vision', capabilities: ['vision'] }] });
    config.setAssignmentOrder('vision', [provider.id + '::fixture-vision']);
    const list = async () => {
      const response = await fetch(allowedOrigin + '/iris/api/actions/providers_list', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 200);
      return (await response.json()).providers.find(value => value.id === provider.id).models[0].health.vision;
    };
    config.recordRateLimit({ providerId: provider.id, modelId: 'fixture-vision', capability: 'vision', retryAfterMs: 120000 });
    const cooling = await list(); assert(cooling.retryAt); assert.equal(cooling.category, 'rate_limit');
    const state = await (await fetch(allowedOrigin + '/iris/api/state')).json();
    assert.equal(state.health.capabilities.vision.retryAt, cooling.retryAt);
    config.recordProviderHealth(provider.id, 'fixture-vision', 'vision', {
      ok: false, source: 'probe', category: 'quota', httpStatus: 403, note: 'Free quota exhausted.' });
    config.resetCache();
    const exhausted = await list(); assert.equal(exhausted.reason, 'free_quota'); assert.equal(exhausted.retryAt, undefined);
    assert.deepEqual(config.pickAllFor('vision'), []);
    config.setModelVerified(provider.id, 'fixture-vision', 'vision', { ok: true });
    assert.equal((await list()).status, 'verified');
    assert.equal(modelCalls, before, '这里只注入健康事实，不发起模型验证');
  });
  let unloadedAssembly;
  await check('Iris unload removes tools, skills and routes from real services', async () => {
    assert.equal(hostRuntimeEvidence().server.loaded, true);
    const assembly = ctx.get('irisRuntime');
    unloadedAssembly = assembly;
    assert.equal(assembly.snapshot().state, 'open');
    let release, operationSignal;
    const foreign = assembly.runHostOperation(signal => {
      operationSignal = signal; return new Promise(resolve => { release = resolve; });
    });
    let settled = false;
    const unloading = Promise.resolve(irisFiber.dispose());
    void unloading.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(operationSignal.aborted, true);
    assert.equal(settled, false, 'the real Fiber must await the owned runtime drain');
    await assert.rejects(assembly.runHostOperation(() => {}), { code: 'IRIS_DSH_RUNTIME_CLOSED' });
    release(); await foreign; await unloading;
    assert.equal(assembly.snapshot().state, 'closed');
    report.runtimeAssembly = { ownedService: true, foreignSignalAborted: true, unloadWaitedForDrain: true,
      closedRejectsNewOperations: true, writerReleased: true };
    assert.equal(ctx.get('tools').schemas().length, 0);
    assert.equal((await ctx.get('skills').list()).length, 0);
    assert.equal((await fetch(allowedOrigin + '/iris/api/doctor')).status, 404);
  });
  await check('Iris reload owns a new runtime and old disposal cannot remove its registrations', async () => {
    const reloadedFiber = await mount({ name: iris.name, inject: iris.inject, apply: iris.apply });
    const replacement = ctx.get('irisRuntime');
    assert.notEqual(replacement, unloadedAssembly);
    assert.equal(replacement.snapshot().state, 'open');
    await irisFiber.dispose(); await unloadedAssembly.dispose();
    await assert.rejects(unloadedAssembly.coreSnapshotForDsh(), { code: 'IRIS_DSH_RUNTIME_CLOSED' });
    assert.equal(replacement.snapshot().state, 'open');
    assert.deepEqual(ctx.get('tools').schemas().map(item => item.name).sort(), [...EXPECTED_IRIS_TOOLS].sort());
    assert.deepEqual((await ctx.get('skills').list()).map(item => item.name).sort(), [...EXPECTED_IRIS_SKILLS].sort());
    assert.equal((await fetch(allowedOrigin + '/iris/api/doctor')).status, 200);
    assert.equal((await fetch(allowedOrigin + '/iris/api/core/snapshot')).status, 200);
    report.runtimeAssembly.reloadIsolated = true;
    await reloadedFiber.dispose();
    assert.equal(replacement.snapshot().state, 'closed');
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
