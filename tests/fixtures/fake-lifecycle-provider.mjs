import fs from 'node:fs';
import { defineProviderAdapter } from '../../lib/provider-adapter.js';
import { providerErrorRecord } from '../../lib/provider-contract.js';

export const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

/** 最小可辨识的 MP4 前缀字节（ftyp box），仅作 fixture 载荷。 */
export const FAKE_MP4 = Buffer.from(
  'AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
  'base64'
);

/** 最小可辨识的 WAV 头字节（RIFF/WAVE），仅作 fixture 载荷。 */
export const FAKE_WAV = Buffer.from(
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=',
  'base64'
);

/** 转写正文 fixture（UTF-8 文本）。 */
export const FAKE_TRANSCRIPT = Buffer.from('fixture 转写正文：鸢尾在雨后开花。', 'utf8');

function requireLifecycleInput(operation, input) {
  if (!input || !['image', 'video', 'tts', 'transcribe'].includes(input.capability)
      || !input.signal || typeof input.signal.aborted !== 'boolean') {
    throw new Error('Fake lifecycle ' + operation + ' 缺少已知 capability 或 AbortSignal');
  }
  if (operation === 'submit' && (!String(input.model || '').trim() || String(input.model).includes('::'))) {
    throw new Error('Fake lifecycle submit 必须收到供应商原始 model id');
  }
  if (['poll', 'cancel'].includes(operation) && !String(input.remoteTaskId || '').trim()) {
    throw new Error('Fake lifecycle ' + operation + ' 缺少 remoteTaskId');
  }
}

function consume(steps, fallback, input, context) {
  const step = steps.length ? steps.shift() : fallback;
  if (typeof step === 'function') return step(input, context);
  if (step && Object.prototype.hasOwnProperty.call(step, 'throw')) throw step.throw;
  return step && Object.prototype.hasOwnProperty.call(step, 'result') ? step.result : step;
}

/** 完整、零网络、可脚本化的 Provider Adapter fixture（image 与 video 生命周期同构）。 */
export function createFakeLifecycleProvider(options = {}) {
  const calls = { discover: [], submit: [], poll: [], cancel: [], download: [], mapError: [] };
  const submitSteps = [...(options.submitSteps || [])];
  const pollSteps = [...(options.pollSteps || [])];
  const cancelSteps = [...(options.cancelSteps || [])];
  const downloadSteps = [...(options.downloadSteps || [])];
  const bytes = options.bytes || FAKE_PNG;
  const videoBytes = options.videoBytes || FAKE_MP4;
  const audioBytes = options.audioBytes || FAKE_WAV;
  const transcriptBytes = options.transcriptBytes || FAKE_TRANSCRIPT;

  const adapter = defineProviderAdapter({
    id: options.id || 'fake',
    protocol: 'fixture',
    capabilities: options.capabilities || ['image'],
    operations: {
      discover: async (input, context) => {
        calls.discover.push({ input, context });
        return { models: [{ id: options.modelId || 'image-v0', capabilities: ['image'] }] };
      },
      submit: async (input, context) => {
        requireLifecycleInput('submit', input);
        calls.submit.push({ input, context });
        // TTS 是同步完成型：默认直接 completed + inline-base64 音频产物。
        const fallback = input.capability === 'tts'
          ? {
            kind: 'completed',
            value: { kind: 'audio' },
            artifacts: [{ kind: 'inline-base64', data: audioBytes.toString('base64'), mediaType: 'audio/mpeg' }]
          }
          : { kind: 'accepted', remoteTaskId: 'remote-default' };
        return consume(submitSteps, fallback, input, context);
      },
      poll: async (input, context) => {
        requireLifecycleInput('poll', input);
        calls.poll.push({ input, context });
        return consume(pollSteps, { kind: 'pending', progress: 'fixture-running' }, input, context);
      },
      cancel: async (input, context) => {
        requireLifecycleInput('cancel', input);
        calls.cancel.push({ input, context });
        return consume(cancelSteps, { kind: 'unknown', message: 'fixture cancel unknown' }, input, context);
      },
      download: async (input, context) => {
        requireLifecycleInput('download', input);
        calls.download.push({ input, context });
        const step = consume(downloadSteps, null, input, context);
        const inlineData = input.artifact?.kind === 'inline-base64' && input.artifact.data
          ? Buffer.from(input.artifact.data, 'base64') : null;
        const fallback = input.capability === 'video' ? videoBytes
          : input.capability === 'tts' ? audioBytes
          : input.capability === 'transcribe' ? transcriptBytes : bytes;
        const body = step === null ? (inlineData || fallback)
          : (Buffer.isBuffer(step) ? step : (step?.body || inlineData || fallback));
        fs.writeFileSync(input.targetPath, body, { flag: 'wx', mode: 0o600 });
        return { bytes: body.length };
      },
      mapError: (error, context) => {
        calls.mapError.push({ context });
        return providerErrorRecord(error, context);
      }
    },
    unsupported: {}
  });
  return Object.freeze({ adapter, calls });
}
