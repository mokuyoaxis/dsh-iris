/**
 * TTS 迁移 Core 后的 failover 验收（E2：同步完成型单 Task 多 Attempt → 一次交付）。
 * 运行：node tests/tts-task-v2.mjs
 *
 * 语义差说明（相对 legacy）：legacy 是"单 Task 多 Attempt + 每次尝试独立交付到
 * outputs/"；Core 是"单 Task 多 Attempt + 一次 Core Artifact 交付"。候选链共用
 * 一个 voice（Core providerInput 静态）。写前 Attempt、429 明确未受理 failover、
 * 零 legacy 双写、不落 API Key 的真值表语义全部保留。
 */
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-tts-task-v2');
const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};
const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const tasks = await import('../lib/tasks.js');
const { runAction } = await import('../lib/actions.js');
const { dshCoreDataRoot, inspectProviderTaskForDsh } = await import('../lib/dsh-core-adapter.js');
const { inspectCoreArtifact, readCoreArtifactBytes } = await import('../lib/core-artifacts.js');
const { createCoreRuntime } = await import('../lib/core-runtime.js');

const first = config.upsert({
  name: 'tts-reject', apiKey: 'tts-first-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'qwen-tts-latest', capabilities: ['tts'] }]
});
const second = config.upsert({
  name: 'tts-accept', apiKey: 'tts-second-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true,
  models: [{ id: 'qwen3-tts-flash', capabilities: ['tts'] }]
});
config.setAssignmentOrder('tts', [
  models.modelRef(first.id, 'qwen-tts-latest'),
  models.modelRef(second.id, 'qwen3-tts-flash')
]);

const AUDIO = Buffer.from('fake-tts-audio-bytes');
const taskStoreDir = () => path.join(dshCoreDataRoot(), 'task-store', 'v0', 'tasks');
function coreRecords() {
  try {
    return fs.readdirSync(taskStoreDir()).map((name) => fs.readFileSync(path.join(taskStoreDir(), name), 'utf8'));
  } catch (_) {
    return [];
  }
}

const originalFetch = global.fetch;
let calls = 0;
let writeAhead = 0;
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.includes('/multimodal-generation/generation')) throw new Error('unexpected fetch: ' + url);
  calls++;
  const records = coreRecords();
  const current = records.length ? JSON.parse(records[0]).attempts?.at(-1) : undefined;
  if (current?.acceptance === 'none' && current?.stage === 'submitting') writeAhead++;
  const auth = init.headers && (init.headers.Authorization || init.headers.authorization);
  if (auth === 'Bearer tts-first-secret') {
    return new Response(JSON.stringify({ code: 'Throttling', message: 'not accepted' }), {
      status: 429, headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ output: { audio: { data: AUDIO.toString('base64') } } }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};

try {
  const legacyBefore = tasks.all().length;
  const action = await runAction({}, 'tts', { text: '你好', voice: 'Cherry' });
  assert(calls === 2 && writeAhead === 2, 'TTS 每次请求前均预写 Core Attempt', { calls, writeAhead });
  assert(action.storage === 'core' && action.providerId === second.id && action.artifactIds.length === 1,
    'TTS 必须走 Core 并返回实际候选与 Artifact', action);

  const task = await inspectProviderTaskForDsh(action.taskId);
  assert(task.capability === 'tts' && task.attempts.length === 2,
    'TTS failover 只创建一个 Core Task', task);
  assert(task.attempts[0].acceptance === 'not_accepted', 'TTS 429 明确未受理');
  assert(task.attempts[1].resultKind === 'completed' && task.attempts[1].acceptance === 'accepted',
    'TTS 同步成功记录 completed', task.attempts[1]);
  assert(task.outcome === 'succeeded' && task.deliveryState === 'ready' && task.phase === 'terminal',
    'TTS 同步完成即终态（生成与交付同一次调用收口）', task);
  assert(tasks.all().length === legacyBefore, 'Core TTS 零 legacy 双写', tasks.all().length);
  assert(!fs.existsSync(path.join(config.irisHome(), 'outputs')), 'Core TTS 不得创建 legacy outputs');

  const runtime = createCoreRuntime({ dataRoot: dshCoreDataRoot(), mode: 'reader' });
  runtime.start();
  const artifact = await runtime.run('inspect', ({ dataRoot }) => inspectCoreArtifact(dataRoot, task.artifactIds[0]));
  const bytes = await runtime.run('inspect', ({ dataRoot }) => readCoreArtifactBytes(dataRoot, artifact.id));
  await runtime.dispose();
  assert(artifact.kind === 'generated-audio' && artifact.mediaType === 'audio/mpeg'
      && artifact.metadata?.capability === 'tts' && bytes.bytes.equals(AUDIO),
    'TTS Artifact 必须是 generated-audio 且字节与响应一致', artifact);
  for (const record of coreRecords()) {
    assert(!record.includes('tts-first-secret') && !record.includes('tts-second-secret'),
      'Core TTS Task 不持久化 API Key');
  }
} finally {
  global.fetch = originalFetch;
}

console.log('ALL OK —— TTS 迁移 Core：写前 Attempt、429 failover、同步交付 generated-audio、零 legacy 双写');
