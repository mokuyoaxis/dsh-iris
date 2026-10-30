// Internal, non-generating creation service. One supplied writer owns the complete intent/commit sequence.
import crypto from 'node:crypto';
import { createCoreArtifact, readCoreArtifactBytes } from './core-artifacts.js';
import { createImageFlowService } from './image-flow.js';
import { readImportImage } from './image-import.js';
import { normalizeGenerationInput } from './generation-input.js';
import { readFlowRun, requireAudioRoot } from './flow-store.js';
import { readImportAudio, normalizeAudioFlowInput } from './audio-flow-input.js';
import { initializeCreationRoot, inspectCreationRoot, creationRequestId, creationInputDigest,
  readCreationRequest, publishCreationRequest, completeCreationRequest, creationFail, CREATION_KINDS, isImportCreation } from './creation-request-store.js';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function verifyImported(artifact, intent) {
  if (artifact.digest.value !== intent.sha256 || artifact.size !== intent.size || artifact.mediaType !== intent.mediaType
      || artifact.kind !== (intent.mediaType.startsWith('audio/') ? 'imported-audio' : 'imported-image') || artifact.createdAt !== intent.createdAt
      || JSON.stringify(artifact.metadata) !== JSON.stringify(intent.metadata) || artifact.relations.length) {
    creationFail('IRIS_CREATION_RESULT_CONFLICT', '原作品与请求意图不一致');
  }
  return artifact;
}
function flowInput(input, generate = false) {
  const required = generate ? ['modelRef', 'prompt'] : ['sourceArtifactId', 'modelRef', 'prompt'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => ![...required, 'size', ...(generate ? ['workflowParameters'] : [])].includes(key))
      || !required.every(key => typeof input[key] === 'string')
      || input.size !== undefined && typeof input.size !== 'string') {
    creationFail('IRIS_CREATION_INPUT_INVALID', '流程创建只接受来源作品、明确模型、Prompt 和可选 size');
  }
  const normalized = normalizeGenerationInput('image', { ...(!generate ? { source_artifact_id: input.sourceArtifactId } : {}),
    model_ref: input.modelRef, prompt: input.prompt, ...(input.size !== undefined ? { size: input.size } : {}),
    ...(input.workflowParameters !== undefined ? { workflow_parameters: input.workflowParameters } : {}) });
  return { ...(normalized.sourceArtifactId ? { source_artifact_id: normalized.sourceArtifactId } : {}), model_ref: normalized.modelRef,
    ...normalized.providerInput };
}
export function createLocalCreationService(runtime, { resolveImageCandidates, resolveAudioCandidates, onPrepared } = {}) {
  const flows = createImageFlowService(runtime, { resolveImageCandidates, resolveAudioCandidates });
  function execute(name, input) {
    if (name === 'creation.root' || name === 'creation.lookup') {
      return runtime.run('inspect', ({ dataRoot, signal }) => {
        signal.throwIfAborted();
        const fields = name === 'creation.root' ? [] : ['kind', 'key'];
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length
            || fields.some(key => !Object.hasOwn(input, key))
            || name === 'creation.lookup' && (!CREATION_KINDS.includes(input.kind) || typeof input.key !== 'string')) {
          creationFail('IRIS_CREATION_INPUT_INVALID', '需要明确的创建类型和原 Key');
        }
        const marker = inspectCreationRoot(dataRoot, { allowAbsent: true });
        if (name === 'creation.root') return { contractVersion: 0, rootId: marker?.rootId ?? null,
          ...([2, 3].includes(marker?.schemaVersion) ? { imageGeneration: true } : {}), ...(marker?.schemaVersion === 3 ? { audio: true } : {}) };
        if (!marker) creationFail('IRIS_CREATION_NOT_FOUND', '此数据根尚无创建请求区');
        const id = creationRequestId(marker, input.kind, input.key);
        const request = readCreationRequest(dataRoot, id, marker);
        if (!request) creationFail('IRIS_CREATION_NOT_FOUND', '此数据根没有对应的创建请求');
        if (request.kind !== input.kind) creationFail('IRIS_CREATION_RESULT_CONFLICT', '原请求类型与查询身份不一致');
        const intent = request.intent;
        let result = null;
        if (isImportCreation(request.kind)) {
          let artifact;
          try { artifact = readCoreArtifactBytes(dataRoot, intent.artifactId).artifact; }
          catch (error) {
            if (error.code !== 'IRIS_ARTIFACT_NOT_FOUND') throw error;
            if (request.state === 'succeeded') creationFail('IRIS_CREATION_RESULT_UNAVAILABLE', '原创建结果已不可用，不会重新创建');
          }
          if (artifact) result = { artifactId: verifyImported(artifact, intent).id };
        } else {
          let run;
          try { run = readFlowRun(dataRoot, intent.runId); }
          catch (error) {
            if (error.code !== 'IRIS_FLOW_NOT_FOUND') throw error;
            if (request.state === 'succeeded') creationFail('IRIS_CREATION_RESULT_UNAVAILABLE', '原创建流程已不可用，不会重新创建');
          }
          if (run) {
            try { flows.inspectCreation(dataRoot, intent, { allowCreate: false }); }
            catch (error) {
              if (['IRIS_FLOW_NOT_FOUND', 'IRIS_ARTIFACT_NOT_FOUND'].includes(error.code)) {
                creationFail('IRIS_CREATION_RESULT_UNAVAILABLE', '原创建流程的作品已不可用，不会恢复数据');
              }
              throw error;
            }
            result = { runId: run.id };
          }
        }
        return { contractVersion: 0, kind: request.kind, state: request.state, result };
      });
    }
    return runtime.run('execute', async ({ dataRoot, signal }) => {
      if (name === 'creation.init') return { contractVersion: 0, root: initializeCreationRoot(dataRoot) };
      const kinds = { 'creation.image': 'image-import', 'creation.flow': 'flow-create', 'creation.generate': 'generation-create',
        'creation.audio': 'audio-import', 'creation.speech': 'speech-create', 'creation.transcribe': 'transcription-create' };
      const kind = kinds[name];
      if (!kind) throw new TypeError('未知本地创建操作');
      if (['audio-import', 'speech-create', 'transcription-create'].includes(kind)) requireAudioRoot(dataRoot);
      const marker = inspectCreationRoot(dataRoot), id = creationRequestId(marker, kind, input.key);
      let source, owned;
      if (isImportCreation(kind)) {
        source = kind === 'audio-import' ? readImportAudio(input.bytes, input.mediaType) : await readImportImage({ imageBytes: input.bytes }, signal);
        if (source.mediaType !== input.mediaType) creationFail('IRIS_CREATION_MEDIA_MISMATCH', '图片真实格式与 Content-Type 不一致');
        owned = { mediaType: source.mediaType, size: source.bytes.length, sha256: sha(source.bytes) };
      } else if (['speech-create', 'transcription-create'].includes(kind)) {
        const value = input.value, speech = kind === 'speech-create';
        const allowed = speech ? ['modelRef', 'text', 'voice'] : ['modelRef', 'sourceArtifactId'];
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) creationFail('IRIS_CREATION_INPUT_INVALID', '音频创建输入无效');
        owned = normalizeAudioFlowInput(speech ? 'speech/v0' : 'transcribe/v0', { model_ref: value.modelRef,
          ...(speech ? { text: value.text, ...(value.voice !== undefined ? { voice: value.voice } : {}) } : { source_artifact_id: value.sourceArtifactId }) });
      } else owned = flowInput(input.value, kind === 'generation-create');
      const inputDigest = creationInputDigest(kind, owned);
      let request = readCreationRequest(dataRoot, id, marker);
      const replay = Boolean(request);
      if (request && request.inputDigest !== inputDigest) creationFail('IRIS_CREATION_KEY_CONFLICT', '该 Key 已绑定其他输入，请保留原请求或为新动作使用新 Key');
      if (!request) {
        const intent = isImportCreation(kind)
          ? { artifactId: 'artifact_' + crypto.randomBytes(12).toString('hex'), ...owned,
            metadata: source.metadata, createdAt: new Date().toISOString() }
          : await flows.prepareCreation(dataRoot, signal, { ...owned, ...(kind === 'speech-create' ? { recipe: 'speech/v0' }
            : kind === 'transcription-create' ? { recipe: 'transcribe/v0' } : {}) });
        signal.throwIfAborted();
        request = publishCreationRequest(dataRoot, { schemaVersion: 0, id, rootId: marker.rootId, kind,
          inputDigest, createdAt: intent.createdAt, intent, state: 'prepared' });
      }
      onPrepared?.(); // The Host now detaches HTTP disconnect cancellation; shutdown still reaches this runtime.
      signal.throwIfAborted();
      let result;
      const intent = request.intent;
      if (isImportCreation(kind)) {
        if (request.state === 'prepared') {
          result = createCoreArtifact(dataRoot, { artifactId: intent.artifactId, bytes: source.bytes,
            mediaType: intent.mediaType, kind: kind === 'audio-import' ? 'imported-audio' : 'imported-image', metadata: intent.metadata,
            expectedDigest: intent.sha256, expectedSize: intent.size, createdAt: intent.createdAt });
        } else {
          try { result = readCoreArtifactBytes(dataRoot, intent.artifactId).artifact; }
          catch (error) {
            if (error.code !== 'IRIS_ARTIFACT_NOT_FOUND') throw error;
            creationFail('IRIS_CREATION_RESULT_UNAVAILABLE', '该请求的原结果已不可用；不会重新创建或恢复已删除作品');
          }
        }
        result = { artifact: verifyImported(result, intent) };
      } else {
        try { result = { flow: flows.inspectCreation(dataRoot, intent, { allowCreate: request.state === 'prepared' }) }; }
        catch (error) {
          if (request.state !== 'succeeded' || !['IRIS_FLOW_NOT_FOUND', 'IRIS_ARTIFACT_NOT_FOUND'].includes(error.code)) throw error;
          creationFail('IRIS_CREATION_RESULT_UNAVAILABLE', '该请求的原流程或来源已不可用，不重新创建');
        }
      }
      signal.throwIfAborted();
      if (request.state === 'prepared') completeCreationRequest(dataRoot, request);
      return { contractVersion: 0, idempotentReplay: replay, ...result };
    });
  }
  return Object.freeze({ execute });
}
