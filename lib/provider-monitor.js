// Optional, service-owned, read-only connection checks. Never a media probe or durable health assertion.
import { loadProviderCatalog } from './provider-catalog.js';
import { executeConfigCommand } from './provider-config-service.js';
import { modelDirectoryBinding } from './model-directory.js';
import { selectMediaProtocol, isConfiguredProvider } from './provider-protocol.js';

const AUTOMATIC = new Set(['dashscope', 'openai-images', 'openai-chat-images', 'openai-responses-images', 'gemini-web-music', 'comfyui']);
const errorCode = error => ['IRIS_CONFIG_CHANGED', 'IRIS_CONFIG_BUSY', 'IRIS_PROVIDER_OPERATION_UNSUPPORTED'].includes(error.code) ? error.code
  : ['authentication', 'permission', 'network', 'timeout', 'protocol', 'rate_limit', 'provider', 'aborted'].includes(error.category) ? error.category : 'connection_failed';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export function createProviderMonitor({ configPath, registry, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const records = new Map(), pending = new Set(); let closed = false;
  const catalog = () => { if (closed) fail('IRIS_PROVIDER_MONITOR_CLOSED', '连接检查已关闭'); return loadProviderCatalog(configPath); };
  function record(providerId, provider = catalog().providers.find(item => item.id === providerId)) {
    if (!provider) fail('IRIS_CONFIG_INPUT_INVALID', '供应商不存在');
    let item = records.get(providerId);
    if (item && item.binding !== modelDirectoryBinding(provider)) { stop(item); records.delete(providerId); item = null; }
    if (!item) { item = { providerId, binding: modelDirectoryBinding(provider), enabled: false, intervalSeconds: 300, last: null, epoch: 0 }; records.set(providerId, item); }
    if (!isConfiguredProvider(provider)) stop(item);
    return { provider, item };
  }
  function stop(item) { item.epoch++; clearTimer(item.timer); item.enabled = false; item.controller?.abort(); }
  function snapshot() {
    const providers = catalog().providers.map(provider => {
      const { item } = record(provider.id, provider);
      return { providerId: provider.id, automaticSupported: AUTOMATIC.has(selectMediaProtocol(provider).mediaProtocol),
        enabled: item.enabled, intervalSeconds: item.intervalSeconds, checking: Boolean(item.pending), last: item.last };
    });
    for (const [id, item] of records) if (!providers.some(provider => provider.providerId === id)) { stop(item); records.delete(id); }
    return providers;
  }
  async function check(providerId, expectedRevision, { signal } = {}) {
    const { provider, item } = record(providerId);
    if (!isConfiguredProvider(provider)) fail('IRIS_CONFIG_INPUT_INVALID', '请先保存并启用供应商连接');
    if (item.pending) fail('IRIS_API_BUSY', '此供应商正在检查，请等待结果');
    const controller = item.controller = new AbortController();
    const started = Date.now();
    const job = (async () => {
      try {
        const result = await executeConfigCommand(configPath, 'settings.discover', { expectedRevision, providerId }, { registry,
          signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]) });
        item.last = { ok: true, at: new Date().toISOString(), elapsedMs: Date.now() - started, modelCount: result.models.length };
      } catch (error) {
        if (error.code === 'IRIS_CONFIG_CHANGED') throw error;
        item.last = { ok: false, at: new Date().toISOString(), elapsedMs: Date.now() - started,
          code: controller.signal.aborted || signal?.aborted ? 'check_unconfirmed' : errorCode(error),
          ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) };
      }
      return { contractVersion: 0, providerId, ...item.last };
    })();
    item.pending = job;
    pending.add(job);
    try { return await job; } finally { pending.delete(job); item.pending = null; item.controller = null; }
  }
  function schedule(item) {
    const epoch = item.epoch;
    item.timer = setTimer(async () => {
      if (!item.enabled || closed || epoch !== item.epoch) return;
      try {
        const view = await executeConfigCommand(configPath, 'settings.show', {}, { registry });
        const { provider, item: current } = record(item.providerId);
        if (current !== item || !item.enabled || !isConfiguredProvider(provider)) return;
        if (!item.pending) await check(item.providerId, view.revision);
      } catch (error) { item.last = { ok: false, at: new Date().toISOString(), code: errorCode(error) }; }
      finally { if (item.enabled && !closed && epoch === item.epoch) schedule(item); }
    }, item.intervalSeconds * 1000);
    item.timer?.unref?.();
  }
  function configure({ providerId, enabled, intervalSeconds }) {
    if (typeof enabled !== 'boolean' || ![60, 300, 900].includes(intervalSeconds)) fail('IRIS_CONFIG_INPUT_INVALID', '保活需选择开关和60/300/900秒间隔');
    const { provider, item } = record(providerId);
    if (enabled && (!isConfiguredProvider(provider) || !AUTOMATIC.has(selectMediaProtocol(provider).mediaProtocol))) fail('IRIS_CONFIG_INPUT_INVALID', '此连接没有已支持的自动轻量检查');
    stop(item); item.intervalSeconds = intervalSeconds; item.enabled = enabled;
    if (enabled) schedule(item);
    return { contractVersion: 0, monitors: snapshot(), persistence: 'service-session' };
  }
  async function dispose() { closed = true; for (const item of records.values()) stop(item); await Promise.allSettled([...pending]); records.clear(); }
  return Object.freeze({ snapshot, check, configure, dispose });
}
