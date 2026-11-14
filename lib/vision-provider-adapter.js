// Built-in durable vision bridge. Model Ports own protocol parsing; Core owns the network lifecycle.
import { defineProviderAdapter } from './provider-adapter.js';
import { ProviderContractError, providerErrorRecord } from './provider-contract.js';
import { createHttpVisionModelPort } from './http-vision-model-adapter.js';
import { completeVision, VISION_BUDGET } from './vision-core.js';
import { longOcr } from './ocr.js';
import { ModelPortError, modelErrorRecord } from './model-port-contract.js';
import { createVisionInputObserver, visionInputLimits } from './vision-image-input.js';
import { providerApiKey } from './provider-protocol.js';
import { resolveProviderCredential } from './provider-credentials.js';
import { providerNetworkRequirement, sameNetworkRequirement, networkPolicyError } from './network-policy.js';
import { assertProviderNetwork } from './provider-network.js';
import { writePrivateFile } from './private-storage.js';
import { MAX_VISION_RESULT_BYTES } from './vision-flow-input.js';
import { reportModelRateLimit, recordModelAvailability, modelRateLimit } from './provider-health.js';
import { modelAvailabilityBinding, modelUnavailable, modelUnavailableReason } from './model-directory.js';

function mapVisionError(error) {
  // Network preflight errors already carry Core's verified admission facts.
  if (error instanceof ProviderContractError) return providerErrorRecord(error);
  return mapVisionErrorRecord(modelErrorRecord(error));
}

function mapVisionErrorRecord(record) {
  const category = { IRIS_MODEL_INPUT_INVALID: 'invalid_request', IRIS_MODEL_IMAGE_TOO_LARGE: 'invalid_request',
    IRIS_MODEL_UNAVAILABLE: 'invalid_request', IRIS_MODEL_UNSUPPORTED: 'invalid_request',
    IRIS_MODEL_AUTH_FAILED: 'authentication', IRIS_MODEL_RATE_LIMITED: 'rate_limit',
    IRIS_MODEL_TIMEOUT: 'timeout', IRIS_MODEL_ABORTED: 'aborted', IRIS_MODEL_REQUEST_FAILED: 'network' }[record.code] || 'protocol';
  // The HTTP Model Port has already distinguished an exact model-not-found rejection
  // from a generic route 404. Keep that fact across OCR's safe error records too.
  const missing = record.code === 'IRIS_MODEL_UNAVAILABLE' && record.status === 404 && record.invocation === 'rejected';
  return providerErrorRecord({ safeMessage: record.message, providerCode: missing ? 'model_not_found' : record.code,
    stage: record.stage === 'validate' ? 'validate' : record.stage === 'prepare' ? 'prepare' : 'submit', category,
    acceptance: ['not_invoked', 'rejected'].includes(record.invocation) ? 'not_accepted' : 'unknown',
    ...(record.status ? { httpStatus: record.status } : {}), retryable: false });
}

const artifact = (bytes, mediaType) => {
  if (!bytes.length || bytes.length > MAX_VISION_RESULT_BYTES) throw new ProviderContractError('视觉结果超过交付上限', {
    stage: 'response', category: 'protocol', acceptance: 'accepted'
  });
  return { kind: 'inline-base64', mediaType, data: bytes.toString('base64') };
};

function ocrReport(result) {
  return { contractVersion: 0, status: result.status, totalChunks: result.totalChunks,
    successfulChunks: result.successfulChunks, failedChunks: result.failedChunks, skippedChunks: result.skippedChunks,
    invocations: result.invocations, width: result.width, height: result.height,
    sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight,
    ...(result.stopCode ? { stopCode: result.stopCode } : {}),
    chunks: result.chunks.map(chunk => ({ index: chunk.index, y: chunk.y, height: chunk.height, status: chunk.status,
      text: chunk.text, ...(chunk.code ? { code: chunk.code } : {}),
      ...(chunk.input ? { input: chunk.input } : {}),
      ...(chunk.errors?.length ? { errors: chunk.errors.map(error => Object.fromEntries(['code', 'stage', 'invocation', 'status']
        .filter(key => error[key] !== undefined).map(key => [key, error[key]]))) } : {}) })) };
}

export function createVisionProviderAdapter(supplied, { network: suppliedNetwork, fetchPort, onRateLimit, onModelAvailability, deferCooling = false } = {}) {
  const requirement = providerNetworkRequirement(supplied);
  const network = suppliedNetwork === undefined ? undefined : assertProviderNetwork(suppliedNetwork);
  if (requirement && (!network || !sameNetworkRequirement(requirement, network.networkRequirement) || network.providerId !== supplied.id)) {
    throw networkPolicyError('IRIS_NETWORK_CONTEXT_REQUIRED', '视觉需要原配置匹配的网络上下文，不会默认直连');
  }
  if (network && fetchPort) throw new TypeError('视觉network与fetchPort不能同时提供');
  const provider = resolveProviderCredential(supplied);
  if (provider.type && provider.type !== 'openai') throw new ProviderContractError('当前持久视觉只支持OpenAI兼容协议', {
    stage: 'validate', category: 'invalid_request', acceptance: 'not_accepted'
  });
  const run = (name, action) => (request, context) => network ? network.run(() => action(request), { ...context, operation: name }) : action(request);
  return Object.freeze({ ...defineProviderAdapter({ id: provider.id, protocol: 'openai-vision', capabilities: ['vision'],
    operations: {
      submit: run('submit', async request => {
        if (request.capability !== 'vision') throw new TypeError('视觉Adapter只接受vision任务');
        if (modelUnavailable(provider, request.model, 'vision')) throw new ProviderContractError(modelUnavailableReason(), {
          stage: 'validate', category: 'invalid_request', acceptance: 'not_accepted'
        });
        const blocked = modelRateLimit(provider, request.model);
        if (blocked && !(deferCooling && blocked.until)) throw new ProviderContractError('该视觉模型限流或额度不足，请核对后再使用', {
          stage: 'validate', category: 'rate_limit', acceptance: 'not_accepted'
        });
        const inputs = new Map(), input = request.input;
        const fetch = async (...args) => {
          try { return await (network?.fetch || fetchPort || globalThis.fetch)(...args); }
          catch (error) {
            if (error instanceof ProviderContractError && error.stage === 'prepare' && error.acceptance === 'not_accepted') {
              throw new ModelPortError(error.category === 'rate_limit' ? 'IRIS_MODEL_RATE_LIMITED' : 'IRIS_MODEL_REQUEST_FAILED', {
                stage: 'prepare', invocation: 'not_invoked'
              });
            }
            throw error;
          }
        };
        const httpPort = createHttpVisionModelPort({ providerId: provider.id, modelId: request.model,
          baseUrl: provider.baseUrl, apiKey: providerApiKey(provider), fetch,
          imageInput: visionInputLimits(provider, request.model), prepareImageRequest: createVisionInputObserver(inputs) });
        const port = Object.freeze({
          describe() {
            const descriptor = httpPort.describe();
            return modelUnavailable(provider, request.model, 'vision')
              ? { ...descriptor, availability: 'unavailable', reasonCode: 'IRIS_MODEL_UNAVAILABLE' } : descriptor;
          },
          async complete(input, options) {
            try { return await httpPort.complete(input, options); }
            catch (error) {
              // Observe each actual call: a partially successful OCR run can still
              // prove this model unavailable. Later chunks must not invoke it again.
              const event = { ...mapVisionError(error), ok: false, source: 'task', binding: modelAvailabilityBinding(provider, request.model, 'vision') };
              if (recordModelAvailability(provider, request.model, 'vision', event)) {
                try { onModelAvailability?.({ providerId: provider.id, modelId: request.model, capability: 'vision', ...event }); }
                catch (_) { console.warn('[iris] 视觉模型可用性未能持久化，请检查配置写入权限'); }
              }
              throw error;
            }
          }
        });
        try {
          if (input.recipe === 'ocr/v0') {
            const result = await longOcr({ image: input.image, ports: [port], signal: request.signal, operation: input.operation, inputs,
              chunkHeight: input.chunk_height, overlap: input.overlap, maxDimension: input.max_dimension, maxInvocations: input.max_invocations });
            if (result.status === 'failed') {
              const errors = result.chunks.flatMap(chunk => chunk.errors || []);
              const error = errors.find(item => !['not_invoked', 'rejected'].includes(item.invocation)) || errors[0];
              const mapped = error ? mapVisionErrorRecord(error) : providerErrorRecord({ category: 'protocol', acceptance: 'unknown', safeMessage: 'OCR未获得完整文本段' });
              throw new ProviderContractError(mapped.safeMessage, mapped);
            }
            return { kind: 'completed', artifacts: [artifact(Buffer.from(result.fullText), 'text/plain'),
              artifact(Buffer.from(JSON.stringify(ocrReport(result))), 'application/json')] };
          }
          const result = await completeVision([port], { prompt: input.question, image: input.image }, {
            signal: request.signal, operation: input.operation, budget: VISION_BUDGET });
          return { kind: 'completed', artifacts: [artifact(Buffer.from(result.text), 'text/plain')] };
        } catch (error) {
          const mapped = mapVisionError(error);
          reportModelRateLimit(provider, request.model, { ...mapped, source: 'task' }, onRateLimit, 'vision');
          throw new ProviderContractError(mapped.safeMessage, mapped);
        }
      }),
      download: run('download', async ({ artifact: value, targetPath }) => {
        const bytes = Buffer.from(value.data, 'base64');
        if (!bytes.length || bytes.length > MAX_VISION_RESULT_BYTES || bytes.toString('base64') !== value.data) throw new TypeError('视觉交付字节无效');
        writePrivateFile(targetPath, bytes, { flag: 'wx' }); return { bytes: bytes.length };
      }),
      mapError: mapVisionError
    }, unsupported: { discover: '模型目录来自明确的owner配置', poll: '同步视觉不提供远端任务查询', cancel: '视觉仅支持本地停止' }
  }), ...(requirement ? { networkRequirement: requirement } : {}),
  ...(deferCooling ? { schedulingReadyAt: modelId => Date.parse(modelRateLimit(provider, modelId)?.until || '') || 0 } : {}) });
}
