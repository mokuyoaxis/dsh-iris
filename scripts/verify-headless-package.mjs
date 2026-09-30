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
