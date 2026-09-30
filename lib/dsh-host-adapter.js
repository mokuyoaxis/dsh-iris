'use strict';

/** DSH/Cordis runtime objects are normalized here and nowhere in Iris commands. */
import fs from 'node:fs';
import path from 'node:path';
import { defineHostAdapter } from './host-contract.js';
import { BrowserHtmlRenderer } from './render.js';

export function detectDshVersion({ entry = process.argv[1] } = {}) {
  if (!entry) return 'unknown';
  let resolved = path.resolve(String(entry));
  try { resolved = fs.realpathSync(resolved); } catch (_) { /* 入口可能尚未物化 */ }
  let current = path.dirname(resolved);
  for (let depth = 0; depth < 6; depth++) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8'));
      if (manifest.name === '@deepseek-ai/dsh') return String(manifest.version || 'unknown');
    } catch (_) { /* 当前层不是 DSH 包根目录 */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return 'unknown';
}

function property(ctx, name) {
  try { return ctx && ctx[name]; } catch (_) { return undefined; }
}

function service(ctx, name) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name);
      if (value) return value;
    } catch (_) { /* optional DSH service was not injected */ }
  }
  return property(ctx, name);
}

function unavailableFor(value, reason) {
  return { kind: value ? 'incompatible' : 'unavailable', reason };
}

function imageAttachmentDto(ref) {
  const out = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    name: typeof ref.name === 'string' ? ref.name : ''
  };
  // readImage 会核对这三项完整性事实；省略未知值，不从 ID/文件名猜测。
  for (const key of ['bytes', 'width', 'height']) {
    if (Number.isSafeInteger(ref[key]) && ref[key] > 0) out[key] = ref[key];
  }
  const original = ref.originalDimensions;
  if (original && Number.isSafeInteger(original.width) && original.width > 0
      && Number.isSafeInteger(original.height) && original.height > 0) {
    out.originalDimensions = Object.freeze({ width: original.width, height: original.height });
  }
  return Object.freeze(out);
}

function collectImageAttachments(nodes) {
  const out = [];
  const ids = new Set();
  const seen = new Set();
  const stack = Array.isArray(nodes) ? [...nodes] : [nodes];
  let scanned = 0;
  while (stack.length && scanned < 8000) {
    const node = stack.pop();
    scanned++;
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const ref = node.attachment && typeof node.attachment === 'object'
      ? node.attachment
      : (node.attachmentId && node.mediaType ? node : null);
    if (ref && typeof ref.attachmentId === 'string'
        && typeof ref.mediaType === 'string' && ref.mediaType.startsWith('image/')
        && !ids.has(ref.attachmentId)) {
      ids.add(ref.attachmentId);
      out.push(imageAttachmentDto(ref));
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
  }
  return out;
}

function registerWithEffect(ctx, registry, definition) {
  if (typeof ctx.effect === 'function') return ctx.effect(() => registry.register(definition));
  return registry.register(definition);
}

function visionRouteError(message) {
  return Object.assign(new Error(message), { code: 'IRIS_HOST_CAPABILITY_INCOMPATIBLE' });
}

function dshVisionPort(llm, { defaults, requiresRoute }) {
  return Object.freeze({
    id: 'dsh-global',
    model: '全局视觉模型',
    async analyze({ question, ref, signal }) {
      let route = {};
      if (requiresRoute) {
        // rc.2 路由检查前就停止取消请求；旧桥接继续由宿主处理 signal，
        // 其 fallback 语义待共享调用控制迁移时统一。
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('已取消');
        const selection = defaults.currentSelection();
        if (typeof selection?.provider !== 'string' || !selection.provider.trim()
            || typeof selection?.model !== 'string' || !selection.model.trim()) {
          throw visionRouteError('DSH 默认模型没有明确路由；请在 Iris 配置视觉模型');
        }
        // 默认文本选择只有明确声明 image 输入时才可成为视觉候选。
        const { provider, model } = selection;
        const info = await llm.resolveModelInfo(provider, model, signal);
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('已取消');
        if (info?.provider !== provider || info?.id !== model || !Array.isArray(info.inputModalities)
            || !info.inputModalities.includes('image')) {
          throw visionRouteError('DSH 默认模型未确认支持图片；请在 Iris 配置视觉模型或选择已声明图片输入的宿主模型');
        }
        route = { provider, model };
      }
      const chunks = [];
      for await (const chunk of llm.stream({
        sessionId: undefined,
        provider: undefined,
        model: undefined,
        ...route,
        signal,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image', attachment: ref }
          ]
        }]
      })) {
        if (chunk?.type === 'error') throw visionRouteError('DSH 视觉调用失败；请检查宿主模型状态');
        // rc.2 的 Runtime 把 Adapter 异常转换为 finish，而不是单独的 error 事件。
        if (requiresRoute && chunk?.type === 'finish') {
          if (chunk.reason?.kind === 'error') throw visionRouteError('DSH 视觉调用失败；请检查宿主模型状态');
          if (chunk.reason?.kind === 'aborted') throw visionRouteError('DSH 视觉调用已取消');
        }
        const text = typeof chunk?.delta === 'string'
          ? chunk.delta
          : (chunk?.type === 'text-delta' ? String(chunk.text || '') : '');
        if (text) chunks.push(text);
        if (chunks.reduce((sum, item) => sum + item.length, 0) > 6000) break;
      }
      return chunks.join('').trim();
    }
  });
}

/** Build a fresh capability snapshot so optional DSH services can arrive after plugin apply(). */
export function createDshHostAdapter(ctx, { version = detectDshVersion() } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('DSH Host Adapter 需要宿主 ctx');
  const ports = {};
  const unavailable = {};

  const attachments = service(ctx, 'attachments');
  if (attachments && typeof attachments.saveImage === 'function' && typeof attachments.readImage === 'function') {
    ports.attachments = Object.freeze({
      saveImage: (input) => attachments.saveImage(input),
      readImage: (ref, signal) => attachments.readImage(ref, signal)
    });
  } else unavailable.attachments = unavailableFor(attachments, 'DSH attachments 需要 saveImage/readImage');

  const browser = service(ctx, 'browser');
  if (browser && ['open', 'openUrl', 'screenshot', 'close'].every((name) => typeof browser[name] === 'function')) {
    const renderer = new BrowserHtmlRenderer({ browser });
    ports.browser = Object.freeze({
      async renderHtml(input) {
        const { png } = await renderer.render(input);
        return { bytes: new Uint8Array(png), mediaType: 'image/png' };
      }
    });
  } else unavailable.browser = unavailableFor(browser, 'DSH browser 需要 open/openUrl/screenshot/close');

  const slots = service(ctx, 'slots');
  if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
    ports.clientSlots = Object.freeze({
      inject: (seat, callback) => slots.inject(seat, callback),
      register: (definition, component) => slots.register(definition, component)
    });
  } else unavailable.clientSlots = unavailableFor(slots, 'DSH client slots 需要 inject/register');

  const routes = service(ctx, 'webServer') || service(ctx, 'httpServer');
  if (routes && typeof routes.register === 'function') {
    ports.routes = Object.freeze({ register: (definition) => routes.register(definition) });
  } else unavailable.routes = unavailableFor(routes, 'DSH webServer/httpServer 需要 register');

  const sessions = service(ctx, 'sessionQuery');
  if (sessions && typeof sessions.readSession === 'function') {
    ports.sessions = Object.freeze({
      readSession: (id) => sessions.readSession(id),
      async listImageAttachments(id) {
        const record = await sessions.readSession(id);
        return collectImageAttachments(record && record.events);
      },
      async findImageAttachment(id, attachmentId) {
        return (await this.listImageAttachments(id)).find((item) => item.attachmentId === attachmentId) || null;
      }
    });
  } else unavailable.sessions = unavailableFor(sessions, 'DSH sessionQuery 需要 readSession');

  const skills = service(ctx, 'skills');
  if (skills && typeof skills.register === 'function') {
    ports.skills = Object.freeze({ register: (definition) => registerWithEffect(ctx, skills, definition) });
  } else unavailable.skills = unavailableFor(skills, 'DSH Skill registry 需要 register');

  const llm = service(ctx, 'llm');
  const defaults = service(ctx, 'agentDefaultModel');
  if (llm && typeof llm.stream === 'function') {
    ports.textModel = Object.freeze({
      stream: (request) => llm.stream(request),
      resolveModelInfo: typeof llm.resolveModelInfo === 'function'
        ? (provider, model, signal) => llm.resolveModelInfo(provider, model, signal)
        : undefined,
      currentSelection: defaults && typeof defaults.currentSelection === 'function'
        ? () => defaults.currentSelection()
        : () => null
    });
    const requiresRoute = /^0\.2\./.test(version);
    if (!requiresRoute || defaults && typeof defaults.currentSelection === 'function'
        && typeof llm.resolveModelInfo === 'function') {
      ports.visionModel = dshVisionPort(llm, { defaults, requiresRoute });
    } else unavailable.visionModel = {
      kind: 'unavailable', reason: 'DSH 0.2 视觉桥接需要默认模型选择和精确图片能力元数据'
    };
  } else {
    unavailable.textModel = unavailableFor(llm, 'DSH llm 需要 stream');
    unavailable.visionModel = unavailableFor(llm, 'DSH llm 需要 stream');
  }

  const tools = service(ctx, 'tools');
  if (tools && typeof tools.register === 'function') {
    ports.tools = Object.freeze({ register: (definition) => registerWithEffect(ctx, tools, definition) });
  } else unavailable.tools = unavailableFor(tools, 'DSH tools 需要 register');

  return defineHostAdapter({ id: 'deepseek-harness', version, ports, unavailable });
}
