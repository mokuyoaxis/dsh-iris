import { listModels } from './adapters.js';
import { capabilitiesOfDiscoveredModel } from './models.js';
import { providerApiKey, providerMediaBaseUrl, selectMediaProtocol, providerProtocolDescriptor } from './provider-protocol.js';
import { createConfiguredProviderAdapter } from './provider-adapters.js';
import { invokeProviderOperation } from './provider-adapter.js';
import { redactProviderMessage } from './provider-contract.js';
import { MODEL_DIRECTORY_TTL_MS, MODEL_DIRECTORY_RETRY_MS, currentModelDirectory, modelDirectoryBinding } from './model-directory.js';

const pending = new Map();
const registryPending = new WeakMap();

/** 只有完整发现成功才替换快照；相同连接合并网络读取，各调用方保存自己的配置。 */
export async function refreshModelDirectory(provider, { force = false, signal, save, discover = listModels, now = Date.now(), registry } = {}) {
  if (!providerProtocolDescriptor(selectMediaProtocol(provider).mediaProtocol, registry)) {
    return { refreshed: false, error: '当前协议未提供模型目录发现' };
  }
  const previous = currentModelDirectory(provider);
  if (!force && previous) {
    const stale = Boolean(previous.lastError) || !previous.checkedAt || now - Date.parse(previous.checkedAt) >= MODEL_DIRECTORY_TTL_MS
      || Date.parse(previous.invalidatedAt || '') >= Date.parse(previous.checkedAt);
    if (!stale || (previous.failedAt && now - Date.parse(previous.failedAt) < MODEL_DIRECTORY_RETRY_MS)) {
      return { refreshed: false, directory: previous, ...(previous.lastError ? { error: previous.lastError } : {}) };
    }
  }
  signal?.throwIfAborted();
  let calls = pending;
  if (registry) {
    if (!registryPending.has(registry)) registryPending.set(registry, new Map());
    calls = registryPending.get(registry);
    discover = async ({ signal, timeoutMs }) => (await invokeProviderOperation(
      createConfiguredProviderAdapter(provider, { registry }), 'discover', { signal, timeoutMs })).models;
  }
  const binding = modelDirectoryBinding(provider);
  let job = calls.get(binding);
  if (!job) {
    const budget = AbortSignal.timeout(15000);
    job = discover({ key: providerApiKey(provider), baseUrl: providerMediaBaseUrl(provider),
      signal: signal ? AbortSignal.any([signal, budget]) : budget, timeoutMs: 15000 });
    calls.set(binding, job);
    job.finally(() => { if (calls.get(binding) === job) calls.delete(binding); }).catch(() => {});
  }
  let discovered;
  try {
    discovered = await job;
  } catch (error) {
    signal?.throwIfAborted();
    const key = providerApiKey(provider);
    const message = String(error?.message || error);
    const directory = { version: 1, binding, ...(previous || {}), failedAt: new Date(now).toISOString(),
      lastError: redactProviderMessage(key ? message.split(key).join('[REDACTED]') : message) };
    if (await save(directory) === false) return { refreshed: false, error: '连接在目录同步期间发生变化，请重新同步' };
    return { refreshed: false, directory, error: directory.lastError };
  }
  signal?.throwIfAborted();
  const models = discovered.map(model => ({ id: typeof model === 'string' ? model : model.id,
    capabilities: capabilitiesOfDiscoveredModel(model) }));
  const known = new Set(previous?.models?.map(model => model.id)
    || provider.models?.map(model => typeof model === 'string' ? model : model.id) || []);
  const directory = { version: 1, binding, checkedAt: new Date(now).toISOString(), models,
    added: models.filter(model => !known.has(model.id)).map(model => model.id) };
  if (await save(directory) === false) return { refreshed: false, error: '连接在目录同步期间发生变化，请重新同步' };
  return { refreshed: true, directory };
}
