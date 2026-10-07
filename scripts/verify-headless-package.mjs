/**
 * 仓库外、无 DSH 的真实 npm 包验收。运行：
 *   node scripts/verify-headless-package.mjs [--offline]
 * --offline 仅限制 npm 安装；全部 Provider 请求始终由离线 fixture 接管。
 * 每次创建独立临时目录，保留 tarball、安装日志、产物和 report.json 供复核。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const options = process.argv.slice(2);
assert(options.every((option) => option === '--offline'), '只支持 --offline 参数');
const repo = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-headless-package-'));
const consumer = path.join(work, 'consumer');
const packed = path.join(work, 'packed');
const dataRoot = path.join(work, 'core');
const inputs = path.join(work, 'inputs');
const exportsDir = path.join(work, 'exports');
const unusedDsh = path.join(work, 'unused-dsh-home');
const report = { status: 'running', work, commands: [], artifacts: [], tasks: [] };
const reportFile = path.join(work, 'report.json');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function saveReport() {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}

function run(program, args, { cwd = consumer, env = {}, label, timeout = 60000, status = 0 } = {}) {
  const started = Date.now();
  const result = spawnSync(program, args, {
    cwd, encoding: 'utf8', shell: false, timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', IRIS_IMPORT_WORKBENCH_CONFIG: '', ...env }
  });
  const name = label || args.slice(0, 2).join(' ');
  const command = {
    label: name, program, args, status: result.status, signal: result.signal,
    durationMs: Date.now() - started, stdout: result.stdout || '', stderr: result.stderr || ''
  };
  report.commands.push(command);
  saveReport();
  assert(!result.error, name + ': ' + result.error?.message);
  assert.equal(result.status, status, name + ': ' + command.stderr);
  return command.stdout;
}

function snapshot(directory) {
  const files = {};
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(directory, file)] = digest(fs.readFileSync(file));
    }
  }
  walk(directory);
  return files;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

console.log('验收目录：' + work);
try {
  assert(!isWithin(repo, fs.realpathSync(work)), '验收目录必须在仓库外');
  for (const directory of [consumer, packed, inputs, exportsDir]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'iris-headless-package-acceptance', private: true, type: 'module'
  }) + '\n', { mode: 0o600 });
  const npmrc = path.join(work, 'empty.npmrc');
  fs.writeFileSync(npmrc, '', { mode: 0o600 });

  console.log('1/5 打包当前工作树并审计清单');
  const [pkg] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packed], {
    cwd: repo, label: 'npm pack'
  }));
  const files = pkg.files.map((file) => file.path);
  assert(files.includes('lib/generation-input.js'));
  assert(!files.some((file) => /^(?:tests|scripts|\.internal|node_modules)\//.test(file)));
  assert(pkg.files.find((file) => file.path === 'bin/dsh-iris.js').mode & 0o111, 'CLI 必须有可执行位');
  const tarball = path.join(packed, pkg.filename);
  report.package = {
    name: pkg.name, version: pkg.version, fileCount: files.length,
    tarball, sha256: digest(fs.readFileSync(tarball)), integrity: pkg.integrity
  };

  console.log('2/5 在空项目中通过 npm 安装 tarball 与现有生产依赖');
  run('npm', ['install', '--no-audit', '--no-fund', '--save-exact',
    '--userconfig', npmrc, '--registry', 'https://registry.npmjs.org',
    ...(options.includes('--offline') ? ['--offline'] : []), tarball], {
    label: 'npm install tarball', timeout: 300000
  });
  const requireConsumer = createRequire(path.join(consumer, 'package.json'));
  const installedJson = requireConsumer.resolve(pkg.name + '/package.json');
  const installed = fs.realpathSync(path.dirname(installedJson));
  assert(isWithin(consumer, installed) && !isWithin(repo, installed), '必须使用包外实际安装副本');
  const installedPackage = readJson(installedJson);
  assert.equal(installedPackage.version, pkg.version);
  const dependencies = Object.keys(readJson(path.join(consumer, 'package-lock.json')).packages);
  assert(!dependencies.some((name) => /(?:^|\/)node_modules\/(?:@deepseek-ai\/|cordis(?:\/|$)|dsh(?:\/|$))/.test(name)),
    '安装树不得包含 DSH/Cordis');
  function auditLinks(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) assert(isWithin(consumer, fs.realpathSync(file)), '安装树不得通过链接回用仓库或外部依赖');
      else if (entry.isDirectory()) auditLinks(file);
    }
  }
  auditLinks(path.join(consumer, 'node_modules'));
  for (const file of files.filter((file) => file !== 'package.json')) {
    assert.equal(digest(fs.readFileSync(path.join(installed, file))), digest(fs.readFileSync(path.join(repo, file))),
      '安装文件必须与打包源码一致：' + file);
  }
  const requireInstalled = createRequire(installedJson);
  const sharp = requireInstalled('sharp');
  const bin = path.join(consumer, 'node_modules', '.bin', 'dsh-iris');
  assert(isWithin(installed, fs.realpathSync(bin)), 'npm bin 必须指向安装副本');
  const cliRelative = (installedPackage.bin['dsh-iris']).replace(/^\.\//, '');
  assert.equal(fs.realpathSync(bin), path.join(installed, cliRelative));
  report.environment = {
    node: process.version, npm: run('npm', ['--version'], { label: 'npm version' }).trim(),
    arch: process.arch, platform: process.platform, kernel: os.release(), sharp: sharp.versions.sharp,
    installed, dependencyPaths: dependencies.filter((directory) => directory
      && fs.existsSync(path.join(consumer, directory, 'package.json'))),
    noDshOrCordis: true, noExternalModuleLinks: true
  };

  // 直接消费安装副本中的内部核心；不增加公共 export/CLI，也不引用仓库 fixture。
  const promptConsumer = path.join(work, 'prompt-consumer.mjs');
  fs.writeFileSync(promptConsumer, [
    "import assert from 'node:assert/strict';",
    'import { assemblePrompt, preparePromptOptimization, runPromptOptimization } from ' + JSON.stringify(pathToFileURL(path.join(installed, 'lib/prompt-optimizer-core.js')).href) + ';',
    "globalThis.fetch = () => { throw new Error('禁止网络'); };",
    "const rule = { id: 'end', label: '约束', kind: 'output', position: 'suffix', text: '不要水印' };",
    "assert.equal(assemblePrompt({ text: '  原稿  ', rules: [rule] }).optimized, '  原稿  \\n\\n不要水印');",
    'let calls = 0;',
    "const identity = { origin: 'provider', backendId: 'fixture:text', providerId: 'fixture', modelId: 'text' };",
    "const port = { describe() { return { contractVersion: 0, kind: 'text', identity, availability: 'available', features: { system: 'supported', temperature: 'supported', maxOutputTokens: 'supported', reasoning: 'unknown' } }; },",
    "  async complete(request, options) { calls++; assert(request.prompt.includes('原稿')); assert(options.signal); return { contractVersion: 0, text: '独立优化正文', finishReason: 'stop', identity }; } };",
    "const plan = preparePromptOptimization({ text: '原稿', rules: [rule] }, { systemPrompt: '保留原意', targets: { general: '保持语言' }, generation: { temperature: 0.3, timeoutMs: 1000, maxOutputTokens: 1200 } });",
    "assert.equal((await runPromptOptimization(port, plan)).optimized, '独立优化正文\\n\\n不要水印');",
    "assert.equal(calls, 1); console.log('PASS 无 DSH 的实际安装副本共享优化与零网络组装');", ''
  ].join('\n'), { mode: 0o600 });
  const consumerBefore = snapshot(consumer);
  run(process.execPath, [promptConsumer], { env: { DSH_HOME: unusedDsh }, label: 'installed shared prompt optimizer' });
  assert.deepEqual(snapshot(consumer), consumerBefore, '提示词共享核心不得写消费者配置/Task/Artifact');
  assert(!fs.existsSync(unusedDsh), '共享核心不得使用 DSH_HOME');
  report.promptOptimizer = { installedCore: true, noDshOrCordis: true, noNetwork: true, modelInvocations: 1, assemblyInvocations: 0, noWrites: true };

  const visionConsumer = path.join(work, 'vision-consumer.mjs');
  fs.writeFileSync(visionConsumer, [
    "import assert from 'node:assert/strict';",
    'import { completeVision } from ' + JSON.stringify(pathToFileURL(path.join(installed, 'lib/vision-core.js')).href) + ';',
    'import { createHttpVisionModelPort } from ' + JSON.stringify(pathToFileURL(path.join(installed, 'lib/http-vision-model-adapter.js')).href) + ';',
    "globalThis.fetch = () => { throw new Error('禁止网络'); };",
    'let calls = 0;',
    "const image = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' };",
    "const port = createHttpVisionModelPort({ providerId: 'fixture', modelId: 'vision', baseUrl: 'https://fixture.invalid/v1', fetch: async (_url, options) => {",
    "  calls++; const body = JSON.parse(options.body); assert.equal(body.messages[0].content[1].image_url.url, 'data:image/png;base64,AQID');",
    "  return new Response('data: {\"choices\":[{\"delta\":{\"content\":\"完整正文\"},\"finish_reason\":\"stop\"}]}\\n\\ndata: [DONE]\\n\\n', { headers: { 'Content-Type': 'text/event-stream' } }); } });",
    "assert.equal((await completeVision([port], { prompt: 'fixture', image })).text, '完整正文');",
    "assert.equal(calls, 1); console.log('PASS 无 DSH 的实际安装副本视觉核心和 HTTP 协议');", ''
  ].join('\n'), { mode: 0o600 });
  run(process.execPath, [visionConsumer], { env: { DSH_HOME: unusedDsh }, label: 'installed shared vision core' });
  assert.deepEqual(snapshot(consumer), consumerBefore, '视觉共享核心不得写配置/Task/Artifact');
  assert(!fs.existsSync(unusedDsh), '视觉共享核心不得使用 DSH_HOME');
  report.vision = { installedCore: true, noDshOrCordis: true, noNetwork: true, modelInvocations: 1, noWrites: true };

  const ocrConsumer = path.join(work, 'ocr-consumer.mjs');
  fs.writeFileSync(ocrConsumer, [
    "import assert from 'node:assert/strict';", "import { createRequire } from 'node:module';",
    'import { longOcr } from ' + JSON.stringify(pathToFileURL(path.join(installed, 'lib/ocr.js')).href) + ';',
    'import { createHttpVisionModelPort } from ' + JSON.stringify(pathToFileURL(path.join(installed, 'lib/http-vision-model-adapter.js')).href) + ';',
    'const sharp = createRequire(' + JSON.stringify(installedJson) + ")('sharp');",
    "globalThis.fetch = () => { throw new Error('禁止网络'); };", 'let calls = 0;',
    "const bytes = await sharp({ create: { width: 128, height: 300, channels: 3, background: '#ff0000' } }).png().toBuffer();",
    "const port = createHttpVisionModelPort({ providerId: 'fixture', modelId: 'vision', baseUrl: 'https://fixture.invalid/v1', fetch: async (_url, options) => {",
    "  calls++; const body = JSON.parse(options.body); const png = Buffer.from(body.messages[0].content[1].image_url.url.split(',')[1], 'base64');",
    "  assert.equal((await sharp(png).metadata()).height, 100);",
    "  return new Response('data: {\"choices\":[{\"delta\":{\"content\":\"完整 OCR 正文\"},\"finish_reason\":\"stop\"}]}\\n\\ndata: [DONE]\\n\\n', { headers: { 'Content-Type': 'text/event-stream' } }); } });",
    "const result = await longOcr({ image: { bytes: new Uint8Array(bytes), mediaType: 'image/png' }, ports: [port], chunkHeight: 100, overlap: 0 });",
    "assert.equal(result.status, 'complete'); assert.equal(result.totalChunks, 3); assert.equal(result.invocations, 3);",
    "assert(result.fullText.includes('[第3段 y=200]')); assert.equal(calls, 3); console.log('PASS 无 DSH 的实际安装副本多块 OCR 与零网络');", ''
  ].join('\n'), { mode: 0o600 });
  run(process.execPath, [ocrConsumer], { env: { DSH_HOME: unusedDsh }, label: 'installed shared OCR' });
  assert.deepEqual(snapshot(consumer), consumerBefore, 'OCR 共享业务不得写配置/Task/Artifact');
  assert(!fs.existsSync(unusedDsh), 'OCR 共享业务不得使用 DSH_HOME');
  report.ocr = { installedCore: true, noDshOrCordis: true, noNetwork: true, modelInvocations: 3, chunks: 3, noWrites: true };

  const compositeConsumer = path.join(work, 'composite-consumer.mjs');
  fs.writeFileSync(compositeConsumer, [
    "import assert from 'node:assert/strict';", "import { createRequire } from 'node:module';",
    'import { locateObject } from ' + JSON.stringify(pathToFileURL(path.join(installed, 'lib/locate.js')).href) + ';',
    'import { summarizeMedia } from ' + JSON.stringify(pathToFileURL(path.join(installed, 'lib/summarize.js')).href) + ';',
    'import { describeGeneratedImage } from ' + JSON.stringify(pathToFileURL(path.join(installed, 'lib/composite-vision-routing.js')).href) + ';',
    'const sharp = createRequire(' + JSON.stringify(installedJson) + ")('sharp');",
    'let calls = 0;',
    "const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#ff0000' } }).png().toBuffer();",
    "const identity = { origin: 'provider', backendId: 'fixture:vision', providerId: 'fixture', modelId: 'vision' };",
    "const port = { describe() { return { contractVersion: 0, kind: 'vision', identity, availability: 'available', features: { system: 'unknown', temperature: 'unknown', maxOutputTokens: 'unknown', reasoning: 'unknown' } }; },",
    "  async complete(request) { calls++; return { contractVersion: 0, identity, text: calls === 1 ? '{\"x1\":1,\"y1\":2,\"x2\":40,\"y2\":50}' : 'red sheet', finishReason: 'stop' }; } };",
    "globalThis.fetch = () => { throw new Error('禁止网络'); };",
    "const image = { bytes: new Uint8Array(bytes), mediaType: 'image/png' };",
    "assert.equal((await locateObject([port], { image, target: 'red', width: 160, height: 100 })).bbox.x2, 40);",
    "const result = await summarizeMedia({ ports: [port], frames: [0, 1, 2].map(atSec => ({ buffer: bytes, width: 160, height: 100, atSec })) });",
    "assert.equal(result.text, 'red sheet'); assert.equal(calls, 2); assert.equal(result.sheet.cols, 3);",
    "const canceled = new AbortController(); canceled.abort(); assert.equal(await describeGeneratedImage({}, { image, signal: canceled.signal }), '');",
    "console.log('PASS 无 DSH 的安装副本定位/拼图与预取消自述');", ''
  ].join('\n'), { mode: 0o600 });
  run(process.execPath, [compositeConsumer], { env: { DSH_HOME: unusedDsh }, label: 'installed shared composite vision' });
  assert.deepEqual(snapshot(consumer), consumerBefore, '复合视觉业务不得写配置/Task/Artifact');
  assert(!fs.existsSync(unusedDsh), '复合视觉业务不得使用 DSH_HOME');
  report.compositeVision = { installedCore: true, noDshOrCordis: true, noNetwork: true, modelInvocations: 2, noWrites: true };

  // Fixture 自身只导入 node:fs；副本置于包外，CLI 不引用仓库源码或 node_modules。
  const fixture = path.join(work, 'provider-fixture.mjs');
  fs.copyFileSync(path.join(repo, 'tests', 'fixtures', 'headless-async-fetch.mjs'), fixture);
  const stateFile = path.join(work, 'provider-state.json');
  const videoPath = path.join(inputs, 'clip.mp4');
  const bootstrap = path.join(work, 'bootstrap.mjs');
  fs.writeFileSync(bootstrap, [
    "import fs from 'node:fs';",
    "import './provider-fixture.mjs';",
    'const fixtureFetch = globalThis.fetch;',
    'globalThis.fetch = async (input, init) => {',
    '  const result = await fixtureFetch(input, init);',
    '  const url = String(input instanceof Request ? input.url : input);',
    "  return result.ok && url.startsWith('https://artifact.invalid/remote-') && url.endsWith('.mp4')",
    "    ? new Response(fs.readFileSync(process.env.IRIS_PACKAGE_FIXTURE_VIDEO), { headers: { 'Content-Type': 'video/mp4' } })",
    '    : result;',
    '};', ''
  ].join('\n'), { mode: 0o600 });
  const cliEnv = {
    DSH_HOME: unusedDsh, NODE_OPTIONS: '--import=' + pathToFileURL(bootstrap).href,
    IRIS_ASYNC_FIXTURE_STATE: stateFile, IRIS_PACKAGE_FIXTURE_VIDEO: videoPath
  };
  function cli(args, { status = 0, json = true, errorCode } = {}) {
    const stdout = run(bin, args, { env: cliEnv, status, label: 'CLI ' + args.slice(0, 2).join(' ') });
    if (errorCode) assert(report.commands.at(-1).stderr.includes(errorCode), 'CLI 必须返回预期错误：' + errorCode);
    assert(!stdout.includes('fixture-key-package'), 'CLI 不得输出 fixture 凭据');
    assert(!fs.existsSync(unusedDsh), 'CLI 不得使用 DSH_HOME');
    assert(!fs.existsSync(path.join(dataRoot, '.iris-runtime-writer-v0')), 'CLI 退出后必须释放 writer 租约');
    return json ? JSON.parse(stdout) : stdout;
  }
  const rootArgs = ['--data-root', dataRoot];
  const state = () => fs.existsSync(stateFile) ? readJson(stateFile) : { submit: 0, poll: 0, download: 0, tasks: {} };
  const artifacts = new Map();
  async function verifyArtifact(artifact, label) {
    const before = snapshot(dataRoot);
    const networkBefore = state();
    const inspected = cli(['artifact', 'inspect', artifact.id, ...rootArgs]).artifact;
    const manifest = readJson(path.join(dataRoot, 'artifact-store', 'v0', 'manifests', artifact.id + '.json'));
    assert.deepEqual(inspected.digest, manifest.digest);
    const output = path.join(exportsDir, label + path.extname(manifest.object));
    cli(['artifact', 'export', artifact.id, ...rootArgs, '--output', output]);
    const bytes = fs.readFileSync(output);
    assert.equal(digest(bytes), manifest.digest.value, '导出 SHA-256 必须匹配 Manifest');
    assert.deepEqual(bytes, fs.readFileSync(path.join(dataRoot, 'artifact-store', 'v0', 'objects', manifest.object)));
    assert(!JSON.stringify(manifest).includes(work), 'Manifest 不得保存宿主路径');
    assert.deepEqual(snapshot(dataRoot), before, 'inspect/export 必须保持 Core 零写入');
    assert.deepEqual(state(), networkBefore, 'inspect/export 必须保持零 Provider 请求');
    if (artifact.mediaType.startsWith('image/')) {
      const dimensions = await sharp(bytes).metadata();
      assert(dimensions.width > 0 && dimensions.height > 0);
    }
    artifacts.set(artifact.id, artifact);
    report.artifacts.push({ id: artifact.id, kind: artifact.kind, mediaType: artifact.mediaType, sha256: digest(bytes), output });
    return { output, bytes };
  }

  console.log('3/5 实际执行 help、crop、diff、ffmpeg 抽帧与 Artifact 导出');
  assert(cli(['--help'], { json: false }).includes('media frames'));
  assert(!fs.existsSync(stateFile), 'help 不得请求 Provider');
  const images = [];
  for (const [index, background] of ['#ff0000', '#0000ff'].entries()) {
    const image = path.join(inputs, 'image-' + index + '.png');
    await sharp({ create: { width: 16, height: 12, channels: 3, background } }).png().toFile(image);
    const crop = cli(['run', 'crop', ...rootArgs, '--input', JSON.stringify({
      image_path: image, left: 2, top: 1, width: 8, height: 6
    })]);
    assert.equal(crop.artifact.metadata.width, 8);
    assert.equal(crop.artifact.metadata.height, 6);
    images.push(crop.artifact);
    await verifyArtifact(crop.artifact, 'crop-' + index);
  }
  const diff = cli(['media', 'diff', ...rootArgs, '--input', JSON.stringify({
    image_a_artifact_id: images[0].id, image_b_artifact_id: images[1].id, grid: 4, top_regions: 2
  })]);
  assert.equal(diff.metrics.ratio, 1);
  assert.equal(diff.artifact.kind, 'pixel-diff');
  assert.deepEqual(new Set(diff.artifact.relations.map((relation) => relation.artifactId)), new Set(images.map((artifact) => artifact.id)));
  assert(diff.artifact.relations.every((relation) => relation.type === 'derived-from'));
  await verifyArtifact(diff.artifact, 'diff');
  report.environment.ffmpeg = run('ffmpeg', ['-version'], { label: 'ffmpeg version' }).split('\n')[0];
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=96x64:rate=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest',
    '-pix_fmt', 'yuv420p', videoPath], { label: 'create local video' });
  const framesInput = { video_path: videoPath, max_frames: 3, target_width: 48, format: 'png' };
  const frames = cli(['media', 'frames', ...rootArgs, '--input', JSON.stringify(framesInput)]);
  assert.equal(frames.artifacts.length, 3);
  for (const [index, artifact] of frames.artifacts.entries()) {
    assert.equal(artifact.metadata.frameIndex, index + 1);
    assert.equal(artifact.metadata.width, 48);
    await verifyArtifact(artifact, 'local-frame-' + index);
  }
  assert(!fs.existsSync(stateFile), '本地媒体命令不得请求 Provider');

  // 四个独立视觉命令也必须通过 npm 安装的可执行入口，而不是源码导入。
  const visionFixture = path.join(work, 'headless-vision-fetch.mjs');
  fs.copyFileSync(path.join(repo, 'tests/fixtures/headless-vision-fetch.mjs'), visionFixture);
  fs.copyFileSync(path.join(repo, 'tests/fixtures/headless-async-fetch.mjs'), path.join(work, 'headless-async-fetch.mjs'));
  const visionStateFile = path.join(work, 'vision-state.json'), visionConfigFile = path.join(work, 'vision-providers.json');
  fs.writeFileSync(visionStateFile, JSON.stringify({ submit: 0, poll: 0, download: 0, tasks: {} }), { mode: 0o600 });
  fs.writeFileSync(visionConfigFile, JSON.stringify({ providers: [{ id: 'vision-fixture', type: 'openai', enabled: true,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope', apiKey: 'fixture-key',
    models: [{ id: 'vision', capabilities: ['vision'] }, { id: 'asr', capabilities: ['transcribe'] }] }],
    assignments: { vision: ['vision-fixture::vision'] } }), { mode: 0o600 });
  const visionConfigBefore = digest(fs.readFileSync(visionConfigFile));
  const coreBeforeVision = snapshot(dataRoot);
  const visionEnv = { DSH_HOME: unusedDsh, NODE_OPTIONS: '--import=' + pathToFileURL(visionFixture).href,
    IRIS_ASYNC_FIXTURE_STATE: visionStateFile };
  function visionCli(command, input, extra = [], status = 0) {
    const stdout = run(bin, ['vision', command, '--provider-config', visionConfigFile, '--input', JSON.stringify(input), ...extra],
      { env: visionEnv, status, label: 'installed CLI vision ' + command });
    assert(!stdout.includes('fixture-key')); assert(!fs.existsSync(unusedDsh));
    return JSON.parse(stdout);
  }
  const visionImage = path.join(inputs, 'vision.png');
  await sharp({ create: { width: 40, height: 200, channels: 3, background: 'red' } }).png().toFile(visionImage);
  const looked = visionCli('look', { image_path: visionImage });
  assert.equal(looked.modelRef, 'vision-fixture::vision'); assert.equal(looked.selectionReason, 'assignment');
  const located = visionCli('locate', { image_path: visionImage, target: 'red' }, ['--model-ref', 'vision-fixture::vision']);
  assert.equal(located.bbox.found, true); assert.equal(located.selectionReason, 'explicit');
  const recognized = visionCli('ocr', { image_path: visionImage, chunk_height: 100, overlap: 0 });
  assert.equal(recognized.status, 'complete'); assert.equal(recognized.totalChunks, 2);
  const partialOcr = visionCli('ocr', { image_path: visionImage, chunk_height: 100, overlap: 0, max_invocations: 1 }, [], 1);
  assert.equal(partialOcr.status, 'partial');
  const artifactInput = { artifact_id: images[0].id };
  const artifactLook = visionCli('look', artifactInput, rootArgs);
  assert.equal(artifactLook.artifactId, artifactInput.artifact_id);
  assert.equal(readJson(visionStateFile).vision.at(-1).imageSha256, images[0].digest.value);
  const artifactLocate = visionCli('locate', { ...artifactInput, target: 'red' }, rootArgs);
  assert.equal(artifactLocate.artifactId, artifactInput.artifact_id);
  assert.equal(artifactLocate.width, images[0].metadata.width);
  const artifactOcr = visionCli('ocr', artifactInput, rootArgs);
  assert.equal(artifactOcr.artifactId, artifactInput.artifact_id); assert.equal(artifactOcr.status, 'complete');
  assert.deepEqual(snapshot(dataRoot), coreBeforeVision, '已安装 CLI 的看图/定位/OCR 只读 Core 图片');
  const savedSummary = path.join(exportsDir, 'vision-summary.json'), savedSheet = path.join(exportsDir, 'vision-sheet.png');
  const summarized = visionCli('summarize', { video_path: videoPath, max_frames: 3 }, ['--output', savedSummary, '--sheet-output', savedSheet]);
  assert.equal(summarized.transcription.status, 'disabled'); assert.deepEqual(readJson(savedSummary), summarized);
  assert.equal(digest(fs.readFileSync(savedSheet)), summarized.contactSheet.sha256);
  assert.equal(readJson(visionStateFile).vision.at(-1).imageSha256, summarized.contactSheet.sha256);
  assert.deepEqual(snapshot(dataRoot), coreBeforeVision, '纯视觉不得写已有 Core 数据根');
  const artifactSheet = path.join(exportsDir, 'vision-artifact-sheet.png');
  const reused = visionCli('summarize', { frame_artifact_ids: frames.artifacts.map(a => a.id).reverse(),
    transcribe_text: '已有帧的显式转写' }, ['--data-root', dataRoot, '--sheet-output', artifactSheet]);
  assert.deepEqual(reused.frames.map(f => f.artifactId), frames.artifacts.map(a => a.id));
  assert.deepEqual(reused.frames.map(f => f.atSec), frames.artifacts.map(a => a.metadata.atSec));
  assert.equal(reused.transcription.status, 'provided');
  assert.equal(digest(fs.readFileSync(artifactSheet)), readJson(visionStateFile).vision.at(-1).imageSha256);
  assert.deepEqual(snapshot(dataRoot), coreBeforeVision, '已安装 CLI 复用原帧，不改写 Core');
  const visionRoot = path.join(work, 'vision-core');
  const audioSummary = visionCli('summarize', { video_path: videoPath, max_frames: 2, transcribe: true,
    transcribe_model_ref: 'vision-fixture::asr' }, ['--data-root', visionRoot]);
  assert.equal(audioSummary.transcription.status, 'complete'); assert.equal(readJson(visionStateFile).submit, 1);
  const asrTask = readJson(path.join(visionRoot, 'task-store/v0/tasks', audioSummary.transcription.taskId + '.json'));
  assert.equal(asrTask.attempts.length, 1); assert.equal(asrTask.deliveryState, 'ready');
  assert(!fs.existsSync(path.join(visionRoot, '.iris-runtime-writer-v0')));
  assert.equal(digest(fs.readFileSync(visionConfigFile)), visionConfigBefore);
  report.visionCli = { installedBin: true, noDshOrCordis: true, commands: 10, pureVisionNoCoreWrites: true,
    existingFrameArtifactsReadOnly: true, existingImageArtifactsReadOnly: true,
    strictExplicitSelection: true, ocrPartialExitCode: 1, sameContactSheetBytes: true, coreAsrTaskId: asrTask.id,
    coreAsrArtifactIds: asrTask.artifactIds, coreAsrSubmits: 1 };
  saveReport();

  console.log('4/5 四类生成经已安装 CLI 完成 submit → observe → Artifact（全部离线）');
  const configFile = path.join(work, 'fixture-providers.json');
  const models = {
    image: 'wanx2.1-t2i-turbo', video: 'wan2.6-i2v',
    tts: 'qwen3-tts-flash', transcribe: 'qwen-audio-3.0-asr-flash-filetrans'
  };
  fs.writeFileSync(configFile, JSON.stringify({ providers: [{
    id: 'package-fixture', enabled: true, apiKey: 'fixture-key-package', mediaProtocol: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: Object.entries(models).map(([capability, id]) => ({
      id, capabilities: [{ image: 'image-gen', video: 'video-gen' }[capability] || capability]
    }))
  }] }) + '\n', { mode: 0o600 });
  const audioPath = path.join(inputs, 'audio.wav');
  fs.writeFileSync(audioPath, Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=', 'base64'));
  const scenarios = [
    { capability: 'image', input: { prompt: '  package image fixture  ', n: '1' }, polls: 2, kind: 'generated-image' },
    { capability: 'video', input: { prompt: '  package video fixture  ', duration: '5',
      img_data_url: 'data:image/png;base64,' + fs.readFileSync(path.join(inputs, 'image-0.png')).toString('base64') },
    polls: 3, kind: 'generated-video' },
    { capability: 'tts', input: { text: '  package tts fixture  ', voice: ' Cherry ' }, polls: 0, kind: 'generated-audio' },
    { capability: 'transcribe', input: { audio_path: audioPath }, polls: 2, kind: 'transcript' }
  ];
  for (const scenario of scenarios) {
    const before = state();
    let result = cli(['run', scenario.capability, ...rootArgs, '--provider-config', configFile,
      '--input', JSON.stringify(scenario.input)]);
    assert.equal(state().poll, before.poll, 'submit 不得隐式轮询');
    for (let poll = 0; poll < scenario.polls; poll++) {
      const counter = state().poll;
      result = cli(['task', 'observe', result.task.id, ...rootArgs, '--provider-config', configFile]);
      assert.equal(state().poll, counter + 1, '单步 observe 只能 poll 一次');
    }
    assert.equal(result.task.outcome, 'succeeded');
    assert.equal(result.task.deliveryState, 'ready');
    assert.equal(result.task.attempts.length, 1);
    assert.equal(state().submit, before.submit + (scenario.capability === 'tts' ? 0 : 1), '观察不得重提');
    assert.equal(result.task.capability, scenario.capability);
    const inspected = cli(['task', 'inspect', result.task.id, ...rootArgs]);
    assert.deepEqual(inspected.task, result.task);
    const artifact = cli(['artifact', 'inspect', result.task.artifactIds[0], ...rootArgs]).artifact;
    assert.equal(artifact.kind, scenario.kind);
    const exported = await verifyArtifact(artifact, scenario.capability);
    if (scenario.capability === 'transcribe') assert(exported.bytes.toString('utf8').includes('fixture 转写正文'));
    if (scenario.capability === 'video') {
      const relatedFrames = cli(['media', 'frames', ...rootArgs, '--input', JSON.stringify({
        ...framesInput, video_path: undefined, artifact_id: artifact.id
      })]);
      assert.equal(relatedFrames.artifacts.length, 3);
      for (const [index, frame] of relatedFrames.artifacts.entries()) {
        assert.deepEqual(frame.relations, [{ type: 'frame-of', artifactId: artifact.id }]);
        await verifyArtifact(frame, 'artifact-frame-' + index);
      }
    }
    report.tasks.push({ id: result.task.id, capability: scenario.capability, artifactIds: result.task.artifactIds, attempts: 1, polls: scenario.polls });
  }
  const counters = state();
  assert.equal(counters.submit, 3);
  assert.equal(counters.tts, 1);
  assert.equal(counters.poll, 7);
  assert.equal(counters.download, 2);
  assert.equal(counters.uploadPolicy, 1);
  assert.equal(counters.uploadFile, 1);
  report.providerCalls = { submit: counters.submit, tts: counters.tts, poll: counters.poll,
    download: counters.download, uploadPolicy: counters.uploadPolicy, uploadFile: counters.uploadFile, allMocked: true };

  console.log('5/5 跨进程只读检查、零写入/零网络、配置与导出保护');
  const beforeRead = snapshot(dataRoot);
  const beforeNetwork = state();
  const configBefore = digest(fs.readFileSync(configFile));
  assert.equal(cli(['task', 'list', ...rootArgs]).total, scenarios.length);
  assert.equal(cli(['artifact', 'list', ...rootArgs]).total, artifacts.size);
  cli(['providers', 'list', '--provider-config', configFile]);
  cli(['capabilities', 'list', '--provider-config', configFile]);
  const doctor = cli(['doctor', ...rootArgs, '--json']);
  assert.equal(doctor.exitCode, 0);
  const protectedExport = report.artifacts[0];
  cli(['artifact', 'export', protectedExport.id, ...rootArgs, '--output', protectedExport.output], {
    status: 1, json: false, errorCode: 'IRIS_ARTIFACT_EXPORT_EXISTS'
  });
  assert.equal(digest(fs.readFileSync(protectedExport.output)), protectedExport.sha256);
  cli(['run', 'image', ...rootArgs, '--provider-config', configFile,
    '--input', JSON.stringify({ prompt: 'rejected', n: 0 })], {
    status: 2, json: false, errorCode: 'IRIS_CLI_USAGE'
  });
  assert.deepEqual(snapshot(dataRoot), beforeRead);
  assert.deepEqual(state(), beforeNetwork);
  assert.equal(digest(fs.readFileSync(configFile)), configBefore, '只读配置查询不得迁移或改写配置');
  for (const file of Object.keys(beforeRead).filter((file) => file.endsWith('.json'))) {
    const content = fs.readFileSync(path.join(dataRoot, file), 'utf8');
    assert(!content.includes('fixture-key-package') && !content.includes('package image fixture')
      && !content.includes('package video fixture') && !content.includes('package tts fixture')
      && !content.includes('oss://'), 'Core 不得持久化凭据、生成输入或签名地址');
  }
  console.log('补验开发版 CLI 六项：S2V、HTML、配置、wait、批量、隔离/恢复');
  const completionRoot = path.join(work, 'completion-core'), completionConfig = path.join(work, 'completion-providers.json');
  const completionRootArgs = ['--data-root', completionRoot], completionConfigArgs = ['--provider-config', completionConfig];
  cli(['config', 'init', ...completionConfigArgs]);
  const completionProviderInput = path.join(inputs, 'completion-provider.json');
  fs.writeFileSync(completionProviderInput, JSON.stringify({ id: 'completion', apiKey: 'fixture-key-package', type: 'openai', mediaProtocol: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [
      { id: 'wan2.2-s2v', capabilities: ['video-gen'] }, { id: 'qwen3-tts-flash', capabilities: ['tts'] }
    ] }), { mode: 0o600 });
  cli(['providers', 'add', ...completionConfigArgs, '--input-file', completionProviderInput]);
  cli(['models', 'add', 'completion::qwen3-vl-flash', ...completionConfigArgs, '--input', '{"capabilities":["vision"]}']);
  cli(['models', 'caps', 'completion::qwen3-vl-flash', ...completionConfigArgs, '--input', '{"capabilities":["vision"]}']);
  cli(['assignments', 'set', ...completionConfigArgs, '--input', '{"capability":"video-gen","model_refs":["completion::wan2.2-s2v"]}']);
  assert.equal(cli(['config', 'check', ...completionConfigArgs]).valid, true);
  assert.equal(cli(['models', 'list', ...completionConfigArgs]).models.length, 3);
  const s2vBefore = state();
  const s2v = cli(['run', 'video', ...completionRootArgs, ...completionConfigArgs, '--input', JSON.stringify({ first_frame_path: path.join(inputs, 'image-0.png'), audio_path: audioPath })]);
  assert.equal(s2v.task.modelRef, 'completion::wan2.2-s2v');
  const s2vReady = cli(['task', 'wait', s2v.taskId, ...completionRootArgs, ...completionConfigArgs, '--timeout-ms', '5000', '--poll-interval-ms', '50']);
  assert.equal(s2vReady.ready, true); assert.equal(s2vReady.task.attempts.length, 1);
  assert.equal(state().submit, s2vBefore.submit + 1); assert.equal(state().uploadFile, s2vBefore.uploadFile + 2);
  const readyBefore = state(); cli(['task', 'wait', s2v.taskId, ...completionRootArgs]); assert.deepEqual(state(), readyBefore);
  assert.equal(cli(['task', 'list', ...completionRootArgs, '--capability', 'video', '--limit', '1']).total, 1);
  const s2vArtifact = s2vReady.task.artifactIds[0];
  assert.equal(cli(['artifact', 'list', ...completionRootArgs, '--kind', 'generated-video']).total, 1);
  const bulkDirectory = path.join(work, 'bulk-exports'); fs.mkdirSync(bulkDirectory);
  const bulkInput = path.join(inputs, 'bulk.json'); fs.writeFileSync(bulkInput, JSON.stringify({ artifact_ids: [s2vArtifact] }));
  cli(['artifact', 'inspect-many', ...completionRootArgs, '--input-file', bulkInput]);
  const bulk = cli(['artifact', 'export-many', ...completionRootArgs, '--input-file', bulkInput, '--output', bulkDirectory]);
  assert.equal(bulk.results[0].exported, true);
  const s2vMediaHash = digest(fs.readFileSync(path.join(bulkDirectory, s2vArtifact + '.mp4')));
  assert.equal(s2vMediaHash, bulk.results[0].artifact.digest.value);
  const deletionSelection = { task_ids: [s2v.taskId], artifact_ids: [s2vArtifact] };
  assert.equal(cli(['core', 'delete', ...completionRootArgs, '--input', JSON.stringify(deletionSelection)]).preview, true);
  const isolated = cli(['core', 'delete', ...completionRootArgs, '--input', JSON.stringify(deletionSelection), '--confirm-delete']);
  assert.equal(cli(['artifact', 'list', ...completionRootArgs]).total, 0);
  cli(['core', 'transactions', ...completionRootArgs]); cli(['core', 'restore', isolated.transactionId, ...completionRootArgs]);
  assert.equal(cli(['artifact', 'inspect', s2vArtifact, ...completionRootArgs]).artifact.digest.value, s2vMediaHash);
  const cleanup = cli(['core', 'cleanup', ...completionRootArgs]); assert.equal(cleanup.candidates.length, 0);
  const testedTts = cli(['models', 'test', 'completion::qwen3-tts-flash', ...completionConfigArgs, ...completionRootArgs, '--capability', 'tts']);
  assert.equal(testedTts.passed, true); assert(testedTts.taskId);
  cli(['config', 'show', ...completionConfigArgs]);
  let htmlArtifact;
  if (process.env.IRIS_TEST_BROWSER_EXECUTABLE) {
    const rendered = cli(['media', 'html', ...completionRootArgs, '--browser-executable', process.env.IRIS_TEST_BROWSER_EXECUTABLE,
      '--browser-no-sandbox', String(process.env.IRIS_TEST_BROWSER_NO_SANDBOX === 'true'), '--input', '{"html":"<style>body{margin:0;background:red}</style>","width":320,"height":200,"full_page":false}',
      '--output', path.join(work, 'completion-html.png')]);
    assert.deepEqual(rendered.artifact.metadata, { width: 320, height: 200 }); htmlArtifact = rendered.artifact.id;
  }
  report.cliCompletion = { s2vTaskId: s2v.taskId, s2vSubmits: 1, s2vUploads: 2, waitNoResubmit: true, bulkExportHash: s2vMediaHash,
    configurationPrivateBackups: true, filtering: true, quarantineRestored: true, cleanupReadOnly: true, ttsProbeTaskId: testedTts.taskId,
    htmlRealBrowser: Boolean(htmlArtifact), ...(htmlArtifact ? { htmlArtifactId: htmlArtifact } : {}) };
  assert(!fs.existsSync(unusedDsh));
  report.checks = {
    installedFileBytesMatchSource: true, npmBinWorks: true, localSharpAndFfmpeg: true,
    artifactExportBytesAndManifestHashesMatch: true, readersZeroCoreWritesAndProviderCalls: true,
    explicitObserveNoResubmit: true, providerConfigUnchanged: true,
    noDshHomeCreated: !fs.existsSync(unusedDsh), exportNoOverwrite: true, invalidInputZeroSubmit: true
  };
  report.status = 'passed';
  saveReport();
  console.log(`PASS —— 包外无 DSH：${report.tasks.length} 类生成、${report.artifacts.length} 份产物校验，${report.package.fileCount} 个包文件`);
  console.log('验收报告：' + reportFile);
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message };
  saveReport();
  console.error(error.message);
  console.error('失败证据保留：' + reportFile);
  process.exitCode = 1;
}
