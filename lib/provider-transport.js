// Bind all hops of an existing media transport to an instance-owned request function.
import * as transport from './adapters.js';

const REQUEST_METHODS = Object.freeze([
  'generateImageMultimodal', 'startImageGeneration', 'submitImage', 'submitVideo', 'uploadTempFile',
  'pollTask', 'synthesizeTts', 'openAiGenerateImage', 'openAiChatGenerateImage', 'openAiResponsesGenerateImage',
  'listModels', 'visionStream', 'submitTranscription', 'pollTranscriptionTask', 'generateMusic'
]);

export function createProviderTransport(fetchPort) {
  if (typeof fetchPort !== 'function') throw new TypeError('Provider transport 需要明确的 fetchPort');
  const bound = { ...transport };
  for (const name of REQUEST_METHODS) bound[name] = input => transport[name]({ ...input, fetchPort });
  bound.downloadTo = (url, filePath, options) => transport.downloadTo(url, filePath, { ...options, fetchPort });
  return Object.freeze(bound);
}
