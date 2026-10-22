// Internal, non-generating creation service. One supplied writer owns the complete intent/commit sequence.
import crypto from 'node:crypto';
import { createCoreArtifact, readCoreArtifactBytes } from './core-artifacts.js';
import { createImageFlowService } from './image-flow.js';
import { readImportImage } from './image-import.js';
import { normalizeGenerationInput } from './generation-input.js';
import { initializeCreationRoot, inspectCreationRoot, creationRequestId, creationInputDigest,
  readCreationRequest, publishCreationRequest, completeCreationRequest, creationFail } from './creation-request-store.js';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function flowInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['sourceArtifactId', 'modelRef', 'prompt', 'size'].includes(key))
      || !['sourceArtifactId', 'modelRef', 'prompt'].every(key => typeof input[key] === 'string')
      || input.size !== undefined && typeof input.size !== 'string') {
    creationFail('IRIS_CREATION_INPUT_INVALID', '流程创建只接受来源作品、明确模型、Prompt 和可选 size');
  }
  const normalized = normalizeGenerationInput('image', { source_artifact_id: input.sourceArtifactId,
    model_ref: input.modelRef, prompt: input.prompt, ...(input.size !== undefined ? { size: input.size } : {}) });
  return { source_artifact_id: normalized.sourceArtifactId, model_ref: normalized.modelRef,
    ...normalized.providerInput };
}
export function createLocalCreationService(runtime, { resolveImageCandidates, onPrepared } = {}) {
  const flows = createImageFlowService(runtime, { resolveImageCandidates });
  function execute(name, input) {
    return runtime.run('execute', async ({ dataRoot, signal }) => {
      if (name === 'creation.init') return { contractVersion: 0, root: initializeCreationRoot(dataRoot) };
      if (!['creation.image', 'creation.flow'].includes(name)) throw new TypeError('未知本地创建操作');
      const kind = name === 'creation.image' ? 'image-import' : 'flow-create';
      const marker = inspectCreationRoot(dataRoot), id = creationRequestId(marker, kind, input.key);
      let source, owned;
      if (kind === 'image-import') {
        source = await readImportImage({ imageBytes: input.bytes }, signal);
        if (source.mediaType !== input.mediaType) creationFail('IRIS_CREATION_MEDIA_MISMATCH', '图片真实格式与 Content-Type 不一致');
        owned = { mediaType: source.mediaType, size: source.bytes.length, sha256: sha(source.bytes) };
      } else owned = flowInput(input.value);
      const inputDigest = creationInputDigest(kind, owned);
      let request = readCreationRequest(dataRoot, id, marker);
      const replay = Boolean(request);
      if (request && request.inputDigest !== inputDigest) creationFail('IRIS_CREATION_KEY_CONFLICT', '该 Key 已绑定其他输入，请保留原请求或为新动作使用新 Key');
      if (!request) {
        const intent = kind === 'image-import'
          ? { artifactId: 'artifact_' + crypto.randomBytes(12).toString('hex'), ...owned,
            metadata: source.metadata, createdAt: new Date().toISOString() }
          : await flows.prepareCreation(dataRoot, signal, owned);
        signal.throwIfAborted();
        request = publishCreationRequest(dataRoot, { schemaVersion: 0, id, rootId: marker.rootId, kind,
          inputDigest, createdAt: intent.createdAt, intent, state: 'prepared' });
      }
      onPrepared?.(); // The Host now detaches HTTP disconnect cancellation; shutdown still reaches this runtime.
      signal.throwIfAborted();
      let result;
      const intent = request.intent;
      if (kind === 'image-import') {
        if (request.state === 'prepared') {
          result = createCoreArtifact(dataRoot, { artifactId: intent.artifactId, bytes: source.bytes,
            mediaType: intent.mediaType, kind: 'imported-image', metadata: intent.metadata,
            expectedDigest: intent.sha256, expectedSize: intent.size, createdAt: intent.createdAt });
        } else {
          try { result = readCoreArtifactBytes(dataRoot, intent.artifactId).artifact; }
          catch (error) {
            if (error.code !== 'IRIS_ARTIFACT_NOT_FOUND') throw error;
            creationFail('IRIS_CREATION_RESULT_UNAVAILABLE', '该请求的原结果已不可用；不会重新创建或恢复已删除作品');
          }
        }
        if (result.digest.value !== intent.sha256 || result.size !== intent.size || result.mediaType !== intent.mediaType
            || result.kind !== 'imported-image' || result.createdAt !== intent.createdAt
            || JSON.stringify(result.metadata) !== JSON.stringify(intent.metadata) || result.relations.length) {
          creationFail('IRIS_CREATION_RESULT_CONFLICT', '原作品与请求意图不一致');
        }
        result = { artifact: result };
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
