import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ffmpegAvailable } from '../lib/media-probe.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-vision-cli-'));
const image = path.join(work, 'red.png'), screenshot = path.join(work, 'long.png'), video = path.join(work, 'video.mp4');
const config = path.join(work, 'providers.json'), stateFile = path.join(work, 'state.json'), dataRoot = path.join(work, 'core');
const dshHome = path.join(work, 'unused-dsh'), output = path.join(work, 'result.json'), sheet = path.join(work, 'sheet.png');
const provider = (id, models) => ({ id, enabled: true, type: 'openai', baseUrl: 'https://' + id + '.invalid/compatible-mode/v1',
  mediaProtocol: 'dashscope', mediaBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: 'fixture-key', models: models.map(id => ({ id, capabilities: [id === 'asr' ? 'transcribe' : 'vision'] })) });
const catalog = { providers: [provider('first', ['backup', 'selected', 'asr']), provider('second', ['selected'])], assignments: { vision: ['first::selected'] } };
fs.writeFileSync(config, JSON.stringify(catalog), { mode: 0o600 });
const configBefore = fs.readFileSync(config);
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const reset = extra => fs.writeFileSync(stateFile, JSON.stringify({ submit: 0, poll: 0, download: 0, tasks: {}, ...extra }), { mode: 0o600 });
let checks = 0;
function cli(command, input, flags = [], expected = 0) {
  const args = ['bin/dsh-iris.js', 'vision', command, '--provider-config', config, '--input', JSON.stringify(input), ...flags];
  const run = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 15000, shell: false,
    env: { ...process.env, DSH_HOME: dshHome, NODE_OPTIONS: '--import=' + pathToFileURL(path.join(repo, 'tests/fixtures/headless-vision-fetch.mjs')).href,
      IRIS_ASYNC_FIXTURE_STATE: stateFile } });
  assert(!run.error, run.error?.message); assert.equal(run.status, expected, run.stderr + '\n' + run.stdout);
  assert(!run.stdout.includes('fixture-key') && !run.stderr.includes('fixture-key'));
  assert(!run.stdout.includes(work) && !run.stderr.includes(work));
  assert(!fs.existsSync(dshHome)); assert.deepEqual(fs.readFileSync(config), configBefore);
  assert(!fs.existsSync(path.join(dataRoot, '.iris-runtime-writer-v0')));
  checks++; return run;
}
const json = (...args) => JSON.parse(cli(...args).stdout);
try {
  await sharp({ create: { width: 40, height: 30, channels: 3, background: 'red' } }).png().toFile(image);
  await sharp({ create: { width: 40, height: 200, channels: 3, background: 'white' } }).png().toFile(screenshot);
  reset();
  const look = json('look', { image_path: image });
  assert.equal(look.modelRef, 'first::selected'); assert.equal(look.selectionReason, 'assignment');
  assert.equal(look.text, '图片是红色的。'); assert.equal(state().vision.length, 1);
  assert.equal(state().vision[0].imageSha256, createHash('sha256').update(fs.readFileSync(image)).digest('hex'));
  assert(!fs.existsSync(dataRoot));

  reset({ modes: { selected: 'auth' } });
  const fallback = json('look', { image_path: image });
  assert.equal(fallback.modelRef, 'first::backup'); assert.equal(fallback.selectionReason, 'pool');
  assert.deepEqual(state().vision.map(value => value.model), ['selected', 'backup']);
  reset({ modes: { selected: 'rate' } });
  assert(cli('look', { image_path: image }, ['--model-ref', 'first::selected'], 1).stderr.includes('IRIS_MODEL_RATE_LIMITED'));
  assert.equal(state().vision.length, 1);
  reset();
  assert.equal(json('look', { image_path: image }, ['--model-ref', 'second::selected']).modelRef, 'second::selected');
  assert.equal(state().vision[0].provider, 'second.invalid');
  reset();
  cli('look', { image_path: image }, ['--model-ref', 'missing::selected'], 1); assert(!state().vision);
  cli('look', { image_path: image }, ['--model-ref', 'selected'], 1); assert(!state().vision);
  cli('locate', { image_path: image, target: ' ' }, [], 1); assert(!state().vision);
  cli('look', { image_path: 'relative.png' }, [], 1); assert(!state().vision);
  cli('ocr', { image_path: image, max_invocations: 0 }, [], 1); assert(!state().vision);
  cli('look', { image_path: image }, ['--format', 'csv'], 2); assert(!state().vision);
  cli('look', { image_path: image }, ['--timeout-ms', '0'], 1); assert(!state().vision);

  reset();
  const located = json('locate', { image_path: image, target: '红色区域' }, ['--model-ref', 'first::selected']);
  assert.deepEqual(located.bbox, { found: true, x1: 1, y1: 2, x2: 20, y2: 25 });
  assert.equal(located.width, 40); assert.equal(located.selectionReason, 'explicit');
  reset({ responses: ['{"found":false}'] });
  assert.deepEqual(json('locate', { image_path: image, target: '蓝色区域' }).bbox, { found: false });
  reset({ responses: ['secret fixture-key malformed bbox'] });
  assert(cli('locate', { image_path: image, target: '红色区域' }, [], 1).stderr.includes('IRIS_MODEL_PROTOCOL_INVALID'));
  assert.equal(state().vision.length, 1);

  reset({ responses: ['IRIS 427', 'GREEN 913'] });
  const ocr = json('ocr', { image_path: screenshot, chunk_height: 100, overlap: 0 });
  assert.equal(ocr.status, 'complete'); assert.equal(ocr.totalChunks, 2); assert.equal(ocr.invocations, 2);
  assert(ocr.fullText.includes('IRIS 427') && ocr.fullText.includes('GREEN 913'));
  assert(ocr.chunks.every(chunk => chunk.modelRef === 'first::selected'));
  reset();
  const partial = json('ocr', { image_path: screenshot, chunk_height: 100, overlap: 0, max_invocations: 1 }, [], 1);
  assert.equal(partial.status, 'partial'); assert.equal(partial.skippedChunks, 1); assert.equal(state().vision.length, 1);
  reset({ modes: { selected: 'auth', backup: 'auth' } });
  const failed = json('ocr', { image_path: image }, ['--model-ref', 'first::selected'], 1);
  assert.equal(failed.status, 'failed'); assert.equal(failed.successfulChunks, 0);

  reset();
  assert.equal(cli('look', { image_path: image }, ['--format', 'text', '--output', path.join(work, 'answer.txt')]).stdout, '图片是红色的。\n');
  assert.equal(fs.readFileSync(path.join(work, 'answer.txt'), 'utf8'), '图片是红色的。\n');
  reset();
  const answerPath = path.join(work, 'answer.txt'), oldAnswer = fs.readFileSync(answerPath);
  cli('look', { image_path: image }, ['--output', answerPath], 2); assert(!state().vision); assert.deepEqual(fs.readFileSync(answerPath), oldAnswer);

  if (ffmpegAvailable()) {
    const makeVideo = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=96x64:d=1:r=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
    assert.ifError(makeVideo.error);
    assert.equal(makeVideo.status, 0, makeVideo.stderr || makeVideo.signal);
    reset();
    cli('summarize', { video_path: video, transcribe_model_ref: 'first::asr' }, [], 1); assert(!state().vision);
    const summary = json('summarize', { video_path: video, max_frames: 3 }, ['--output', output, '--sheet-output', sheet]);
    assert.equal(summary.transcription.status, 'disabled'); assert.equal(summary.frames.length, 3); assert.equal(state().submit, 0);
    assert.equal(state().vision.length, 1); assert.deepEqual(JSON.parse(fs.readFileSync(output)), summary);
    const sheetHash = createHash('sha256').update(fs.readFileSync(sheet)).digest('hex');
    assert.equal(sheetHash, summary.contactSheet.sha256); assert.equal(sheetHash, state().vision[0].imageSha256);
    assert(!fs.existsSync(dataRoot));
    reset();
    cli('summarize', { video_path: video }, ['--output', path.join(work, 'same'), '--sheet-output', path.join(work, 'same')], 2); assert(!state().vision);
    reset();
    json('summarize', { video_path: video, max_frames: 2, transcribe_text: '用户提供的音轨' });
    assert(state().vision[0].prompt.includes('用户提供的音轨')); assert.equal(state().submit, 0);

    reset();
    const audioSummary = json('summarize', { video_path: video, max_frames: 2, transcribe: true, transcribe_model_ref: 'first::asr' }, ['--data-root', dataRoot]);
    assert.equal(audioSummary.transcription.status, 'complete'); assert.equal(state().submit, 1); assert.equal(state().poll, 2);
    assert(state().vision[0].prompt.includes('fixture 转写正文')); assert(audioSummary.text.includes('音轨已结合'));
    const taskFile = path.join(dataRoot, 'task-store/v0/tasks', audioSummary.transcription.taskId + '.json');
    const task = JSON.parse(fs.readFileSync(taskFile)); assert.equal(task.attempts.length, 1); assert.equal(task.modelRef, 'first::asr');
    assert.equal(task.deliveryState, 'ready'); assert.equal(task.artifactIds.length, 1);
    reset({ asrFail: true });
    const degraded = json('summarize', { video_path: video, max_frames: 2, transcribe: true }, ['--data-root', dataRoot]);
    assert.equal(degraded.transcription.status, 'failed'); assert.equal(state().submit, 1); assert.equal(state().vision.length, 1);
    reset({ asrHang: true });
    assert(cli('summarize', { video_path: video, max_frames: 2, transcribe: true }, ['--data-root', dataRoot, '--timeout-ms', '3500'], 1).stderr.includes('IRIS_MODEL_TIMEOUT'));
    assert(state().asrAborted); assert.equal(state().submit, 1); assert(!state().vision);
  } else {
    console.log('SKIP —— ffmpeg/ffprobe 不可用，仅跳过视觉 CLI 的真实视频摘要/音轨转写；看图、定位、OCR、输出与取消继续验证');
  }

  for (const mode of ['length', 'unknown']) {
    reset({ mode });
    const result = cli('look', { image_path: image }, [], 1);
    assert(result.stderr.includes(mode === 'length' ? 'IRIS_MODEL_OUTPUT_LIMIT' : 'IRIS_MODEL_PROTOCOL_INVALID'), result.stderr);
    assert.equal(state().vision.length, 1); assert.equal(result.stdout, '');
  }
  reset({ mode: 'hang' });
  assert(cli('look', { image_path: image }, ['--timeout-ms', '100'], 1).stderr.includes('IRIS_MODEL_TIMEOUT'));
  assert(state().visionAborted); assert.equal(state().vision.length, 1);
  if (process.platform !== 'win32') {
    reset({ mode: 'sigint' });
    assert.equal(cli('look', { image_path: image }, [], 130).stdout, ''); assert(state().visionAborted);
  } else {
    console.log('SKIP —— Windows 不运行 POSIX SIGINT 自发信号；模型超时中断仍验证');
  }
  console.log(`ALL OK —— 视觉 CLI ${checks} 次实际子进程通过，条件跳过项已单独列出`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
