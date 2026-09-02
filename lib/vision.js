'use strict';
/**
 * Iris 视觉后端抽象（阶段 1）。
 *
 * 对齐 RESEARCH 4.1b 的 vision-mix 经验：把"识图"拆成「VisionBackend 接口 +
 * 两个实现」，让自持栈与 DSH 全局模型可替换、按序降级。
 * - SelfStackVisionBackend：自持栈（OpenAI 兼容 /chat/completions，qwen-vl）
 * - GlobalLlmVisionBackend：DSH 全局视觉模型（ctx.llm.stream()）
 *
 * 调用方（工具）不感知底层：buildVisionBackends 按 provider 顺序组装，
 * askWithBackends 依次尝试、保留每个后端的失败现场。
 */
import * as adapters from './adapters.js';

/** 后端接口约定：id / kind / model 只读，analyze(request) → Promise<string> */

export class SelfStackVisionBackend {
  constructor({ provider }) {
    this.provider = provider;
  }
  get id() {
    return this.provider.id;
  }
  get kind() {
    return 'selfstack';
  }
  get model() {
    return this.provider.visionModel || 'qwen-vl-plus';
  }
  async analyze({ question, imageDataUrl, signal }) {
    return adapters.visionStream({
      key: this.provider.apiKey,
      baseUrl: this.provider.baseUrl,
      model: this.model,
      prompt: question,
      imageDataUrl,
      signal
    });
  }
}

export class GlobalLlmVisionBackend {
  constructor({ llm }) {
    this.llm = llm;
  }
  get id() {
    return 'global';
  }
  get kind() {
    return 'global';
  }
  get model() {
    return '全局视觉模型';
  }
  async analyze({ question, ref, signal }) {
    const chunks = [];
    for await (const chunk of this.llm.stream({
      sessionId: undefined,
      provider: undefined,
      model: undefined,
      signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image', attachment: ref }
          ]
        }
      ]
    })) {
      const t = chunk && chunk.delta;
      if (typeof t === 'string' && t) chunks.push(t);
      if (chunks.join('').length > 6000) break;
    }
    return chunks.join('').trim();
  }
}

/**
 * 按 provider 顺序组装视觉后端链（自持栈在前，全局模型兜底在后）。
 * 只接受已声明/推断 vision 能力的 provider（由调用方用 capability 过滤）。
 * @param {object} ctx DSH ctx（用于取 llm 服务）
 * @param {{providers: Array, model?: string}} opts model 覆盖全部自持栈的 vision 模型
 * @returns {Array} 有序后端
 */
export function buildVisionBackends(ctx, { providers, model }) {
  const backends = [];
  for (const p of providers || []) {
    if (p && p.type === 'openai') {
      const provider = model ? { ...p, visionModel: model } : p;
      backends.push(new SelfStackVisionBackend({ provider }));
    }
  }
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
  if (llm && typeof llm.stream === 'function') backends.push(new GlobalLlmVisionBackend({ llm }));
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
        category: err && err.category,
        status: err && err.status,
        message: String((err && err.message) || err)
      });
    }
  }
  const err = new Error('iris: 视觉模型不可用——自持栈与全局视觉模型都失败了');
  err.errors = errors;
  throw err;
}
