/** 子进程/包外验收 fixture：不导入 Iris 或 DSH，绝不访问真实网络。 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import './headless-async-fetch.mjs';

const providerFetch = globalThis.fetch;
const stateFile = process.env.IRIS_ASYNC_FIXTURE_STATE;
const read = () => ({ submit: 0, poll: 0, download: 0, tasks: {}, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) });
const write = state => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

globalThis.fetch = async (input, options = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const state = read();
  if (state.asrHang && /\/tasks\//.test(url)) {
    state.poll++; write(state);
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
      const current = read(); current.asrAborted = true; write(current); reject(options.signal.reason);
    }, { once: true }));
  }
  if (state.asrFail && url.endsWith('/services/audio/asr/transcription')) {
    state.submit++; write(state);
    return new Response('secret fixture-key https://private.invalid/input', { status: 400 });
  }
  if (!url.endsWith('/chat/completions')) return providerFetch(input, options);
  const body = JSON.parse(options.body), content = body.messages.find(value => value.role === 'user').content;
  const prompt = content.find(value => value.type === 'text').text;
  const dataUrl = content.find(value => value.type === 'image_url').image_url.url;
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  state.vision ||= [];
  const index = state.vision.length;
  state.vision.push({ model: body.model, provider: new URL(url).hostname, prompt,
    mediaType: dataUrl.slice(5, dataUrl.indexOf(';')), imageSha256: hash(bytes) });
  write(state);
  const mode = state.modes?.[body.model] || state.mode;
  if (mode === 'auth' || mode === 'rate') return new Response('secret fixture-key https://private.invalid/input', { status: mode === 'auth' ? 401 : 429 });
  if (mode === 'hang' || mode === 'sigint') {
    if (mode === 'sigint') setTimeout(() => process.kill(process.pid, 'SIGINT'), 25);
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
      const current = read(); current.visionAborted = true; write(current); reject(options.signal.reason);
    }, { once: true }));
  }
  const dimensions = await sharp(bytes).metadata();
  const bbox = prompt.includes('0–1000 归一化坐标')
    ? JSON.stringify({ x1: 1000 / dimensions.width, y1: 2000 / dimensions.height, x2: 20000 / dimensions.width, y2: 25000 / dimensions.height })
    : '{"x1":1,"y1":2,"x2":20,"y2":25}';
  const text = state.responses?.[index] ?? (prompt.includes('只返回一个 JSON 对象') ? bbox
    : prompt.includes('完整读出图片') ? 'IRIS 427' : prompt.includes('关键帧') || prompt.includes('转写文本') ? '视频摘要：' + (prompt.includes('fixture 转写正文') ? '音轨已结合。' : '红色画面。') : '图片是红色的。');
  const finish = mode === 'length' ? 'length' : mode === 'unknown' ? 'provider_unknown' : 'stop';
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
};
