import { listModels } from './adapters.js';
import { capabilitiesOfDiscoveredModel } from './models.js';
import { providerApiKey, providerMediaBaseUrl, selectMediaProtocol, providerProtocolDescriptor } from './provider-protocol.js';
import { createConfiguredProviderAdapter } from './provider-adapters.js';
import { invokeProviderOperation } from './provider-adapter.js';
import { redactProviderMessage } from './provider-contract.js';
import { MODEL_DIRECTORY_TTL_MS, MODEL_DIRECTORY_RETRY_MS, currentModelDirectory, modelDirectoryBinding } from './model-directory.js';
import { assertDiscoveryCredentials } from './provider-credentials.js';
import { assertProviderNetwork } from './provider-network.js';
import { providerNetworkRequirement, sameNetworkRequirement, networkPolicyError } from './network-policy.js';

const pending = new Map();
const registryPending = new WeakMap();
const networkPending = new WeakMap();

/** 只有完整发现成功才替换快照；相同连接合并网络读取，各调用方保存自己的配置。 */
export async function refreshModelDirectory(provider, { force = false, signal, save, discover = listModels, now = Date.now(), registry, network } = {}) {
  if (network !== undefined) assertProviderNetwork(network);
  const requirement = providerNetworkRequirement(provider);
  if (requirement && (!network || !sameNetworkRequirement(requirement, network.networkRequirement) || provider.id !== network.providerId)) {
    throw networkPolicyError('IRIS_NETWORK_CONTEXT_REQUIRED', '模型目录需要供应商匹配的网络上下文，不会使用默认出口');
  }
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
  let registries = registryPending;
  if (network) {
    if (!networkPending.has(network)) networkPending.set(network, { calls: new Map(), registries: new WeakMap() });
    const scoped = networkPending.get(network);
    calls = scoped.calls; registries = scoped.registries;
  }
  if (registry) {
    if (!registries.has(registry)) registries.set(registry, new Map());
    calls = registries.get(registry);
    discover = async ({ signal, timeoutMs }) => (await invokeProviderOperation(
      createConfiguredProviderAdapter(provider, { registry, ...(network ? { network } : {}) }), 'discover', { signal, timeoutMs })).models;
  }
  const binding = modelDirectoryBinding(provider), key = providerApiKey(provider);
  let job = calls.get(binding);
  if (!job) {
    const budget = AbortSignal.timeout(15000);
    const request = { key, baseUrl: providerMediaBaseUrl(provider),
      signal: signal ? AbortSignal.any([signal, budget]) : budget, timeoutMs: 15000 };
    job = network && !registry
      ? network.run(fetchPort => discover({ ...request, fetchPort })) : discover(request);
    calls.set(binding, job);
    job.finally(() => { if (calls.get(binding) === job) calls.delete(binding); }).catch(() => {});
  }
  let discovered;
  try {
    discovered = await job;
    assertDiscoveryCredentials(discovered, key);
  } catch (error) {
    signal?.throwIfAborted();
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
