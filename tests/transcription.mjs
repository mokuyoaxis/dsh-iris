import * as adapters from '../lib/adapters.js';
const assert = (cond, msg, extra) => {
  if (!cond) { console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra))); process.exit(1); }
};
const calls = [];
const originalFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
  if (url.includes('/services/audio/asr/transcription')) return new Response(JSON.stringify({ output: { task_id: 'asr-task' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/tasks/')) return new Response(JSON.stringify({ output: { task_status: 'SUCCEEDED', results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'https://result.invalid/transcript.json' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://result.invalid/transcript.json') return new Response(JSON.stringify({ transcripts: [{ sentences: [{ text: '你好，' }, { text: 'Iris。' }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  throw new Error('unexpected fetch: ' + url);
};
try {
  await adapters.submitTranscription({ key: 'k', model: 'qwen-audio-3.0-asr-flash-filetrans', audioUrl: 'oss://bucket/audio.wav' });
  let call = calls.at(-1);
  assert(call.body.input.file_urls[0] === 'oss://bucket/audio.wav', 'Qwen-Audio Filetrans 使用 file_urls', call.body);
  assert(call.init.headers['X-DashScope-OssResourceResolve'] === 'enable', 'oss:// 转写启用资源解析头');
  await adapters.submitTranscription({ key: 'k', model: 'qwen3-asr-flash-filetrans', audioUrl: 'https://example.invalid/audio.wav' });
  call = calls.at(-1);
  assert(call.body.input.file_url === 'https://example.invalid/audio.wav', 'Qwen3 Filetrans 使用 file_url', call.body);
  const result = await adapters.pollTranscriptionTask({ key: 'k', remoteTaskId: 'asr-task' });
  assert(result.done && result.ok && result.text === '你好，Iris。', '轮询下载 transcription_url 并提取正文', result);
  assert(adapters.transcriptionText({ transcripts: [{ text: '第一段' }, { sentences: [{ text: '第二段' }] }] }) === '第一段\n第二段', '正文提取兼容两种结构');
} finally { global.fetch = originalFetch; }
console.log('ALL OK —— ASR file_url(s) 提交 + OSS 解析 + transcription_url 正文提取通过');
