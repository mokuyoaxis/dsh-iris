import { normalizeGenerationInput } from './generation-input.js';
import { parseModelRef } from './models.js';

export const AUDIO_RECIPES = Object.freeze({
  'speech/v0': Object.freeze({ capability: 'tts', step: 'speak' }),
  'transcribe/v0': Object.freeze({ capability: 'transcribe', step: 'transcribe' })
});
export const MAX_AUDIO_INPUT_BYTES = 20 * 1024 * 1024;
export const AUDIO_TYPES = Object.freeze({ 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac' });
export const isAudioRecipe = recipe => Object.hasOwn(AUDIO_RECIPES, recipe);
const invalid = message => { throw Object.assign(new Error(message), { code: 'IRIS_AUDIO_INPUT_INVALID' }); };

export function normalizeAudioFlowInput(recipe, input) {
  if (!isAudioRecipe(recipe) || !input || typeof input !== 'object' || Array.isArray(input)) invalid('不支持的音频流程输入');
  const speech = recipe === 'speech/v0', required = speech ? ['model_ref', 'text'] : ['model_ref', 'source_artifact_id'];
  if (Object.keys(input).some(key => ![...required, ...(speech ? ['voice'] : [])].includes(key))
      || required.some(key => typeof input[key] !== 'string') || !parseModelRef(input.model_ref)
      || input.voice !== undefined && typeof input.voice !== 'string') invalid('请提供明确模型和文字或当前工作区的音频作品');
  if (speech) {
    const normalized = normalizeGenerationInput('tts', input);
    return { model_ref: normalized.modelRef, ...normalized.providerInput };
  }
  if (!/^artifact_[a-f0-9]{24}$/.test(input.source_artifact_id)) invalid('转写来源须为当前工作区的音频作品');
  return { model_ref: input.model_ref, source_artifact_id: input.source_artifact_id };
}

/** Bounded container sniffing, not a decoder or a claim of provider compatibility. */
export function readImportAudio(bytes, mediaType) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_AUDIO_INPUT_BYTES) invalid('音频须为最多20 MiB的WAV、MP3、OGG或FLAC');
  const value = Buffer.from(bytes);
  const actual = value.length >= 12 && value.toString('ascii', 0, 4) === 'RIFF' && value.toString('ascii', 8, 12) === 'WAVE' ? 'audio/wav'
    : value.length >= 10 && (value.toString('ascii', 0, 3) === 'ID3' || value[0] === 0xff && (value[1] & 0xe0) === 0xe0) ? 'audio/mpeg'
      : value.length >= 27 && value.toString('ascii', 0, 4) === 'OggS' ? 'audio/ogg'
        : value.length >= 8 && value.toString('ascii', 0, 4) === 'fLaC' ? 'audio/flac' : null;
  if (!actual || actual !== mediaType) invalid('音频容器与Content-Type不一致，或不是支持的格式');
  return { bytes: value, mediaType: actual, metadata: {} };
}
