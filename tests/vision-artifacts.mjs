import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCoreArtifact, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { createCommandService } from '../lib/command-service.js';
import { readVisionArtifact } from '../lib/vision-input.js';
import { VISION_BUDGET } from '../lib/vision-core.js';

const { root } = useTempDshHome('iris-vision-artifacts');
const repo = fileURLToPath(new URL('../', import.meta.url));
const config = await import('../lib/config.js');
const iris = await import('../lib/index.js');
const { runAction } = await import('../lib/actions.js');
const { dshCoreDataRoot, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const dataRoot = dshCoreDataRoot(), providerFile = path.join(root, 'providers.json'), stateFile = path.join(root, 'state.json');
const hash = value => createHash('sha256').update(value).digest('hex');
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const file = path.join(directory, entry.name);
    return [entry.name, entry.isDirectory() ? snapshot(file) : { hash: hash(fs.readFileSync(file)), mtime: fs.statSync(file).mtimeMs }];
  }));
}
const provider = config.upsert({ enabled: true, type: 'openai', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1',
  models: [{ id: 'vision', capabilities: ['vision'] }], visionModel: 'vision' });
fs.writeFileSync(providerFile, JSON.stringify({ providers: [provider], assignments: { vision: [provider.id + '::vision'] } }), { mode: 0o600 });
const configBefore = fs.readFileSync(providerFile);
const reset = extra => fs.writeFileSync(stateFile, JSON.stringify({ submit: 0, poll: 0, download: 0, tasks: {}, ...extra }));
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
let checks = 0;
function cli(command, input, flags = [], expected = 0) {
  const result = spawnSync(process.execPath, ['bin/dsh-iris.js', 'vision', command, '--provider-config', providerFile,
    '--input', JSON.stringify(input), ...flags], { cwd: repo, encoding: 'utf8', timeout: 15000, shell: false,
    env: { ...process.env, DSH_HOME: path.join(root, 'unused-dsh'),
      NODE_OPTIONS: '--import=' + pathToFileURL(path.join(repo, 'tests/fixtures/headless-vision-fetch.mjs')).href,
      IRIS_ASYNC_FIXTURE_STATE: stateFile } });
  assert.ifError(result.error); assert.equal(result.status, expected, result.stderr + result.stdout);
  assert(!result.stdout.includes(root) && !result.stderr.includes(root));
  assert(!result.stdout.includes('fixture-key') && !result.stderr.includes('fixture-key'));
  assert(!fs.existsSync(path.join(root, 'unused-dsh'))); assert.deepEqual(fs.readFileSync(providerFile), configBefore);
  checks++; return result;
}
const rootArgs = ['--data-root', dataRoot];
const writer = createCoreRuntime({ dataRoot, mode: 'writer' }); writer.start();
const create = input => writer.run('execute', ({ dataRoot }) => createCoreArtifact(dataRoot, input));
const bytes = await sharp({ create: { width: 128, height: 300, channels: 3, background: 'red' } }).png().toBuffer();
const file = path.join(root, 'original.png'); fs.writeFileSync(file, bytes);
const definitions = new Map(), disposers = [], saved = new Map();
let sessionReads = 0, imageReads = 0;
const ctx = { get: name => ({
  tools: { register(def) { definitions.set(def.name, def); return () => {}; } },
  attachments: { async saveImage(input) {
    const ref = { attachmentId: 'saved-' + saved.size, mediaType: input.mediaType };
    saved.set(ref.attachmentId, Buffer.from(input.data)); return ref;
  }, async readImage(ref) { imageReads++; return { data: ref.attachmentId === 'session-source' ? bytes : saved.get(ref.attachmentId), mediaType: 'image/png' }; } },
  sessionQuery: { async readSession() { sessionReads++; return { events: [{ type: 'image', attachment: { attachmentId: 'session-source', mediaType: 'image/png' } }] }; } }
})[name], inject() {}, effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); } };
const originalFetch = globalThis.fetch;
const requests = [];
let hanging = false, activeSignal;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body), content = body.messages[0].content;
  const prompt = content[0].text, url = content[1].image_url.url;
  requests.push({ prompt, image: Buffer.from(url.split(',')[1], 'base64'), mediaType: url.slice(5, url.indexOf(';')) });
  if (hanging) {
    activeSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }
  const text = prompt.includes('只返回一个 JSON 对象') ? '{"x1":1,"y1":2,"x2":20,"y2":25}' : 'fixture 完整文字';
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
    + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
try {
  const original = await create({ bytes, mediaType: 'image/png', kind: 'generated-image', metadata: { width: 1, height: 1 } });
  const commands = createCommandService(writer, { browser: { async renderHtml() { return { bytes, mediaType: 'image/png' }; } } });
  const cropped = (await commands.execute('crop', { artifact_id: original.id, left: 0, top: 0, width: 128, height: 200 })).artifact;
  const html = (await commands.execute('media.html', { html: '<p>IRIS 427</p>' })).artifact;
  const images = [original, cropped, html];
  for (const format of ['jpeg', 'webp', 'gif']) {
    const converted = await sharp(bytes).toFormat(format).toBuffer();
    images.push(await create({ bytes: converted, mediaType: 'image/' + format, kind: 'host-input', metadata: {} }));
  }
  const nonImage = await create({ bytes: Buffer.from('transcript'), mediaType: 'text/plain', kind: 'transcript', metadata: {} });
  const oversized = await create({ bytes: Buffer.alloc(VISION_BUDGET.maxImageBytes + 1, 1), mediaType: 'image/png', kind: 'host-input', metadata: {} });
  const corrupt = await create({ bytes, mediaType: 'image/png', kind: 'generated-image', metadata: {} });
  fs.writeFileSync(path.join(dataRoot, 'artifact-store/v0/objects', corrupt.id + '.png'), Buffer.alloc(corrupt.size));
  fs.renameSync(file, file + '.unavailable');
  const before = snapshot(dataRoot);
  reset();
  const output = path.join(root, 'look.json');
  const looked = JSON.parse(cli('look', { artifact_id: original.id }, [...rootArgs, '--model-ref', provider.id + '::vision', '--output', output]).stdout);
  assert.equal(looked.artifactId, original.id); assert.equal(looked.modelRef, provider.id + '::vision');
  assert.equal(looked.selectionReason, 'explicit'); assert.deepEqual(JSON.parse(fs.readFileSync(output)), looked);
  assert.equal(state().vision.length, 1); assert.equal(state().vision[0].imageSha256, hash(bytes));
  for (const artifact of images.slice(1)) {
    reset();
    const result = JSON.parse(cli('look', { artifact_id: artifact.id }, rootArgs).stdout);
    assert.equal(result.artifactId, artifact.id);
    assert.equal(state().vision[0].mediaType, artifact.mediaType);
    assert.equal(state().vision[0].imageSha256, artifact.digest.value);
  }
  reset();
  const located = JSON.parse(cli('locate', { artifact_id: original.id, target: '红色' }, rootArgs).stdout);
  assert.equal(located.artifactId, original.id); assert.equal(located.width, 128); assert.equal(located.height, 300);
  assert.deepEqual(located.bbox, { found: true, x1: 1, y1: 2, x2: 20, y2: 25 });
  assert.equal(state().vision[0].imageSha256, hash(bytes), '定位读取真实图片尺寸，不信任生成记录的尺寸提示');
  reset({ responses: ['{"found":false}'] });
  const absent = JSON.parse(cli('locate', { artifact_id: cropped.id, target: '不存在' }, rootArgs).stdout);
  assert.equal(absent.artifactId, cropped.id); assert.deepEqual(absent.bbox, { found: false });
  const ocrInput = { artifact_id: html.id, chunk_height: 100, overlap: 0 };
  reset({ responses: ['一', '二', '三'] });
  const ocr = JSON.parse(cli('ocr', ocrInput, rootArgs).stdout);
  assert.equal(ocr.artifactId, html.id); assert.equal(ocr.totalChunks, 3); assert.equal(ocr.status, 'complete');
  for (let i = 0; i < 3; i++) {
    const chunk = await sharp(bytes).extract({ left: 0, top: i * 100, width: 128, height: 100 }).png().toBuffer();
    assert.equal(state().vision[i].imageSha256, hash(chunk));
  }
  reset();
  const partial = JSON.parse(cli('ocr', { ...ocrInput, max_invocations: 1 }, rootArgs, 1).stdout);
  assert.equal(partial.artifactId, html.id); assert.equal(partial.status, 'partial'); assert.equal(state().vision.length, 1);

  for (const command of ['look', 'locate', 'ocr']) {
    for (const badInput of [{}, { artifact_id: 'bad-id' }, { artifact_id: original.id, image_path: file },
      { artifact_id: nonImage.id }, { artifact_id: corrupt.id }, { artifact_id: oversized.id }, { artifact_id: 'artifact_' + '0'.repeat(24) }]) {
      reset(); cli(command, { ...badInput, ...(command === 'locate' ? { target: '区域' } : {}) }, rootArgs, 1); assert(!state().vision);
    }
    reset(); cli(command, { artifact_id: original.id, ...(command === 'locate' ? { target: '区域' } : {}) }, [], 2); assert(!state().vision);
  }
  const missingRoot = path.join(root, 'missing-core'); reset();
  cli('look', { artifact_id: original.id }, ['--data-root', missingRoot], 1); assert(!fs.existsSync(missingRoot)); assert(!state().vision);
  reset({ mode: 'hang' });
  assert(cli('look', { artifact_id: original.id }, [...rootArgs, '--timeout-ms', '1000'], 1).stderr.includes('IRIS_MODEL_TIMEOUT'));
  assert.equal(state().visionAborted, true); assert.equal(state().vision.length, 1);
  assert.deepEqual(snapshot(dataRoot), before, '跨进程图片 reader 与另一 writer 共存，成功/失败/超时均不改 Core');

  const pre = new AbortController(); pre.abort(); let reads = 0;
  await assert.rejects(readVisionArtifact({ run() { reads++; } }, original.id, pre.signal), { code: 'IRIS_MODEL_ABORTED' });
  assert.equal(reads, 0, '预先取消不得检查/读取 Artifact');
  await iris.apply(ctx);
  const legacyBefore = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'));
  const tools = [['iris_look_at_image', 'look', {}], ['iris_locate', 'locate', { target: '红色' }],
    ['iris_long_ocr', 'ocr', { chunk_height: 100, overlap: 0 }]];
  for (const [name, action, args] of tools) {
    const input = { artifact_id: original.id, ...args }, count = requests.length, saves = saved.size;
    assert(definitions.get(name).parameters.properties.artifact_id);
    const result = await definitions.get(name).execute(input, { signal: new AbortController().signal });
    assert(result.includes('fixture') || result.includes('bbox')); assert(result.includes(original.id));
    const response = await runAction({}, action, input);
    assert(response.ok); assert.equal(response.artifactId, original.id);
    assert.equal(requests.length, count + (action === 'ocr' ? 6 : 2));
    assert.equal(saved.size, saves, '自持模型成功时，Core 图片无需额外宿主附件或临时导出');
    for (const bad of [{ artifact_id: original.id, image_path: file }, { artifact_id: nonImage.id }, { artifact_id: corrupt.id }]) {
      const beforeCalls = requests.length;
      await assert.rejects(definitions.get(name).execute({ ...bad, ...args }, {}));
      await assert.rejects(runAction({}, action, { ...bad, ...args }));
      assert.equal(requests.length, beforeCalls);
    }
    const countBeforeAbort = requests.length;
    await assert.rejects(definitions.get(name).execute(input, { signal: pre.signal }));
    await assert.rejects(runAction({}, action, input, { signal: pre.signal }));
    assert.equal(requests.length, countBeforeAbort);
  }
  assert.equal(sessionReads, 0); assert.equal(imageReads, 0, 'Core ID 不得当作会话附件 ID');
  for (const [name, args] of [['iris_locate', { target: '红色' }], ['iris_long_ocr', { chunk_height: 100, overlap: 0 }]]) {
    const beforeCalls = requests.length;
    const result = await definitions.get(name).execute({ attachment_id: 'session-source', ...args }, { agent: { session: { id: 'fixture' } } });
    assert(result.includes('bbox') || result.includes('OCR 完成'));
    assert.equal(requests.length, beforeCalls + (name === 'iris_locate' ? 1 : 3));
    await assert.rejects(definitions.get(name).execute({ attachment_id: 'session-source', artifact_id: original.id, ...args }, {}));
  }
  assert.equal(sessionReads, 2); assert.equal(imageReads, 2);
  hanging = true;
  const canceled = new AbortController();
  const pending = definitions.get('iris_long_ocr').execute({ artifact_id: original.id, chunk_height: 100, overlap: 0 }, { signal: canceled.signal });
  pending.catch(() => {});
  const deadline = performance.now() + 3000;
  while (!activeSignal && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert(activeSignal); const count = requests.length; canceled.abort();
  await assert.rejects(pending, { code: 'IRIS_MODEL_ABORTED' }); assert(activeSignal.aborted); assert.equal(requests.length, count);
  hanging = false;
  assert.deepEqual(snapshot(dataRoot), before); assert.deepEqual(fs.readFileSync(path.join(config.irisHome(), 'tasks.json')), legacyBefore);
  fs.renameSync(file + '.unavailable', file);
  for (const command of ['look', 'locate', 'ocr']) {
    reset(); cli(command, { image_path: file, ...(command === 'locate' ? { target: '红色' } : {}) });
  }
  assert.deepEqual(snapshot(dataRoot), before);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, html.id).bytes, bytes);
  console.log(`ALL OK —— 图片 Artifact：${checks} 次真实 CLI，三类 DSH 工具/动作，同源字节/MIME与原像素、OCR切片/部分完成、会话附件兼容、writer 共存、错误/取消零 Core 写入`);
} finally {
  globalThis.fetch = originalFetch;
  stopProviderTaskWatchesForDsh();
  for (const dispose of disposers.reverse()) await dispose();
  await writer.dispose();
}
