'use strict';
/** OCR Host 边界：配置显式传入；同一 operation 从解引用开始覆盖整张长图。 */
import { buildVisionModelCandidates } from './vision-model-routing.js';
import { longOcr, normalizeOcrSettings, OCR_BUDGET } from './ocr.js';
import { createModelOperation } from './model-invoker.js';
import { ModelPortError, modelPortSnapshot, normalizeModelCall } from './model-port-contract.js';
import { waitForModelWork } from './model-call-runtime.js';

export async function runOcrRequest(host, { providers = [], model, image, prepareImage, signal,
  chunkHeight, overlap, maxDimension, maxInvocations, budget = OCR_BUDGET }) {
  const settings = normalizeOcrSettings({ chunkHeight, overlap, maxDimension, maxInvocations });
  const operation = createModelOperation({ signal, budget: { timeoutMs: budget.timeoutMs, maxInvocations: settings.maxInvocations } });
  try {
    const candidates = buildVisionModelCandidates(host, { providers, model });
    normalizeModelCall(modelPortSnapshot(candidates[0].port), { prompt: 'OCR',
      image: { bytes: new Uint8Array([0]), mediaType: 'image/png' } }, { budget });
    const resolved = await waitForModelWork(() => prepareImage ? prepareImage(operation.signal) : image, operation.signal);
    return await longOcr({ image: resolved, ports: candidates.map(candidate => candidate.port), ...settings, operation, budget });
  } catch (error) {
    if (error instanceof ModelPortError) throw error;
    throw new ModelPortError('IRIS_MODEL_REQUEST_FAILED', { stage: 'prepare', invocation: 'not_invoked' });
  } finally { operation.dispose(); }
}
