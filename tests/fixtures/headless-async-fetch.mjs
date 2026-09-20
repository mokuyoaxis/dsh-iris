import fs from 'node:fs';

const stateFile = String(process.env.IRIS_ASYNC_FIXTURE_STATE || '');
if (!stateFile) throw new Error('IRIS_ASYNC_FIXTURE_STATE is required');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8XnWQAAAABJRU5ErkJggg==',
  'base64'
);

const MP4 = Buffer.from(
  'AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
  'base64'
);

const WAV = Buffer.from(
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=',
  'base64'
);

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { submit: 0, poll: 0, download: 0, tasks: {} };
    throw error;
  }
}

function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const state = readState();

  if (method === 'POST' && (url.endsWith('/services/aigc/text2image/image-synthesis')
      || url.endsWith('/services/aigc/video-generation/video-synthesis'))) {
    const body = JSON.parse(String(init.body || '{}'));
    const remoteTaskId = 'remote-' + (state.submit + 1);
    const isVideo = url.includes('video-generation');
    state.submit += 1;
    state.lastModel = body.model;
    state.submitHadAuthorization = Boolean(new Headers(init.headers).get('authorization'));
    state.tasks[remoteTaskId] = { poll: 0, ...(isVideo ? { video: true } : {}) };
    if (state.failNextSubmitAfterAcceptance) {
      state.failNextSubmitAfterAcceptance = false;
      writeState(state);
      throw new TypeError('fixture connection closed after remote acceptance');
    }
    writeState(state);
    return json({ output: { task_id: remoteTaskId } });
  }

  const taskMatch = url.match(/\/api\/v1\/tasks\/(remote-[0-9]+)$/);
  if (method === 'GET' && taskMatch) {
    const remoteTaskId = taskMatch[1];
    if (!state.tasks[remoteTaskId]) return json({ message: 'fixture task missing' }, 404);
    state.poll += 1;
    state.tasks[remoteTaskId].poll += 1;
    state.pollHadAuthorization = Boolean(new Headers(init.headers).get('authorization'));
    const count = state.tasks[remoteTaskId].poll;
    writeState(state);
    // 视频任务建模长轮询：前两拍 RUNNING，第三拍起 SUCCEEDED（产物为 mp4）。
    const readyAfter = state.tasks[remoteTaskId].video ? 3 : 2;
    if (count < readyAfter) return json({ output: { task_status: 'RUNNING' } });
    // 转写任务成功时正文走 output.text（adapter 的 pollTranscriptionTask 解析）。
    if (state.tasks[remoteTaskId].asr) {
      return json({
        output: { task_status: 'SUCCEEDED', text: 'fixture 转写正文：CLI 与 API 同一份事实。' }
      });
    }
    return json({
      output: {
        task_status: 'SUCCEEDED',
        results: [{ url: `https://artifact.invalid/${remoteTaskId}.${state.tasks[remoteTaskId].video ? 'mp4' : 'png'}` }]
      }
    });
  }

  if (method === 'GET' && /^https:\/\/artifact\.invalid\/remote-[0-9]+\.(png|mp4)$/.test(url)) {
    state.download += 1;
    if (state.failNextDownload) {
      state.failNextDownload = false;
      writeState(state);
      return json({ message: 'fixture download failed' }, 503);
    }
    writeState(state);
    const isMp4 = url.endsWith('.mp4');
    return new Response(isMp4 ? MP4 : PNG, {
      status: 200,
      headers: { 'Content-Type': isMp4 ? 'video/mp4' : 'image/png' }
    });
  }

  // 临时存储上传：策略 + 文件两段，返回 oss:// 地址（fixture 不验证内容）。
  if (method === 'GET' && /\/uploads\?/.test(url)) {
    state.uploadPolicy = (state.uploadPolicy || 0) + 1;
    writeState(state);
    return json({ data: {
      upload_dir: 'iris-fixture', upload_host: 'https://upload.invalid',
      oss_access_key_id: 'id', signature: 'sig', policy: 'policy',
      x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true'
    } });
  }
  if (method === 'POST' && url === 'https://upload.invalid') {
    state.uploadFile = (state.uploadFile || 0) + 1;
    writeState(state);
    return new Response('', { status: 200 });
  }

  // 转写上传型异步：受理 + remoteTaskId → 长轮询 → 文本正文。
  if (method === 'POST' && url.endsWith('/services/audio/asr/transcription')) {
    const body = JSON.parse(String(init.body || '{}'));
    const remoteTaskId = 'remote-' + (state.submit + 1);
    state.submit += 1;
    state.lastModel = body.model;
    state.submitHadAuthorization = Boolean(new Headers(init.headers).get('authorization'));
    state.tasks[remoteTaskId] = { poll: 0, asr: true };
    writeState(state);
    return json({ output: { task_id: remoteTaskId } });
  }

  // TTS 同步合成：直接 completed，无远端任务 ID。
  if (method === 'POST' && url.endsWith('/services/aigc/multimodal-generation/generation')) {
    const body = JSON.parse(String(init.body || '{}'));
    state.tts = (state.tts || 0) + 1;
    state.lastModel = body.model;
    state.ttsHadAuthorization = Boolean(new Headers(init.headers).get('authorization'));
    writeState(state);
    return json({ output: { audio: { data: WAV.toString('base64') } } });
  }

  throw new Error(`unexpected fixture request: ${method} ${url}`);
};
