import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useTempDshHome } from './test-env.js';
const { root } = useTempDshHome('iris-summary-core-m4');
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP 摘要 Core 转写接线：无 ffmpeg'); process.exit(0);
}
const config = await import('../lib/config.js');
const iris = await import('../lib/index.js');
const { dshCoreDataRoot, stopProviderTaskWatchesForDsh } = await import('../lib/dsh-core-adapter.js');
const { listCoreTasks } = await import('../lib/core-tasks.js');
const { readCoreArtifactBytes } = await import('../lib/core-artifacts.js');
const provider = config.upsert({ type: 'openai', enabled: true, apiKey: 'fixture-only-secret', mediaProtocol: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [
    { id: 'vision', capabilities: ['vision'] }, { id: 'qwen-audio-3.0-asr-flash-filetrans', capabilities: ['transcribe'] }
  ] });
config.setAssignmentOrder('vision', [provider.id + '::vision']);
config.setAssignmentOrder('transcribe', [provider.id + '::qwen-audio-3.0-asr-flash-filetrans']);
const clip = path.join(root, 'audio.mp4');
const gen = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=160x100:rate=12:duration=1',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-pix_fmt', 'yuv420p', '-shortest', clip], { encoding: 'utf8' });
assert.equal(gen.status, 0, gen.stderr);
const definitions = new Map(), disposers = [];
const ctx = { get: name => ({ tools: { register(def) { definitions.set(def.name, def); return () => {}; } },
  attachments: { async saveImage(input) { return { attachmentId: 'sheet', mediaType: input.mediaType }; }, async readImage() { throw new Error('not used'); } } })[name],
  inject() {}, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); } };
const originalFetch = globalThis.fetch;
let submits = 0, visuals = 0, cancelDuringUpload = false, uploadSignal;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const transcript = 'explicit Core artifact transcript';
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url.includes('/uploads?')) {
    if (cancelDuringUpload) {
      uploadSignal = options.signal;
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    return json({ data: { upload_dir: 'fixture', upload_host: 'https://upload.invalid', oss_access_key_id: 'id',
      signature: 'sig', policy: 'policy', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } });
  }
  if (url === 'https://upload.invalid') return new Response('', { status: 200 });
  if (url.endsWith('/services/audio/asr/transcription')) { submits++; return json({ output: { task_id: 'summary-asr-1' } }); }
  if (url.endsWith('/api/v1/tasks/summary-asr-1')) return json({ output: { task_status: 'SUCCEEDED', text: transcript } });
  if (url.endsWith('/chat/completions')) {
    visuals++; const body = JSON.parse(options.body);
    assert(body.messages[0].content[0].text.includes(transcript), '摘要必须消费 Core Artifact 的转写正文');
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'red video with speech' }, finish_reason: 'stop' }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }
  throw new Error('unexpected fixture URL');
};
try {
  await iris.apply(ctx);
  const legacyBefore = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'));
  const tool = definitions.get('iris_media_summarize');
  const result = await tool.execute({ video_path: clip, max_frames: 2 }, { signal: new AbortController().signal });
  assert(result.blocks[0].text.includes('red video with speech'));
  assert.equal(submits, 1); assert.equal(visuals, 1);
  const { tasks } = listCoreTasks(dshCoreDataRoot());
  assert.equal(tasks.length, 1); assert.equal(tasks[0].capability, 'transcribe');
  assert.equal(tasks[0].attempts.length, 1); assert.equal(tasks[0].deliveryState, 'ready');
  assert.equal(readCoreArtifactBytes(dshCoreDataRoot(), tasks[0].artifactIds[0]).bytes.toString('utf8'), transcript);
  assert.deepEqual(fs.readFileSync(path.join(config.irisHome(), 'tasks.json')), legacyBefore);
  cancelDuringUpload = true;
  const canceled = new AbortController();
  const pending = tool.execute({ video_path: clip, max_frames: 2 }, { signal: canceled.signal });
  pending.catch(() => {});
  const deadline = performance.now() + 5000;
  while (!uploadSignal && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert(uploadSignal); canceled.abort();
  await assert.rejects(pending, error => error.code === 'IRIS_MODEL_ABORTED');
  assert(uploadSignal.aborted); assert.equal(visuals, 1); assert.equal(submits, 1);
} finally {
  stopProviderTaskWatchesForDsh();
  for (const dispose of disposers.reverse()) await dispose();
  globalThis.fetch = originalFetch;
}
console.log('ALL OK —— 摘要自动转写消费 Core Artifact、单次提交/视觉、零 legacy 双写及转写取消停止摘要通过');
