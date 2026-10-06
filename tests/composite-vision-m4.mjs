import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { createDshVisionFixture } from './fixtures/vision-models.mjs';
import { locateObject } from '../lib/locate.js';
import { summarizeMedia, buildContactSheet } from '../lib/summarize.js';
import { runLocateRequest, runSummaryRequest, describeGeneratedImage } from '../lib/composite-vision-routing.js';
import { VISION_BUDGET } from '../lib/vision-core.js';
const { root } = useTempDshHome('iris-composite-m4');
const config = await import('../lib/config.js');
const { runAction } = await import('../lib/actions.js');
const iris = await import('../lib/index.js');
const source = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#ff0000' } }).png().toBuffer();
const image = { bytes: new Uint8Array(source), mediaType: 'image/png' };
const frames = [0, 1, 2].map(atSec => ({ buffer: source, width: 160, height: 100, atSec }));
const fake = steps => createFakeModelPort({ kind: 'vision', steps });
const code = value => error => error.code === value;

// bbox 解析失败后不再生成；收到不完整终态时不使用已到达的 bbox。
for (const answer of ['secret /private/image', '{"x1":"secret","y1":0,"x2":10,"y2":20}', '{broken secret}']) {
  const first = fake([{ text: answer }]), next = fake();
  await assert.rejects(locateObject([first.port, next.port], { image, target: 'button', width: 160, height: 100 }), error =>
    error.code === 'IRIS_MODEL_PROTOCOL_INVALID' && !error.message.includes('secret'));
  assert.equal(first.stats.invocations, 1); assert.equal(next.stats.invocations, 0);
}
for (const finishReason of ['length', 'unknown', 'tool-calls']) {
  const first = fake([{ text: '{"x1":1,"y1":1,"x2":40,"y2":50}', finishReason }]), next = fake();
  await assert.rejects(locateObject([first.port, next.port], { image, target: 'button', width: 160, height: 100 }));
  assert.equal(next.stats.invocations, 0);
}
const pre = new AbortController(); pre.abort();
let preparations = 0;
await assert.rejects(runLocateRequest({}, { target: ' ', prepareImage() { preparations++; return image; } }), code('IRIS_MODEL_INPUT_INVALID'));
await assert.rejects(runLocateRequest({}, { target: 'button', signal: pre.signal, prepareImage() { preparations++; return image; } }), code('IRIS_MODEL_ABORTED'));
await assert.rejects(runSummaryRequest({}, { signal: pre.signal, prepareMedia() { preparations++; return { frames }; } }), code('IRIS_MODEL_ABORTED'));
assert.equal(preparations, 0);
await assert.rejects(runSummaryRequest({}, { prepareMedia: () => new Promise(() => {}), budget: { ...VISION_BUDGET, timeoutMs: 30 } }), code('IRIS_MODEL_TIMEOUT'));

// 一张拼图只生成一次；模型与展示使用同一份拼图，时间戳标签有真实像素。
const summary = fake([{ text: 'three red frames' }]);
const result = await summarizeMedia({ ports: [summary.port], frames, question: 'content?', transcript: 'explicit words' });
assert.equal(summary.stats.invocations, 1); assert(result.text.includes('red'));
assert.deepEqual(Buffer.from(summary.calls[0].request.image.bytes), result.sheet.buffer);
assert(summary.calls[0].request.prompt.includes('explicit words'));
const pixels = await sharp(result.sheet.buffer).extract({ left: 0, top: 100, width: 160, height: 22 }).raw().toBuffer();
assert(pixels.some(value => value > 100), '时间戳文字可见，未被裁到缩略图外');
for (const finishReason of ['length', 'unknown']) {
  const first = fake([{ text: 'partial summary', finishReason }]), next = fake();
  await assert.rejects(summarizeMedia({ ports: [first.port, next.port], frames }));
  assert.equal(next.stats.invocations, 0);
}
const dsh = createDshVisionFixture({ steps: [{ text: 'actual bridge summary' }] });
const host = { ports: { attachments: dsh.attachments, textModel: { ...dsh.textModel,
  currentSelection: () => ({ provider: 'fixture', model: 'vision-v0' }),
  async resolveModelInfo() { return { provider: 'fixture', id: 'vision-v0', inputModalities: ['image'] }; } } } };
const dshSummary = await runSummaryRequest(host, { frames });
assert.equal(dsh.stats.invocations, 1); assert.deepEqual(Buffer.from(dsh.calls[0].request.image.bytes), dshSummary.sheet.buffer);
assert.equal(await describeGeneratedImage(host, { image, signal: pre.signal }), '');
assert.equal(dsh.stats.invocations, 1, '已取消的自述不得调用模型或妨碍图片交付');

// 真实动作和工具：严格 HTTP、自持成功无需 DSH 视觉服务；纯视觉不写 Task/Artifact。
const provider = config.upsert({ type: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'private-fixture-key',
  models: [{ id: 'vision', capabilities: ['vision'] }], visionModel: 'vision', enabled: true });
const file = path.join(root, 'source.png'); fs.writeFileSync(file, source);
const originalFetch = globalThis.fetch;
let received = [], finish = 'stop', text = '{"x1":10,"y1":20,"x2":50,"y2":80}', cancelSignal;
let wait = false;
const definitions = new Map(), disposers = [];
let saves = 0;
const ctx = { get: name => ({ tools: { register(def) { definitions.set(def.name, def); return () => {}; } },
  attachments: { async saveImage(input) { saves++; return { attachmentId: 'sheet', mediaType: input.mediaType }; },
    async readImage() { return { data: source, mediaType: 'image/png' }; } } })[name],
  inject() {}, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); } };
await iris.apply(ctx);
const tasksBefore = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'));
const invoke = (name, args, signal = new AbortController().signal) => definitions.get(name).execute(args, { signal, agent: { session: { id: 'fixture' } } });
const visionFetch = async (_url, options) => {
  const body = JSON.parse(options.body); received.push(body);
  if (wait) { cancelSignal = options.signal; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); }
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
};
globalThis.fetch = visionFetch;
try {
  assert((await runAction({}, 'locate', { image_path: file, target: '  button  ' })).text.includes('bbox (10,20,50,80)'));
  assert((await invoke('iris_locate', { image_path: file, target: 'button' })).includes('width=40, height=60'));
  assert(received[0].messages[0].content[0].text.includes('「button」'));
  const before = received.length;
  await assert.rejects(invoke('iris_locate', { image_path: file, target: ' ' }), code('IRIS_MODEL_INPUT_INVALID'));
  assert.equal(received.length, before);
  assert.equal(await describeGeneratedImage({}, { providers: [provider], image, originalPrompt: 'red' }), text);
  finish = 'length';
  assert.equal(await describeGeneratedImage({}, { providers: [provider], image, originalPrompt: 'red' }), '');
  finish = 'stop'; text = 'red video';
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  if (ffmpeg) {
    const clip = path.join(root, 'clip.mp4');
    const gen = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=160x100:rate=12:duration=3',
      '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' });
    assert.equal(gen.status, 0, gen.stderr);
    let before = received.length;
    const gui = await runAction({}, 'media_summarize', { video_path: clip, max_frames: 12, transcribe_text: 'explicit transcript' });
    assert(gui.ok && gui.text.includes('red video')); assert.equal(received.length, before + 1);
    assert(received.at(-1).messages[0].content[0].text.includes('explicit transcript'));
    const modelImage = received.at(-1).messages[0].content[1].image_url.url;
    assert.equal(gui.imageDataUrl, modelImage);
    const { extractFrames } = await import('../lib/media-probe.js');
    const twelve = await extractFrames({ inputPath: clip, maxFrames: 12, targetWidth: 160 });
    assert(twelve.every((f, i) => i === 0 || f.atSec > twelve[i - 1].atSec), '十帧以上仍按时间顺序排列');
    before = received.length;
    const agent = await invoke('iris_media_summarize', { video_path: clip, max_frames: 3, transcribe: false });
    assert(agent.blocks[0].text.includes('red video')); assert.equal(received.length, before + 1); assert.equal(saves, 1);
    wait = true;
    const canceled = new AbortController();
    const pending = invoke('iris_media_summarize', { video_path: clip, max_frames: 3, transcribe: false }, canceled.signal);
    pending.catch(() => {});
    const deadline = performance.now() + 5000;
    while (!cancelSignal && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
    assert(cancelSignal); canceled.abort();
    await assert.rejects(pending, code('IRIS_MODEL_ABORTED')); assert(cancelSignal.aborted); assert.equal(saves, 1);
    wait = false;
  } else console.log('SKIP 真实抽帧入口：本机无 ffmpeg');
  assert.deepEqual(fs.readFileSync(path.join(config.irisHome(), 'tasks.json')), tasksBefore);
  assert(!fs.existsSync(path.join(config.irisHome(), 'core-v0')));
  assert(!fs.existsSync(path.join(config.irisHome(), 'artifacts.json')));
} finally { globalThis.fetch = originalFetch; for (const dispose of disposers.reverse()) await dispose(); }
console.log('ALL OK —— M4 定位/摘要/自述共享端口、同图/单次拼图、空目标/格式终态/取消、时间顺序及入口零 Task 写入通过');
