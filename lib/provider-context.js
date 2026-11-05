// Public author context, backed by Core-owned clients. No proxy/resource-management ports.
import { AsyncLocalStorage } from 'node:async_hooks';
import { ProviderContractError } from './provider-contract.js';
import { assertProviderNetwork } from './provider-network.js';
import { providerNetworkRequirement, sameNetworkRequirement, networkPolicyError } from './network-policy.js';
import { modelRef } from './models.js';

export const PROVIDER_FACTORY_CONTEXT_VERSION = 1;
const managed = new WeakSet();
export function markProviderContextAdapter(adapter) { managed.add(adapter); return adapter; }
export function hasProviderContext(adapter) { return managed.has(adapter); }

/** Only the registry creates a context; callers borrow fetch for one awaited lifecycle method. */
export function createProviderContext(provider, options, inheritedNetwork) {
  if (options?.modelId !== undefined && typeof options.modelId !== 'string') throw new TypeError('Provider modelId 必须是字符串');
  const requirement = providerNetworkRequirement(provider);
  if (requirement && (!options?.network || !sameNetworkRequirement(requirement, options.network.networkRequirement)
      || options.network.providerId !== provider.id)) {
    throw networkPolicyError('IRIS_NETWORK_CONTEXT_REQUIRED', '统一 Provider 需要原配置匹配的网络上下文，不会借用默认出口');
  }
  const network = assertProviderNetwork(options?.network === undefined ? inheritedNetwork() : options.network), scope = new AsyncLocalStorage();
  const fetch = (...args) => {
    if (!scope.getStore()?.active) {
      throw Object.assign(new ProviderContractError('Provider 网络端口只可在当前完整生命周期方法内使用；请等待正文和子请求完成', {
        stage: 'prepare', category: 'invalid_request', acceptance: 'not_accepted', providerCode: 'IRIS_PROVIDER_CONTEXT_OPERATION_REQUIRED'
      }), { code: 'IRIS_PROVIDER_CONTEXT_OPERATION_REQUIRED' });
    }
    return network.fetch(...args);
  };
  const context = Object.freeze({ contractVersion: PROVIDER_FACTORY_CONTEXT_VERSION, network: Object.freeze({ fetch }),
    ...(options?.modelId !== undefined ? { modelId: options.modelId } : {}) });
  function invoke(name, action, args) {
    const request = args[0], operation = { ...args[1], providerId: provider.id, operation: name };
    if (!operation.modelRef && typeof request?.model === 'string') operation.modelRef = modelRef(provider.id, request.model);
    return network.run(() => scope.run({ active: true }, async () => {
      const current = scope.getStore();
      try { return await action(...args); }
      finally { current.active = false; }
    }), operation);
  }
  return { context, invoke };
}
