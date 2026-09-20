import {
  createConfiguredProviderAdapter,
  createDashScopeProviderAdapter,
  createOpenAiImagesProviderAdapter
} from '../lib/provider-adapters.js';
import { invokeProviderOperation, providerAdapterSnapshot } from '../lib/provider-adapter.js';
import {
  assertProviderConformance,
  runProviderConformance
} from './fixtures/provider-conformance.mjs';

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

const dashSecret = 'sk-dashscope-fixture-secret';
const dashCalls = [];
const dashTransport = {
  async listModels(input) {
    dashCalls.push(['discover', input]);
    return ['wan-async', 'wan-sync', 'wan-async'];
  },
  dashscopeImageMode(model) {
    return ['wan-sync', 'report-secret'].includes(String(model)) ? 'multimodal-sync' : 'legacy-async';
  },
  async submitImage(input) {
    dashCalls.push(['submit-image', input]);
    if (input.model === 'rate-limit') {
      throw Object.assign(new Error('rate limit ' + dashSecret), { status: 429, category: 'rate_limit' });
    }
    if (input.model === 'server-error') {
      throw Object.assign(new Error('server ' + dashSecret), { status: 500, category: 'server' });
    }
    return 'dash-image-1';
  },
  async generateImageMultimodal(input) {
    dashCalls.push(['submit-image-sync', input]);
    if (input.model === 'report-secret') {
      return ['https://result.invalid/result.png?token=' + dashSecret, '/home/private/result.png'];
    }
    return ['https://result.invalid/image.png'];
  },
  async submitVideo(input) {
    dashCalls.push(['submit-video', input]);
    return 'dash-video-1';
  },
  async submitTranscription(input) {
    dashCalls.push(['submit-transcribe', input]);
    return 'dash-asr-1';
  },
  async synthesizeTts(input) {
    dashCalls.push(['submit-tts', input]);
    return { audioB64: 'YWJj', audioUrl: null };
  },
  async pollTask(input) {
    dashCalls.push(['poll-media', input]);
    if (input.remoteTaskId === 'pending') return { done: false, ok: false, status: 'RUNNING', urls: [] };
    if (input.remoteTaskId === 'canceled') return { done: true, ok: false, status: 'CANCELED', message: 'remote canceled', urls: [] };
    if (input.remoteTaskId === 'unknown') return { done: true, ok: false, status: 'UNKNOWN', message: 'unknown', urls: [] };
    if (input.remoteTaskId === 'failed') return { done: true, ok: false, status: 'FAILED', message: 'failed', urls: [] };
    return { done: true, ok: true, status: 'SUCCEEDED', urls: ['https://result.invalid/video.mp4'] };
  },
  async pollTranscriptionTask(input) {
    dashCalls.push(['poll-transcribe', input]);
    return { done: true, ok: true, status: 'SUCCEEDED', text: 'fixture transcript' };
  },
  async downloadTo(url, targetPath, options) {
    dashCalls.push(['download', { url, targetPath, ...options }]);
    return 23;
  }
};

const dashProvider = {
  id: 'dash-fixture',
  apiKey: dashSecret,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
};
const dash = createDashScopeProviderAdapter(dashProvider, { transport: dashTransport });
const dashReport = await runProviderConformance(dash, {
  secretMarkers: [dashSecret],
  cases: [
    {
      name: 'discover-dedupe',
      operation: 'discover',
      input: {},
      expect: (result) => result.models.length === 2
    },
    {
      name: 'submit-image-async',
      operation: 'submit',
      input: { capability: 'image', model: 'wan-async', input: { prompt: 'p' } },
      expect: (result) => result.kind === 'accepted' && result.remoteTaskId === 'dash-image-1'
    },
    {
      name: 'submit-image-sync',
      operation: 'submit',
      input: { capability: 'image', model: 'wan-sync', input: { prompt: 'p' } },
      expect: (result) => result.kind === 'completed' && result.value.kind === 'urls'
        && result.artifacts[0].kind === 'remote-url'
    },
    {
      name: 'submit-video',
      operation: 'submit',
      input: { capability: 'video', model: 'wan-video', input: { prompt: 'p' } },
      expect: (result) => result.kind === 'accepted' && result.remoteTaskId === 'dash-video-1'
    },
    {
      name: 'submit-transcribe',
      operation: 'submit',
      input: { capability: 'transcribe', model: 'qwen-asr', input: { audioUrl: 'oss://fixture' } },
      expect: (result) => result.kind === 'accepted' && result.remoteTaskId === 'dash-asr-1'
    },
    {
      name: 'submit-tts',
      operation: 'submit',
      input: { capability: 'tts', model: 'qwen-tts', input: { text: 'hello', voice: 'Cherry' } },
      expect: (result) => result.kind === 'completed' && result.value.audioB64 === 'YWJj'
    },
    {
      name: 'poll-pending',
      operation: 'poll',
      input: { capability: 'image', remoteTaskId: 'pending' },
      expect: (result) => result.kind === 'pending' && result.progress === 'RUNNING'
    },
    {
      name: 'poll-media-success',
      operation: 'poll',
      input: { capability: 'video', remoteTaskId: 'success' },
      expect: (result) => result.kind === 'succeeded' && result.artifacts[0].kind === 'remote-url'
    },
    {
      name: 'poll-transcribe-success',
      operation: 'poll',
      input: { capability: 'transcribe', remoteTaskId: 'success' },
      expect: (result) => result.kind === 'succeeded' && result.value.text === 'fixture transcript'
    },
    {
      name: 'poll-canceled',
      operation: 'poll',
      input: { capability: 'image', remoteTaskId: 'canceled' },
      expect: (result) => result.kind === 'canceled'
    },
    {
      name: 'poll-unknown',
      operation: 'poll',
      input: { capability: 'image', remoteTaskId: 'unknown' },
      expect: (result) => result.kind === 'unknown'
    },
    {
      name: 'poll-failed',
      operation: 'poll',
      input: { capability: 'image', remoteTaskId: 'failed' },
      expect: (result) => result.kind === 'failed'
    },
    {
      name: 'download',
      operation: 'download',
      input: {
        artifact: { kind: 'remote-url', url: 'https://result.invalid/video.mp4' },
        targetPath: '/tmp/fixture-video.mp4'
      },
      expect: (result) => result.bytes === 23
    }
  ]
});
assertProviderConformance(dashReport);
const redactedFailureReport = await runProviderConformance(dash, {
  secretMarkers: [dashSecret],
  requireCasesForSupported: false,
  cases: [{
    name: 'intentional-redacted-failure', operation: 'submit',
    input: { capability: 'image', model: 'report-secret', input: { prompt: 'p' } },
    expect: () => false
  }]
});
assert(!redactedFailureReport.ok
  && !JSON.stringify(redactedFailureReport).includes(dashSecret)
  && !JSON.stringify(redactedFailureReport).includes('/home/private'),
'conformance 失败报告必须二次脱敏', redactedFailureReport);
assert(providerAdapterSnapshot(dash).operations.cancel.status === 'unsupported',
  'DashScope cancel 未验证前必须显式 unsupported');

const rejected = await invokeProviderOperation(dash, 'submit', {
  capability: 'image', model: 'rate-limit', input: { prompt: 'p' }
});
const ambiguous = await invokeProviderOperation(dash, 'submit', {
  capability: 'image', model: 'server-error', input: { prompt: 'p' }
});
assert(rejected.kind === 'not_accepted' && rejected.error.category === 'rate_limit',
  'DashScope 明确 429 拒绝允许 failover', rejected);
assert(ambiguous.kind === 'acceptance_unknown' && ambiguous.error.category === 'provider',
  'DashScope 500 必须停止自动提交', ambiguous);
assert(!JSON.stringify([dashReport, rejected, ambiguous]).includes(dashSecret),
  'conformance 报告和规范结果不得泄露 DashScope key');
assert(dashCalls.every(([, input]) => !input?.key || input.key === dashSecret),
  '低层 transport 必须收到闭包凭据且不从调用输入取 key');

const openAiSecret = 'sk-openai-fixture-secret';
const openAiCalls = [];
const openAiTransport = {
  async listModels(input) {
    openAiCalls.push(['discover', input]);
    return ['gpt-image-1'];
  },
  async openAiGenerateImage(input) {
    openAiCalls.push(['submit', input]);
    return [{ b64: 'YWJj' }];
  },
  async downloadTo(url, targetPath, options) {
    openAiCalls.push(['download', { url, targetPath, ...options }]);
    return 3;
  }
};
const openAiProvider = {
  id: 'openai-fixture',
  apiKey: openAiSecret,
  baseUrl: 'https://api.openai.invalid/v1',
  mediaProtocol: 'openai-images'
};
const openAi = createOpenAiImagesProviderAdapter(openAiProvider, { transport: openAiTransport });
const openAiReport = await runProviderConformance(openAi, {
  secretMarkers: [openAiSecret],
  cases: [
    {
      name: 'discover',
      operation: 'discover',
      input: {},
      expect: (result) => result.models[0].id === 'gpt-image-1'
    },
    {
      name: 'submit-sync-image',
      operation: 'submit',
      input: { capability: 'image', model: 'gpt-image-1', input: { prompt: 'p' } },
      expect: (result) => result.kind === 'completed' && result.value.kind === 'openai'
        && result.artifacts[0].kind === 'inline-base64'
        && result.artifacts[0].data === 'YWJj'
        && !JSON.stringify(result).includes('YWJj')
    },
    {
      name: 'download',
      operation: 'download',
      input: {
        artifact: { kind: 'remote-url', url: 'https://result.invalid/image.png' },
        targetPath: '/tmp/fixture-image.png'
      },
      expect: (result) => result.bytes === 3
    }
  ]
});
assertProviderConformance(openAiReport);
const openAiSnapshot = providerAdapterSnapshot(openAi);
assert(openAiSnapshot.operations.poll.status === 'unsupported'
  && openAiSnapshot.operations.cancel.status === 'unsupported',
  'OpenAI Images 同步路径必须显式声明 poll/cancel unsupported', openAiSnapshot);
assert(!JSON.stringify(openAiReport).includes(openAiSecret), 'OpenAI conformance 报告不得泄露 key');

assert(createConfiguredProviderAdapter(dashProvider, { transport: dashTransport }).protocol === 'dashscope',
  '官方 DashScope HTTPS Base URL 应推断为 dashscope');
assert(createConfiguredProviderAdapter(openAiProvider, { transport: openAiTransport }).protocol === 'openai-images',
  '显式 OpenAI Images 协议应保持');
let unknownProtocol;
try {
  createConfiguredProviderAdapter({ ...openAiProvider, mediaProtocol: 'unknown-protocol' }, { transport: openAiTransport });
} catch (error) { unknownProtocol = error; }
assert(unknownProtocol instanceof TypeError, '未知协议必须在任何网络调用前失败');

console.log('ALL OK —— DashScope/OpenAI Images Provider Adapter v0 通过完整零网络 conformance');
