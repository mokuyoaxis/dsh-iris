'use strict';
/** Host 选型留边界，定位/拼图只消费共享模型端口；准备也属于本次预算。 */
import sharp from 'sharp';
import { runVisionOperation, runVisionRequest } from './vision-model-routing.js';
import { locateObject, normalizeLocateTarget, createLocateImageRequest } from './locate.js';
import { summarizeMedia } from './summarize.js';
import { VISION_BUDGET } from './vision-core.js';
import { normalizeModelCall } from './model-port-contract.js';
import { waitForModelWork } from './model-call-runtime.js';

export async function runLocateRequest(host, { providers = [], model, target, image, prepareImage, signal, budget = VISION_BUDGET, onRateLimit }) {
  target = normalizeLocateTarget(target);
  const inputs = new Map();
  const result = await runVisionOperation(host, { providers, model, signal, budget, onRateLimit, prepareImages: true,
    orientImages: true, prepareImageRequest: createLocateImageRequest(target, inputs) }, async (ports, operation) => {
    const resolved = await waitForModelWork(() => prepareImage ? prepareImage(operation.signal) : image, operation.signal);
    const source = normalizeModelCall(ports[0].describe(), { prompt: target, image: resolved }, { budget }).request.image;
    const { width, height } = await waitForModelWork(() => sharp(Buffer.from(source.bytes)).metadata(), operation.signal);
    const completion = await locateObject(ports, { target, image: source, width, height }, { operation, budget });
    return { completion, ...completion.bbox, width, height, input: inputs.get(completion.identity.backendId) };
  });
  const { answer: _answer, ...location } = result;
  return location;
}

export async function runSummaryRequest(host, { providers = [], model, prepareMedia, frames, question, transcript, signal, budget = VISION_BUDGET, onRateLimit }) {
  return runVisionOperation(host, { providers, model, signal, budget, onRateLimit }, async (ports, operation) => {
    const media = await waitForModelWork(() => prepareMedia ? prepareMedia(operation.signal) : { frames, transcript }, operation.signal);
    const completion = await summarizeMedia({ ports, frames: media.frames, question, transcript: media.transcript,
      operation, budget });
    return { completion, sheet: completion.sheet, frames: media.frames, meta: media.meta, transcriptNote: media.transcriptNote || '' };
  });
}

/** 增强描述沿用共享调用；失败不改变已经完成的媒体交付。 */
export async function describeGeneratedImage(host, { providers = [], originalPrompt, image, prepareImage, signal, onRateLimit }) {
  try {
    const result = await runVisionRequest(host, { providers, image, prepareImage, signal, onRateLimit,
      question: `用不超过两句话描述这张图片的主题与构图。生成该图的提示词是：「${String(originalPrompt).slice(0, 200)}」` });
    return result.answer.slice(0, 300);
  } catch (_) { return ''; }
}
