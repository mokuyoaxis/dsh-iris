'use strict';
import { providerApiKey, unsupportedProtocolError } from './provider-protocol.js';
/**
 * Iris 视觉后端抽象（阶段 1）。
 *
 * 把“识图”拆成「VisionBackend 接口 +
 * 两个实现」，让自持栈与 DSH 全局模型可替换、按序降级。
 * - SelfStackVisionBackend：自持栈（OpenAI 兼容 /chat/completions，qwen-vl）
 * - HostVisionBackend：由 Host Adapter 提供的可选视觉模型
 *
 * 调用方（工具）不感知底层：buildVisionBackendsFromHost 按 provider 顺序组装，
 * askWithBackends 依次尝试、保留每个后端的失败现场。
 */
import * as adapters from './adapters.js';
import { hasHostPort } from './host-contract.js';
import { resolveModelRef, parseModelRef } from './models.js';

/** 后端接口约定：id / kind / model 只读，analyze(request) → Promise<string> */

export class SelfStackVisionBackend {
  constructor({ provider, model }) {
    this.provider = provider;
    this.requestedModel = model;
  }
  get id() {
    return this.provider.id;
  }
  get kind() {
    return 'selfstack';
  }
  get model() {
    const ref = resolveModelRef(this.provider, 'vision', this.requestedModel);
    return parseModelRef(ref)?.modelId || '';
  }
  async analyze({ question, imageDataUrl, signal }) {
    const model = this.model;
    if (!model) throw Object.assign(new Error('iris: 未配置视觉模型，请发现或手工添加并标注 vision 能力'), {
      code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE'
    });
    return adapters.visionStream({
      key: providerApiKey(this.provider),
      baseUrl: this.provider.baseUrl,
      model,
      prompt: question,
      imageDataUrl,
      signal
    });
  }
}

export class HostVisionBackend {
  constructor({ port }) { this.port = port; }
  get id() { return this.port.id || 'host-vision'; }
  get kind() { return this.port.kind || 'global'; }
  get model() { return this.port.model || '宿主视觉模型'; }
  async analyze(request) { return this.port.analyze(request); }
}

const VISION_FACTORIES = new Map([
  ['openai', (provider, model) => new SelfStackVisionBackend({ provider, model })]
]);

/** Host Adapter 入口；Command 不读取 DSH ctx。 */
export function buildVisionBackendsFromHost(host, { providers, model }) {
  const backends = [];
  for (const p of providers || []) {
    if (p) {
      const type = typeof p.type === 'string' && p.type.trim() ? p.type.trim() : 'openai';
      const factory = VISION_FACTORIES.get(type);
      if (!factory) {
        // 保留不可用证据，让宿主视觉端口仍能按既有顺序降级。
        backends.push({
          id: p.id, kind: 'selfstack', model: String(model || p.visionModel || ''),
          async analyze() { throw unsupportedProtocolError(type, 'vision'); }
        });
      } else backends.push(factory(p, model));
    }
  }
  if (hasHostPort(host, 'visionModel') && typeof host.ports.visionModel.analyze === 'function') {
    backends.push(new HostVisionBackend({ port: host.ports.visionModel }));
  }
  return backends;
}

/**
 * 依次尝试后端链，返回首个非空回答。
 * @param {Array} backends 有序后端
 * @param {object} request {question, imageDataUrl?, ref?, signal?}
 * @returns {Promise<{answer:string, via:string, model:string, backendId:string, errors:Array}>}
 * @throws 全部后端失败 → Error（带 errors 现场）
 */
export async function askWithBackends(backends, request) {
  const errors = [];
  for (const b of backends) {
    try {
      const answer = await b.analyze(request);
      if (answer && answer.trim()) {
        return { answer: answer.trim(), via: b.kind, model: b.model, backendId: b.id, errors };
      }
    } catch (err) {
      errors.push({
        backendId: b.id,
        kind: b.kind,
        model: b.model,
        code: err && err.code,
        category: err && err.category,
        status: err && err.status,
        message: String((err && err.message) || err)
      });
    }
  }
  const err = new Error('iris: 视觉模型不可用——自持栈与全局视觉模型都失败了');
  if (errors.length && errors[0].code && errors.every((error) => error.code === errors[0].code)) err.code = errors[0].code;
  err.errors = errors;
  throw err;
}

/* ---------------- 视觉能力测试（"test it, don't guess it"） ---------------- */

/**
 * 固定红色测试图（1x1 纯红 PNG，真实生成）。用于验证模型真的能看图，
 * 而不是只看 HTTP 返回 200 就声称支持 vision。
 */
export const RED_TEST_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

/** 期望的回答语义：必须提到红色（中文"红"或英文 red），才判定具备视觉能力 */
const RED_HINTS = /红|red/i;

/**
 * 视觉能力测试：向后端发固定红色测试图并提问，验证回答是否识别出红色。
 * 用于用户显式触发的能力实测流程。
 * @param {object} backend VisionBackend 实例（有 analyze 方法）
 * @param {{timeoutMs?:number, signal?:AbortSignal}} opts
 * @returns {Promise<{ok:boolean, answer:string, error?:string, timedOut?:boolean}>}
 */
export async function testVisionCapability(backend, { timeoutMs = 10000, signal } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('能力测试超时'), { timedOut: true })), timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    const answer = await Promise.race([
      backend.analyze({
        question: '这张图片是什么颜色？请只回答颜色名称（中文）。',
        imageDataUrl: RED_TEST_IMAGE,
        signal
      }),
      timeout
    ]);
    const ok = RED_HINTS.test(String(answer || ''));
    return { ok, answer: String(answer || '') };
  } catch (err) {
    return {
      ok: false,
      answer: '',
      error: String((err && err.message) || err),
      timedOut: !!err.timedOut,
      category: err && err.category,
      status: err && err.status
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
