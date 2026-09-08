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

const originalFetch = global.fetch;
let calls = 0;
let writeAhead = 0;
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.includes('/multimodal-generation/generation')) throw new Error('unexpected fetch: ' + url);
  calls++;
  const disk = JSON.parse(fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8'));
  const current = disk.tasks.at(-1)?.attempts?.at(-1);
  if (current?.acceptance === 'none' && current?.stage === 'submit') writeAhead++;
  const auth = init.headers && init.headers.Authorization;
  if (auth === 'Bearer tts-first-secret') {
    return new Response(JSON.stringify({ code: 'Throttling', message: 'not accepted' }), {
      status: 429, headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ output: { audio: { data: Buffer.from('fake-wav').toString('base64') } } }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};

try {
  const action = await runAction({}, 'tts', { text: '你好', voice: 'Cherry' });
  const task = tasks.get(action.taskId);
  assert(calls === 2 && writeAhead === 2, 'TTS 每次请求前均预写 Attempt', { calls, writeAhead });
  assert(tasks.all().length === 1 && task.attempts.length === 2, 'TTS failover 只创建一个 Task', task);
  assert(task.attempts[0].acceptance === 'not_accepted', 'TTS 429 明确未受理');
  assert(task.attempts[1].resultKind === 'completed' && task.attempts[1].acceptance === 'accepted', 'TTS 同步成功记录 completed');
  assert(task.outcome === 'succeeded' && task.deliveryState === 'ready' && task.status === 'succeeded', 'TTS 生成与交付收口', task);
  assert(action.providerId === second.id && task.voice === 'Cherry', 'TTS 返回实际候选与 voice');
  assert(fs.existsSync(path.join(config.irisHome(), 'outputs', task.files[0])), 'TTS 音频已落盘');
  const registry = fs.readFileSync(path.join(config.irisHome(), 'tasks.json'), 'utf8');
  assert(!registry.includes('tts-first-secret') && !registry.includes('tts-second-secret'), 'TTS Task 不持久化 API Key');
} finally {
  global.fetch = originalFetch;
}

console.log('ALL OK —— TTS 同步生成使用单 Task 多 Attempt 并独立交付');
