'use strict';
/** Host 边界：显式配置选型、字节解析和结果投影。 */
import { resolveModelRef, parseModelRef } from './models.js';
import { providerApiKey } from './provider-protocol.js';
import { createHttpVisionModelPort } from './http-vision-model-adapter.js';
import { prepareDshVisionModelPort } from './dsh-vision-model-adapter.js';
import { createModelOperation } from './model-invoker.js';
import { ModelPortError, normalizeModelDescriptor, normalizeModelCall, modelErrorRecord } from './model-port-contract.js';
import { waitForModelWork } from './model-call-runtime.js';
import { completeVision, VISION_BUDGET } from './vision-core.js';
import { open } from 'node:fs/promises';

const features = Object.freeze({ system: 'unknown', temperature: 'unknown', maxOutputTokens: 'unknown', reasoning: 'unknown' });

function unavailablePort(id, code = 'IRIS_MODEL_UNAVAILABLE') {
  const descriptor = normalizeModelDescriptor({ contractVersion: 0, kind: 'vision',
    identity: { origin: 'host', backendId: id }, availability: code === 'IRIS_MODEL_UNSUPPORTED' ? 'incompatible' : 'unavailable', reasonCode: code, features });
  return Object.freeze({ describe: () => descriptor, async complete() { throw new ModelPortError(code, { stage: 'prepare', backendId: id }); } });
}

/** 默认选择仅在轮到 Host 候选时解析；自持成功不会多查 Host 元数据。 */
function deferredDshPort(host) {
  const ready = typeof host?.ports?.textModel?.stream === 'function'
    && typeof host?.ports?.textModel?.currentSelection === 'function'
    && typeof host?.ports?.textModel?.resolveModelInfo === 'function'
    && typeof host?.ports?.attachments?.saveImage === 'function' && typeof host?.ports?.attachments?.readImage === 'function';
  const initial = normalizeModelDescriptor({ contractVersion: 0, kind: 'vision',
    identity: { origin: 'host', backendId: 'dsh-vision:default' }, availability: ready ? 'available' : 'unavailable',
    ...(ready ? {} : { reasonCode: 'IRIS_MODEL_UNAVAILABLE' }), features });
  // 保持请求前后的不透明身份一致，实际模型身份作为边界内投影事实返回。
  let selected, bound;
  return { port: Object.freeze({ describe: () => initial,
    async complete(request, options) {
      // 一轮复合操作的后续图片复用已解析路由，默认模型切换只影响下次操作。
      const port = bound || await prepareDshVisionModelPort(host?.ports?.textModel, host?.ports?.attachments, { signal: options.signal });
      bound = port;
      const result = await port.complete(request, options);
      selected = result.identity;
      return { ...result, identity: initial.identity };
    }
  }), selected: () => selected };
}

/** 配置只绑定一个自持模型；CLI 不附加宿主候选。 */
export function createConfiguredVisionModelPort(provider, model) {
  const parsed = parseModelRef(resolveModelRef(provider, 'vision', model));
  const id = 'iris-provider:' + encodeURIComponent(provider.id);
  if (!parsed) return unavailablePort(id);
  if (typeof provider.type === 'string' && provider.type.trim() && provider.type.trim() !== 'openai') {
    return unavailablePort(id, 'IRIS_MODEL_UNSUPPORTED');
  }
  return createHttpVisionModelPort({ providerId: provider.id, modelId: parsed.modelId,
    baseUrl: provider.baseUrl, apiKey: providerApiKey(provider) });
}

export function buildVisionModelCandidates(host, { providers = [], model } = {}) {
  const candidates = providers.filter(Boolean).map(provider => {
    const parsed = parseModelRef(resolveModelRef(provider, 'vision', model));
    const port = createConfiguredVisionModelPort(provider, model);
    const id = port.describe().identity.backendId;
    return { port, id, via: 'selfstack', backendId: provider.id, model: parsed?.modelId || '' };
  });
  const hostCandidate = deferredDshPort(host);
  candidates.push({ ...hostCandidate, id: 'dsh-vision:default', via: 'global', backendId: 'dsh-global', model: '宿主视觉模型' });
  return candidates;
}

export function visionImageFromDataUrl(value, maxBytes = VISION_BUDGET.maxImageBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 64) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== match[2]) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
  return { bytes: new Uint8Array(bytes), mediaType: match[1] };
}

/** 打开一次并限额读取，避免用巨大文件分配无界内存；读取受操作取消控制。 */
export async function readVisionImageFile(file, mediaType, signal) {
  return waitForModelWork(async () => {
    const handle = await open(file, 'r');
    try {
      if (signal?.aborted) throw signal.reason;
      const stat = await handle.stat();
      if (!stat.isFile() || !stat.size || stat.size > VISION_BUDGET.maxImageBytes) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
      const bytes = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        if (signal?.aborted) throw signal.reason;
        const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
        if (!bytesRead) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
        offset += bytesRead;
      }
      const extra = new Uint8Array(1);
      if ((await handle.read(extra, 0, 1, offset)).bytesRead) throw new ModelPortError('IRIS_MODEL_INPUT_INVALID');
      return { bytes, mediaType };
    } finally { await handle.close(); }
  }, signal);
}

function projectError(record, candidates) {
  const candidate = candidates.find(value => value.id === record.backendId);
  const category = { IRIS_MODEL_AUTH_FAILED: 'auth', IRIS_MODEL_RATE_LIMITED: 'rate_limit',
    IRIS_MODEL_TIMEOUT: 'timeout', IRIS_MODEL_ABORTED: 'aborted' }[record.code] || 'unknown';
  return { ...record, kind: candidate?.via, backendId: candidate?.backendId || record.backendId,
    model: candidate?.model || '', category };
}

/** prepareImage 的信号覆盖文件/会话读取；函数开始时即建立整体预算。 */
export async function runVisionOperation(host, { providers, model, signal, budget = VISION_BUDGET }, consume) {
  const candidates = buildVisionModelCandidates(host, { providers, model });
  const operation = createModelOperation({ signal, budget: { timeoutMs: budget.timeoutMs, maxInvocations: candidates.length } });
  try {
    const { completion: result, ...details } = await consume(candidates.map(candidate => candidate.port), operation);
    const selected = candidates.find(candidate => candidate.id === result.identity.backendId);
    return { ...details, answer: result.text.trim(), via: selected.via, backendId: selected.backendId,
      model: selected.selected?.()?.modelId || selected.model, errors: result.errors.map(record => projectError(record, candidates)) };
  } catch (error) {
    if (error instanceof ModelPortError) {
      error.errors = (error.errors || []).map(record => projectError(record, candidates));
      throw error;
    }
    throw new ModelPortError('IRIS_MODEL_REQUEST_FAILED', { stage: 'prepare', invocation: 'not_invoked' });
  } finally { operation.dispose(); }
}

/** 单图与复合业务共用同一候选、整体预算和结果投影。 */
export async function runVisionRequest(host, { providers, model, question, image, dataUrl, prepareImage, signal, budget = VISION_BUDGET }) {
  return runVisionOperation(host, { providers, model, signal, budget }, async (ports, operation) => {
    normalizeModelCall(ports[0].describe(), { prompt: question,
      image: { bytes: new Uint8Array([0]), mediaType: 'image/png' } }, { budget });
    const resolved = await waitForModelWork(() => prepareImage ? prepareImage(operation.signal)
      : image || visionImageFromDataUrl(dataUrl, budget.maxImageBytes), operation.signal);
    return { completion: await completeVision(ports, { prompt: question, image: resolved }, { operation, budget }) };
  });
}

/** 付费确认在动作入口；红图实测只有一个供应商，不退到 Host 冒充其能力。 */
export async function probeVisionModel(provider, model, image, { signal, timeoutMs = 15000 } = {}) {
  try {
    const [candidate] = buildVisionModelCandidates(null, { providers: [provider], model });
    const result = await completeVision([candidate.port], { prompt: '这张图片是什么颜色？请只回答颜色名称（中文）。', image },
      { signal, budget: { ...VISION_BUDGET, timeoutMs } });
    return { ok: /红|red/i.test(result.text), answer: result.text };
  } catch (error) {
    const record = modelErrorRecord(error);
    const projected = projectError(record, []);
    return { ok: false, answer: '', error: record.message, code: record.code,
      timedOut: record.code === 'IRIS_MODEL_TIMEOUT', category: projected.category, status: record.status };
  }
}
