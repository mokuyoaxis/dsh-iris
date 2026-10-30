import { defineProviderAdapter } from '../../lib/provider-adapter.js';
import { createFakeLifecycleProvider } from './fake-lifecycle-provider.mjs';

export const AUDIO_BINDING = 'sha256:' + 'c'.repeat(64);
export const SPEECH_MODEL = 'audio-fixture::speech', TRANSCRIBE_MODEL = 'audio-fixture::transcribe';
export const TRANSCRIPT = Buffer.from('雨后的鸢尾花。<script>never execute</script>\n第二行。');
export const AUDIO_WAV = (() => {
  const samples = 800, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 8000) * 8000), 44 + i * 2);
  return bytes;
})();
export function audioFlowFixture({ unknown = false, beforeSubmit, failPreparation = false } = {}) {
  const speech = { kind: 'completed', value: { kind: 'audio' }, artifacts: [{ kind: 'inline-base64', data: AUDIO_WAV.toString('base64'), mediaType: 'audio/wav' }] };
  const fake = createFakeLifecycleProvider({ id: 'audio-fixture', capabilities: ['tts', 'transcribe'],
    submitSteps: Array.from({ length: 30 }, () => async (input, context) => {
      await beforeSubmit?.(input, context);
      if (unknown) return { kind: 'acceptance_unknown', error: { category: 'network', stage: 'response', acceptance: 'unknown', message: 'fixture unknown' } };
      return input.capability === 'tts' ? speech : { kind: 'accepted', remoteTaskId: 'original-asr-task' };
    }),
    pollSteps: Array.from({ length: 30 }, () => ({ kind: 'succeeded', artifacts: [{ kind: 'inline-base64', data: TRANSCRIPT.toString('base64'), mediaType: 'text/plain' }] })) });
  const preparation = [];
  const adapter = defineProviderAdapter({ ...fake.adapter, unsupportedPreparation: undefined, prepareInput: async ({ bytes, filename, model, signal }) => {
    signal.throwIfAborted(); preparation.push({ bytes: Buffer.from(bytes), filename, model });
    if (failPreparation) throw Error('controlled upload failure');
    return { url: 'oss://private-fixture/audio?signature=NEVER_PERSIST_THIS' };
  } });
  return { adapter, calls: fake.calls, preparation,
    resolveAudioCandidates({ capability, modelRef, signal }) {
      signal.throwIfAborted();
      if (modelRef !== (capability === 'tts' ? SPEECH_MODEL : TRANSCRIBE_MODEL)) throw Error('unexpected audio model');
      return [{ adapter, model: modelRef, providerBinding: AUDIO_BINDING, selectionReason: 'explicit' }];
    },
    resolveTaskAdapter(task) {
      if (task.providerBinding !== AUDIO_BINDING || ![SPEECH_MODEL, TRANSCRIBE_MODEL].includes(task.modelRef)) throw Error('audio binding drift');
      return adapter;
    }
  };
}
